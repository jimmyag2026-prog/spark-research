# lane α · 交互链路的速度与稳定性（U1 / U4 / V77）— worktree `~/Desktop/AI4S/spark-research-alpha`，分支 `feat/W9-alpha`

先读 `_COMMON.md` 逐条遵守，再读 `docs/USAGE_LOG.md` 的 **U1 与 U4** 证据段。基线 `v0.9.0-alpha.1`（含闸门 H：**V137 的重试循环已在 `router.ts`**，你在它之上加看门狗和规范化，不要重写重试）。

对标：OpenScience `backend/cli/src/session/` 的 `output-watchdog.ts`（99 行）· `retry.ts`（`normalizeProviderError` 段）· `contract-progress.ts`。只读只读克隆 `~/Desktop/AI4S/spark-research-v0.5-plan/upstream/openscience/`，**不复制代码，复制机制**。

## 四件事（四个 commit）

### α-1 · 输出看门狗（新 `backend/src/llm/watchdog.ts`）
现状：`llmTimeoutMs`（默认 120000）是整个调用的平摊墙钟超时。实测一次真卡住等了 75 秒才失败；反过来一个正在慢慢吐 token 的长回答会被无辜杀掉。
交付：`outputWatchdog({ timeoutMs, signal, expire, onTimeout })`，语义照抄上游：**只计等待模型事件的时间**；`progress()` 在**真实内容增量**到达时把剩余预算重置为满额；**元数据事件（usage 帧、role 帧、空 delta）不续期**；`pause(true/false)` 供工具执行/权限等待期间暂停计时。`CallOptions` 加 `idleTimeoutMs?: number`（默认取 `llmTimeoutMs`，语义变了：从「总时长」变「静默时长」），旧 `timeoutMs` 保留为总时长硬上限（默认 `idleTimeoutMs × 3`）。**两个超时都要落 `LlmError.kind = "timeout"`，但 message 里区分「静默超时」与「总时长超时」。**
接入点（收口 diff，你只写 diff 不改 router.ts）：`LLMRouter.call()` 的流式分支——每个 `onDelta` 内容块调 `progress()`。
测试 `tests/unit/llm_watchdog.test.ts`：① 静默 > idle → timeout ② 持续 delta 超过 idle 总长但每次间隔 < idle → 不超时 ③ 元数据帧不续期 ④ pause 期间不计时 ⑤ 总时长硬上限仍生效。用假计时器，不要真 sleep。

### α-2 · 跨 provider 错误规范化与分类（新 `backend/src/llm/provider_error.ts`）
现状：`classifyHttpError` 只在 `anthropic.ts` 有一份；openai_compat 各写各的；流式错误帧（无 statusCode）没人分类。
交付：`normalizeProviderError(raw): { statusCode?, code, type, message }`——从 HTTP 响应体和流内错误帧两种来源提取，处理 `error.code` 为数字（OpenRouter 用它放 HTTP 类）、`error.metadata.error_type`、裸 `{"error":"token"}` 三种形状。`classify(normalized): { kind: LlmErrorKind, retryable: boolean }`：
- 429 / `too_many_requests` / 文本含 rate limit / quota / overloaded / resource exhausted → `rate_limit`，可重试
- ≥500 / `server_error` / `internal_error` → `upstream`，可重试
- 上下文溢出（`context_length_exceeded`、或文本含 "context window" / "prompt is too long" 等）→ `unsupported`，**不可重试**；**但 429 优先于溢出，限流措辞必须排除出溢出模式**（上游这条注释原因：瞬时限流会被误判成终态「输入太大」）
- 401/403 → `auth`，不可重试；400 且非溢出 → `parse` 或 `unsupported`，不可重试
`Retry-After` / `retry-after-ms` 头解析成 `retryAfterMs` 放进规范化结果，V137 的退避在有它时**按 provider 给的时间表走**（收口 diff）。
测试 `tests/unit/provider_error.test.ts`：每种形状一条 + **「含 'input token count' 的 429 → rate_limit 不是 unsupported」**这条必须有。

