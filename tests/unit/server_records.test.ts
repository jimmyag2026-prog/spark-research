import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordEdge, ResearchRecord } from "../../backend/src/project/models";
import { makeServer } from "../helpers/server_scenario";

// P7 · Research Record 时间线与证据子图（DESIGN 域 C2）。

interface Seeded {
  idea: string;
  paper: string;
  experiment: string;
  observation: string;
  conclusion: string;
  artifactRecord: string;
  artifactId: string;
}

function seedGraph(fx: ReturnType<typeof makeServer>): Seeded {
  const project = fx.manager.open(fx.project.slug);
  const records = project.records();
  const paper = records.create({
    type: "paper",
    title: "AlphaFold",
    content: "论文锚点",
    evidence: "sourced",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const idea = records.create({
    type: "idea",
    title: "用扩散模型做侧链",
    content: "假设",
    evidence: "inferred",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  const experiment = records.create({
    type: "experiment",
    title: "阻尼振子",
    content: "实验",
    evidence: "inferred",
    metadata: { mode: "dry", state: "analyze" },
    createdAt: "2026-01-03T00:00:00.000Z",
  });
  const csvPath = join(project.paths.artifactsDir, "energy.csv");
  writeFileSync(csvPath, "t,e\n0,1\n");
  const saved = project.artifacts().save(
    csvPath,
    "# 干实验产出",
    [{ kind: "write", file: "energy.csv", role: "tool", content: "能量曲线" }],
    { sessionId: "s1", cellIndex: 1 },
    project.slug,
  );
  const artifactRecord = records.createFromArtifact(saved, {
    title: "energy.csv",
    content: "能量曲线",
    metadata: { kind: "dry_run_output" },
  });
  const observation = records.create({
    type: "observation",
    title: "能量单调衰减",
    content: "观察",
    evidence: "computed",
    origin: { kind: "cell", sessionId: "s1", ref: "run-1" },
    createdAt: "2026-01-04T00:00:00.000Z",
  });
  const conclusion = records.create({
    type: "conclusion",
    title: "结论卡",
    content: "阻尼有效",
    evidence: "inferred",
    createdAt: "2026-01-05T00:00:00.000Z",
  });
  records.link(idea.id, paper.id, "cites");
  records.link(paper.id, idea.id, "supports");
  records.link(artifactRecord.id, experiment.id, "derives_from");
  records.link(observation.id, experiment.id, "derives_from");
  records.link(observation.id, artifactRecord.id, "derives_from");
  records.link(conclusion.id, observation.id, "derives_from");
  project.close();
  return {
    idea: idea.id,
    paper: paper.id,
    experiment: experiment.id,
    observation: observation.id,
    conclusion: conclusion.id,
    artifactRecord: artifactRecord.id,
    artifactId: saved.id,
  };
}

describe("HTTP · records 时间线", () => {
  test("GET /api/records 按时间返回并给出 total", async () => {
    const fx = makeServer();
    try {
      seedGraph(fx);
      const { status, body } = await fx.get<{
        records: ResearchRecord[];
        total: number;
        types: string[];
        project: string;
      }>("/api/records");
      expect(status).toBe(200);
      expect(body.total).toBe(6);
      expect(body.records).toHaveLength(6);
      expect(body.records[0]!.type).toBe("paper");
      expect(body.types.sort()).toEqual(
        ["artifact", "conclusion", "experiment", "idea", "observation", "paper"].sort(),
      );
    } finally {
      await fx.stop();
    }
  });

  test("type 过滤支持多类型逗号分隔；未知类型 → 400", async () => {
    const fx = makeServer();
    try {
      seedGraph(fx);
      const { body } = await fx.get<{ records: ResearchRecord[]; total: number }>(
        "/api/records?type=idea,conclusion",
      );
      expect(body.total).toBe(2);
      expect(body.records.map((r) => r.type).sort()).toEqual(["conclusion", "idea"]);
      expect((await fx.get("/api/records?type=nope")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("since / until 时间窗过滤", async () => {
    const fx = makeServer();
    try {
      seedGraph(fx);
      const { body } = await fx.get<{ total: number; records: ResearchRecord[] }>(
        "/api/records?since=2026-01-04T00:00:00.000Z",
      );
      // artifact record 用当前时间创建，所以时间窗 ≥ 01-04 会带上它。
      expect(body.records.map((r) => r.type)).toContain("observation");
      expect(body.records.map((r) => r.type)).not.toContain("paper");
      const until = await fx.get<{ total: number }>("/api/records?until=2026-01-02T00:00:00.000Z");
      expect(until.body.total).toBe(2);
    } finally {
      await fx.stop();
    }
  });

  test("limit / offset 分页时 total 保持不变", async () => {
    const fx = makeServer();
    try {
      seedGraph(fx);
      const first = await fx.get<{ records: ResearchRecord[]; total: number; offset: number }>(
        "/api/records?limit=2",
      );
      const second = await fx.get<{ records: ResearchRecord[]; total: number; offset: number }>(
        "/api/records?limit=2&offset=2",
      );
      expect(first.body.total).toBe(6);
      expect(second.body.total).toBe(6);
      expect(second.body.offset).toBe(2);
      expect(first.body.records.map((r) => r.id)).not.toEqual(second.body.records.map((r) => r.id));
      expect((await fx.get("/api/records?limit=0")).status).toBe(400);
      expect((await fx.get("/api/records?offset=-1")).status).toBe(400);
      expect((await fx.get("/api/records?limit=abc")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("evidence 与 session 过滤", async () => {
    const fx = makeServer();
    try {
      seedGraph(fx);
      const computed = await fx.get<{ total: number }>("/api/records?evidence=computed");
      expect(computed.body.total).toBe(2); // observation + artifact record
      const session = await fx.get<{ total: number }>("/api/records?session=s1");
      expect(session.body.total).toBe(2);
      expect((await fx.get("/api/records?evidence=nope")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/records/meta 给出可用类型与证据标签", async () => {
    const fx = makeServer();
    try {
      const { body } = await fx.get<{ types: string[]; evidence: string[] }>("/api/records/meta");
      expect(body.types).toContain("reading");
      expect(body.evidence).toEqual(["observed", "sourced", "computed", "inferred"]);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/records/:id 带进出边；artifact record 附产物内容（AD-3）", async () => {
    const fx = makeServer();
    try {
      const seeded = seedGraph(fx);
      const { status, body } = await fx.get<{
        record: ResearchRecord;
        outgoing: RecordEdge[];
        incoming: RecordEdge[];
        artifact: { content: string; filename: string } | null;
      }>(`/api/records/${seeded.artifactRecord}`);
      expect(status).toBe(200);
      expect(body.record.type).toBe("artifact");
      expect(body.outgoing.map((e) => e.targetId)).toContain(seeded.experiment);
      expect(body.incoming.map((e) => e.sourceId)).toContain(seeded.observation);
      expect(body.artifact?.filename).toBe("energy.csv");
      expect(body.artifact?.content).toContain("t,e");
      expect((await fx.get("/api/records/missing")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/records/:id/graph 双向展开证据子图", async () => {
    const fx = makeServer();
    try {
      const seeded = seedGraph(fx);
      const { status, body } = await fx.get<{ nodes: ResearchRecord[]; edges: RecordEdge[]; depth: number }>(
        `/api/records/${seeded.conclusion}/graph?depth=3`,
      );
      expect(status).toBe(200);
      expect(body.depth).toBe(3);
      const ids = body.nodes.map((n) => n.id);
      expect(ids).toContain(seeded.observation);
      expect(ids).toContain(seeded.experiment);
      expect(ids).toContain(seeded.artifactRecord);
      expect(body.edges.length).toBeGreaterThanOrEqual(4);
      expect((await fx.get(`/api/records/${seeded.conclusion}/graph?depth=9`)).status).toBe(400);
      expect((await fx.get("/api/records/missing/graph")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/artifacts 列本项目产物；version/:id 取内容与 lineage", async () => {
    const fx = makeServer();
    try {
      const seeded = seedGraph(fx);
      const list = await fx.get<{ artifacts: Array<{ id: string }> }>("/api/artifacts");
      expect(list.body.artifacts.map((a) => a.id)).toContain(seeded.artifactId);
      const bySession = await fx.get<{ artifacts: Array<{ id: string }> }>("/api/artifacts?session=s1");
      expect(bySession.body.artifacts).toHaveLength(1);
      const one = await fx.get<{ artifact: { content: string } }>(
        `/api/artifacts/version/${seeded.artifactId}`,
      );
      expect(one.body.artifact.content).toContain("t,e");
      const lineage = await fx.get<{ graph: { nodes: unknown[] } }>(
        `/api/artifacts/version/${seeded.artifactId}/lineage`,
      );
      expect(Array.isArray(lineage.body.graph.nodes)).toBe(true);
      expect((await fx.get("/api/artifacts/version/missing")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });
});
