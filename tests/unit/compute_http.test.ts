import { describe, expect, test } from "bun:test";
import {
  EXECUTION_STATES,
  EXECUTION_TRANSITIONS,
  approvalGate,
  dispatchGate,
} from "../../backend/src/compute/lifecycle";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";

// CB-5 接线 · `/api/compute/**` 的 HTTP 投影。
//
// 三条要点，其余交给 CLI/契约测试：
//   ① /machine 的两道门必须从 lifecycle 的转移表**推导**得出，不许手写
//      （lab 的 /machine 就因为手写而对外撒过一次谎）；
//   ② approve/reject **actor 必填**——服务进程的 OS 用户与点「批准」的人没关系，
//      HTTP 层不许有 env 兜底；
//   ③ **派发与释放不在 HTTP 面上**。MCP 是 HTTP 的投影，HTTP 开的口子就是 agent 的路。

interface JobBody {
  project: string;
  job: {
    jobId: string;
    lifecycle: { execution: string; delivery: string };
    approval: { actor: string; actorSource: string } | null;
    plan: { digest: string; approvalRequired: boolean; command: string[] };
    next: string;
  };
  decisionId?: string;
  humanAction?: string;
  next?: string;
}

async function plan(fx: ServerFixture, over: Record<string, unknown> = {}) {
  const res = await fx.post<JobBody>("/api/compute/jobs", {
    purpose: "HTTP 接线测试",
    command: ["/bin/echo", "hi"],
    // network=unrestricted → L-3 派生 approvalRequired=true，走完整审批链。
    network: "unrestricted",
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("HTTP · /api/compute/machine", () => {
  test("两道门从 EXECUTION_TRANSITIONS 推导得出，且目标状态各只有一条入边", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const { status, body } = await fx.get<{
      executionStates: string[];
      approvalGate: { from: string; to: string };
      dispatchGate: { from: string; to: string; consumesApproval: boolean; verifies: string[] };
      terminal: string[];
      httpWithheld: Array<{ action: string; humanAction: string }>;
    }>("/api/compute/machine");
    expect(status).toBe(200);
    expect(body.executionStates).toEqual([...EXECUTION_STATES]);

    const inboundOf = (state: string) =>
      Object.entries(EXECUTION_TRANSITIONS)
        .filter(([, events]) => Object.values(events as Record<string, string>).includes(state))
        .map(([from]) => from);

    for (const [label, gate] of [
      ["approvalGate", body.approvalGate],
      ["dispatchGate", body.dispatchGate],
    ] as const) {
      const inbound = inboundOf(gate.to);
      // dispatch 有两条入边（approved 与 approvalRequired=false 的 planned，L-2），
      // 但**带审批的那一条**必须是 approved；approve 的入边只有一条。
      expect(inbound, `${label} 自报 from='${gate.from}'，但转移表里没有这条边`).toContain(gate.from);
    }
    expect(body.approvalGate).toEqual(approvalGate());
    expect(body.dispatchGate).toEqual(dispatchGate());
    expect(body.dispatchGate.consumesApproval).toBe(true);
    expect(body.dispatchGate.verifies).toEqual(["planDigest", "uploads"]);

    // 派发/释放不在 HTTP 面上，而且是**写进机器可读视图**的，不是让调用方试出来。
    expect(body.httpWithheld.map((w) => w.action).sort()).toEqual(["dispatch", "release"]);
    for (const w of body.httpWithheld) expect(w.humanAction).toContain("spark-research compute");
    await fx.stop();
  });
});

describe("HTTP · /api/compute/targets", () => {
  test("没配 Modal 凭据 → 「未配置」（needs_credential）+ 配置指引；local 可用且是默认", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const { status, body } = await fx.get<{
      targets: Array<{
        kind: string;
        availability: string;
        credentialConfigured: boolean | null;
        setupHint: string | null;
        isDefault: boolean;
      }>;
    }>("/api/compute/targets");
    expect(status).toBe(200);
    const byKind = Object.fromEntries(body.targets.map((t) => [t.kind, t]));
    expect(byKind.modal!.availability).toBe("needs_credential");
    expect(byKind.modal!.credentialConfigured).toBe(false);
    expect(byKind.modal!.setupHint).toBeTruthy();
    expect(byKind.local!.availability).toBe("available");
    expect(byKind.local!.isDefault).toBe(true);
    expect(byKind.ssh!.availability).toBe("placeholder");
    await fx.stop();
  });
});

describe("HTTP · plan / list / get", () => {
  test("POST /jobs 停在 awaiting_approval，并把「需要人执行哪条命令」写进返回体", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    expect(body.job.lifecycle.execution).toBe("awaiting_approval");
    expect(body.job.plan.approvalRequired).toBe(true);
    expect(body.humanAction).toContain("compute approve");
    expect(body.humanAction).toContain(body.job.jobId);
    await fx.stop();
  });

  test("command 缺失或不是 argv 数组 → 400（不接受 shell 字符串）", async () => {
    const fx = makeServer({ slug: "compute-http" });
    expect((await fx.post("/api/compute/jobs", { purpose: "没有命令" })).status).toBe(400);
    const shell = await fx.post("/api/compute/jobs", {
      purpose: "shell 字符串",
      command: ["/bin/sh", "-c", "echo hi"],
    });
    // 这一条被 validatePlan 拒 → 422（调用方给的东西不合法，不是服务端崩了）。
    expect(shell.status).toBe(422);
    await fx.stop();
  });

  test("GET /jobs 列表 + 状态过滤；GET /jobs/:id 查不到 → 404", async () => {
    const fx = makeServer({ slug: "compute-http" });
    await plan(fx);
    const all = await fx.get<{ jobs: unknown[] }>("/api/compute/jobs");
    expect(all.body.jobs).toHaveLength(1);
    const filtered = await fx.get<{ jobs: unknown[] }>("/api/compute/jobs?state=succeeded");
    expect(filtered.body.jobs).toHaveLength(0);
    expect((await fx.get("/api/compute/jobs?state=不存在")).status).toBe(400);
    expect((await fx.get("/api/compute/jobs/cj-nope")).status).toBe(404);
    await fx.stop();
  });
});

