import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConclusionStore } from "../../backend/src/conclusion/store";
import { parseConclusionCard, parseReviewStamp, renderConclusionCard } from "../../backend/src/conclusion/models";
import {
  CAPABILITY_RULE,
  DATA_CONSISTENCY_RULE,
  STATS_RULE,
  capabilityLabeling,
  claimsBitwiseReproducibility,
  dataConsistency,
  extractStatsSignals,
  mentionsSimulation,
  reconciliationMode,
  resolveEvidence,
  statsPlausibility,
} from "../../backend/src/reviewer/conclusion_rules";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import type { RecordStore } from "../../backend/src/project/records";

// P8-gate G2/G3/G4：结论卡三个检查器的单测。
//
// 检查器本身零 IO，但「observation 是否真实存在于执行记录」这件事只有对着**真的**
// RecordStore 才验得出来——所以这里用真实项目 + 真实 sqlite，不打桩。
// 对抗用例的口径与 P3 citation-integrity 一致：伪造 / 断链 / 跨项目各来一发。

const roots: string[] = [];
const projects: Project[] = [];

function newProject(slug = "g2"): Project {
  const root = mkdtempSync(join(tmpdir(), "conclusion-test-"));
  roots.push(root);
  const project = new ProjectManager(root).create(slug);
  projects.push(project);
  return project;
}

interface ObservationOptions {
  simulated?: boolean;
  deterministic?: boolean;
  runId?: string | null;
  experimentId?: string | null;
  content?: string;
}

function makeObservation(records: RecordStore, options: ObservationOptions = {}): string {
  const record = records.create({
    type: "observation",
    title: "观察",
    content: options.content ?? "# 观察\n\n能量单调衰减。",
    evidence: "computed",
    metadata: {
      kind: "simulation_summary",
      runId: options.runId === undefined ? "run-1" : options.runId,
      experimentId: options.experimentId === undefined ? "exp-1" : options.experimentId,
      ...(options.simulated !== undefined ? { simulated: options.simulated } : {}),
      ...(options.deterministic !== undefined ? { deterministic: options.deterministic } : {}),
    },
  });
  return record.id;
}

afterAll(() => {
  for (const project of projects) {
    try {
      project.close();
    } catch {
      /* 已关就算了 */
    }
  }
});

