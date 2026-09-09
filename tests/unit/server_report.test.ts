import { describe, expect, test } from "bun:test";
import { ConclusionReviewer } from "../../backend/src/conclusion/reviewer";
import { ConclusionStore } from "../../backend/src/conclusion/store";
import type { ConclusionCard } from "../../backend/src/conclusion/models";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";

// P8-gate G1/G7 的 HTTP 投影：结论卡端点 + 报告导出端点。
//
// 与 CLI 对照的关键一条（AD-6 / BACKLOG V10）：**HTTP 层的 actor 没有 env 兜底**。
// 缺 actor 直接 400，落库的 actorSource 是 `http:explicit`。

function seed(fx: ServerFixture, options: { review?: boolean; broken?: boolean } = {}): string {
  const project = fx.manager.open(fx.project.slug);
  const records = project.records();
  const obs = records.create({
    type: "observation",
    title: "观察",
    content: "# 观察\n\nn=30，衰减常数缩短 3.1 倍（p=0.002）。",
    evidence: "computed",
    metadata: { kind: "simulation_summary", runId: "r1", experimentId: "e1", deterministic: true },
  });
  const store = new ConclusionStore(records);
  const card = store.create({
    claim: "阻尼系数升高使能量衰减更快",
    limitations: "只测了一组初始条件",
    evidenceIds: [options.broken ? "ghost-record" : obs.id],
  });
  if (options.review) new ConclusionReviewer(records, { store }).review(card, { actor: "张三" });
  project.close();
  return card.recordId;
}

describe("GET /api/conclusions", () => {
  test("列出结论卡并可按 review 状态过滤", async () => {
    const fx = makeServer({ slug: "concl" });
    try {
      seed(fx, { review: true });
      seed(fx);
      const all = await fx.get<{ conclusions: ConclusionCard[]; total: number }>("/api/conclusions");
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(2);

      const approved = await fx.get<{ conclusions: ConclusionCard[] }>("/api/conclusions?review=approved");
      expect(approved.body.conclusions).toHaveLength(1);
      expect(approved.body.conclusions[0]!.review.state).toBe("approved");

      const bad = await fx.get("/api/conclusions?review=banana");
      expect(bad.status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("详情附带不落库的评估结果（含证据能力位）", async () => {
    const fx = makeServer({ slug: "concl-detail" });
    try {
      const id = seed(fx);
      const res = await fx.get<{
        conclusion: ConclusionCard;
        assessment: { wouldApprove: boolean; reconciliation: string; evidence: { deterministic: boolean | null }[] };
      }>(`/api/conclusions/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.conclusion.review.state).toBe("pending");
      expect(res.body.assessment.wouldApprove).toBe(true);
      expect(res.body.assessment.reconciliation).toBe("bitwise");
      expect(res.body.assessment.evidence[0]!.deterministic).toBe(true);

      // 评估不写库：状态仍然是 pending。
      const again = await fx.get<{ conclusion: ConclusionCard }>(`/api/conclusions/${id}`);
      expect(again.body.conclusion.review.state).toBe("pending");
    } finally {
      await fx.stop();
    }
  });

  test("不存在的结论卡 404", async () => {
    const fx = makeServer({ slug: "concl-404" });
    try {
      expect((await fx.get("/api/conclusions/nope")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });
});

describe("POST /api/conclusions/:id/review", () => {
  test("缺 actor → 400（HTTP 层不接受环境变量兜底）", async () => {
    const fx = makeServer({ slug: "concl-actor" });
    try {
      const id = seed(fx);
      const res = await fx.post<{ error: string }>(`/api/conclusions/${id}/review`, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("actor");
    } finally {
      await fx.stop();
    }
  });

  test("带 actor → approved，actorSource 记 http:explicit", async () => {
    const fx = makeServer({ slug: "concl-ok" });
    try {
      const id = seed(fx);
      const res = await fx.post<{ approved: boolean; conclusion: ConclusionCard }>(
        `/api/conclusions/${id}/review`,
        { actor: "张三" },
      );
      expect(res.status).toBe(200);
      expect(res.body.approved).toBe(true);
      expect(res.body.conclusion.review.state).toBe("approved");
      expect(res.body.conclusion.review.actorSource).toBe("http:explicit");
    } finally {
      await fx.stop();
    }
  });

  test("hard finding → vetoed（HTTP 仍是 200：这是一个有意义的结果，不是请求失败）", async () => {
    const fx = makeServer({ slug: "concl-veto" });
    try {
      const id = seed(fx, { broken: true });
      const res = await fx.post<{ approved: boolean; conclusion: ConclusionCard; findings: { rule: string }[] }>(
        `/api/conclusions/${id}/review`,
        { actor: "张三" },
      );
      expect(res.status).toBe(200);
      expect(res.body.approved).toBe(false);
      expect(res.body.conclusion.review.state).toBe("vetoed");
      expect(res.body.findings.some((f) => f.rule === "data-consistency")).toBe(true);
    } finally {
      await fx.stop();
    }
  });

  test("人工否决要理由：空字符串 veto 等于没传（照常跑检查器）", async () => {
    const fx = makeServer({ slug: "concl-veto-empty" });
    try {
      const id = seed(fx);
      const res = await fx.post<{ approved: boolean }>(`/api/conclusions/${id}/review`, { actor: "张三", veto: "" });
      expect(res.status).toBe(200);
      expect(res.body.approved).toBe(true);
    } finally {
      await fx.stop();
    }
  });
});

describe("GET /api/report", () => {
  test("JSON 信封带 counts 与 markdown", async () => {
    const fx = makeServer({ slug: "rep" });
    try {
      seed(fx, { review: true });
      const res = await fx.get<{ markdown: string; counts: { approvedConclusions: number }; recordIds: string[] }>(
        "/api/report",
      );
      expect(res.status).toBe(200);
      expect(res.body.markdown).toContain("# 研究报告");
      expect(res.body.counts.approvedConclusions).toBe(1);
      expect(res.body.recordIds.length).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  });

  test("format=markdown 返回 text/markdown + 下载文件名", async () => {
    const fx = makeServer({ slug: "rep-md" });
    try {
      seed(fx, { review: true });
      const res = await fetch(`${fx.base}/api/report?format=markdown`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(res.headers.get("content-disposition")).toContain("rep-md-report.md");
      expect(await res.text()).toContain("## 四、结论");
    } finally {
      await fx.stop();
    }
  });

  test("未知 format → 400", async () => {
    const fx = makeServer({ slug: "rep-bad" });
    try {
      expect((await fx.get("/api/report?format=pdf")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });
});
