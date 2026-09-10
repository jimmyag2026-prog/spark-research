import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CITATION_INTEGRITY_REVIEW_KIND,
  NoProgressGuard,
  RecordStoreEvidenceQuery,
  ResearchContract,
  createLiteratureReviewContract,
  describeStop,
  evaluateRound,
  type ContractStage,
  type EvidenceQuery,
  type EvidenceSnapshot,
} from "../../backend/src/agents/contract";
import { CITATION_RULE } from "../../backend/src/reviewer/rules";
import { RecordStore } from "../../backend/src/project/records";

// v0.4 P13 波次 W2-b：Research Contract（AD-10：完成判定问图不问模型）。
// 见 backend/src/agents/contract.ts 顶部注释与 docs/devlog/W2-b.md。

const dirs: string[] = [];
function tempRoot(prefix = "spark-contract-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function store(): RecordStore {
  return new RecordStore(join(tempRoot(), "records.db"), "demo");
}

function addPaper(s: RecordStore, title: string) {
  return s.create({ type: "paper", title, content: title, evidence: "sourced" });
}

function addReading(s: RecordStore, paperId: string, title: string) {
  const r = s.create({ type: "reading", title, content: title, evidence: "sourced" });
  s.link(r.id, paperId, "cites");
  return r;
}

function addCitationReview(
  s: RecordStore,
  opts: { targetRecordId: string; hardFindingCount: number; softFindingCount?: number; createdAt?: string },
) {
  return s.create({
    type: "observation",
    title: "citation-integrity 核验",
    content: `hard=${opts.hardFindingCount}`,
    evidence: "computed",
    createdAt: opts.createdAt,
    metadata: {
      kind: CITATION_INTEGRITY_REVIEW_KIND,
      checker: CITATION_RULE,
      targetRecordId: opts.targetRecordId,
      hardFindingCount: opts.hardFindingCount,
      softFindingCount: opts.softFindingCount ?? 0,
    },
  });
}

// ── EvidenceQuery / RecordStoreEvidenceQuery ─────────────────────────────────

describe("RecordStoreEvidenceQuery", () => {
  test("snapshot() 是当前全部 record id 的集合", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    expect(q.snapshot().recordIds.size).toBe(0);
    const p = addPaper(s, "A");
    const snap = q.snapshot();
    expect(snap.recordIds.has(p.id)).toBe(true);
    expect(snap.recordIds.size).toBe(1);
  });

  test("newSince() 按 id 集合差，不按时间戳", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const baseline = q.snapshot();
    const p1 = addPaper(s, "A");
    const p2 = addPaper(s, "B");
    const fresh = q.newSince(baseline, "paper");
    expect(fresh.map((r) => r.id).sort()).toEqual([p1.id, p2.id].sort());
    // 不传 type 时也一样按集合差工作，覆盖所有 record 类型。
    const anyFresh = q.newSince(baseline);
    expect(anyFresh.length).toBe(2);
  });

  test("listByType() 支持在 metadata 上叠加谓词", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    addCitationReview(s, { targetRecordId: "x", hardFindingCount: 1 });
    addCitationReview(s, { targetRecordId: "y", hardFindingCount: 0 });
    s.create({ type: "observation", title: "别的观察", content: "noise", evidence: "observed" });
    const reviews = q.listByType(
      "observation",
      (r) => (r.metadata as { kind?: string }).kind === CITATION_INTEGRITY_REVIEW_KIND,
    );
    expect(reviews.length).toBe(2);
  });

  test("incoming()/outgoing() 按边类型过滤，并映射回对端 record", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const paper = addPaper(s, "A");
    const reading = addReading(s, paper.id, "卡片 A");
    expect(q.incoming(paper.id, "cites").map((r) => r.id)).toEqual([reading.id]);
    expect(q.incoming(paper.id, "derives_from")).toEqual([]);
    expect(q.outgoing(reading.id, "cites").map((r) => r.id)).toEqual([paper.id]);
  });
});

// ── ResearchContract 容器本身 ──────────────────────────────────────────────────

