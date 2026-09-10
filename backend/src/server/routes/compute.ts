import { Hono } from "hono";
import { ApprovalRequiredError } from "../../compute/approval";
import { ComputeAdmissionError, ComputeDispatchConflictError, UnknownTargetError } from "../../compute/broker";
import { UnknownComputeJobError, type ComputeJobView } from "../../compute/job_store";
import {
  ComputeStateError,
  DELIVERY_STATES,
  DELIVERY_TRANSITIONS,
  EXECUTION_STATES,
  EXECUTION_TRANSITIONS,
  RESOURCE_STATES,
  RESOURCE_TRANSITIONS,
  approvalGate,
  dispatchGate,
  isExecutionTerminal,
  type ExecutionState,
} from "../../compute/lifecycle";
import { PlanValidationError, type PlanInput } from "../../compute/plan";
import { TARGET_KINDS, type TargetRef } from "../../compute/target";
import {
  UploadChangedError,
  UploadDeniedError,
  UploadLimitError,
  collectUploads,
} from "../../compute/uploads";
import {
  computeTargetViews,
  defaultComputeAdapters,
  jobJson,
  nextActionFor,
  openComputeScope,
} from "../../compute/cli";
import { configuredComputeTarget, configuredModalEnvironment } from "../../config";
import { HttpError, type ServerContext } from "../context";
import {
  jsonBody,
  optionalNumber,
  optionalString,
  optionalStringList,
  projectSlug,
  queryString,
  requireString,
} from "./shared";

// 远端算力端点（CB-5 接线，设计 §1.1.8 的 HTTP 投影）。
//
// ── 这一层刻意**没有** dispatch / release ──────────────────────────────────
//
// 六个端点：/machine · /targets · /jobs（GET 列表 + POST plan）· /jobs/:id ·
// /jobs/:id/approve · /jobs/:id/reject · /jobs/:id/collect。
//
// **派发（run）与释放（release）不做 HTTP 端点**。理由不是「还没做」，是设计：
// MCP 层是 HTTP 层的一次投影（`mcp/tools.ts` 每个工具都只是对本 app 的一次 fetch），
// 所以任何在 HTTP 上开着的口子，等于给外部 agent 多了一条路。派发 = 计费动作本身
// （与 `lab_simulate` 同构），release = 删远端卷（与 `project_archive` 同构）——
// 这两件事只允许从一个**有真实交互终端**的地方发起，那个地方是 CLI
// （`compute run` / `compute release`，TTY 门在 approval/gate.ts）。
//
// approve/reject 有 HTTP 端点（供 Web 工作台里的人点），但比 CLI 更严：
// **actor 必填**（照 lab.ts:32-37）。服务进程的 OS 用户与点「批准」的人没有任何关系，
// 所以这里不许有 env 兜底，actorSource 一律记 `http:explicit`。

function requireActor(body: Record<string, unknown>): { actor: string; actorSource: string } {
  const actor = body.actor;
  if (typeof actor !== "string" || actor.trim() === "") {
    throw new HttpError(400, "approve/reject 必须记名：请求体缺少 actor（HTTP 层不从环境变量猜审批人）");
  }
  return { actor: actor.trim(), actorSource: "http:explicit" };
}

function mapComputeError(error: unknown): never {
  if (error instanceof UnknownComputeJobError) throw new HttpError(404, error.message);
  if (error instanceof ApprovalRequiredError) throw new HttpError(403, error.message);
  if (error instanceof ComputeDispatchConflictError) throw new HttpError(409, error.message);
  if (error instanceof ComputeStateError) throw new HttpError(409, error.message);
  if (error instanceof ComputeAdmissionError) throw new HttpError(429, error.message);
  if (error instanceof UnknownTargetError) throw new HttpError(400, error.message);
  if (
    error instanceof PlanValidationError ||
    error instanceof UploadDeniedError ||
    error instanceof UploadLimitError ||
    error instanceof UploadChangedError
  ) {
    // 调用方给的东西不合法（或工作区在审批之后变了），不是服务端崩了 → 422。
    throw new HttpError(422, error.message);
  }
  throw error;
}

function view(job: ComputeJobView): Record<string, unknown> {
  return { ...jobJson(job), next: nextActionFor(job) };
}

function parseTarget(raw: string | undefined, modalEnvironment: string | null): TargetRef {
  const kind = raw ?? "local";
  if (kind === "local") return { kind: "local" };
  if (kind === "modal") return modalEnvironment ? { kind: "modal", environment: modalEnvironment } : { kind: "modal" };
  throw new HttpError(400, `target '${kind}' 不能派发（可选：local / modal；ssh 在 v0.5 只有 schema 槽位）`);
}

