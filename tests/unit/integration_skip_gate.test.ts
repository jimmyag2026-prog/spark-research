import { describe, expect, test } from "bun:test";
import { decideExitCode, summarize } from "../../scripts/check-integration-skip";

// δ-1（USAGE_LOG U7）· 绊线本身的门禁。
//
// 被测的是纯函数 `decideExitCode(bun 测试输出, bun 自己的退出码)`，喂的是真实形状的
// bun test 摘要文本（下面几段都照抄自实跑输出），不 spawn 子进程——所以这条用例
// 属于 `bun test tests/unit`，零额外耗时、不受并行噪音影响。
//
// 要守住的三件事：
//   ① 全部 skip → 退出 1（U7 现场：`0 pass / 8 skip / 0 fail`，27ms，读起来像绿的）
//   ② 一个用例都没收集到 → 退出 1（同一形态的另一半，U7 里点名的 pytest 零收集先例）
//   ③ 真有用例失败时原样透传 bun 的退出码——绊线不许把真失败改写成别的码

// U7 记录的现场输出（δ-1 修复前，`bun run test:integration` 的原样输出）。
const ALL_SKIPPED = `
 0 pass
 8 skip
 0 fail
Ran 8 tests across 3 files. [27.00ms]
`;

// δ-1 修复后同一条命令的实跑输出。
const ALL_PASSING = `
 8 pass
 0 fail
 11 expect() calls
Ran 8 tests across 3 files. [69.00ms]
`;

const PARTIALLY_SKIPPED = `
 6 pass
 2 skip
 0 fail
Ran 8 tests across 3 files. [70.00ms]
`;

const NOTHING_COLLECTED = `
 0 pass
 0 fail
Ran 0 tests across 0 files. [3.00ms]
`;

const HAS_FAILURE = `
 6 pass
 2 fail
Ran 8 tests across 3 files. [88.00ms]
`;

describe("check-integration-skip · summarize", () => {
  test("从 bun test 摘要里读出 pass / skip / fail", () => {
    expect(summarize(ALL_SKIPPED)).toEqual({ pass: 0, skip: 8, fail: 0, total: 8 });
    expect(summarize(ALL_PASSING)).toEqual({ pass: 8, skip: 0, fail: 0, total: 8 });
    expect(summarize(PARTIALLY_SKIPPED)).toEqual({ pass: 6, skip: 2, fail: 0, total: 8 });
  });

  test("摘要里没有某一项时按 0 计，不抛", () => {
    expect(summarize(NOTHING_COLLECTED)).toEqual({ pass: 0, skip: 0, fail: 0, total: 0 });
    expect(summarize("完全不是 bun test 的输出")).toEqual({ pass: 0, skip: 0, fail: 0, total: 0 });
  });
});

describe("check-integration-skip · decideExitCode", () => {
  test("① 全部跳过 → 退出 1（U7 现场：0 pass / 8 skip / 0 fail 不许再算通过）", () => {
    expect(decideExitCode(ALL_SKIPPED, 0)).toBe(1);
  });

  test("② 一个用例都没收集到 → 退出 1", () => {
    expect(decideExitCode(NOTHING_COLLECTED, 0)).toBe(1);
  });

  test("有 pass → 退出 0", () => {
    expect(decideExitCode(ALL_PASSING, 0)).toBe(0);
  });

  test("只跳过一部分、其余通过 → 退出 0（绊线只堵「全跳过」，不反对单条 skip）", () => {
    expect(decideExitCode(PARTIALLY_SKIPPED, 0)).toBe(0);
  });

  test("③ bun 自己非零退出时原样透传，不被绊线改写", () => {
    expect(decideExitCode(HAS_FAILURE, 1)).toBe(1);
    // 137 = 被 SIGKILL 打死（OOM / 超时杀进程）。这类码必须原样带出去，
    // 否则 CI 上「被杀」会被误报成「全跳过」，查错方向整个歪掉。
    expect(decideExitCode(ALL_SKIPPED, 137)).toBe(137);
    expect(decideExitCode("", 2)).toBe(2);
  });
});