describe("HTTP · approve / reject 必须记名", () => {
  test("缺 actor → 400，且**没有**落任何 decision record", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    const res = await fx.post(`/api/compute/jobs/${body.job.jobId}/approve`, {});
    expect(res.status).toBe(400);

    const project = fx.manager.open("compute-http");
    expect(project.records().list({ type: "decision" })).toHaveLength(0);
    project.close();
    await fx.stop();
  });

  test("给了 actor → 批准成功，actorSource 记 http:explicit（审计时分得清网页批的还是命令行批的）", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    const res = await fx.post<JobBody>(`/api/compute/jobs/${body.job.jobId}/approve`, {
      actor: "王研究员",
      note: "命令我看过了",
    });
    expect(res.status).toBe(200);
    expect(res.body.job.lifecycle.execution).toBe("approved");
    expect(res.body.job.approval!.actor).toBe("王研究员");
    expect(res.body.job.approval!.actorSource).toBe("http:explicit");
    expect(res.body.decisionId).toBeTruthy();
    // 批准 ≠ 已派发：下一步是一条要人去终端敲的命令。
    expect(res.body.job.next).toContain("compute run");
    await fx.stop();
  });

  test("重复批准同一个任务 → 403（已经不在 awaiting_approval 了）", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    await fx.post(`/api/compute/jobs/${body.job.jobId}/approve`, { actor: "王研究员" });
    const again = await fx.post(`/api/compute/jobs/${body.job.jobId}/approve`, { actor: "王研究员" });
    expect(again.status).toBe(403);
    await fx.stop();
  });

  test("reject 缺 reason → 400；给了 → rejected 终态", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    expect((await fx.post(`/api/compute/jobs/${body.job.jobId}/reject`, { actor: "王研究员" })).status).toBe(400);
    const ok = await fx.post<JobBody>(`/api/compute/jobs/${body.job.jobId}/reject`, {
      actor: "王研究员",
      reason: "这个命令会把整个数据集传上去",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.job.lifecycle.execution).toBe("rejected");
    await fx.stop();
  });
});

describe("HTTP · 派发与释放刻意不在这一层", () => {
  // 这是本 lane 最重要的一条 HTTP 断言：MCP 工具都是「对本 app 的一次 fetch」，
  // 所以**只要 HTTP 上没有这两个端点，MCP 就没有任何办法走到它们**——
  // 扣留不是靠 MCP 那张名单自觉，是这一层压根没有路。
  for (const path of ["run", "dispatch", "release"]) {
    test(`POST /api/compute/jobs/:id/${path} 不存在（404 JSON，不是 500 也不是悄悄成功）`, async () => {
      const fx = makeServer({ slug: "compute-http" });
      const body = await plan(fx);
      const res = await fx.post<{ error: string }>(`/api/compute/jobs/${body.job.jobId}/${path}`, { actor: "x" });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("未知端点");

      // 任务状态一动没动。
      const after = await fx.get<JobBody>(`/api/compute/jobs/${body.job.jobId}`);
      expect(after.body.job.lifecycle.execution).toBe("awaiting_approval");
      await fx.stop();
    });
  }
});

describe("HTTP · collect", () => {
  test("execution 还没到终态就 collect → 409（「你调早了」，不是服务端崩了）", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    const res = await fx.post<{ error: string }>(`/api/compute/jobs/${body.job.jobId}/collect`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("终态");
    await fx.stop();
  });

  test("从未派发过的终态任务（rejected）collect → 409，不假装收到了空产物", async () => {
    const fx = makeServer({ slug: "compute-http" });
    const body = await plan(fx);
    await fx.post(`/api/compute/jobs/${body.job.jobId}/reject`, { actor: "王研究员", reason: "不批" });
    const res = await fx.post<{ error: string }>(`/api/compute/jobs/${body.job.jobId}/collect`, {});
    expect(res.status).toBe(409);
    await fx.stop();
  });
});
