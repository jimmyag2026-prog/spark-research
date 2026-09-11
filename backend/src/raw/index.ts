// v0.7 W7-D0 · L0 原始层入口。
//
// 两种落点：
// - 项目内 `projects/<slug>/raw/`（Project.raw()）——有项目上下文的埋点都走这里；
// - 全局兜底 `<dataDir>/raw/`（globalRawSink()）——connector/kernel 在没有项目的调用路径
//   （capabilities 探测、daemon 的 mcp_call、chat 未绑定项目）也得记，**不记等于漏**。
//   门禁 G1 对账时两处合计。
//
// 与 api_ledger 同款理由：每次现算路径、不缓存单例（单测里同进程切换 SPARK_RESEARCH_DATA_DIR）。

import { join } from "node:path";
import { dataDir, type ConfigOptions } from "../config";
import { JsonlRawSink } from "./sink";
import type { RawSink } from "./models";

export * from "./models";
export * from "./redact";
export { JsonlRawSink, MemoryRawSink, sha256Of, sha256Text, entryHash, DEFAULT_BLOB_THRESHOLD } from "./sink";

export function globalRawRoot(options: ConfigOptions = {}): string {
  return join(dataDir(options), "raw");
}

export function globalRawSink(options: ConfigOptions = {}): RawSink {
  return new JsonlRawSink(globalRawRoot(options), { project: null });
}
