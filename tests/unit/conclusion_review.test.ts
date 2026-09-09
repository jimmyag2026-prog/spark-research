import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConclusionCommand } from "../../backend/src/conclusion/cli";
import { ConclusionReviewer, ConclusionReviewError } from "../../backend/src/conclusion/reviewer";
import { ConclusionStore, ConclusionStoreError } from "../../backend/src/conclusion/store";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import type { RecordStore } from "../../backend/src/project/records";

// P8-gate G1：结论卡 review 门槛（pending / approved / vetoed）。
//
// 判定规则不可协商：任一 hard finding → vetoed，零 hard → approved。
// 这里验的是「门槛真的关得住」——包括「已 approved 的卡在证据被破坏后重新评审会翻成 vetoed」。

const roots: string[] = [];
const projects: Project[] = [];

function newWorkspace(slug = "g1"): { root: string; manager: ProjectManager; project: Project } {
  const root = mkdtempSync(join(tmpdir(), "conclusion-review-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create(slug);
  projects.push(project);
  return { root, manager, project };
}

function makeObservation(records: RecordStore, extra: Record<string, unknown> = {}): string {
  return records.create({
    type: "observation",
    title: "观察",
    content: "# 观察\n\n在 n=30 的样本上测得均值差 0.42（p=0.002）。",
    evidence: "computed",
    metadata: { kind: "simulation_summary", runId: "run-1", experimentId: "exp-1", deterministic: true, ...extra },
  }).id;
}

afterAll(() => {
  for (const project of projects) {
    try {
      project.close();
    } catch {
      /* 已关 */
    }
  }
});

describe("ConclusionReviewer", () => {
  test("干净的结论卡 → approved，并落一条 decision record", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({
      claim: "阻尼系数从 0.1 提高到 0.4 后，能量衰减时间常数缩短约 3 倍",
      limitations: "只在单一初始条件下验证",
      evidenceIds: [obsId],
    });
    expect(card.review.state).toBe("pending");

    const reviewer = new ConclusionReviewer(records);
    const result = reviewer.review(card, { actor: "张三", actorSource: "explicit" });

    expect(result.approved).toBe(true);
    expect(result.card.review.state).toBe("approved");
    expect(result.card.review.actor).toBe("张三");
    expect(result.card.review.hardCount).toBe(0);

    const decision = records.get(result.decisionRecordId)!;
    expect(decision.type).toBe("decision");
    expect(decision.metadata).toMatchObject({ kind: "conclusion_review", verdict: "approved", actor: "张三" });
    // decision --derives_from--> conclusion：审计时顺着边能找回被批的那张卡。
    const edges = records.edgesOf(result.decisionRecordId);
    expect(edges.outgoing.some((e) => e.targetId === card.recordId && e.type === "derives_from")).toBe(true);
  });

  test("hard finding → vetoed（伪造证据的结论进不了结论区）", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const card = new ConclusionStore(records).create({
      claim: "方法 A 优于方法 B",
      evidenceIds: ["not-a-real-record"],
    });
    const result = new ConclusionReviewer(records).review(card, { actor: "李四" });
    expect(result.approved).toBe(false);
    expect(result.card.review.state).toBe("vetoed");
    expect(result.card.review.hardCount).toBeGreaterThan(0);
    expect(result.card.review.findings.some((f) => f.rule === "data-consistency")).toBe(true);
  });

  test("soft finding 不否决（启发式只提示）", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({
      claim: "处理组显著优于对照组（n=3，p=0.048）",
      evidenceIds: [obsId],
    });
    const result = new ConclusionReviewer(records).review(card, { actor: "王五" });
    expect(result.approved).toBe(true);
    expect(result.softCount).toBeGreaterThan(0);
    expect(result.card.review.state).toBe("approved");
  });

  test("人工否决：检查器全过也能被人挡下，理由入库", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({ claim: "结论成立", evidenceIds: [obsId] });
    const reviewer = new ConclusionReviewer(records);
    expect(reviewer.assess(card).wouldApprove).toBe(true);

    const result = reviewer.review(card, { actor: "赵六", veto: "对照组设置有问题，重做" });
    expect(result.approved).toBe(false);
    expect(result.card.review.state).toBe("vetoed");
    expect(result.card.review.reason).toBe("对照组设置有问题，重做");
    expect(records.get(result.decisionRecordId)!.metadata).toMatchObject({ manualVeto: true });
  });

  test("人工否决必须给理由", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({ claim: "结论", evidenceIds: [obsId] });
    expect(() => new ConclusionReviewer(records).review(card, { veto: "   " })).toThrow(ConclusionReviewError);
  });

  test("重新评审会翻面：approved 的卡在证据被指向别处后变 vetoed", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = makeObservation(records);
    const store = new ConclusionStore(records);
    const card = store.create({ claim: "结论", evidenceIds: [obsId] });
    const reviewer = new ConclusionReviewer(records, { store });
    expect(reviewer.review(card, { actor: "甲" }).approved).toBe(true);

    // 把证据换成一个不存在的 id（模拟「改了卡但没改证据」）。
    records.update(card.recordId, { metadata: { evidenceIds: ["ghost-id"] } });
    const again = reviewer.review(card.recordId, { actor: "甲" });
    expect(again.approved).toBe(false);
    expect(reviewer.store.get(card.recordId)!.review.state).toBe("vetoed");
  });

  test("assess 不写任何东西（报告预览走这条）", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = makeObservation(records);
    const card = new ConclusionStore(records).create({ claim: "结论", evidenceIds: [obsId] });
    const reviewer = new ConclusionReviewer(records);
    const before = records.count();
    const assessment = reviewer.assess(card);
    expect(assessment.wouldApprove).toBe(true);
    expect(records.count()).toBe(before);
    expect(reviewer.store.get(card.recordId)!.review.state).toBe("pending");
  });

  test("湿实验模拟读数不标注 → vetoed（G4 在评审里的落点）", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const obsId = records.create({
      type: "observation",
      title: "湿实验观察",
      content: "# 观察\n\nOD600 = 0.0",
      evidence: "observed",
      metadata: { kind: "wet_run_observation", runId: "wet-1", experimentId: "wexp-1", simulated: true },
    }).id;
    const store = new ConclusionStore(records);
    const bad = store.create({ claim: "37°C 孵育后菌体正常生长，OD600 达标", evidenceIds: [obsId], mode: "wet" });
    const reviewer = new ConclusionReviewer(records);
    expect(reviewer.review(bad, { actor: "甲" }).approved).toBe(false);

    const good = store.create({
      claim: "协议在 Opentrons 协议引擎里可执行",
      limitations: "读数来自模拟器，不能作为生物学结论",
      evidenceIds: [obsId],
      mode: "wet",
    });
    expect(reviewer.review(good, { actor: "甲" }).approved).toBe(true);
  });

  test("id 前缀匹配到多张卡时报错而不是随便挑一张", () => {
    const { project } = newWorkspace();
    const records = project.records();
    const store = new ConclusionStore(records);
    // uuid 首字符只有 16 种取值，建 20 张卡 → 鸽笼原理保证至少有一个首字符撞车。
    for (let i = 0; i < 20; i++) store.create({ claim: `结论 ${i}` });
    const byFirstChar = new Map<string, number>();
    for (const card of store.list()) {
      const head = card.recordId.slice(0, 1);
      byFirstChar.set(head, (byFirstChar.get(head) ?? 0) + 1);
    }
    const collided = [...byFirstChar.entries()].find(([, n]) => n > 1);
    expect(collided).toBeDefined();
    expect(() => store.get(collided![0])).toThrow(ConclusionStoreError);

    expect(store.get("")).toBeNull();
    expect(store.get("zzzz-no-such-prefix")).toBeNull();
  });
});

