import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUTS, buildLlmsFullTxt, buildLlmsTxt } from "../../scripts/gen-llms-txt";
import { MCP_TOOLS, MCP_WITHHELD } from "../../backend/src/mcp/tools";
import { loadSkills } from "../../backend/src/skills/frontmatter";

// P9 · llms.txt 生成的**幂等性**（DEVELOPMENT_PLAN P9 验证项：
// 「llms.txt 生成脚本幂等（文档变更后重新生成 diff 干净）」）。
//
// 这组测试同时是一道 CI 门：改了 README/DESIGN/EXTENDING/技能手册却忘了
// 重新生成 llms-full.txt → 这里立刻红。让「文档与给 LLM 看的文本不同步」
// 这类静默腐烂变成一次显式失败。

const REPO_ROOT = join(import.meta.dir, "../..");

describe("llms.txt · 幂等", () => {
  test("连续两次生成逐字节相同（没有时间戳、随机序、Map 遍历序）", () => {
    expect(buildLlmsTxt()).toBe(buildLlmsTxt());
    expect(buildLlmsFullTxt()).toBe(buildLlmsFullTxt());
  });

  test("生成物与仓库里已提交的文件一致（改了文档要重新生成）", () => {
    for (const { file, build } of OUTPUTS) {
      const committed = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(
        build() === committed,
        `${file} 与当前文档不一致——请跑 \`bun scripts/gen-llms-txt.ts\` 后提交`,
      ).toBe(true);
    }
  });

  test("不含绝对路径与机器相关信息（换台机器生成结果必须相同）", () => {
    for (const { build } of OUTPUTS) {
      const text = build();
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("/home/");
      expect(text).not.toContain(REPO_ROOT);
      // 不读凭据状态：一台配了 aminer key 的机器与没配的机器要生成同一份文件。
      expect(text).not.toContain("credentialConfigured");
    }
  });
});

describe("llms.txt · 索引内容", () => {
  const index = buildLlmsTxt();

  test("开头就说清这是什么（LLM 只读前几行也能定位）", () => {
    expect(index.startsWith("# Spark Research\n")).toBe(true);
    expect(index.split("\n")[2]).toContain(">");
  });

  test("列出全部 MCP 工具与刻意不暴露的动作", () => {
    for (const tool of MCP_TOOLS) expect(index).toContain(`\`${tool.name}\``);
    for (const w of MCP_WITHHELD) {
      expect(index).toContain(`\`${w.name}\``);
      expect(index).toContain(w.humanAction);
    }
  });

  test("列出全部技能及其触发条件", () => {
    for (const skill of loadSkills()) {
      expect(index).toContain(skill.name);
      expect(index).toContain(skill.frontmatter.triggers[0]!);
    }
  });

  test("把「用这个工作台必须知道的几条」写进索引", () => {
    // 一个外部 LLM 可能只读 llms.txt 就开始用。那几条硬边界必须在索引里，
    // 而不是埋在 llms-full.txt 的第三千行。
    expect(index).toContain("人工批准是硬门");
    expect(index).toContain("检索不到 ≠ 新颖");
    expect(index).toContain("不许被静默吞掉");
    expect(index).toContain("模拟不是真实数据");
  });

  test("索引足够短（几十行量级，不是全量文档）", () => {
    expect(index.split("\n").length).toBeLessThan(260);
  });
});

describe("llms-full.txt · 全量内容", () => {
  const full = buildLlmsFullTxt();

  test("包含索引本身 + 全部文档 + 全部技能手册", () => {
    expect(full.startsWith("# Spark Research")).toBe(true);
    for (const rel of [
      "README.md",
      "docs/DESIGN.md",
      "docs/EXTENDING.md",
      "docs/DEVELOPMENT_PLAN.md",
      "docs/REVIEW_BRIEF.md",
      "docs/BACKLOG.md",
      "CHANGELOG.md",
    ]) {
      expect(full).toContain(`## 文件：${rel}`);
      // 不只是标题在——正文也要真的被摊平进来。
      const body = readFileSync(join(REPO_ROOT, rel), "utf8").trim().split("\n");
      expect(full).toContain(body[0]!);
    }
    for (const skill of loadSkills()) {
      expect(full).toContain(`## 技能：${skill.name}`);
    }
  });

  test("MCP 工具的完整描述与参数 schema 都在（外部 LLM 靠这段学会调用）", () => {
    for (const tool of MCP_TOOLS) {
      expect(full).toContain(`## ${tool.name}`);
      expect(full).toContain(tool.description.split("\n")[0]!);
    }
    expect(full).toContain('"additionalProperties": false');
  });
});
