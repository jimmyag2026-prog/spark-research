import { describe, expect, test } from "bun:test";
import { legacyEnvViolations } from "../../backend/src/config";

// V127（A7 High-3）：V21 承诺「旧超时 env 名在任何命令启动时直接报错」，但 resolveSetting 只在
// 该设置**被读到**时才抛——doctor 不碰超时设置，于是四个旧名下全部静默 exit 0，与 INSTALL.md 矛盾。
// 阴性对照（已验红）：index.ts 去掉启动期扫描 → CLI 层面回到静默通过。

describe("V127 · 启动期扫描已移除的旧环境变量名", () => {
  test("四个旧超时名各自被拦，消息点名旧名与新名", () => {
    for (const [oldVar, newVar] of [
      ["SPARK_HTTP_TIMEOUT_MS", "SPARK_RESEARCH_HTTP_TIMEOUT_MS"],
      ["SPARK_LLM_TIMEOUT_MS", "SPARK_RESEARCH_LLM_TIMEOUT_MS"],
      ["SPARK_KERNEL_TIMEOUT_MS", "SPARK_RESEARCH_KERNEL_TIMEOUT_MS"],
      ["SPARK_TASK_TIMEOUT_MS", "SPARK_RESEARCH_TASK_TIMEOUT_MS"],
    ]) {
      const msgs = legacyEnvViolations({ [oldVar!]: "1000" });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain(oldVar!);
      expect(msgs[0]).toContain(newVar!);
      expect(msgs[0]).toContain("v0.8 移除");
    }
  });

  test("多个旧名同设 → 逐条列出；只设新名或都不设 → 空数组", () => {
    expect(legacyEnvViolations({ SPARK_HTTP_TIMEOUT_MS: "1", SPARK_TASK_TIMEOUT_MS: "2" })).toHaveLength(2);
    expect(legacyEnvViolations({ SPARK_RESEARCH_HTTP_TIMEOUT_MS: "1000" })).toEqual([]);
    expect(legacyEnvViolations({})).toEqual([]);
    expect(legacyEnvViolations({ SPARK_HTTP_TIMEOUT_MS: "" })).toEqual([]);
  });
});
