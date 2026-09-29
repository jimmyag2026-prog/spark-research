import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeError,
  BridgeSession,
  ELO_INITIAL,
  auditProposal,
  bridgeToIdeaCard,
  buildProposalPrompt,
  jargonHits,
  loadBridgePrompt,
  renderBridgeReport,
  runTournament,
  validateBridgeProposal,
  validateFieldCandidates,
  validateJudgeVerdict,
  validateStructureSignature,
  type BridgeProposal,
  type ProblemCard,
} from "../../backend/src/ideation/bridge";
import { validateIdeaCardPayload } from "../../backend/src/ideation/models";
import { IdeaStore } from "../../backend/src/ideation/store";
import { SKILL_RUNNERS, runSkill } from "../../backend/src/agents/skill_runners";
import { LibraryStore } from "../../backend/src/literature/library";
import { ProjectManager } from "../../backend/src/project/manager";
import { FakeLlm } from "../helpers/review_scenario";

// cross-domain-bridge 单测。所有 LLM 调用注入 fake，零网络。
//
// 钉的是设计里那几条"做成结构而不是靠 prompt 叮嘱"的纪律：
//   jargon 门是确定性的；审计是确定性的；盲写没有共享历史；锦标赛不开群聊；失败看得见。

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const CARD: ProblemCard = {
  statement: "我想用蛋白语言模型的注意力图直接预测别构位点",
  sourceField: "结构生物学",
  domainTerms: ["别构位点", "注意力图", "蛋白语言模型"],
  deadEnds: ["序列保守性"],
};

const SIGNATURE = {
  objects: ["一条长链上的许多单元", "单元之间的成对耦合强度", "少数功能热点"],
  relations: ["耦合强度由链上的统计共现学到", "热点是耦合图中的高介数节点"],
  dynamics: "扰动一个单元后影响沿耦合图传播并在热点处放大",
  constraints: ["只能观测到链的一维顺序与耦合矩阵"],
  objective: "从耦合矩阵预测哪些单元是功能热点",
  observables: ["耦合矩阵", "已知热点的标注"],
};

const FIELDS = {
  fields: [
    { field: "统计物理", localName: "自旋玻璃的耦合网络", canonicalMethod: "平均场 / 级联分析" },
    { field: "网络科学", localName: "加权图的介数中心性", canonicalMethod: "中心性与社区发现" },
    { field: "电力系统", localName: "级联失效的关键节点", canonicalMethod: "N-1 扰动分析" },
  ],
};

function proposal(field: string, overrides: Partial<BridgeProposal> = {}): BridgeProposal {
  return {
    field,
    mechanism: `${field} 里对耦合网络做扰动传播分析`,
    statement: `${field} 的关键节点指标能在耦合矩阵上复现已知热点`,
    mapping: [
      { source: "节点", target: "链上单元", relation: "一一对应", loadBearing: true },
      { source: "边权", target: "耦合强度", relation: "单调保序", loadBearing: true },
      { source: "关键节点", target: "功能热点", relation: "扰动放大处", loadBearing: false },
    ],
    conventionalSkeleton: ["加权图中心性", "扰动传播模拟"],
    atypicalInjection: "把耦合矩阵当作网络而不是特征",
    cheapFalsification: "在 50 条有标注热点的链上算介数，看 AUROC 是否显著高于随机（<0.6 即算错）",
    literatureAge: "old",
    references: ["Freeman 1977 betweenness"],
    ...overrides,
  };
}

const json = (v: unknown) => JSON.stringify(v);

// ── ① 结构签名 ─────────────────────────────────────────────────────────────

