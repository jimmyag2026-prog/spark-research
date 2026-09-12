import { describe, expect, test } from "bun:test";
import { citationIntegrity, citedKeys, type CitationBaseline } from "../../backend/src/reviewer/rules.ts";

// V92（W8-δ · lanes/W8-delta.md）：CITATION_TOKEN 加 \p{Script=Han} 字符集，
// 让「两道核验门」（库内 key 存在性 / judge 输入提取）对中文 bibtex key 生效。
//
// 复刻修复前的正则（原样摘自 git blame 里 `[@key]` 那一行，仅 ASCII、无 `u` 标志）
// 只用来做阴性对照——不是重新实现产品逻辑，就是把「修复前长什么样」钉在测试里，
// 证明「库外中文 key 被静默放过」这件事真实存在过，不是臆造的靶子。
const PRE_V92_CITATION_TOKEN =
  /\[@([A-Za-z0-9][A-Za-z0-9_\-:]*(?:\s*[;,]\s*@[A-Za-z0-9][A-Za-z0-9_\-:]*)*)\]/g;

describe("V92 · 中文引用 key 可见", () => {
  test("中英混排、多 key 一括号、标点粘连——中文 key 都能被正确解析", () => {
    const md =
      "中文单 key：[@李某2023神经解码]。" +
      "中英混排一括号（分号+逗号并列）：[@李某2023神经解码; @smith2020deep, @王五2021脑机接口]。" +
      "标点粘连（引用后紧跟中文逗号/句号，无空格）：[@李某2023神经解码]，紧跟句号。";
    const keys = citedKeys(md);
    expect(keys).toContain("李某2023神经解码");
    expect(keys).toContain("smith2020deep");
    expect(keys).toContain("王五2021脑机接口");
    // ASCII 键的既有形态（字母数字 + -_:）不受影响，同一句话里两种键并存都要认出来。
    expect(citedKeys("兼容性 [@smith2020a-b_c:v2]")).toEqual(["smith2020a-b_c:v2"]);
  });

  test("阴性对照①：库外伪造中文 key —— 改前 citationIntegrity 静默放过（红），改后 hard finding（绿）", async () => {
    const forged = "这一结论来自伪造的中文文献 [@张三2099不存在文献]。";

    // 红：用修复前的正则重新走一遍「解析引用」这一步——伪造的中文 key 整条引用标记
    // 都不会被识别成引用，unknownKeys 永远是空，hard finding 根本不会产生。
    const preFixMatches = [...forged.matchAll(PRE_V92_CITATION_TOKEN)].map((m) => m[1]);
    expect(preFixMatches).toHaveLength(0);

    // 绿：真实 citationIntegrity()（已用上修复后的 CITATION_TOKEN）对同一句话
    // 正确解析出这条引用，且因为它不在库内（knownKeys 不含它）→ hard finding。
    const result = await citationIntegrity({ draft: forged, knownKeys: ["real2020key"] });
    expect(result.unknownKeys).toEqual(["张三2099不存在文献"]);
    const hard = result.findings.find((f) => f.severity === "hard");
    expect(hard).toBeDefined();
    expect(hard!.message).toContain("unknown_citation");
    expect(hard!.detail?.key).toBe("张三2099不存在文献");
  });

  test("阴性对照②：库内中文 key 的陈述能被送进 judge 做一致性核验（judge 输入提取门）", async () => {
    const key = "李某2023神经解码";
    const baseline: CitationBaseline = {
      key,
      title: "基于深度学习的神经信号解码方法",
      summary: "核心结论：仅在小样本（n=8）受试者上验证，未在大规模临床数据上测试。",
    };
    const seenKeys: string[] = [];
    const judge = {
      async judge(input: { key: string; statement: string }) {
        seenKeys.push(input.key);
        // 草稿声称"大规模临床数据"验证过，卡片里明确只提小样本——判 conflict。
        return { verdict: "conflict" as const, reason: "草稿声称的大规模临床验证在卡片里没有依据" };
      },
    };
    const draft = `该方法已经在大规模临床数据上验证有效 [@${key}]。`;

    // 若还是修复前的正则，这句话里的引用整体不可见，judge 永远不会被调用——
    // 用同一份数据先确认这一点，再看修复后的行为。
    expect([...draft.matchAll(PRE_V92_CITATION_TOKEN)]).toHaveLength(0);

    const result = await citationIntegrity({
      draft,
      knownKeys: [key],
      baselines: new Map([[key, baseline]]),
      judge,
    });
    expect(seenKeys).toEqual([key]); // judge 真的收到了这个中文 key 作为输入
    expect(result.conflictKeys).toEqual([key]);
    expect(
      result.findings.some((f) => f.severity === "soft" && f.message.includes("citation_conflict")),
    ).toBe(true);
  });
});
