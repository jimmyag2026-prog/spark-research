#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

// δ-1（USAGE_LOG U7）绊线。
//
// 背景：`bun test tests/integration` 曾经恒定 `0 pass / 8 skip / 0 fail`——三个文件顶层
// 都是 `describe.skipIf(!RECORDING)`，默认 FIXTURE_MODE=replay 下整套不执行。`0 fail`
// 让人读成「过了」，实际那三条链路一次都没被验证。根治已经做了（去掉 skipIf，replay 下
// 照常回放执行，见三个测试文件顶部注释），**这个脚本是绊线，不是根治**：
//
//   将来谁再加一道条件跳过、或把 fixture 删空导致整套被跳，`bun run test:integration`
//   会以退出码 1 失败，而不是又变回一条永远绿的流水线。
//
// 判据堵两种形态：「总数 > 0 且全部 skip」与「一个用例都没收集到」。bun test 自己非零
// 退出（真有用例失败）时原样透传——绊线不能反过来把真失败盖成别的退出码。
//
// 可测试性：核心判定是纯函数 `decideExitCode`，单测直接喂模拟的 bun test 文本输出，
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
  // 一个用例都没收集到，也是「什么都没验证却退出 0」。U7 里点名的先例就是这个形态的
  // 另一半：pytest 曾因文件名不匹配静默收集到零个用例，整个 Python 侧等于没有门槛。
  if (total === 0) return 1;
  if (skip === total) return 1;
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
    const { total } = summarize(stdout + "\n" + stderr);
    console.error(
      total === 0
        ? "\n✖ check-integration-skip：tests/integration 一个用例都没收集到——退出 0 不代表验证过。"
        : "\n✖ check-integration-skip：tests/integration 全部用例都被跳过——这不是「通过」，" +
          `是本轮三条集成链路一次都没被验证。当前 FIXTURE_MODE=${mode}。\n` +
          "  δ-1 之后这套用例在默认 replay 下就该执行（零网络，回放 tests/fixtures/**）；" +
          "全跳过说明有人重新加了条件跳过，或 fixture 不可用。",
    );
  }
  process.exit(exitCode);
}