describe("① 结构签名 · jargon 门是确定性的", () => {
  test("干净的签名通过", () => {
    const r = validateStructureSignature(SIGNATURE, { domainTerms: CARD.domainTerms });
    expect(r.ok).toBe(true);
    expect(r.fields!.objects).toHaveLength(3);
  });

  test("签名里出现用户声明的术语 → 打回并点名", () => {
    const r = validateStructureSignature(
      { ...SIGNATURE, objective: "从注意力图预测别构位点" },
      { domainTerms: CARD.domainTerms },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("别构位点");
    expect(r.errors.join()).toContain("注意力图");
  });

  test("术语命中不区分大小写；≤2 字符的术语不参与（防 'AI' 误伤）", () => {
    expect(jargonHits("uses an Attention Map here", ["attention map"])).toEqual(["attention map"]);
    expect(jargonHits("AI-based approach", ["AI"])).toEqual([]);
  });

  test("dynamics / objective 写成字符串数组也收（deepseek-v4-flash 冒烟实测形态），合并成一句", () => {
    const r = validateStructureSignature(
      { ...SIGNATURE, dynamics: ["训练时权重收敛", "换一个符号则整行重排"], objective: ["排序质量", "不许用位置级标注"] },
      { domainTerms: CARD.domainTerms },
    );
    expect(r.ok).toBe(true);
    expect(r.fields!.dynamics).toBe("训练时权重收敛；换一个符号则整行重排");
    expect(r.fields!.objective).toContain("；");
    // 空数组仍然算缺失
    expect(validateStructureSignature({ ...SIGNATURE, dynamics: [] }).ok).toBe(false);
  });

  test("对象少于 2 / 缺 dynamics → 不合格", () => {
    const r = validateStructureSignature({ ...SIGNATURE, objects: ["只有一个"], dynamics: "" });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("objects");
    expect(r.errors.join()).toContain("dynamics");
  });
});

// ── ② 唤醒 ─────────────────────────────────────────────────────────────────

describe("② 多语言唤醒 · 领域必须互不相同", () => {
  test("重复领域被去重而不是报错；去重后不够数才报", () => {
    const dup = { fields: [FIELDS.fields[0], { ...FIELDS.fields[0], field: "统计物理" }, FIELDS.fields[1]] };
    const r = validateFieldCandidates(dup, { min: 2 });
    expect(r.ok).toBe(true);
    expect(r.fields).toHaveLength(2);
    expect(validateFieldCandidates(dup, { min: 3 }).ok).toBe(false);
  });

  test("接受裸数组与 {fields: [...]} 两种形态", () => {
    expect(validateFieldCandidates(FIELDS.fields).ok).toBe(true);
    expect(validateFieldCandidates(FIELDS).ok).toBe(true);
  });
});

// ── ③ 提案 schema ────────────────────────────────────────────────────────────

describe("③ 提案 schema", () => {
  test("合法提案通过", () => {
    expect(validateBridgeProposal(proposal("网络科学")).ok).toBe(true);
  });

  test("没有映射表 / literatureAge 非法 → 不合格", () => {
    const r = validateBridgeProposal({ ...proposal("x"), mapping: undefined, literatureAge: "ancient" });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("mapping");
    expect(r.errors.join()).toContain("literatureAge");
  });
});

// ── ④ 审计 ─────────────────────────────────────────────────────────────────

describe("④ 结构审计 · 确定性", () => {
  test("合格提案通过，无 finding", () => {
    const r = auditProposal(proposal("网络科学"), CARD);
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
  });

  test("承重映射只有 1 条 → superficial_analogy 硬杀", () => {
    const p = proposal("网络科学");
    p.mapping[1]!.loadBearing = false;
    const r = auditProposal(p, CARD);
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("superficial_analogy");
  });

  test("承重映射缺 relation → broken_mapping 硬杀", () => {
    const p = proposal("网络科学");
    p.mapping[0]!.relation = "";
    expect(auditProposal(p, CARD).findings.map((f) => f.code)).toContain("broken_mapping");
  });

  test("常规骨架 < 2 → all_novel 硬杀（Uzzi 门）", () => {
    const r = auditProposal(proposal("网络科学", { conventionalSkeleton: ["只有一条"] }), CARD);
    expect(r.pass).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("all_novel");
  });

  test("伪证方案太短 → unfalsifiable 硬杀", () => {
    const r = auditProposal(proposal("网络科学", { cheapFalsification: "做个实验" }), CARD);
    expect(r.findings.map((f) => f.code)).toContain("unfalsifiable");
  });

  test("撞死路 / 同域 → soft，不拦但要报", () => {
    const r = auditProposal(
      proposal("结构生物学", { mechanism: "先按序列保守性筛一遍再看耦合" }),
      CARD,
    );
    expect(r.pass).toBe(true);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("dead_end_overlap");
    expect(codes).toContain("same_field");
    expect(r.findings.every((f) => f.severity === "soft")).toBe(true);
  });
});

// ── ⑤ 锦标赛 ────────────────────────────────────────────────────────────────

describe("⑤ 锦标赛 · 两两对决、Elo 计分", () => {
  test("确定性评委（偏好领域名字典序更大者）→ 排名与之一致，Elo 总分守恒", async () => {
    const ps = [proposal("a-field"), proposal("b-field"), proposal("c-field")];
    const entries = await runTournament(ps, async (a, b) => (a.field > b.field ? "a" : "b"));
    expect(entries.map((e) => e.proposal.field)).toEqual(["c-field", "b-field", "a-field"]);
    expect(entries[0]!.wins).toBe(2);
    expect(entries[2]!.losses).toBe(2);
    const total = entries.reduce((s, e) => s + e.rating, 0);
    expect(Math.abs(total - ELO_INITIAL * 3)).toBeLessThan(1e-6);
  });

  test("评委每场只看到两份提案（单循环 = n(n-1)/2 场）", async () => {
    const seen: Array<[string, string]> = [];
    await runTournament([proposal("p1"), proposal("p2"), proposal("p3"), proposal("p4")], async (a, b) => {
      seen.push([a.field, b.field]);
      return "tie";
    });
    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((s) => s.join("|"))).size).toBe(6);
  });

  test("全平局 → 保持原始顺序（稳定）", async () => {
    const entries = await runTournament([proposal("z"), proposal("y")], async () => "tie");
    expect(entries.map((e) => e.proposal.field)).toEqual(["z", "y"]);
    expect(entries[0]!.ties).toBe(1);
  });

  test("裁决 schema：A/B/tie 不区分大小写，其他一律打回", () => {
    expect(validateJudgeVerdict({ winner: "A" }).fields).toBe("a");
    expect(validateJudgeVerdict({ winner: "b" }).fields).toBe("b");
    expect(validateJudgeVerdict({ winner: "TIE" }).fields).toBe("tie");
    expect(validateJudgeVerdict({ winner: "both" }).ok).toBe(false);
  });
});

