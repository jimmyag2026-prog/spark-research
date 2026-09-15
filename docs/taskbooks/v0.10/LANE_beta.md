# lane β · 流式可见

对应方案 §三 β 与 §3.1–3.3。协议**只增不改**：`start/progress/delta/result/done/error` 六种保留。

| 项 | 做什么 | DONE / 门禁 |
|---|---|---|
| β-1 `progress` 补 `ts` / `elapsedMs` / `etaMs?` | `progress.ts` 的 emitter 记 startedAt 与各阶段均值（会话内）；eta 拿不准就不给字段 | 事件 schema 门禁（`server/types.ts` + contract 重生成）；`complete ≤ total` 不变式仍钉住 |
| β-2 `partial` 事件 | 新事件 `partial { kind: "papers" \| "search_source" \| "card", taskId, payload }`。`papers`：检索一回来推候选清单（标题/年份/DOI/来源，≤ 20 条）；`search_source`：每源 ok/failed/timeout/skipped + 条数；`card`：每张卡完成推 标题 + 一句 keyFindings + 相关性分。接线点：`literature_pipeline.ts` 的 `note` 同级加 `emitPartial` 回调（与 α 协调：α 改流程内部，你只加回调与事件出口） | e2e（假 LLM）：检索完成 ≤ 10s 收到 `partial.papers`；每张卡一条 `partial.card` |
| β-3 `delta` 补 `target` / `revision` | `delta { chunk, target: "summary" \| "review" \| "card:<paperId>", revision }`；综述与精读卡的 LLM 调用接 `onDelta`（`review.ts` / `reading.ts` 加可选回调）；重试时 revision +1 | e2e：综述正文逐块到达且 target=review |
| β-4 取消 | `/stream` 客户端断开 → `AbortSignal` 透传到 `llmFor` 与 `ConnectorRegistry.call`（`HttpClient` 加 signal）；LLM adapter 收到 abort 立即停 | 断开后 5s 内 `usage.jsonl` 不再新增行（V156 ③）；阴性对照：不透传 signal → 台账继续增 → 红 |

`routes/session.ts` 是收口专属：SSE 出口的 ≤10 行 diff 写进 devlog「收口 diff」。