### α-3 · 三段结构化进度（新 `backend/src/agents/progress.ts`）
现状：`routes/session.ts:95` 只发一次固定文案「规划与执行中」，plan 三秒还是三十秒界面都不动。
交付：类型 `ProgressEvent = { stage: "plan"|"execute"|"summarize"|"review", complete: number, total: number, decision?: "ready"|"continue"|"repair"|"await_user", message: string }` + `createProgressEmitter(onProgress?)`。`total` 在 plan 完成后确定（= 任务数），`execute` 每完成一个任务发一次 `complete++`，review 有硬 finding 进修正轮时 `decision: "repair"` 并把 `total` 加上修正任务数。
接入点（收口 diff）：`orchestrator.ts` 的 `plan`(683) 前后、`executeTask`(749) 每次返回、`summarize`(909) 开始、`reviewSession`(959) 返回；`routes/session.ts:95` 改成把 emitter 事件原样 `sender.send("progress", event)`。前端 `onProgress` 已经接了 `data.message`，**不用改前端**，但你要在 devlog 里确认 message 字段格式与 `center.tsx:66` 兼容。
测试 `tests/unit/progress_emitter.test.ts`：三段各至少一次事件、`complete ≤ total` 恒成立、repair 时 total 增加。

### α-4 · 失败可诊断（`backend/src/usage/ledger.ts`）
现状：`ok:false` 只有一个布尔，`LlmErrorKind` 七值定义了没落台账；server 对失败零日志。
交付：usage 记录加 `errorKind?: LlmErrorKind` 与 `errorMessage?: string`（**≤ 200 字，经脱敏**：删 `sk-…`、`Bearer …`、任何 ≥16 位字母数字串）；`usage --json` 加 `byErrorKind: Record<kind, count>`；server 对每条 `ok:false` 打一行 `[llm] fail provider=… model=… kind=…`（不打 message）。
测试 `tests/unit/usage_error_kind.test.ts`：① 失败记录带 kind ② 脱敏（塞一个假 key 进错误体，台账里不得出现）③ `byErrorKind` 计数正确。
**V77 顺带**：`unknownCostCalls` 现在只记数；如果 α-2 能拿到 usage 帧但拿不到单价，把这种情况单独计成 `unpricedCalls`，与「上游没返 usage」分开。做不到就如实写。

## 真实核验（尽力如实，写进 devlog）
用 `speed-probe` 项目（已存在）跑 3 轮同一条 chat，记每轮：墙钟、模型调用次数、失败次数与 errorKind。**先测网络前提**（`R6_A8.md` §网络前提），不达标就只记「网络不达标，未测」。

## 足迹
- 允许：`backend/src/llm/watchdog.ts`（新）· `backend/src/llm/provider_error.ts`（新）· `backend/src/llm/types.ts` · `backend/src/llm/providers/openai_compat.ts` · `backend/src/llm/providers/anthropic.ts`（把各自的分类换成调 `provider_error`）· `backend/src/agents/progress.ts`（新）· `backend/src/usage/ledger.ts` · `backend/src/usage/cli.ts`（若 `usage --json` 输出在此）· 四个新测试文件 · `docs/devlog/W9-alpha.md`
- 禁止：`backend/src/llm/router.ts` · `backend/src/agents/orchestrator.ts` · `backend/src/server/routes/session.ts` · `frontend/**`——接入点全部以 ≤10 行 diff 交收口

## 阴性对照
- α-1：`progress()` 里不重置 `remaining` → 测试②红。
- α-2：把 429 优先判据去掉 → 「含 input token count 的 429」测试红。
- α-3：`executeTask` 返回处不发事件 → `complete ≤ total` 测试红（complete 永远 0 而 total > 0 时另一条「execute 至少一次」红）。
- α-4：脱敏函数改成恒等 → 脱敏测试红。
