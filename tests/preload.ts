// v0.7 alpha.6 · 测试数据目录隔离（V74 的系统性修法，bunfig.toml [test].preload 注入）。
//
// 事故：单测里大量 HttpConnector / 内核执行没有注入项目 raw sink，走 `globalRawSink()` 兜底，
// 兜底路径按 `dataDir()` 现算——没设 SPARK_RESEARCH_DATA_DIR 就是用户真实的 ~/.spark-research。
// 一天下来 43,680 行 connector 回放记录（含脚手架的假 connector）、253 行 kernel 记录、324MB
// 落进了用户的真实数据目录，与 R4 真实课题的行混在一起（api_calls.jsonl 从 W6-1 起同样如此）。
//
// 处置：每个 bun test 进程一进来就把 SPARK_RESEARCH_DATA_DIR 指到 mkdtemp（子进程继承 env，
// tests/concurrency 里的真实子进程也覆盖）。**例外**：显式设了 SPARK_RESEARCH_DATA_DIR 的
// （比如手工指向某个目录复现）与 fixture 录制/live 模式（integration 套件要读真实凭据）不动。
// 门禁：dataDir() 若仍落在 ~/.spark-research 下，直接抛错让整套测试红——不许静默写真实目录。

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mode = process.env.SPARK_FIXTURE_MODE ?? process.env.FIXTURE_MODE ?? "";
const recording = mode === "record" || mode === "live";

if (!recording && !process.env.SPARK_RESEARCH_DATA_DIR) {
  process.env.SPARK_RESEARCH_DATA_DIR = mkdtempSync(join(tmpdir(), "spark-test-datadir-"));
}

if (!recording) {
  const real = resolve(join(homedir(), ".spark-research"));
  const current = resolve(process.env.SPARK_RESEARCH_DATA_DIR ?? real);
  if (current === real || current.startsWith(`${real}/`)) {
    throw new Error(
      `tests/preload.ts：SPARK_RESEARCH_DATA_DIR=${current} 落在用户真实数据目录里——测试不许写真实目录（V74）。` +
        `要复现真实目录问题请显式设 SPARK_FIXTURE_MODE=live。`,
    );
  }
}
