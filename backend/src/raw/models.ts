// v0.7 W7-D0 · L0 原始层的行形状（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §四）。
//
// 所有 kind 共用一个外壳：谁、什么时候、哪个项目、来源分级、链式 hash；payload 按 kind 分叉。
// **凭据永不进入**：payload 落盘前必经 `redact.ts`（源码门禁 G2 用带假 key 的 stub 调用
// 后 grep raw 目录）。

import type { ProvenanceClass } from "../provenance/policy";

// V85（v0.8 W8-1 β）：`simulation` 是第五个 kind——`exp run` 驱动的 SimulationPlatform
// 子进程（openmm/pyref/scanpy/pydeseq2/cobrapy）此前不经 KernelManager，raw 完全没记。
// 落点与其余非 connector kind 同规则（sink.ts 的 fileFor()）：`raw/simulation/<date>.jsonl`，
// 不按 platform 分子目录（`platform` 字段已经在行内，需要按平台切片时用它过滤即可）。
export const RAW_KINDS = ["connector", "llm", "kernel", "device", "simulation"] as const;
export type RawKind = (typeof RAW_KINDS)[number];

/** 超过阈值的响应体/原文落 blobs/，行内只留引用。 */
export type RawBody = { inline: string } | { blob: string; bytes: number } | { hashOnly: string; bytes: number };

export interface ConnectorPayload {
  connector: string;
  tool: string;
  host: string;
  method: string;
  params: Record<string, unknown>;
  status: number | string;
  latencyMs: number;
  contentType: string | null;
  response: RawBody | null;
}

export interface LlmPayload {
  provider: string;
  model: string;
  ok: boolean;
  failureKind: string | null;
  messages: RawBody;
  response: RawBody | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; usageUnavailable: boolean };
  options: Record<string, unknown>;
}

export interface KernelPayload {
  kernelId: string;
  kernelType: string;
  status: string;
  timedOut: boolean;
  /** 指向 artifacts.db `execution_records`（有的话）；D0 只存引用 + 内容 hash（用户 2026-09-11 裁定）。 */
  executionRecordId: string | null;
  source: RawBody;
  stdout: RawBody | null;
  stderr: RawBody | null;
  contentHash: string;
}

export interface DevicePayload {
  experimentId: string;
  runId: string | null;
  backend: string;
  stepId: string | null;
  reading: unknown;
}

// V85：`SubprocessSimulationPlatform`（simulation/platform.ts）的 prepare/submit/collect
// 三个生命周期阶段各落一行，用同一个 `runId` 串起来（prepare 阶段还没有 runId，取 null）。
// 与 KernelPayload 同口径：没有独立的 execution_records 写入方，行内自带 params/summary/files，
// 不只是引用。
export interface SimulationPayload {
  platform: string;
  // adapter 内部的任务种类（如 "damped-oscillator"）；不叫 `kind` 是为了不与外壳的
  // `RawEntry.kind`（="simulation"）撞名。
  simKind: string;
  stage: "prepare" | "submit" | "collect";
  runId: string | null;
  specHash: string | null;
  // prepare 阶段：归一化后的参数（脱敏）。submit/collect 阶段不重复记（已在 prepare 行里）。
  params: Record<string, unknown> | null;
  // submit：刚落盘的 RunRecord.state；collect：RunStatus.state。prepare 恒 null。
  status: string | null;
  // collect 阶段：SimulationOutputs.summary 的 JSON 序列化（大的走 blob，见 sink.body()）。
  summary: RawBody | null;
  // collect 阶段：产出文件清单（文件名/角色/字节数，不含绝对路径）。
  files: { filename: string; role: string; bytes: number }[] | null;
}

export type RawPayload = ConnectorPayload | LlmPayload | KernelPayload | DevicePayload | SimulationPayload;

export interface RawEntry {
  v: 1;
  id: string;
  ts: string;
  kind: RawKind;
  project: string | null;
  sessionId: string | null;
  command: string | null;
  provenanceClass: ProvenanceClass;
  license: string | null;
  prevHash: string | null;
  hash: string;
  payload: RawPayload;
}

/** `append()` 的输入：外壳里由 sink 补齐的字段（id/ts/prevHash/hash/v）不用调用方给。 */
export interface RawAppendInput {
  kind: RawKind;
  project?: string | null;
  sessionId?: string | null;
  command?: string | null;
  provenanceClass: ProvenanceClass;
  license?: string | null;
  payload: RawPayload;
  /** 测试注入固定时间。 */
  ts?: string;
}

export interface RawFilter {
  kind?: RawKind;
  since?: string;
  until?: string;
}

export interface RawVerifyResult {
  ok: boolean;
  lines: number;
  /** 第一条对不上的行号（1 起）；ok 时不存在。 */
  brokenAt?: number;
  reason?: string;
}

/** 社区替换点（照 SimulationPlatform 的做法）：默认 JsonlRawSink，测试 MemoryRawSink。 */
export interface RawSink {
  readonly id: string;
  append(input: RawAppendInput): RawEntry;
  iterate(filter?: RawFilter): Iterable<RawEntry>;
  /** 逐行重算 hash 与链；篡改任一行必报 brokenAt（门禁 G3）。 */
  verify(kind: RawKind, name?: string): RawVerifyResult;
  /** 正文落盘策略（inline / blob）由 sink 决定；`hashOnly` 由调用方按来源许可决定。 */
  body(text: string): RawBody;
}
