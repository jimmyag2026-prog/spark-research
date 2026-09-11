import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir } from "../../backend/src/config";
import { globalRawRoot } from "../../backend/src/raw";
import { apiCallStorePath } from "../../backend/src/usage/api_ledger";

// v0.7 alpha.6 · V74 系统性门禁：任何 bun test 进程的数据目录都不许落在用户真实 ~/.spark-research 里。
// 事故见 tests/preload.ts 顶部注释（R4 抓到单测往真实目录写了 324MB raw）。
describe("测试数据目录隔离（tests/preload.ts）", () => {
  test("dataDir() / 全局 raw 根 / api_calls.jsonl 都不在 ~/.spark-research 下", () => {
    const real = resolve(join(homedir(), ".spark-research"));
    for (const p of [dataDir(), globalRawRoot(), apiCallStorePath()]) {
      const r = resolve(p);
      expect(r === real || r.startsWith(`${real}/`)).toBe(false);
    }
    expect(process.env.SPARK_RESEARCH_DATA_DIR).toBeTruthy();
  });
});