describe("G2 data-consistency：结论引用的 observation 必须真实存在于执行记录", () => {
  test("真实存在且连了边的证据：零 finding", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({
      claim: "阻尼系数升高后能量衰减更快",
      evidenceIds: [obsId],
    });
    const result = dataConsistency({ card, lookup: records });
    expect(result.findings).toHaveLength(0);
    expect(result.resolved[0]!.ok).toBe(true);
    expect(result.resolved[0]!.linked).toBe(true);
  });

  test("对抗①：伪造的 observation 引用 → hard（dangling_evidence）", () => {
    const project = newProject();
    const records = project.records();
    const card = new ConclusionStore(records).create({
      claim: "本方法优于基线",
      evidenceIds: ["00000000-dead-beef-0000-000000000000"],
    });
    const result = dataConsistency({ card, lookup: records });
    const hard = result.findings.filter((f) => f.severity === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.rule).toBe(DATA_CONSISTENCY_RULE);
    expect(hard[0]!.message).toContain("dangling_evidence");
    expect(result.resolved[0]!.ok).toBe(false);
  });

  test("对抗②：指向已删除 record → 同样是 hard（证据消失 = 断链）", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({ claim: "结论", evidenceIds: [obsId] });
    expect(dataConsistency({ card, lookup: records }).findings).toHaveLength(0);

    // 「已删除」= 解析不出来。用一个删掉了这条 record 的 lookup 复现，
    // 因为 RecordStore 没有 delete（证据不可删是有意的设计）。
    const withDeleted = {
      project: records.project,
      get: (id: string) => (id === obsId ? null : records.get(id)),
      edgesOf: (id: string) => records.edgesOf(id),
    };
    const result = dataConsistency({ card, lookup: withDeleted });
    const hard = result.findings.filter((f) => f.severity === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.message).toContain("dangling_evidence");
  });

  test("对抗③：跨项目引用 → hard，且报出证据实际属于哪个项目", () => {
    const projectA = newProject("proj-a");
    const projectB = newProject("proj-b");
    const recordsA = projectA.records();
    const recordsB = projectB.records();
    const foreignId = makeObservation(recordsB);

    const card = new ConclusionStore(recordsA).create({ claim: "跨项目搬证据", evidenceIds: [foreignId] });
    const foreign = (id: string) => (recordsB.get(id) ? projectB.slug : null);
    const result = dataConsistency({ card, lookup: recordsA, foreign });
    const hard = result.findings.filter((f) => f.severity === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.message).toContain("cross_project_evidence");
    expect(hard[0]!.detail).toMatchObject({ ownerProject: projectB.slug });
  });

  test("零证据的结论卡 → hard（no_evidence）", () => {
    const project = newProject();
    const records = project.records();
    const card = new ConclusionStore(records).create({ claim: "我觉得可行" });
    const result = dataConsistency({ card, lookup: records });
    expect(result.findings.filter((f) => f.severity === "hard").map((f) => f.message.split(":")[0])).toEqual([
      "no_evidence",
    ]);
  });

  test("引用的是 idea/paper 而不是 observation → hard（evidence_type_mismatch）", () => {
    const project = newProject();
    const records = project.records();
    const idea = records.create({ type: "idea", content: "一个想法", metadata: { kind: "idea_card" } });
    const card = new ConclusionStore(records).create({ claim: "结论", evidenceIds: [idea.id] });
    const result = dataConsistency({ card, lookup: records });
    const hard = result.findings.filter((f) => f.severity === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.message).toContain("evidence_type_mismatch");
    expect(hard[0]!.detail).toMatchObject({ actualType: "idea" });
  });

  test("observation 没有执行锚点 → soft（手工登记的观察，合法但要被看见）", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records, { runId: null, experimentId: null });
    const card = new ConclusionStore(records).create({ claim: "结论", evidenceIds: [obsId] });
    const result = dataConsistency({ card, lookup: records });
    expect(result.findings.filter((f) => f.severity === "hard")).toHaveLength(0);
    expect(result.findings.map((f) => f.message).join()).toContain("evidence_without_execution");
  });

  test("证据存在但图上没连边 → soft（evidence_not_linked）", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records);
    // 绕过 ConclusionStore.create 的连边逻辑，直接造一条只写了 metadata 的卡。
    const record = records.create({
      type: "conclusion",
      content: "结论",
      metadata: { kind: "conclusion_card", claim: "结论", evidenceIds: [obsId] },
    });
    const card = parseConclusionCard(records.get(record.id)!)!;
    const result = dataConsistency({ card, lookup: records });
    expect(result.findings.filter((f) => f.severity === "hard")).toHaveLength(0);
    expect(result.findings.map((f) => f.message).join()).toContain("evidence_not_linked");
  });

  test("P5/P6 的旧形态（单个 observationId + review 裸字符串）照样读得出来", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records);
    const record = records.create({
      type: "conclusion",
      title: "旧卡",
      content: "旧结论",
      metadata: { kind: "conclusion_card", claim: "旧结论", observationId: obsId, review: "pending" },
    });
    const card = parseConclusionCard(records.get(record.id)!)!;
    expect(card.evidenceIds).toEqual([obsId]);
    expect(card.review.state).toBe("pending");
  });

  test("review 字段解析不出来时落回 pending（绝不当成 approved）", () => {
    expect(parseReviewStamp(undefined).state).toBe("pending");
    expect(parseReviewStamp("approved").state).toBe("approved");
    expect(parseReviewStamp({ state: "banana" }).state).toBe("pending");
    expect(parseReviewStamp(42).state).toBe("pending");
  });
});