// ── 会话全链路 ──────────────────────────────────────────────────────────────

describe("BridgeSession · 全链路（fake LLM）", () => {
  test("system prompt 能加载到（内嵌兜底），不是 [prompt missing]", () => {
    expect(loadBridgePrompt()).toContain("跨领域桥接");
  });

  test("签名含术语先被打回、回灌重试后通过；盲写无共享历史；审计与锦标赛落到报告", async () => {
    const dirty = { ...SIGNATURE, objective: "预测别构位点" };
    const good = [proposal("统计物理"), proposal("网络科学")];
    // 第三份：承重只有 1 条 → 审计否决，不进锦标赛
    const bad = proposal("电力系统");
    bad.mapping[1]!.loadBearing = false;
    const llm = new FakeLlm([
      json(dirty), // ① 第一次：含术语
      json(SIGNATURE), // ① 重试
      json(FIELDS), // ②
      json(good[0]), // ③ 席位 1
      json(good[1]), // ③ 席位 2
      json(bad), // ③ 席位 3
      json({ winner: "B", reason: "映射更承重" }), // ⑤ 唯一一场（2 份通过）
    ]);
    const notes: string[] = [];
    const report = await new BridgeSession({ llm }).run(CARD, { fields: 3, note: (m) => notes.push(m) });

    // ① 重试回灌带了原因
    expect(llm.calls[1]!.messages.at(-1)!.content).toContain("别构位点");
    // ③ 盲写：每次提案调用只有 system + 1 条 user，且不含其他提案的陈述
    const proposalCalls = llm.calls.slice(3, 6);
    for (const [i, c] of proposalCalls.entries()) {
      expect(c.messages).toHaveLength(2);
      expect(c.messages[1]!.content).toContain(`席位 ${i + 1}`);
      for (const other of good) {
        if (other.field === FIELDS.fields[i]!.field) continue;
        expect(c.messages[1]!.content).not.toContain(other.statement);
      }
      // 签名以纯结构形式进入提案 prompt，术语不出现
      expect(c.messages[1]!.content).not.toContain("别构位点");
    }
    // ④ 审计：1 份否决且原因可见
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.proposal.field).toBe("电力系统");
    expect(report.rejected[0]!.audit.findings[0]!.code).toBe("superficial_analogy");
    // ⑤ 锦标赛：B（网络科学）胜
    expect(report.ranked.map((r) => r.proposal.field)).toEqual(["网络科学", "统计物理"]);
    expect(report.ranked[0]!.rank).toBe(1);
    expect(report.ranked[0]!.wins).toBe(1);
    expect(report.llmCalls).toBe(7);
    expect(report.failedFields).toEqual([]);
    expect(notes.some((n) => n.startsWith("⑤"))).toBe(true);

    const md = renderBridgeReport(report);
    expect(md).toContain("# 跨领域桥接报告");
    expect(md).toContain("#1 网络科学");
    expect(md).toContain("被审计否决的桥（1）");
    expect(md).toContain("inferred");
  });

  test("某个领域两次都写不出合格提案 → 列进 failedFields，不静默丢、不带走整轮", async () => {
    const llm = new FakeLlm([
      json(SIGNATURE),
      json({ fields: FIELDS.fields.slice(0, 2) }),
      json(proposal("统计物理")),
      "{not json at all", // 席位 2 第一次
      json({ field: "网络科学" }), // 席位 2 重试仍缺字段
    ]);
    const report = await new BridgeSession({ llm }).run(CARD, { fields: 2 });
    expect(report.ranked).toHaveLength(1);
    expect(report.ranked[0]!.rating).toBe(ELO_INITIAL); // 单份不办锦标赛
    expect(report.failedFields).toHaveLength(1);
    expect(report.failedFields[0]!.field).toBe("网络科学");
    expect(report.failedFields[0]!.errors.join()).toContain("mapping");
    expect(renderBridgeReport(report)).toContain("未能产出合格提案的领域（1）");
  });

  test("签名两次都不干净 → 抛 BridgeError[signature]，不往下走", async () => {
    const dirty = { ...SIGNATURE, objective: "预测别构位点" };
    const llm = new FakeLlm([json(dirty), json(dirty)]);
    await expect(new BridgeSession({ llm }).run(CARD)).rejects.toBeInstanceOf(BridgeError);
    expect(llm.calls).toHaveLength(2);
  });

  test("空问题直接拒", async () => {
    await expect(new BridgeSession({ llm: new FakeLlm(["{}"]) }).run({ ...CARD, statement: "  " })).rejects.toThrow(
      /问题陈述为空/,
    );
  });

  test("提案 prompt 里写明只看签名、只许一处非典型注入", () => {
    const text = buildProposalPrompt(SIGNATURE, FIELDS.fields[0]!, 0);
    expect(text).toContain("看不到其他领域的提案");
    expect(text).toContain("只写一处");
    expect(text).toContain("至少 2 条承重");
  });
});

