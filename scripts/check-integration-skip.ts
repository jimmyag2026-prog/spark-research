#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

// δ-1（USAGE_LOG U7）：`bun test tests/integration` 在默认 FIXTURE_MODE=replay 下
// 是 `0 pass / N skip / 0 fail`——三个文件顶层都是 `describe.skipIf(!RECORDING)`，
// 只在 `FIXTURE_MODE=record|live` 时才真的打网络跑。这是**故意的**设计：
//
//   这几条链路的 replay 覆盖已经在 tests/unit/{literature,novelty,protein}_e2e.test.ts
//   里跑了（同一批 cassette、同一批断言，见三个文件各自的头部注释），并且那三个文件
//   **在** `bun test tests/unit` 的范围内，是 CI 主流水线每次都跑的部分。让
//   `tests/integration/*.test.ts` 在 replay 下也跑一遍，只是把同一件事在同一批 fixture
//   上验两遍——不是「补上没验证的链路」，是纯重复，CI 时间加倍换不来新覆盖。
//
// 所以根治点**不是**让它在 replay 下也执行，而是让「单独跑
// `bun run test:integration` 时全部 8 条被跳过」这件事在输出上**看起来不像通过**：
// `0 fail` 会让人误判为「过了」，这个脚本把「全部跳过」变成非零退出码——
// 该命令因此只在 FIXTURE_MODE=record/live（真打了网络）时才可能是绿的。
//
// 可测试性：核心判定逻辑是纯函数 `decideExitCode`，单测直接喂模拟的 bun test 文本输出，
// 不需要真的 spawn 子进程（见 tests/unit/integration_skip_gate.test.ts）。

export interface Summary {
  pass: number;
  skip: number;
  fail: number;
  total: number;
}

export function summarize(output: string): Summary {
  const passMatch = output.match(/(\d+)\s+pass/);
  const skipMatch = output.match(/(\d+)\s+skip/);
  const failMatch = output.match(/(\d+)\s+fail/);
  const pass = passMatch ? Number(passMatch[1]) : 0;
  const skip = skipMatch ? Number(skipMatch[1]) : 0;
  const fail = failMatch ? Number(failMatch[1]) : 0;
  return { pass, skip, fail, total: pass + skip + fail };
}

/**
 * bunTestExitCode：`bun test tests/integration` 自己的退出码。非零（真的有用例失败）时
 * 原样透传——「全 skip」判定只用来堵「看起来绿但什么都没跑」这一种情况，
 * 不能反过来把真失败盖成别的退出码。
 */
export function decideExitCode(output: string, bunTestExitCode: number): number {
  if (bunTestExitCode !== 0) return bunTestExitCode;
  const { skip, total } = summarize(output);
  if (total > 0 && skip === total) return 1;
  return 0;
}

if (import.meta.main) {
  const result = spawnSync("bun", ["test", "tests/integration"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  const exitCode = decideExitCode(stdout + "\n" + stderr, result.status ?? 1);
  if (exitCode === 1 && (result.status ?? 0) === 0) {
    const mode = process.env.FIXTURE_MODE ?? "(未设置，默认 replay)";
    console.error(
      "\n✖ check-integration-skip：tests/integration 全部用例都被跳过——这不是「通过」，" +
        `是本轮三条集成链路一次都没被验证。当前 FIXTURE_MODE=${mode}。\n` +
        "  replay 覆盖看 tests/unit/{literature,novelty,protein}_e2e.test.ts（CI 主流水线跑）；" +
        "要真打网络验证这三条链路本身：FIXTURE_MODE=record 或 FIXTURE_MODE=live bun run test:integration。",
    );
  }
  process.exit(exitCode);
}