describe("conclusion CLI", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  }

  test("list 空项目给出下一步指引", async () => {
    const { root } = newWorkspace("cli-empty");
    const cap = capture();
    const code = await runConclusionCommand(["list"], { root, ...cap.deps });
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("还没有结论卡");
  });

  test("review 通过 → 退出码 0；review 否决 → 退出码 1", async () => {
    const { root, manager } = newWorkspace("cli-review");
    const project = manager.defaultProject();
    const records = project.records();
    const store = new ConclusionStore(records);
    const good = store.create({ claim: "结论 A", evidenceIds: [makeObservation(records)] });
    const bad = store.create({ claim: "结论 B", evidenceIds: ["ghost"] });
    project.close();

    const ok = capture();
    expect(await runConclusionCommand(["review", good.recordId, "--actor", "张三"], { root, ...ok.deps })).toBe(0);
    expect(ok.out.join("\n")).toContain("approved");

    const veto = capture();
    expect(await runConclusionCommand(["review", bad.recordId, "--actor", "张三"], { root, ...veto.deps })).toBe(1);
    expect(veto.out.join("\n")).toContain("vetoed");
    expect(veto.err.join("\n")).toContain("dangling_evidence");
  });

  test("list --review approved 只列通过的", async () => {
    const { root, manager } = newWorkspace("cli-filter");
    const project = manager.defaultProject();
    const records = project.records();
    const store = new ConclusionStore(records);
    const good = store.create({ claim: "通过的结论", evidenceIds: [makeObservation(records)] });
    store.create({ claim: "没证据的结论" });
    new ConclusionReviewer(records, { store }).review(good, { actor: "张三" });
    project.close();

    const cap = capture();
    const code = await runConclusionCommand(["list", "--review", "approved", "--json"], { root, ...cap.deps });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join("\n")) as { claim: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.claim).toBe("通过的结论");
  });

  test("show 输出卡片正文 + 「现在重新评审会怎样」", async () => {
    const { root, manager } = newWorkspace("cli-show");
    const project = manager.defaultProject();
    const records = project.records();
    const card = new ConclusionStore(records).create({ claim: "没有证据的结论" });
    project.close();

    const cap = capture();
    expect(await runConclusionCommand(["show", card.recordId], { root, ...cap.deps })).toBe(0);
    expect(cap.out.join("\n")).toContain("vetoed");
    expect(cap.out.join("\n")).toContain("no_evidence");
  });

  test("--veto 不带理由被拒；带理由则记名否决", async () => {
    const { root, manager } = newWorkspace("cli-veto");
    const project = manager.defaultProject();
    const records = project.records();
    const card = new ConclusionStore(records).create({ claim: "结论", evidenceIds: [makeObservation(records)] });
    project.close();

    const bare = capture();
    expect(await runConclusionCommand(["review", card.recordId, "--veto"], { root, ...bare.deps })).toBe(1);
    expect(bare.err.join("\n")).toContain("必须带理由");

    const withReason = capture();
    expect(
      await runConclusionCommand(["review", card.recordId, "--veto", "对照组不成立", "--actor", "李四"], {
        root,
        ...withReason.deps,
      }),
    ).toBe(1);
    const reopened = new ProjectManager(root).defaultProject();
    expect(new ConclusionStore(reopened.records()).get(card.recordId)!.review.reason).toBe("对照组不成立");
    reopened.close();
  });

  test("未知子命令与缺参数都给帮助并退非零", async () => {
    const { root } = newWorkspace("cli-help");
    const bad = capture();
    expect(await runConclusionCommand(["frobnicate"], { root, ...bad.deps })).toBe(1);
    expect(bad.err.join("\n")).toContain("未知的 conclusion 子命令");
    const none = capture();
    expect(await runConclusionCommand([], { root, ...none.deps })).toBe(1);
    const help = capture();
    expect(await runConclusionCommand(["help"], { root, ...help.deps })).toBe(0);
  });
});
