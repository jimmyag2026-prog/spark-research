import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChemCommand } from "../../backend/src/chem/cli";
import { runComputeCommand } from "../../backend/src/compute/cli";
import { runConclusionCommand } from "../../backend/src/conclusion/cli";
import { ConclusionStore } from "../../backend/src/conclusion/store";
import { runUsageApiCommand, runUsageCommand } from "../../backend/src/cli/usage";
import { runExpCommand } from "../../backend/src/experiment/cli";
import { issue as issueApprovalToken } from "../../backend/src/lab/approval_token";
import { runLabCommand } from "../../backend/src/lab/cli";
import { runLitCommand } from "../../backend/src/literature/cli";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import type { ResearchRecord } from "../../backend/src/project/models";
import { runReportCommand } from "../../backend/src/report/cli";
import { TaskRegistry } from "../../backend/src/server/tasks";
import { ApiCallStore, apiCallStorePath } from "../../backend/src/usage/api_ledger";
import { UsageStore } from "../../backend/src/usage/ledger";
import { CASSETTES, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";
import { makeServer } from "../helpers/server_scenario";

// P7 退出标准之一：**UI 与 CLI 是同一个能力的两个入口**。
// 同一个操作从两边走，落进证据图的东西必须一样。
//
// 对照的是「record 的形状」而不是「文案」：类型、evidence、边、以及那些审计要用的
// metadata 字段（approve 批的 hash、observation 的 evidence）。文案两边本来就该不同
// （CLI 打给终端看，API 回 JSON），拿文案对照只会得到一堆假警报。
//
// 挑的三个操作是各域里最有状态的那个：湿实验 approve（AD-6）、干实验闭环、文献入库。

// record 的可对照指纹：只留跨入口必须一致的字段。
function fingerprint(record: ResearchRecord): Record<string, unknown> {
  const meta = record.metadata as Record<string, unknown>;
  return {
    type: record.type,
    evidence: record.evidence,
    originKind: record.origin.kind,
    hasArtifact: record.artifactId !== null,
    kind: meta.kind ?? null,
    // 实验 record 的状态机位置；非实验 record 没有这个字段。
    state: meta.state ?? null,
    mode: meta.mode ?? null,
  };
}

function graphShape(project: Project): {
  records: Record<string, unknown>[];
  edges: Array<{ type: string; sourceType: string; targetType: string }>;
} {
  const records = project.records();
  const all = records.list();
  const byId = new Map(all.map((r) => [r.id, r]));
  const edges = records
    .listEdges()
    .map((edge) => ({
      type: edge.type,
      sourceType: byId.get(edge.sourceId)?.type ?? "?",
      targetType: byId.get(edge.targetId)?.type ?? "?",
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    records: all.map(fingerprint).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    edges,
  };
}

function cliWorkspace(slug: string) {
  const root = mkdtempSync(join(tmpdir(), "spark-parity-cli-"));
  const manager = new ProjectManager(root);
  manager.create(slug, { name: "对照项目", description: "" }).close();
  manager.setCurrent(slug);
  const sink = { out: () => {}, err: () => {} };
  return { root, manager, sink };
}

describe("UI ↔ CLI 行为对照", () => {
  test("湿实验 compile → approve → simulate：两边落同一张证据图", async () => {
    // ── CLI 侧 ──
    const cli = cliWorkspace("parity-wet");
    // V19：approve 要求可交互终端或 CI 旁路令牌（见 lab/cli.ts）——这里模拟「真人在
    // 交互终端里确认了」，因为这条测试验的是 UI↔CLI 的证据图对照，不是 V19 终端门本身
    // （终端门的正负路径测试在 tests/unit/lab_cli.test.ts）。
    const deps = {
      manager: cli.manager,
      backend: new MockDeviceBackend(),
      actor: "张三",
      approvalIsInteractiveTty: () => true,
      approvalConfirm: async () => "yes",
      ...cli.sink,
    };
    expect(await runLabCommand(["compile", "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD", "--title", "OD 测定", "--json"], deps)).toBe(0);
    const cliProject = cli.manager.open("parity-wet");
    const wetId = cliProject
      .records()
      .list({ type: "experiment" })
      .find((r) => (r.metadata as { mode?: string }).mode === "wet")!.id;
    cliProject.close();
    expect(await runLabCommand(["approve", wetId, "--actor", "张三"], deps)).toBe(0);
    expect(await runLabCommand(["simulate", wetId], deps)).toBe(0);

    // ── HTTP 侧 ──
    const fx = makeServer({ slug: "parity-wet" });
    try {
      const compiled = await fx.post<{ experiment: { id: string } }>("/api/lab/experiments", {
        naturalLanguage: "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD",
        title: "OD 测定",
      });
      const id = compiled.body.experiment.id;
      // V95：approve/simulate 现在都要求一次性审批令牌（HTTP 面不再是旁路）——
      // 与上面 CLI 侧的 V19 终端门是两件独立的事：这里直接调用 issue() 铸令牌，
      // 不重新测 `lab token` 的 TTY 门（那道门单独测，见 lab_cli.test.ts）。
      expect(
        (
          await fx.post(`/api/lab/experiments/${id}/approve`, {
            actor: "张三",
            approvalToken: issueApprovalToken(fx.project.paths.root, id).token,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fx.run(`/api/lab/experiments/${id}/simulate`, {
            actor: "张三",
            approvalToken: issueApprovalToken(fx.project.paths.root, id).token,
          })
        ).task.state,
      ).toBe("succeeded");

      const httpProject = fx.manager.open(fx.project.slug);
      const cliAgain = cli.manager.open("parity-wet");
      try {
        expect(graphShape(httpProject)).toEqual(graphShape(cliAgain));

        // 审批的实质内容也要一致：批的是哪个 hash、谁批的、evidence 是 inferred。
        const httpDecision = httpProject.records().list({ type: "decision" })[0]!;
        const cliDecision = cliAgain.records().list({ type: "decision" })[0]!;
        expect(httpDecision.metadata.decision).toBe(cliDecision.metadata.decision as string);
        expect(httpDecision.metadata.actor).toBe(cliDecision.metadata.actor as string);
        // protocolHash 两边**不该**相同：P6 把 protocolId 固定成 `wet-<record id>`，
        // 而 record id 是随机 UUID，所以 hash 标识的是「这一条实验的这一版脚本」。
        // 能对照的是「批的 hash 就是它自己实验当前的 hash」——approve gate 的实质。
        const httpExp = httpProject
          .records()
          .list({ type: "experiment" })
          .find((r) => (r.metadata as { mode?: string }).mode === "wet")!;
        const cliExp = cliAgain
          .records()
          .list({ type: "experiment" })
          .find((r) => (r.metadata as { mode?: string }).mode === "wet")!;
        expect(httpDecision.metadata.protocolHash).toBe(
          (httpExp.metadata as { protocolHash: string }).protocolHash,
        );
        expect(cliDecision.metadata.protocolHash).toBe(
          (cliExp.metadata as { protocolHash: string }).protocolHash,
        );
        expect(String(httpDecision.metadata.protocolHash)).toHaveLength(16);
        // 唯一**应该**不同的字段：署名来源。CLI 是命令行显式给的，HTTP 是网页请求给的。
        expect(cliDecision.metadata.actorSource).toBe("explicit");
        expect(httpDecision.metadata.actorSource).toBe("http:explicit");

        // 执行产出两边都是 observed（模拟硬件也标明来源）。
        const httpObs = httpProject.records().list({ type: "observation" })[0]!;
        const cliObs = cliAgain.records().list({ type: "observation" })[0]!;
        expect(httpObs.evidence).toBe("observed");
        expect(cliObs.evidence).toBe("observed");
        expect(httpObs.metadata.simulated).toBe(cliObs.metadata.simulated as boolean);
      } finally {
        httpProject.close();
        cliAgain.close();
      }
    } finally {
      await fx.stop();
    }
  });

  test("干实验 new → run：两边产出同形状的 artifact / observation", async () => {
    const cli = cliWorkspace("parity-dry");
    const deps = { manager: cli.manager, pollIntervalMs: 50, ...cli.sink };
    expect(
      await runExpCommand(
        ["new", "阻尼振子基线", "--param", "steps=200", "--param", "sampleInterval=20", "--json"],
        deps,
      ),
    ).toBe(0);
    const cliProject = cli.manager.open("parity-dry");
    const expId = cliProject.records().list({ type: "experiment" })[0]!.id;
    cliProject.close();
    expect(await runExpCommand(["run", expId], deps)).toBe(0);

    const fx = makeServer({ slug: "parity-dry" });
    try {
      const created = await fx.post<{ experiment: { id: string } }>("/api/experiments", {
        title: "阻尼振子基线",
        params: { steps: 200, sampleInterval: 20 },
      });
      const task = await fx.run(`/api/experiments/${created.body.experiment.id}/run`, { pollIntervalMs: 50 });
      expect(task.task.state).toBe("succeeded");

      const httpProject = fx.manager.open(fx.project.slug);
      const cliAgain = cli.manager.open("parity-dry");
      try {
        expect(graphShape(httpProject)).toEqual(graphShape(cliAgain));

        // 干实验的观察是算出来的，而且两边的摘要键完全一致（同一个 pyref 实现）。
        const httpObs = httpProject.records().list({ type: "observation" })[0]!;
        const cliObs = cliAgain.records().list({ type: "observation" })[0]!;
        expect(httpObs.evidence).toBe("computed");
        expect(Object.keys(httpObs.metadata.summary as object).sort()).toEqual(
          Object.keys(cliObs.metadata.summary as object).sort(),
        );
        // artifact 也真的落了盘，两边数量一致。
        expect(httpProject.artifacts().listByProjectSlug(httpProject.slug).length).toBe(
          cliAgain.artifacts().listByProjectSlug(cliAgain.slug).length,
        );
      } finally {
        httpProject.close();
        cliAgain.close();
      }
    } finally {
      await fx.stop();
    }
  });

  test("文献检索入库：两边落同样的 paper record 与 bibtex key", async () => {
    const cli = cliWorkspace("parity-lit");
    expect(
      await runLitCommand(
        ["search", SEARCH_QUERY, "--sources", SEARCH_SOURCES.join(","), "--limit", "10", "--add"],
        { manager: cli.manager, searcher: searcherWith(CASSETTES.search, "replay"), ...cli.sink },
      ),
    ).toBe(0);

    const fx = makeServer({ slug: "parity-lit", searcher: searcherWith(CASSETTES.search, "replay") });
    try {
      const task = await fx.run("/api/lit/search", {
        query: SEARCH_QUERY,
        sources: SEARCH_SOURCES,
        limit: 10,
        add: true,
      });
      expect(task.task.state).toBe("succeeded");

      const httpProject = fx.manager.open(fx.project.slug);
      const cliAgain = cli.manager.open("parity-lit");
      try {
        expect(graphShape(httpProject)).toEqual(graphShape(cliAgain));
        // 标题集合一致 —— bibtex key 由标题/作者/年份决定，标题一致 key 就一致。
        const titles = (project: Project) =>
          project
            .records()
            .list({ type: "paper" })
            .map((r) => r.title)
            .sort();
        expect(titles(httpProject)).toEqual(titles(cliAgain));
        expect(titles(httpProject).length).toBeGreaterThan(0);
      } finally {
        httpProject.close();
        cliAgain.close();
      }
    } finally {
      await fx.stop();
    }
  });

  // P8：结论评审在两侧落同样的 record 形状。
  // 唯一允许的差异是 `actorSource`——CLI 落 $USER 是诚实的（就是这个人敲的命令），
  // HTTP 必须显式传 actor 并记 `http:explicit`（AD-6 的 P7 补充 / BACKLOG V10）。
  test("结论评审：两边落同形状的 decision record，只有 actorSource 按设计不同", async () => {
    const seed = (project: Project): string => {
      const records = project.records();
      const obs = records.create({
        type: "observation",
        title: "观察",
        content: "# 观察\n\nn=30，衰减常数缩短 3.1 倍（p=0.002）。",
        evidence: "computed",
        metadata: { kind: "simulation_summary", runId: "r1", experimentId: "e1", deterministic: true },
      });
      return new ConclusionStore(records).create({ claim: "阻尼升高使衰减更快", evidenceIds: [obs.id] }).recordId;
    };

    const cli = cliWorkspace("parity-concl");
    const cliProject = cli.manager.open("parity-concl");
    const cliCardId = seed(cliProject);
    cliProject.close();
    expect(
      await runConclusionCommand(["review", cliCardId, "--actor", "张三"], { manager: cli.manager, ...cli.sink }),
    ).toBe(0);

    const fx = makeServer({ slug: "parity-concl" });
    try {
      const httpProject = fx.manager.open(fx.project.slug);
      const httpCardId = seed(httpProject);
      httpProject.close();
      const res = await fx.post<{ approved: boolean }>(`/api/conclusions/${httpCardId}/review`, { actor: "张三" });
      expect(res.body.approved).toBe(true);

      const httpAgain = fx.manager.open(fx.project.slug);
      const cliAgain = cli.manager.open("parity-concl");
      try {
        expect(graphShape(httpAgain)).toEqual(graphShape(cliAgain));
        const stamp = (project: Project) => {
          const card = new ConclusionStore(project.records()).get(
            project === cliAgain ? cliCardId : httpCardId,
          )!;
          return { state: card.review.state, actor: card.review.actor, hardCount: card.review.hardCount };
        };
        expect(stamp(httpAgain)).toEqual(stamp(cliAgain));
        const source = (project: Project, id: string) =>
          new ConclusionStore(project.records()).get(id)!.review.actorSource;
        expect(source(cliAgain, cliCardId)).toBe("explicit");
        expect(source(httpAgain, httpCardId)).toBe("http:explicit");
      } finally {
        httpAgain.close();
        cliAgain.close();
      }
    } finally {
      await fx.stop();
    }
  });

  // C5-②（v0.5 W5-1-c）：SMILES depict 的 CLI 与 HTTP 入口落同形状的 artifact record。
  // 不对照 SVG 内容本身（rdkit 渲染同一分子两次的坐标/id 属性未必逐字节相同），
  // 对照的是「落进证据图的东西一样」——类型、evidence、metadata.kind、分子式/canonical
  // SMILES，与 fingerprint() 的口径一致。
  test("SMILES depict：CLI 与 HTTP 两边落同形状的 artifact record", async () => {
    const cli = cliWorkspace("parity-chem");
    expect(await runChemCommand(["depict", "CCO", "--name", "ethanol"], { manager: cli.manager, ...cli.sink })).toBe(
      0,
    );

    const fx = makeServer({ slug: "parity-chem" });
    try {
      const res = await fx.post<{ result: { canonicalSmiles: string; formula: string; recordId: string } }>(
        "/api/chem/depict",
        { smiles: "CCO", name: "ethanol" },
      );
      expect(res.status).toBe(200);

      const httpProject = fx.manager.open(fx.project.slug);
      const cliProject = cli.manager.open("parity-chem");
      try {
        const httpRecord = httpProject.records().get(res.body.result.recordId)!;
        const cliRecord = cliProject.records().list({ type: "artifact" })[0]!;
        expect(fingerprint(httpRecord)).toEqual(fingerprint(cliRecord));
        expect((httpRecord.metadata as Record<string, unknown>).canonicalSmiles).toBe(
          (cliRecord.metadata as Record<string, unknown>).canonicalSmiles,
        );
        expect((httpRecord.metadata as Record<string, unknown>).formula).toBe(
          (cliRecord.metadata as Record<string, unknown>).formula,
        );
        // 两边都真的落了一份 image/svg+xml artifact。
        const httpArtifact = httpProject.artifacts().get(httpRecord.artifactId!);
        const cliArtifact = cliProject.artifacts().get(cliRecord.artifactId!);
        expect(httpArtifact?.contentType).toBe("image/svg+xml");
        expect(cliArtifact?.contentType).toBe("image/svg+xml");
      } finally {
        httpProject.close();
        cliProject.close();
      }
    } finally {
      await fx.stop();
    }
  });

  // ── W6-1 β：工作台四面板的 UI↔CLI 字段对照 ──────────────────────────────
  //
  // 这四条与上面几条略有不同：面板①③④对齐的后端出口（TaskRegistry / compute /
  // usage）本身就是 CLI 与 HTTP 共用的同一份实现代码，不是各自独立地把同一份数据
  // 写两份——所以这里验的是「CLI 出口与 HTTP 出口序列化出来的字段集合一致，且都
  // 覆盖前端 lib/types.ts 实际读取的字段」，而不是重新验证一遍数据本身对不对
  // （那些各自域的单测已经覆盖）。面板②复用既有的 record/graph 对照写法。

  test("面板①长任务：GET /api/tasks 与 CLI `lit tasks --json` 输出同形状的 TaskSnapshot", async () => {
    // 同一个 TaskRegistry 实例分别喂给 CLI dispatcher 与 HTTP 路由：验的是两条
    // 序列化路径（literature/cli.ts 的 `case "tasks"` 与 server/routes/session.ts 的
    // `taskRoutes`）都老实地把 registry.list() 原样交出去，没有偷偷加字段/丢字段。
    const registry = new TaskRegistry();
    const started = registry.start({
      kind: "lit.search",
      project: "parity-tasks",
      run: async (handle) => {
        handle.progress(1, 2, "检索中");
        return { added: 3 };
      },
    });
    await registry.settle(started.id);

    const cli = cliWorkspace("parity-tasks");
    const cliOut: string[] = [];
    expect(
      await runLitCommand(["tasks", "--json"], {
        manager: cli.manager,
        taskRegistry: registry,
        out: (l) => cliOut.push(l),
        err: cli.sink.err,
      }),
    ).toBe(0);
    const cliTasks = JSON.parse(cliOut.join("\n")) as Array<Record<string, unknown>>;
    expect(cliTasks.length).toBeGreaterThan(0);
    const cliFields = Object.keys(cliTasks[0]!).sort();

    const fx = makeServer({ slug: "parity-tasks", tasks: registry });
    try {
      const res = await fx.get<{ tasks: Array<Record<string, unknown>> }>("/api/tasks");
      expect(res.status).toBe(200);
      expect(res.body.tasks.length).toBeGreaterThan(0);
      const httpFields = Object.keys(res.body.tasks[0]!).sort();

      expect(httpFields).toEqual(cliFields);
      // frontend/workspace/src/lib/types.ts TaskSnapshot 与 TasksView 实际读取的字段：
      // 长任务面板消费 id/kind/state/progress/error/createdAt/finishedAt，一个都不能少。
      for (const field of ["id", "kind", "project", "state", "createdAt", "startedAt", "finishedAt", "progress", "result", "error", "events"]) {
        expect(httpFields).toContain(field);
      }
      expect(res.body.tasks[0]!.state).toBe("succeeded");
    } finally {
      await fx.stop();
    }
  });

  // 面板②（record/证据图浏览）已经由右栏时间线 + RecordDetail 覆盖，UI 本身
  // 无需新建；这里只补上 CLI `report show` 与 HTTP `/api/records/:id` 的字段对照——
  // 前端 RecordDetail 消费 record / outgoing / incoming 三个键（frontend/workspace/
  // src/lib/api.ts records.get 的返回类型），CLI 把同样的东西嵌在 edges.{outgoing,incoming} 里。
  test("面板②record 详情：CLI `report show --json` 与 HTTP `/api/records/:id` 落同形状的 record + 入边/出边", async () => {
    const seed = (project: Project): { rootId: string; edgeType: string } => {
      const records = project.records();
      const root = records.create({
        type: "observation",
        title: "面板②种子观察",
        content: "# 观察\n\n用于 record 详情面板的入边/出边对照。",
        evidence: "computed",
        metadata: { kind: "parity-seed" },
      });
      const child = records.create({
        type: "decision",
        title: "面板②种子决策",
        content: "# 决策\n\n引用上面的观察。",
        evidence: "inferred",
        metadata: { kind: "parity-seed-decision" },
      });
      records.link(child.id, root.id, "derives_from");
      return { rootId: root.id, edgeType: "derives_from" };
    };

    const cli = cliWorkspace("parity-records");
    const cliProject = cli.manager.open("parity-records");
    const cliSeed = seed(cliProject);
    cliProject.close();
    const cliOut: string[] = [];
    expect(
      await runReportCommand(["show", cliSeed.rootId, "--json"], {
        manager: cli.manager,
        out: (l) => cliOut.push(l),
        err: cli.sink.err,
      }),
    ).toBe(0);
    const cliShown = JSON.parse(cliOut.join("\n")) as {
      record: ResearchRecord;
      edges: { outgoing: Array<{ sourceId: string; targetId: string; type: string }>; incoming: Array<{ sourceId: string; targetId: string; type: string }> };
    };

    const fx = makeServer({ slug: "parity-records" });
    try {
      const httpProject = fx.manager.open(fx.project.slug);
      const httpSeed = seed(httpProject);
      httpProject.close();
      const res = await fx.get<{
        record: ResearchRecord;
        outgoing: Array<{ sourceId: string; targetId: string; type: string }>;
        incoming: Array<{ sourceId: string; targetId: string; type: string }>;
        artifact: unknown;
      }>(`/api/records/${httpSeed.rootId}`);
      expect(res.status).toBe(200);

      // UI 消费的字段（RecordDetail / GraphView）：record 的类型/证据/标题/正文/
      // 来源/metadata/时间戳，加上入边/出边数组——两边字段集合必须一致。
      expect(Object.keys(res.body).sort()).toEqual(["project", "record", "outgoing", "incoming", "artifact"].sort());
      expect(Object.keys(cliShown).sort()).toEqual(["record", "edges"].sort());
      expect(Object.keys(res.body.record).sort()).toEqual(Object.keys(cliShown.record).sort());

      // 两边都是「root 没有出边（它没引用别人），有一条 derives_from 入边（决策引用了它）」。
      expect(res.body.outgoing.length).toBe(0);
      expect(cliShown.edges.outgoing.length).toBe(0);
      expect(res.body.incoming.length).toBe(1);
      expect(cliShown.edges.incoming.length).toBe(1);
      expect(res.body.incoming[0]!.type).toBe(cliSeed.edgeType);
      expect(cliShown.edges.incoming[0]!.type).toBe(cliSeed.edgeType);
      expect(Object.keys(res.body.incoming[0]!).sort()).toEqual(Object.keys(cliShown.edges.incoming[0]!).sort());
    } finally {
      await fx.stop();
    }
  });

  test("面板③算力：CLI `compute plan --json` 与 HTTP `POST /api/compute/jobs` 落同形状的 job（HTTP 只多一个 next 字段）", async () => {
    const cliRoot = mkdtempSync(join(tmpdir(), "spark-parity-compute-cli-"));
    const cliManager = new ProjectManager(cliRoot);
    cliManager.create("parity-compute", { name: "对照项目", description: "" }).close();
    cliManager.setCurrent("parity-compute");
    const cliOut: string[] = [];
    expect(
      await runComputeCommand(["plan", "--purpose", "对照用途", "--json", "--", "echo", "hi"], {
        manager: cliManager,
        root: cliRoot,
        out: (l) => cliOut.push(l),
        err: () => {},
      }),
    ).toBe(0);
    const cliPlan = JSON.parse(cliOut.join("\n")) as { job: Record<string, unknown> };
    const cliFields = Object.keys(cliPlan.job).sort();

    const fx = makeServer({ slug: "parity-compute" });
    try {
      const res = await fx.post<{ job: Record<string, unknown> }>("/api/compute/jobs", {
        purpose: "对照用途",
        command: ["echo", "hi"],
      });
      expect(res.status).toBe(201);
      const httpFields = Object.keys(res.body.job).sort();

      // V47 裁定的唯一预期差异：HTTP 视图（server/routes/compute.ts 的 view()）多包一个
      // `next` 字段（给 UI/调用方看下一步该敲哪条 CLI 命令）——除此之外必须逐字段一致，
      // 尤其是 ComputeView 实际消费的 plan.purpose / target.kind / lifecycle.* /
      // plan.command / plan.resources / plan.estimate。
      expect(httpFields).toEqual([...cliFields, "next"].sort());
      for (const field of ["jobId", "projectSlug", "target", "lifecycle", "plan", "approval", "rejection", "actualCostUsd", "exitCode", "message", "createdAt"]) {
        expect(cliFields).toContain(field);
      }
      // local 执行地 + network=none + 无 secretRefs → 不计费也不需要网络/凭据，
      // derivedApprovalRequired() 判 false，plan() 之后停在 planned（不是
      // awaiting_approval——那是需要人工审批的 plan 才会落到的状态）。
      expect((res.body.job.lifecycle as { execution: string }).execution).toBe("planned");
    } finally {
      await fx.stop();
    }
  });

  test("面板④用量：CLI `usage --json` / `usage api --json` 与 HTTP `/api/usage`、`/api/usage/api` 算出同样的数字", async () => {
    // 两边各自的项目/根目录种同一批 usage.jsonl / api_calls.jsonl 行——不是共享同一份
    // 文件，而是照既有对照测试的惯例分别喂相同输入，验证 UsageStore.totals() /
    // ApiCallStore.totals() 这套唯一的聚合实现在两条入口上算出同一个数字
    // （DEVELOPMENT_PLAN_v0.6.md §W6-1 lane β 纪律：不许两处各自算一遍）。
    const seedUsage = (root: string, projectRoot: string) => {
      const store = new UsageStore(join(projectRoot, "usage.jsonl"));
      store.append({ ts: "2026-09-11T00:00:00.000Z", command: "lit-read", provider: "openrouter", model: "z-ai/glm-5.3-flash", ok: true, inputTokens: 1000, outputTokens: 200, costUsd: 0.01 });
      store.append({ ts: "2026-09-11T00:01:00.000Z", command: "lit-review", provider: "openrouter", model: "z-ai/glm-5.3-flash", ok: true, inputTokens: 500, outputTokens: 100, costUsd: null });
    };
    const seedApi = (root: string) => {
      const store = new ApiCallStore(apiCallStorePath({ root }));
      store.append({ ts: "2026-09-11T00:00:00.000Z", connector: "aminer", host: "aminer.org", status: 200, latencyMs: 120, rateLimitWaitMs: 0 });
      store.append({ ts: "2026-09-11T00:00:01.000Z", connector: "aminer", host: "aminer.org", status: 429, latencyMs: 300, rateLimitWaitMs: 0 });
    };

    const cliRoot = mkdtempSync(join(tmpdir(), "spark-parity-usage-cli-"));
    const cliManager = new ProjectManager(cliRoot);
    const cliProject = cliManager.create("parity-usage", { name: "对照项目", description: "" });
    seedUsage(cliRoot, cliProject.paths.root);
    cliProject.close();
    seedApi(cliRoot);

    const cliUsageOut: string[] = [];
    expect(await runUsageCommand(["--project", "parity-usage", "--json"], { manager: cliManager, out: (l) => cliUsageOut.push(l) })).toBe(0);
    const cliUsage = JSON.parse(cliUsageOut.join("\n")) as { calls: number; knownCostUsd: number; unknownCostCalls: number };

    const cliApiOut: string[] = [];
    expect(runUsageApiCommand(true, { root: cliRoot, out: (l) => cliApiOut.push(l) })).toBe(0);
    const cliApi = JSON.parse(cliApiOut.join("\n")) as { calls: number; count429: number; count401: number };

    const fx = makeServer({ slug: "parity-usage" });
    try {
      seedUsage(fx.root, fx.project.paths.root);
      seedApi(fx.root);

      const usageRes = await fx.get<{ calls: number; knownCostUsd: number; unknownCostCalls: number; corruptLines: number }>(
        "/api/usage?project=parity-usage",
      );
      expect(usageRes.status).toBe(200);
      // 已知花费下界与未知调用数：两条入口对同一批输入必须算出一模一样的数字。
      expect(usageRes.body.calls).toBe(cliUsage.calls);
      expect(usageRes.body.knownCostUsd).toBeCloseTo(cliUsage.knownCostUsd, 6);
      expect(usageRes.body.unknownCostCalls).toBe(cliUsage.unknownCostCalls);
      // 口径断言：这批种子数据里有一条 costUsd=null 的调用——未知成本必须被算作「未知」，
      // 不能被悄悄当成 0（UsageView 的示警文案正是靠这个数字判断要不要出现）。
      expect(usageRes.body.unknownCostCalls).toBeGreaterThan(0);

      const apiRes = await fx.get<{ calls: number; count429: number; count401: number }>("/api/usage/api");
      expect(apiRes.status).toBe(200);
      expect(apiRes.body.calls).toBe(cliApi.calls);
      expect(apiRes.body.count429).toBe(cliApi.count429);
      expect(apiRes.body.count401).toBe(cliApi.count401);
      // connector 健康度面板消费的 429 列：这批种子数据必须真的看到 429×1。
      expect(apiRes.body.count429).toBe(1);
    } finally {
      await fx.stop();
    }
  });
});
