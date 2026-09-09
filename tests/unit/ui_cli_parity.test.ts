import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExpCommand } from "../../backend/src/experiment/cli";
import { runLabCommand } from "../../backend/src/lab/cli";
import { runLitCommand } from "../../backend/src/literature/cli";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import type { ResearchRecord } from "../../backend/src/project/models";
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
    const deps = { manager: cli.manager, backend: new MockDeviceBackend(), actor: "张三", ...cli.sink };
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
      expect((await fx.post(`/api/lab/experiments/${id}/approve`, { actor: "张三" })).status).toBe(200);
      expect((await fx.run(`/api/lab/experiments/${id}/simulate`)).task.state).toBe("succeeded");

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
});