describe("G4 capability-labeling：能力位的消费端", () => {
  test("引用 simulated observation 却没标注 → hard", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records, { simulated: true });
    const card = new ConclusionStore(records).create({
      claim: "37°C 孵育 1 小时后 OD600 升至 0.8，说明菌体正常生长",
      evidenceIds: [obsId],
    });
    const resolved = resolveEvidence(card, records);
    const result = capabilityLabeling({ card, resolved });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("hard");
    expect(result.findings[0]!.rule).toBe(CAPABILITY_RULE);
    expect(result.findings[0]!.message).toContain("unlabeled_simulated_evidence");
    expect(result.simulatedEvidenceIds).toEqual([obsId]);
  });

  test("在 limitations 里标注了模拟来源 → 放行", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records, { simulated: true });
    const card = new ConclusionStore(records).create({
      claim: "协议在协议引擎里可执行",
      limitations: "读数来自 Opentrons 模拟器，非真实实验数据，不能作为生物学结论",
      evidenceIds: [obsId],
    });
    const result = capabilityLabeling({ card, resolved: resolveEvidence(card, records) });
    expect(result.findings).toHaveLength(0);
    expect(result.acknowledged).toBe(true);
  });

  test("非确定性平台上声称逐位复现 → hard", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records, { deterministic: false });
    const card = new ConclusionStore(records).create({
      claim: "同参数重跑结果完全一致，逐位复现",
      evidenceIds: [obsId],
    });
    const result = capabilityLabeling({ card, resolved: resolveEvidence(card, records) });
    expect(result.findings.map((f) => f.message).join()).toContain("bitwise_claim_on_nondeterministic");
    expect(result.reconciliation).toBe("interval");
  });

  test("确定性平台上说逐位复现 → 不报", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records, { deterministic: true });
    const card = new ConclusionStore(records).create({
      claim: "同参数重跑逐位一致",
      evidenceIds: [obsId],
    });
    const result = capabilityLabeling({ card, resolved: resolveEvidence(card, records) });
    expect(result.findings).toHaveLength(0);
    expect(result.reconciliation).toBe("bitwise");
  });

  test("对账口径：混合证据只要有一条非确定性就降到 interval；没有能力位则 unknown", () => {
    expect(reconciliationMode([])).toBe("unknown");
    expect(reconciliationMode([{ ok: true, deterministic: true } as never])).toBe("bitwise");
    expect(
      reconciliationMode([{ ok: true, deterministic: true } as never, { ok: true, deterministic: false } as never]),
    ).toBe("interval");
    expect(reconciliationMode([{ ok: true, deterministic: null } as never])).toBe("unknown");
  });

  test("措辞识别：正常的「可复现」不算逐位声明；模拟标注中英文都认", () => {
    expect(claimsBitwiseReproducibility("实验可复现")).toBe(false);
    expect(claimsBitwiseReproducibility("结果可重复")).toBe(false);
    expect(claimsBitwiseReproducibility("数值完全一致")).toBe(true);
    expect(claimsBitwiseReproducibility("bit-for-bit identical")).toBe(true);
    expect(mentionsSimulation("读数来自模拟器")).toBe(true);
    expect(mentionsSimulation("simulated readings only")).toBe(true);
    expect(mentionsSimulation("真实实验读数")).toBe(false);
  });
});

