import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// F-a / F-3：V15——`connectors/base.ts` 里 `MCPConnector` / `MCPConnectorConfig` /
// `MCPTool` 三个 deprecated 别名（P9 引入，v0.4 §2.2 明文「走废弃周期到 v0.5」，
// 周期已在 v0.4.0 发布时走完）已经删除。这个测试不是「测一次删干净了没」，是
// 「以后谁想图省事把它们加回来（哪怕只是为了兼容一个外部调用点），CI 会先红」——
// 跟本 lane 其余「不许再静默」的测试是同一种纪律：删除类工作最怕的不是当次没删净，
// 是半年后又悄悄长回来。
//
// 注意：这里刻意不用简单的全文 grep "MCPConnector" ——base.ts 里保留了一段说明
// 这段历史的注释（提到旧名字面文本），那是文档，不是代码，不该被这个测试打红。
// 只匹配「真的把它们当一个可用的导出/导入」的两种形态：
//   ① `base.ts` 自己重新 `export const/type MCP...`
//   ② 别处 `import { MCP... } from "..."`（哪怕只是类型导入）
// 两者任一出现，就说明别名话又活了，测试必须变红。
const ALIAS_DECLARATION = /export\s+(const|type)\s+MCP(Connector|ConnectorConfig|Tool)\b/;
const ALIAS_IMPORT = /import\s+(type\s+)?\{[^}]*\bMCP(Connector|ConnectorConfig|Tool)\b/;

function grepRepoFor(pattern: RegExp, dirs: string[]): string[] {
  const args = [
    "grep",
    "-rnE",
    pattern.source,
    "--include=*.ts",
    "--include=*.tsx",
    ...dirs.map((d) => join(import.meta.dir, "../..", d)),
  ];
  const res = Bun.spawnSync(args);
  // grep: 0=有匹配, 1=无匹配, >=2=真的出错。
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    throw new Error(`grep 执行失败: ${res.stderr.toString()}`);
  }
  const out = res.stdout.toString().trim();
  return out ? out.split("\n") : [];
}

describe("F-a / F-3：deprecated 别名（MCPConnector/MCPConnectorConfig/MCPTool）不许再出现", () => {
  test("backend/src 与 tests 里没有任何声明或导入这三个旧别名", () => {
    const declared = grepRepoFor(ALIAS_DECLARATION, ["backend/src", "tests"]);
    const imported = grepRepoFor(ALIAS_IMPORT, ["backend/src", "tests"]);
    expect(declared).toEqual([]);
    expect(imported).toEqual([]);
  });
});
