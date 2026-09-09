import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageGraph } from "../../backend/src/artifacts/lineage";
import { ArtifactStore } from "../../backend/src/artifacts/store";
import { ReviewerAgent } from "../../backend/src/reviewer/agent";
import { LlmCitationJudge } from "../../backend/src/reviewer/citation_judge";
import {
  CITATION_RULE,
  citationIntegrity,
  citedKeys,
  isStrongClaim,
  parseCitations,
  splitSentences,
  stripCode,
  type CitationBaseline,
} from "../../backend/src/reviewer/rules";
import { FakeJudge, FakeLlm } from "../helpers/review_scenario";

// citation-integrity 检查器单测（P3 交付物 3）。纯函数 + 注入 fake judge，零网络零 LLM。

const BASELINE: CitationBaseline = {
  key: "jumper2021highly",
  title: "Highly accurate protein structure prediction",
  summary: "核心结论: 在 CASP14 上达到原子级精度; 局限: 对无序区与复合物预测较弱",
};

function baselines(...keys: string[]): Map<string, CitationBaseline> {
  return new Map(keys.map((k) => [k, { ...BASELINE, key: k }]));
}

describe("引用解析", () => {
  test("单个 / 分号并列 / 逗号并列 / 一句多处", () => {
    const md = "结论 A[@a]。结论 B[@b; @c]。结论 C[@d, @e]。结论 D[@f] 与 [@g]。";
    expect(citedKeys(md).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  test("代码块与行内代码里的 [@x] 不算引用", () => {
    const md = "```\n引用示例 [@fakeincode]\n```\n正文 [@real]，行内 `[@alsofake]` 不算。";
    expect(citedKeys(md)).toEqual(["real"]);
    expect(stripCode(md)).not.toContain("fakeincode");
  });

  test("key 允许字母数字与 -_:，非法形态不被误当引用", () => {
    expect(citedKeys("[@smith2020a-b_c]")).toEqual(["smith2020a-b_c"]);
    expect(citedKeys("邮件 a@b.com 与数组 [@]")).toEqual([]);
    expect(citedKeys("markdown 链接 [文字](url) 不是引用")).toEqual([]);
  });

  test("引用带回它所在的句子，便于定位与对照", () => {
    const parsed = parseCitations("第一句无引用。第二句说了结论[@k1]。");
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.sentence).toContain("第二句");
    expect(parsed[0]!.sentenceIndex).toBe(1);
  });

  test("句子切分处理中英文标点与换行", () => {
    expect(splitSentences("一句。两句！三句？").length).toBe(3);
    expect(splitSentences("A sentence. Another one!").length).toBe(2);
    expect(splitSentences("行一\n行二\n\n行三").length).toBe(3);
  });
});

describe("强断言识别", () => {
  test("中英文强断言模式命中", () => {
    for (const s of [
      "该方法证明了折叠问题可解",
      "这是首次实现原子级精度",
      "本方法显著优于所有基线",
      "该结论已被证实",
      "This work proves the hypothesis",
      "Our model significantly outperforms baselines",
      "It is the first to achieve state-of-the-art results",
    ]) {
      expect(isStrongClaim(s)).toBe(true);
    }
  });

  test("普通陈述不误判", () => {
    for (const s of ["该方法在基准上取得了可用精度", "作者报告了实验结果", "The paper reports an approach"]) {
      expect(isStrongClaim(s)).toBe(false);
    }
  });
});

describe("citationIntegrity", () => {
  test("全部真实引用 → 0 finding（阴性对照，防误杀）", async () => {
    const result = await citationIntegrity({
      draft: "已有工作在结构预测上取得进展[@jumper2021highly]。方法基于深度学习[@jumper2021highly]。",
      knownKeys: ["jumper2021highly"],
      baselines: baselines("jumper2021highly"),
      judge: new FakeJudge(),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.unknownKeys).toHaveLength(0);
    expect(result.judgedCount).toBe(2);
  });

  test("库外 key → hard finding，message 含 key 与修复指引", async () => {
    const result = await citationIntegrity({
      draft: "有工作报告了相反结论[@ghost2019fake]。",
      knownKeys: ["jumper2021highly"],
    });
    const hard = result.findings.filter((f) => f.severity === "hard");
    expect(hard).toHaveLength(1);
    expect(hard[0]!.rule).toBe(CITATION_RULE);
    expect(hard[0]!.message).toContain("ghost2019fake");
    expect(hard[0]!.message).toContain("不存在于项目文献库");
    expect(hard[0]!.message).toContain("lit search/add");
    expect(result.unknownKeys).toEqual(["ghost2019fake"]);
  });

  test("同一个假 key 出现多次 → 每处都定位（不合并掉后面的）", async () => {
    const result = await citationIntegrity({
      draft: "第一处[@fake1]。第二处[@fake1]。第三处[@fake1]。",
      knownKeys: [],
    });
    expect(result.findings.filter((f) => f.severity === "hard")).toHaveLength(3);
    expect(result.unknownKeys).toEqual(["fake1"]);
  });

  test("真 key 假内容 → soft finding，标注 inferred，不否决", async () => {
    const result = await citationIntegrity({
      draft: "该工作报告了在复合物预测上的完美表现[@jumper2021highly]。",
      knownKeys: ["jumper2021highly"],
      baselines: baselines("jumper2021highly"),
      judge: new FakeJudge(["复合物预测上的完美表现"]),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("soft");
    expect(result.findings[0]!.message).toContain("citation_conflict");
    expect(result.findings[0]!.message).toContain("inferred");
    expect(result.findings[0]!.detail!.evidence).toBe("inferred");
    expect(result.conflictKeys).toEqual(["jumper2021highly"]);
  });

  test("没有精读卡的 key 不做冲突判定（无对照基准就不臆断）", async () => {
    const judge = new FakeJudge(["任何"]);
    const result = await citationIntegrity({
      draft: "任何陈述[@nocard]。",
      knownKeys: ["nocard"],
      baselines: baselines("other"),
      judge,
    });
    expect(judge.seen).toHaveLength(0);
    expect(result.judgedCount).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  test("参考文献条目不送去做一致性判定（省调用 + 防误报），但仍查 key 是否在库", async () => {
    const judge = new FakeJudge();
    const result = await citationIntegrity({
      draft:
        "正文陈述[@k1]。\n## 参考文献\n- [@k1] Some Title. Author. 2021. Nature.\n- [@ghost2019fake] Fake. 2019.",
      knownKeys: ["k1"],
      baselines: baselines("k1"),
      judge,
    });
    // 只判正文那一处，参考文献那一行跳过
    expect(judge.seen).toHaveLength(1);
    expect(judge.seen[0]!.statement).toContain("正文陈述");
    // 参考文献里的库外 key 照样 hard
    expect(result.findings.filter((f) => f.severity === "hard")).toHaveLength(1);
    expect(result.unknownKeys).toEqual(["ghost2019fake"]);
  });

  test("判定器故障 → 汇总成一条可见的 soft finding，不静默当作一致", async () => {
    const result = await citationIntegrity({
      draft: "陈述一[@k1]。陈述二[@k1]。",
      knownKeys: ["k1"],
      baselines: baselines("k1"),
      judge: new FakeJudge([], ["陈述"]),
    });
    expect(result.judgeErrors).toBe(2);
    const finding = result.findings.find((f) => f.message.includes("citation_judge_unavailable"))!;
    expect(finding.severity).toBe("soft");
    expect(finding.message).toContain("2/2");
    expect(finding.detail!.judgeErrors).toBe(2);
  });

  test("强断言无引用 → soft finding；同句有引用则不报", async () => {
    const result = await citationIntegrity({
      draft: "该方法显著优于所有已有方案。另一处首次实现了端到端预测[@k1]。",
      knownKeys: ["k1"],
    });
    const unsupported = result.findings.filter((f) => f.message.includes("unsupported_claim"));
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.severity).toBe("soft");
    expect(unsupported[0]!.message).toContain("显著优于");
  });

  test("checkUnsupportedClaims=false 时关闭强断言检查", async () => {
    const result = await citationIntegrity({
      draft: "该方法显著优于所有已有方案。",
      knownKeys: [],
      checkUnsupportedClaims: false,
    });
    expect(result.findings).toHaveLength(0);
  });

  test("空草稿 / 无引用草稿不炸", async () => {
    expect((await citationIntegrity({ draft: "", knownKeys: ["k"] })).findings).toHaveLength(0);
    expect((await citationIntegrity({ draft: "一段没有引用的平实描述。", knownKeys: ["k"] })).findings).toHaveLength(0);
  });
});

describe("LlmCitationJudge", () => {
  test("解析裸 JSON 与围栏 JSON 的 verdict", async () => {
    const llm = new FakeLlm(['{"verdict":"conflict","reason":"说反了"}']);
    const judged = await new LlmCitationJudge(llm).judge({
      key: "k",
      statement: "S",
      baseline: BASELINE,
    });
    expect(judged.verdict).toBe("conflict");
    expect(judged.reason).toBe("说反了");
    // 对照基准与草稿句子都进了 prompt
    expect(llm.lastUserPrompt).toContain("CASP14");
    expect(llm.lastUserPrompt).toContain("S");

    const fenced = new FakeLlm(['```json\n{"verdict":"consistent","reason":"一致"}\n```']);
    expect((await new LlmCitationJudge(fenced).judge({ key: "k", statement: "S", baseline: BASELINE })).verdict).toBe(
      "consistent",
    );
  });

  test("输出无法解析 / 调用失败 → 抛错（由检查器汇总成可见的 soft finding）", async () => {
    await expect(
      new LlmCitationJudge(new FakeLlm(["随便说点什么"])).judge({ key: "k", statement: "S", baseline: BASELINE }),
    ).rejects.toThrow(/无法解析/);
    await expect(
      new LlmCitationJudge(new FakeLlm([{ ok: false, content: "[error] HTTP 500" }])).judge({
        key: "k",
        statement: "S",
        baseline: BASELINE,
      }),
    ).rejects.toThrow(/调用失败/);
  });

  test("未知 verdict 值不被接受", async () => {
    await expect(
      new LlmCitationJudge(new FakeLlm(['{"verdict":"maybe","reason":"x"}'])).judge({
        key: "k",
        statement: "S",
        baseline: BASELINE,
      }),
    ).rejects.toThrow(/无法解析/);
  });

  // P8-G5 实测发现：真实模型每轮有 2–6% 的判定不是判错，而是模型输出了一段思维链正文、
  // JSON 始终没出现（多为长推理被截断）。行为上是安全的（降级可见），但白白丢掉那部分
  // 检查覆盖率。重试一次成本极低。
  test("输出不合形状时重试一次；第二次给出 JSON 则判定成功", async () => {
    const llm = new FakeLlm([
      "让我仔细分析：\n(A) 精读卡说……\n(B) 草稿说……",
      '{"verdict":"conflict","reason":"说反了"}',
    ]);
    const judged = await new LlmCitationJudge(llm).judge({ key: "k", statement: "S", baseline: BASELINE });
    expect(judged.verdict).toBe("conflict");
    expect(llm.calls).toHaveLength(2);
    // 重试把上一轮的输出与「只输出 JSON」的指令一起带上，模型才知道自己错在哪。
    expect(llm.lastUserPrompt).toContain("只输出");
    expect(llm.calls[1]!.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  test("两次都不合形状 → 抛第一次的错误（带模型原本想说什么，诊断价值更高）", async () => {
    const llm = new FakeLlm(["第一次的胡言乱语"]);
    await expect(
      new LlmCitationJudge(llm).judge({ key: "k", statement: "S", baseline: BASELINE }),
    ).rejects.toThrow(/第一次的胡言乱语/);
    expect(llm.calls).toHaveLength(2);
  });

  test("截断与「没按格式说话」在错误消息里分得开（P8-G5：两种病要往不同方向修）", async () => {
    const truncated = {
      call: async () => ({
        ok: true as const,
        provider: "kimi" as const,
        model: "m",
        content: "让我分析一下：(A) 精读卡说",
        mock: false,
        finishReason: "length",
      }),
    };
    await expect(
      new LlmCitationJudge(truncated).judge({ key: "k", statement: "S", baseline: BASELINE }),
    ).rejects.toThrow(/输出被截断/);
    await expect(
      new LlmCitationJudge(new FakeLlm(["没有 JSON 的正文"])).judge({ key: "k", statement: "S", baseline: BASELINE }),
    ).rejects.toThrow(/没有可解析的 JSON/);
  });

  test("调用本身失败不重试（重试解决不了没有凭据，只会把一次失败变两次）", async () => {
    const llm = new FakeLlm([{ ok: false, content: "[error] no key" }]);
    await expect(
      new LlmCitationJudge(llm).judge({ key: "k", statement: "S", baseline: BASELINE }),
    ).rejects.toThrow(/调用失败/);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("ReviewerAgent 接入 citation-integrity", () => {
  function setup(markdown: string) {
    const dir = mkdtempSync(join(tmpdir(), "spark-p3-reviewer-"));
    const store = new ArtifactStore(join(dir, "artifacts.db"), join(dir, "storage"));
    const path = join(dir, "review.md");
    writeFileSync(path, markdown);
    // extractedCode 传空串：草稿不是代码产物
    const artifact = store.save(path, "", [], { sessionId: "s1" });
    return { store, artifact, dir };
  }

  test("伪造引用 → hard finding 并 veto", async () => {
    const { store, artifact } = setup("综述正文引用了[@ghost2019fake]。");
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: ["jumper2021highly"] },
    });
    const result = await reviewer.review("s1");

    expect(result.approved).toBe(false);
    expect(result.action).toBe("inject_notice_and_veto_completion");
    const finding = result.findings.find((f) => f.rule === CITATION_RULE)!;
    expect(finding.severity).toBe("hard");
    expect(finding.artifactId).toBe(artifact.id);
  });

  test("soft finding 不因 markdown 的位置加权升级为 hard（防误杀）", async () => {
    const { store } = setup("该方法显著优于所有已有方案。另有真实引用[@jumper2021highly]。");
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: ["jumper2021highly"] },
    });
    const result = await reviewer.review("s1");

    const citationFindings = result.findings.filter((f) => f.rule === CITATION_RULE);
    expect(citationFindings.length).toBeGreaterThan(0);
    expect(citationFindings.every((f) => f.severity === "soft")).toBe(true);
    expect(result.approved).toBe(true);
  });

  test("全真引用的 markdown 草稿通过 review（approved=true）", async () => {
    const { store } = setup("已有工作取得进展[@jumper2021highly]。");
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: {
        knownKeys: ["jumper2021highly"],
        baselines: baselines("jumper2021highly"),
        judge: new FakeJudge(),
      },
    });
    const result = await reviewer.review("s1");
    expect(result.approved).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  test("不注入 citations 配置时行为与 P2 完全一致（markdown 不被检查）", async () => {
    const { store } = setup("引用了[@ghost2019fake]。");
    const result = await new ReviewerAgent(store, [], new LineageGraph()).review("s1");
    expect(result.approved).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  test("非 markdown artifact 不跑引用检查", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-p3-reviewer-"));
    const store = new ArtifactStore(join(dir, "artifacts.db"), join(dir, "storage"));
    const path = join(dir, "notes.txt");
    writeFileSync(path, "文本里写了[@ghost2019fake]。");
    store.save(path, "", [], { sessionId: "s2" });
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: [] },
    });
    const result = await reviewer.review("s2");
    expect(result.findings.filter((f) => f.rule === CITATION_RULE)).toHaveLength(0);
  });
});