describe("ResearchContract", () => {
  test("构造时校验：至少一个 stage，stage id 不许重复", () => {
    expect(() => new ResearchContract("empty", [])).toThrow();
    const dup: ContractStage = { id: "a", description: "x", check: () => ({ done: true, evidence: [], reason: "" }) };
    expect(() => new ResearchContract("dup", [dup, dup])).toThrow();
  });

  test("evaluate()：全部 stage done → allDone=true，summary 说人话列出证据", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const alwaysDone: ContractStage = {
      id: "a",
      description: "总是完成",
      check: () => ({ done: true, evidence: ["rec-1"], reason: "占位" }),
    };
    const contract = new ResearchContract("toy", [alwaysDone]);
    const report = contract.evaluate(q);
    expect(report.allDone).toBe(true);
    expect(report.incomplete).toEqual([]);
    expect(contract.allDone(q)).toBe(true);
    expect(report.summary).toContain("已完成");
    expect(report.summary).toContain("a");
  });

  test("evaluate()：有 stage 未完成 → allDone=false，summary 列出每个未完成 stage 的具体原因", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const neverDone: ContractStage = {
      id: "b",
      description: "永远缺证据",
      check: () => ({ done: false, evidence: [], reason: "缺 X 类型的 record" }),
    };
    const contract = new ResearchContract("toy2", [neverDone]);
    const report = contract.evaluate(q);
    expect(report.allDone).toBe(false);
    expect(report.incomplete.map((s) => s.id)).toEqual(["b"]);
    // 不是一句「未完成」——必须能看到具体缺什么。
    expect(report.summary).toContain("缺 X 类型的 record");
    expect(report.summary).toContain("b");
  });
});

// ── literature-review：三个 stage 的具体判据 ────────────────────────────────────

describe("literature-review 契约", () => {
  test("契约形状：3 个 stage，id 与方案表一致", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);
    expect(contract.id).toBe("literature-review");
    expect(contract.stages.map((st) => st.id)).toEqual(["searched", "read_cards", "citations_verified"]);
  });

  test("searched：空图未完成；新增 paper record 后完成，evidence 精确列出新增的 paper id", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q); // baseline = 此刻（空图）
    let report = contract.evaluate(q);
    const searched1 = report.stages.find((st) => st.id === "searched")!;
    expect(searched1.done).toBe(false);
    expect(searched1.evidence).toEqual([]);

    const p = addPaper(s, "Attention Is All You Need");
    report = contract.evaluate(q);
    const searched2 = report.stages.find((st) => st.id === "searched")!;
    expect(searched2.done).toBe(true);
    expect(searched2.evidence).toEqual([p.id]);
  });

  test("searched：契约创建之前就存在的 paper 不算「本 session 新增」", () => {
    const s = store();
    addPaper(s, "上一轮就有的论文"); // baseline 之前
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q); // baseline 在这篇论文之后拍下
    const report = contract.evaluate(q);
    const searched = report.stages.find((st) => st.id === "searched")!;
    expect(searched.done).toBe(false);
  });

  test("read_cards：没有 paper 时未完成；部分覆盖未完成；全覆盖后完成，evidence 是 reading record id", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);

    let report = contract.evaluate(q);
    expect(report.stages.find((st) => st.id === "read_cards")!.done).toBe(false);

    const p1 = addPaper(s, "A");
    const p2 = addPaper(s, "B");
    report = contract.evaluate(q);
    const zeroCovered = report.stages.find((st) => st.id === "read_cards")!;
    expect(zeroCovered.done).toBe(false);
    expect(zeroCovered.reason).toContain("2/2");

    const r1 = addReading(s, p1.id, "卡片 A");
    report = contract.evaluate(q);
    const partial = report.stages.find((st) => st.id === "read_cards")!;
    expect(partial.done).toBe(false);
    expect(partial.reason).toContain("1/2");

    const r2 = addReading(s, p2.id, "卡片 B");
    report = contract.evaluate(q);
    const full = report.stages.find((st) => st.id === "read_cards")!;
    expect(full.done).toBe(true);
    expect(full.evidence.sort()).toEqual([r1.id, r2.id].sort());
  });

  test("citations_verified：无 review 记录未完成；有 hard finding 未完成；零 hard finding 完成", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);
    const draft = s.create({ type: "artifact", title: "草稿", content: "x", evidence: "inferred", artifactId: "art-1" });

    let report = contract.evaluate(q);
    expect(report.stages.find((st) => st.id === "citations_verified")!.done).toBe(false);

    addCitationReview(s, { targetRecordId: draft.id, hardFindingCount: 2, createdAt: "2024-01-01T00:00:00.000Z" });
    report = contract.evaluate(q);
    const stillBad = report.stages.find((st) => st.id === "citations_verified")!;
    expect(stillBad.done).toBe(false);
    expect(stillBad.reason).toContain("2 条 hard finding");

    const good = addCitationReview(s, {
      targetRecordId: draft.id,
      hardFindingCount: 0,
      createdAt: "2024-01-02T00:00:00.000Z",
    });
    report = contract.evaluate(q);
    const fixed = report.stages.find((st) => st.id === "citations_verified")!;
    expect(fixed.done).toBe(true);
    expect(fixed.evidence).toEqual([good.id]);
  });

  test("citations_verified：判据取最近一次核验（先坏后好 → 完成；先好后坏 → 未完成）", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);
    addCitationReview(s, { targetRecordId: "d", hardFindingCount: 0, createdAt: "2024-01-01T00:00:00.000Z" });
    addCitationReview(s, { targetRecordId: "d", hardFindingCount: 3, createdAt: "2024-01-02T00:00:00.000Z" });
    const report = contract.evaluate(q);
    // 最近一次是坏的：即使更早一次是好的，也不该判完成——「最近状态」才是当下真相。
    expect(report.stages.find((st) => st.id === "citations_verified")!.done).toBe(false);
  });

  test("全部三个 stage 齐了 → allDone()=true", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);
    const paper = addPaper(s, "A");
    const draft = s.create({ type: "artifact", title: "草稿", content: "x", evidence: "inferred", artifactId: "art-1" });
    addReading(s, paper.id, "卡片 A");
    addCitationReview(s, { targetRecordId: draft.id, hardFindingCount: 0 });
    expect(contract.allDone(q)).toBe(true);
  });
});