// ── Idea 卡转换 ────────────────────────────────────────────────────────────

describe("桥 → Idea 卡", () => {
  test("满足共探硬门：contradicting ≥ 1、全 inferred、可入思路库", () => {
    const ranked = {
      proposal: proposal("网络科学"),
      audit: auditProposal(proposal("网络科学", { mechanism: "序列保守性之外" }), CARD),
      rating: 1016,
      wins: 1,
      losses: 0,
      ties: 0,
      rank: 1,
    };
    const card = bridgeToIdeaCard(ranked);
    expect(card.contradicting.length).toBeGreaterThanOrEqual(2); // 承重未验证 + 死路 soft
    expect([...card.supporting, ...card.contradicting].every((e) => e.inferred && e.key === null)).toBe(true);
    // 与共探同一套 schema 校验器也认（库为空 → 全 inferred 合法）
    const v = validateIdeaCardPayload(card, { knownKeys: new Set() });
    expect(v.ok).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "bridge-"));
    roots.push(root);
    const project = new ProjectManager(root).create("bridge-p", { name: "p", description: "" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const stored = new IdeaStore(project.records(), library).create(card, { sessionId: "s1" });
    expect(stored.noveltyStatus).toBe("unchecked");
    expect(stored.hypothesis).toBe(ranked.proposal.statement);
    library.close();
    project.close();
  });
});

// ── skill runner ───────────────────────────────────────────────────────────

describe("skill runner · cross-domain-bridge", () => {
  test("注册进分发表", () => {
    expect(Object.keys(SKILL_RUNNERS)).toContain("cross-domain-bridge");
  });

  test("缺 problem → ok=false + 下一步提示，不许编问题去跑", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-r-"));
    roots.push(root);
    const project = new ProjectManager(root).create("r1", { name: "r1", description: "" });
    const llm = new FakeLlm(["{}"]);
    const r = await runSkill("cross-domain-bridge", { llm, project, sessionId: "s" }, {});
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.digest).toContain("problem");
    expect(llm.calls).toHaveLength(0);
    project.close();
  });

  test("全链路：digest 含排名、artifact 落盘、save=true 落前 3 张 Idea 卡", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-r-"));
    roots.push(root);
    const project = new ProjectManager(root).create("r2", { name: "r2", description: "蛋白别构" });
    const llm = new FakeLlm([
      json(SIGNATURE),
      json({ fields: FIELDS.fields.slice(0, 2) }),
      json(proposal("统计物理")),
      json(proposal("网络科学")),
      json({ winner: "A" }),
    ]);
    const r = await runSkill(
      "cross-domain-bridge",
      { llm, project, sessionId: "s2" },
      { problem: CARD.statement, domainTerms: CARD.domainTerms, deadEnds: CARD.deadEnds, fields: 2, save: true },
    );
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.digest).toContain("#1 统计物理");
    expect(r.digest).toContain("已落 2 张 Idea 卡");
    expect(r.artifacts).toHaveLength(1);
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    expect(new IdeaStore(project.records(), library).list()).toHaveLength(2);
    library.close();
    project.close();
  });
});
