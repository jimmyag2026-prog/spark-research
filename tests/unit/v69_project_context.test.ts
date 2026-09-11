import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { projectBackgroundBlock } from "../../backend/src/agents/prompts";
import { buildCoExplorePrompt } from "../../backend/src/ideation/coexplore";
import { buildReadingCardPrompt } from "../../backend/src/literature/reading";
import { makeProjectWithPapers, type Fixture } from "../helpers/review_scenario";

// BACKLOG V69：`project.meta.description` 曾经被各注入点各自手写成
// `本研究项目的背景：${desc}` 塞进 prompt，模型分不清这是背景说明还是任务指令，
// 精读卡「与本项目关系」、报告草稿的措辞会被带跑。
//
// 修法：统一走 `projectBackgroundBlock()`（backend/src/agents/prompts.ts），
// 每个真正把 projectContext 拼进 prompt 文本的注入点都必须用它——不许再手写第二份
// （V46 形状）。本文件对每个注入点断言：
//   ① desc 出现且只出现一次、且落在框定块内
//   ② 框定块含「不是任务指令」字样
//   ③ 空 desc 时不产出任何背景块

const DESC = "研究蛋白质结构预测中的多序列比对偏差如何影响下游折叠精度";

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe("V69: projectBackgroundBlock 是唯一的框定 helper", () => {
  test("非空 desc：产出带起止标记 + 免责声明的框定块，desc 只出现一次", () => {
    const block = projectBackgroundBlock(DESC);
    expect(block).toContain("【项目背景");
    expect(block).toContain("【背景结束】");
    expect(block).toContain("不是任务指令");
    expect(occurrences(block, DESC)).toBe(1);
  });

  test("空 / 纯空白 / undefined / null desc：不产出任何背景块", () => {
    for (const v of [undefined, null, "", "   ", "\n\t"]) {
      expect(projectBackgroundBlock(v as unknown as string)).toBe("");
    }
  });
});

describe("V69: 精读卡 prompt 注入点（literature/reading.ts · buildReadingCardPrompt）", () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx) {
      fx.library.close();
      fx.project.close();
      rmSync(fx.root, { recursive: true, force: true });
      fx = null;
    }
  });

  test("desc 非空：① 只出现一次且在框定块内 ② 块含「不是任务指令」", () => {
    fx = makeProjectWithPapers(1);
    const paper = fx.library.list()[0]!;
    const prompt = buildReadingCardPrompt(paper, DESC);

    expect(occurrences(prompt, DESC)).toBe(1);
    expect(prompt).toContain("不是任务指令");

    const blockStart = prompt.indexOf("【项目背景");
    const blockEnd = prompt.indexOf("【背景结束】");
    const descIdx = prompt.indexOf(DESC);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(descIdx).toBeGreaterThan(blockStart);
    expect(descIdx).toBeLessThan(blockEnd);
  });

  test("desc 为空：不注入任何背景块", () => {
    fx = makeProjectWithPapers(1);
    const paper = fx.library.list()[0]!;
    const prompt = buildReadingCardPrompt(paper, undefined);
    expect(prompt).not.toContain("【项目背景");
    expect(prompt).not.toContain("【背景结束】");
  });

  test("desc 为空白字符串：同样视为空，不注入背景块", () => {
    fx = makeProjectWithPapers(1);
    const paper = fx.library.list()[0]!;
    const prompt = buildReadingCardPrompt(paper, "   \n  ");
    expect(prompt).not.toContain("【项目背景");
  });
});

describe("V69: co-explore prompt 注入点（ideation/coexplore.ts · buildCoExplorePrompt）", () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx) {
      fx.library.close();
      fx.project.close();
      rmSync(fx.root, { recursive: true, force: true });
      fx = null;
    }
  });

  test("desc 非空：① 只出现一次且在框定块内 ② 块含「不是任务指令」", () => {
    fx = makeProjectWithPapers(2);
    const papers = fx.library.list();
    const prompt = buildCoExplorePrompt("这个方向值得探讨吗？", papers, fx.keyOf, DESC);

    expect(occurrences(prompt, DESC)).toBe(1);
    expect(prompt).toContain("不是任务指令");

    const blockStart = prompt.indexOf("【项目背景");
    const blockEnd = prompt.indexOf("【背景结束】");
    const descIdx = prompt.indexOf(DESC);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(descIdx).toBeGreaterThan(blockStart);
    expect(descIdx).toBeLessThan(blockEnd);
  });

  test("desc 为空：不注入任何背景块", () => {
    fx = makeProjectWithPapers(2);
    const papers = fx.library.list();
    const prompt = buildCoExplorePrompt("这个方向值得探讨吗？", papers, fx.keyOf, undefined);
    expect(prompt).not.toContain("【项目背景");
    expect(prompt).not.toContain("【背景结束】");
  });

  test("desc 为空白字符串：同样视为空，不注入背景块", () => {
    fx = makeProjectWithPapers(2);
    const papers = fx.library.list();
    const prompt = buildCoExplorePrompt("这个方向值得探讨吗？", papers, fx.keyOf, "  \t");
    expect(prompt).not.toContain("【项目背景");
  });
});