// ── NoProgressGuard：三条停机条件之二，确定性判据 ───────────────────────────────

describe("NoProgressGuard", () => {
  function snap(ids: string[]): EvidenceSnapshot {
    return { recordIds: new Set(ids) };
  }

  test("threshold 非法时构造应抛错", () => {
    expect(() => new NoProgressGuard(snap([]), 0)).toThrow();
    expect(() => new NoProgressGuard(snap([]), 1.5)).toThrow();
  });

  test("连续无新增 → streak 递增，达到阈值才 triggered；中途有新增则归零重计", () => {
    const guard = new NoProgressGuard(snap(["a"]), 2);
    const t1 = guard.tick(snap(["a"])); // 无新增
    expect(t1).toEqual({ streak: 1, triggered: false, addedRecordCount: 0, addedRecordIds: [] });

    const t2 = guard.tick(snap(["a", "b"])); // 新增 b，归零
    expect(t2.streak).toBe(0);
    expect(t2.triggered).toBe(false);
    expect(t2.addedRecordIds).toEqual(["b"]);

    const t3 = guard.tick(snap(["a", "b"])); // 无新增，streak=1
    expect(t3.streak).toBe(1);
    expect(t3.triggered).toBe(false);

    const t4 = guard.tick(snap(["a", "b"])); // 无新增，streak=2，达到阈值
    expect(t4.streak).toBe(2);
    expect(t4.triggered).toBe(true);
  });

  test("判据只看两次快照的 record id 集合是否相等，不看时间戳/顺序", () => {
    const guard = new NoProgressGuard(snap(["a", "b"]), 1);
    // 集合相同但构造顺序不同，仍判定为「无新增」。
    const result = guard.tick(snap(["b", "a"]));
    expect(result.triggered).toBe(true);
    expect(result.addedRecordCount).toBe(0);
  });
});

// ── evaluateRound：三条停机条件的汇总（done 优先于 no_progress） ─────────────────