export function computeRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // 状态机视图：UI 与外部调用方照这张表画停留态与合法动作。
  // **全部从 lifecycle.ts 推导，一个字段都不许手写**（AD-12 ③；lab 的 /machine 就是
  // 因为手写 approvalGate 而对外撒过一次谎——D-10 把 wet_run 拆成 approved/executing 之后，
  // 那里手写的 to 仍指着一个已经不存在的状态名）。
  app.get("/machine", (c) =>
    c.json({
      mode: "compute",
      executionStates: EXECUTION_STATES,
      deliveryStates: DELIVERY_STATES,
      resourceStates: RESOURCE_STATES,
      executionTransitions: EXECUTION_TRANSITIONS,
      deliveryTransitions: DELIVERY_TRANSITIONS,
      resourceTransitions: RESOURCE_TRANSITIONS,
      terminal: EXECUTION_STATES.filter(isExecutionTerminal),
      awaiting: "awaiting_approval",
      // 两道门：人工审批（记名）与派发（一次性消费 approval + 执行前重验）。
      approvalGate: approvalGate(),
      dispatchGate: dispatchGate(),
      // 派发/释放不在 HTTP 面上——见本文件顶部注释。写进机器可读视图，
      // 免得调用方试了才知道。
      httpWithheld: [
        { action: "dispatch", humanAction: "spark-research compute run <jobId>（需真实交互终端）" },
        { action: "release", humanAction: "spark-research compute release <jobId>" },
      ],
    }),
  );

  app.get("/targets", (c) => {
    const targets = computeTargetViews({
      adapters: defaultComputeAdapters(),
      credentials: ctx.credentials(),
      defaultTarget: configuredComputeTarget("local", { root: ctx.deps.root }),
    });
    return c.json({ targets, kinds: TARGET_KINDS });
  });

  app.get("/jobs", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const state = queryString(c, "state");
      if (state && !(EXECUTION_STATES as readonly string[]).includes(state)) {
        throw new HttpError(400, `未知状态 '${state}'（可用：${EXECUTION_STATES.join(", ")}）`);
      }
      const compute = openComputeScope(scope.project, { root: ctx.deps.root, credentials: ctx.credentials() });
      const jobs = compute.broker.list(state ? { execution: [state as ExecutionState] } : undefined);
      return c.json({ project: scope.project.slug, jobs: jobs.map(view) });
    });
  });

  // plan：**零副作用**（不建远端资源、不解析凭据），停在 awaiting_approval。
  // 这是 MCP 唯一能触发的写动作，所以它必须是「只产生一张待审批的纸」的那一步。
  app.post("/jobs", async (c) => {
    const body = await jsonBody(c);
    const purpose = requireString(body, "purpose");
    const command = optionalStringList(body, "command");
    if (!command || command.length === 0) {
      throw new HttpError(400, "缺少必填字段: command（argv 数组；不接受 shell 字符串）");
    }
    const network = (optionalString(body, "network") ?? "none") as "none" | "unrestricted";
    if (network !== "none" && network !== "unrestricted") {
      throw new HttpError(400, `network 只能是 none 或 unrestricted，收到 '${String(body.network)}'`);
    }
    const envPairs = body.env;
    if (envPairs !== undefined && (typeof envPairs !== "object" || envPairs === null || Array.isArray(envPairs))) {
      throw new HttpError(400, "字段 env 必须是 {K: V} 对象");
    }

    return ctx.withProject(projectSlug(c), async (scope) => {
      const compute = openComputeScope(scope.project, { root: ctx.deps.root, credentials: ctx.credentials() });
      // workspaceRoot 默认落在**项目目录**里：HTTP/MCP 调用方不该靠猜一个绝对路径
      // 就能把本机任意目录扫进上传清单（deny-list 之外还有这一层收敛）。
      const workspaceRoot = optionalString(body, "workspaceRoot") ?? scope.project.paths.root;
      try {
        const scan = collectUploads(workspaceRoot, optionalStringList(body, "upload") ?? []);
        const input: PlanInput = {
          target: parseTarget(
            optionalString(body, "target") ?? configuredComputeTarget("local", { root: ctx.deps.root }),
            configuredModalEnvironment(null, { root: ctx.deps.root }),
          ),
          purpose,
          command,
          env: (envPairs as Record<string, string> | undefined) ?? {},
          image: null,
          secretRefs: optionalStringList(body, "secretRefs") ?? [],
          resources: {
            gpu: optionalString(body, "gpu") ?? null,
            cpus: optionalNumber(body, "cpus") ?? 1,
            memoryGb: optionalNumber(body, "memoryGb") ?? 1,
            timeoutMinutes: optionalNumber(body, "timeoutMinutes") ?? 30,
          },
          network,
          uploads: scan.entries,
          outputs: optionalStringList(body, "outputs") ?? [],
          workspaceRoot,
        };
        const job = await compute.broker.plan(input, { projectSlug: scope.project.slug });
        return c.json(
          {
            project: scope.project.slug,
            job: view(job),
            skippedUploads: scan.skipped,
            // 把人拉回环里：返回体里直接写清「需要人执行哪条命令」（MCP 判断一）。
            next: nextActionFor(job),
            humanAction: `spark-research compute approve ${job.jobId} --run`,
          },
          201,
        );
      } catch (error) {
        mapComputeError(error);
      }
    });
  });

  app.get("/jobs/:id", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const compute = openComputeScope(scope.project, { root: ctx.deps.root, credentials: ctx.credentials() });
      try {
        return c.json({ project: scope.project.slug, job: view(compute.broker.poll(c.req.param("id"))) });
      } catch (error) {
        mapComputeError(error);
      }
    });
  });

  app.post("/jobs/:id/approve", async (c) => {
    const body = await jsonBody(c);
    const signer = requireActor(body);
    return ctx.withProject(projectSlug(c), (scope) => {
      const compute = openComputeScope(scope.project, { root: ctx.deps.root, credentials: ctx.credentials() });
      try {
        const { job, decisionId } = compute.approval.approve(c.req.param("id"), {
          actor: signer.actor,
          actorSource: signer.actorSource,
          note: optionalString(body, "note"),
        });
        return c.json({
          project: scope.project.slug,
          job: view(job),
          decisionId,
          decision: scope.project.records().get(decisionId),
          // 批准 ≠ 已派发：approval 停在磁盘上等一次显式的 dispatch，而 dispatch 不在
          // HTTP 面上（见文件顶部）。这句话是给 UI 与外部调用方的口径。
          next: `spark-research compute run ${job.jobId}`,
        });
      } catch (error) {
        mapComputeError(error);
      }
    });
  });

  app.post("/jobs/:id/reject", async (c) => {
    const body = await jsonBody(c);
    const signer = requireActor(body);
    const reason = requireString(body, "reason");
    return ctx.withProject(projectSlug(c), (scope) => {
      const compute = openComputeScope(scope.project, { root: ctx.deps.root, credentials: ctx.credentials() });
      try {
        const { job, decisionId } = compute.approval.reject(c.req.param("id"), {
          actor: signer.actor,
          actorSource: signer.actorSource,
          reason,
        });
        return c.json({
          project: scope.project.slug,
          job: view(job),
          decisionId,
          decision: scope.project.records().get(decisionId),
        });
      } catch (error) {
        mapComputeError(error);
      }
    });
  });

  // collect：只在 delivery=pending 时有语义（执行已到终态、产物还在远端）。
  app.post("/jobs/:id/collect", async (c) => {
    return ctx.withProject(projectSlug(c), async (scope) => {
      const compute = openComputeScope(scope.project, { root: ctx.deps.root, credentials: ctx.credentials() });
      try {
        // 先读一遍：broker.collect() 对「还没到终态 / 没有 adapterHandle」抛的是裸 Error
        // （那两条是调用顺序错误，不是状态机转移错误），落到 mapComputeError 会变成 500。
        // 在这里把它们翻成 409——「你调早了」是调用方的问题，不是服务端崩了。
        const current = compute.broker.poll(c.req.param("id"));
        if (!isExecutionTerminal(current.lifecycle.execution)) {
          throw new HttpError(
            409,
            `算力任务 ${current.jobId} 的 execution=${current.lifecycle.execution} 还没到终态，不能收割（L-5）`,
          );
        }
        if (!current.adapterHandle) {
          throw new HttpError(409, `算力任务 ${current.jobId} 从未真正派发出去，没有可收割的东西`);
        }
        const { job, harvest } = await compute.broker.collect(c.req.param("id"));
        return c.json({ project: scope.project.slug, job: view(job), harvest });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        mapComputeError(error);
      }
    });
  });

  return app;
}