describe("G3 stats-plausibility：启发式 soft 提示", () => {
  const project = newProject();
  const records = project.records();
  const store = new ConclusionStore(records);

  function check(claim: string, extra: { limitations?: string; evidenceText?: string } = {}) {
    const obsId = makeObservation(records);
    const card = store.create({ claim, limitations: extra.limitations ?? null, evidenceIds: [obsId] });
    return statsPlausibility({
      card,
      resolved: resolveEvidence(card, records),
      evidenceText: extra.evidenceText,
    });
  }

  test("全部 finding 都是 soft 且标了 heuristic", () => {
    const result = check("n=3 时 p=0.045，因此本方法证明了因果关系");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.severity === "soft")).toBe(true);
    expect(result.findings.every((f) => f.rule === STATS_RULE)).toBe(true);
    expect(result.findings.every((f) => (f.detail as { heuristic?: boolean }).heuristic === true)).toBe(true);
  });

  test("样本量过小", () => {
    expect(check("n=3 条件下观察到差异").findings.map((f) => f.message).join()).toContain("small_sample");
    expect(check("样本量 24 条件下观察到差异").findings.map((f) => f.message).join()).not.toContain("small_sample");
    expect(check("重复 4 次后观察到差异").findings.map((f) => f.message).join()).toContain("small_sample");
  });

  test("多重比较未校正；提到校正方法就不报", () => {
    const uncorrected = check("比较了 12 组条件，其中三组显著");
    expect(uncorrected.findings.map((f) => f.message).join()).toContain("multiple_comparisons_uncorrected");
    const corrected = check("比较了 12 组条件，已做 Bonferroni 校正后仍显著");
    expect(corrected.findings.map((f) => f.message).join()).not.toContain("multiple_comparisons_uncorrected");
  });

  test("p 值边缘（0.04–0.05）", () => {
    expect(check("处理组显著优于对照组（p=0.047）").findings.map((f) => f.message).join()).toContain("marginal_p_value");
    expect(check("处理组显著优于对照组（p=0.001）").findings.map((f) => f.message).join()).not.toContain(
      "marginal_p_value",
    );
    // 阈值声明（p < 0.05）不是观测值，不该被当成边缘 p 值。
    expect(check("在 p < 0.05 水平上显著（n=30）").findings.map((f) => f.message).join()).not.toContain(
      "marginal_p_value",
    );
  });

  test("结论强度超过数据支撑：强因果断言 + 弱证据", () => {
    const overclaim = check("该化合物导致细胞凋亡，普遍适用于所有细胞系", { evidenceText: "n=3" });
    expect(overclaim.findings.map((f) => f.message).join()).toContain("overclaim_vs_evidence");
    // 措辞克制时不报。
    const measured = check("在本条件下观察到凋亡率上升，与假设一致", { evidenceText: "n=3" });
    expect(measured.findings.map((f) => f.message).join()).not.toContain("overclaim_vs_evidence");
  });

  test("信号提取：样本量/p 值/比较数/校正关键词", () => {
    const signals = extractStatsSignals("n=5，比较了 8 组，p = 0.042 与 p=0.03，未做校正");
    expect(signals.sampleSizes).toContain(5);
    expect(signals.pValues).toEqual(expect.arrayContaining([0.042, 0.03]));
    expect(signals.comparisonCount).toBe(8);
    expect(signals.hasCorrection).toBe(false);
    expect(extractStatsSignals("已做 FDR 校正").hasCorrection).toBe(true);
  });

  test("干净的结论：零 finding（不制造噪音）", () => {
    const result = check("在 n=30 的样本上观察到处理组 OD600 高于对照组（p=0.002）");
    expect(result.findings).toHaveLength(0);
  });
});

describe("结论卡渲染", () => {
  test("渲染包含 review 状态、证据 id 与 finding 清单", () => {
    const project = newProject();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({
      claim: "能量单调衰减",
      limitations: "只跑了一组参数",
      evidenceIds: [obsId],
    });
    const text = renderConclusionCard({
      ...card,
      review: { ...card.review, state: "vetoed", findings: [{ rule: "data-consistency", severity: "hard", message: "x" }] },
    });
    expect(text).toContain("已否决（vetoed）");
    expect(text).toContain(obsId);
    expect(text).toContain("只跑了一组参数");
    expect(text).toContain("`data-consistency`");
  });
});