describe("evaluateRound / describeStop", () => {
  test("done 优先：一轮内契约刚好完成，即使同一轮也没有新增节点，也报 done 不报 no_progress", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);
    const paper = addPaper(s, "A");
    const draft = s.create({ type: "artifact", title: "草稿", content: "x", evidence: "inferred", artifactId: "art-1" });
    addReading(s, paper.id, "卡片 A");
    addCitationReview(s, { targetRecordId: draft.id, hardFindingCount: 0 });
    // guard 的起点快照就取"契约已经齐了"之后这一刻 —— 模拟"最后一轮既完成任务、
    // 这一轮本身又没有新证据"的边界情况。
    const guard = new NoProgressGuard(q.snapshot(), 1);
    const evaluation = evaluateRound(contract, guard, q);
    expect(evaluation.report.allDone).toBe(true);
    expect(evaluation.noProgress.triggered).toBe(true); // 无新增确实触发了阈值
    expect(evaluation.stopReason).toBe("done"); // 但汇总判据优先报「正常完成」
    expect(describeStop("literature-review", evaluation)).toContain("已完成");
  });

  test("连续两轮无新增 → 第 2 轮停止，stopReason=no_progress，报告未完成的 stage 与缺口", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q); // 空图，三个 stage 全部未完成
    const guard = new NoProgressGuard(q.snapshot(), 2);

    const round1 = evaluateRound(contract, guard, q); // 第 1 轮：仍然无新增
    expect(round1.report.allDone).toBe(false);
    expect(round1.noProgress.streak).toBe(1);
    expect(round1.stopReason).toBeNull(); // 还没到阈值，循环应当继续

    const round2 = evaluateRound(contract, guard, q); // 第 2 轮：连续第二次无新增
    expect(round2.noProgress.streak).toBe(2);
    expect(round2.stopReason).toBe("no_progress");
    const text = describeStop("literature-review", round2);
    expect(text).toContain("连续 2 轮");
    expect(text).toContain("searched"); // 具体点名哪些 stage 没完成
    expect(text).toContain("read_cards");
    expect(text).toContain("citations_verified");
  });
});

// ── 阴性对照 ①：伪造完成（AD-10 的核心） ────────────────────────────────────────

describe("阴性对照 ① 伪造完成", () => {
  test("模型自称『已完成』，但证据图里没有对应 record → allDone() 必须为 false", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);

    // 模拟一个不老实的 agent：往证据图里塞了一条"自我报告"，但它既不是 paper、
    // 也不是 reading、也不是我们约定的 citation-integrity-review 观察——
    // 换句话说，这是"嘴上说完成了"，图上却没有真正对应类型/结构的证据。
    const fakeClaim = s.create({
      type: "idea",
      title: "进度自报",
      content: "我已经完成了检索、精读卡和引用核验，全部 stage 都 done 了",
      evidence: "inferred",
      metadata: { status: "completed", stage: "all", selfReported: true },
    });

    expect(contract.allDone(q)).toBe(false);
    const report = contract.evaluate(q);
    expect(report.incomplete.map((st) => st.id)).toEqual(["searched", "read_cards", "citations_verified"]);
    // 伪造的那条 record 不会、也不可能出现在任何 stage 的 evidence 里——
    // check() 的签名（check(q: EvidenceQuery)）根本没有入口接收"模型怎么说"，
    // 它只会去查证据图里真实存在的 paper / reading / citation-integrity-review 记录。
    for (const stage of report.stages) {
      expect(stage.evidence).not.toContain(fakeClaim.id);
    }
  });

  test("即使伪造成看起来像证据的 metadata.kind，字段不对（hardFindingCount 缺失）依然判未完成", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const contract = createLiteratureReviewContract(q);
    // 更狡猾的伪造：type 对了（observation）、kind 也对了，但缺了关键字段——
    // 模拟"agent 抄了个 record 形状但没有真的跑核验"。
    s.create({
      type: "observation",
      title: "假的核验记录",
      content: "看起来像 citation-integrity 核验",
      evidence: "inferred",
      metadata: { kind: CITATION_INTEGRITY_REVIEW_KIND, note: "其实没跑过检查器" },
    });
    const report = contract.evaluate(q);
    const stage = report.stages.find((st) => st.id === "citations_verified")!;
    expect(stage.done).toBe(false);
    expect(stage.reason).toContain("缺失或非法");
  });
});
