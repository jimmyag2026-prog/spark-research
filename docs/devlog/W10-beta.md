# W10 · lane β（流式可见）devlog

分支 `feat/W10-beta`（基于 `integration/v0.10-base`），worktree `~/Desktop/AI4S/spark-research-beta`。
任务书：`docs/taskbooks/v0.10/LANE_beta.md`；方案 §三 β。协议**只增不改**：
`start / progress / delta / result / done / error` 六种保留，新增 `partial`，`progress` 补
`ts/elapsedMs/etaMs?`，`delta` 补 `target/revision`。

提交（每一小步 commit + push，push 后核 `git ls-remote`）：

| commit | 内容 |
|---|---|
| `f787ca7` | β-1：progress 补 ts/elapsedMs/etaMs?；partial/delta 事件类型；contract + SDK 重生成 |
| `907a62e` | β-2 + β-3：`emitPartial` 回调与三种 partial 事件；`reading.ts` / `review.ts` 可选 `onDelta` |
| `4d81b6e` | β-4：`AbortSignal` 透传到 `HttpClient` 与 `ConnectorRegistry.call` |

---

## β-1 · `progress` 补 `ts` / `elapsedMs` / `etaMs?`

改 `backend/src/agents/progress.ts`：
- `createProgressEmitter(onProgress?, { now? })`——注入时钟，eta 的算例才测得动（不注入 = `Date.now`）。
- `startedAt` 在 emitter 创建时记；`executeStartedAt` 在 `planned()` 时记。
- `elapsedMs = now - startedAt`；`ts` = 事件发出时刻。
- `etaMs`：**只在 execute 段、`complete ≥ 1` 且 `total > complete` 时给**，
  = `(execute 段已用时 / complete) × (total - complete)`。其余情况**不给这个字段**
  （任务书原话「eta 拿不准就不给」）。分子不含 plan 的耗时——否则一次慢 plan 会把
  第一个任务的 eta 整体抬高。

事件类型在 `server/types.ts` 里**转出去**（不复制第二份定义，同 settings 类型的既有先例），
`bun scripts/gen-contract-schemas.ts` + `bun run gen:sdk` 重生成，lane ε 与外部 SDK 按类型渲染。

`DeltaTarget` 没有写成模板字面量类型（`` `card:${string}` ``）：生成器不认，会在 schema 里
留一条 `{"$comment":"unhandled:..."}`——**宁可类型宽一格、契约诚实**。用 `cardTarget()` 构造。

## β-2 · `partial` 事件（papers / search_source / card）

接线点：`backend/src/agents/literature_pipeline.ts` 的 `note` **同级**新增 `emitPartial`
（外加 `taskId`、`onDelta`）。**只加回调与事件出口，不改流程逻辑**——流程内部（并行、预筛、S10）
归 lane α，它同期在改同一个文件。三个调用点都紧贴既有语句，不移动任何一行流程代码：

1. 检索一回来：每源一条 `search_source`（**失败源同样推**——否则「查了但失败」与「根本没查」
   在界面上一模一样，U43 的病），再一条 `papers`（≤ 20 条：id/标题/年份/DOI/命中源）。
   位置在下载与精读**之前**，这是「检索完成 ≤ 10s 页面出现论文标题」那条 DONE 的产生端。
2. 每张精读卡完成：接 `generateMany` 既有的 `onProgress`，取该卡的第一条 `keyFindings`
   作为「一句话关键发现」。`relevance` 现在恒为 `null`（管线还不产出分数；填 0 会被读成
   「判定为不相关」，那是另一件事，等 α-1 的预筛落地再填）。失败的那篇不推 card 事件
   （没有内容可推），由 `cardFailures` 与 `note` 如实交代。
3. 观察者抛异常（SSE 已关闭等）**不弄死管线**，但落 `note` 留痕，不是静默 `catch {}`。

## β-3 · `delta` 补 `target` / `revision`

- `literature/review.ts`：`GenerateDraftOptions.onDelta?`，`target: "review"`，
  `revision = attempt`——引用了库外 key 触发的重写是**另一稿**，不是同一稿的后续；
  不区分的话前端会把两稿首尾相接。
- `literature/reading.ts`：`GenerateCardOptions.onDelta?`，`target = cardTarget(paperId)`，
  `revision = attempt`（schema 校验失败重试 → 2）。
- 两处都只在**调用方给了 onDelta 时**才改成 options 形式调用 `llm.call`；不给时调用形状与
  接线前逐字节一致（`llm.models` 那条 U50 门禁照常绿）。
- 管线把 `deps.onDelta` 透给这两处；`RevisionCounter`（progress.ts）给收口侧统一算 revision。

## β-4 · 断连取消（V156 ③）

- `http/client.ts`：`HttpRequestInit.signal`。调用方的 signal 与超时 controller **并进同一个**
  （一个 fetch 只认一个 signal）；已 abort 的 signal 立刻透传。
  **取消不许伪装成超时**：`init.signal.aborted` 时抛原始 abort 错误，只有超时才抛 `HttpTimeoutError`——
  混成一种，重试逻辑会把「用户不要了」当成「上游慢」再打一次。
- `connectors/base.ts`：`ConnectorCallOptions`；`call()` / `requestRaw()` 透传到**全体 connector
  唯一的 HTTP 落地点**，handler 分支也把 options 递进去。
- `connectors/registry.ts`：`call(name, tool, params, { signal })`。
- LLM 侧不用改：`CallOptions.signal` 早就有，两个 provider 适配器已经 `effectiveSignal` +
  `raceWithAbort` 地在用（`llm/providers/*.ts`、`llm/watchdog.ts`）。**缺的只是从 `/stream`
  一路递到 `llmFor` 的那几行**，见下面「收口 diff」。

---

## 门禁（7 条，分三个文件）

| 文件 | 条数 | 钉的是 |
|---|---:|---|
| `tests/unit/w10_beta_stream.test.ts` | 3（β-1 状态机）+ 2（接线：契约里真有这些字段、事件名只增不改）+ 2（β-3 revision/target 形状） | 时间字段与 eta 算例；`complete ≤ total` 老不变式 |
| `tests/unit/w10_beta_pipeline.test.ts` | 6（假 LLM e2e） | papers 在下载/精读之前、一卡一条 card、综述逐块到达 `target=review`、库外 key 重写 → revision 1→2、不给回调 = 空操作、观察者抛异常留痕 |
| `tests/unit/w10_beta_cancel.test.ts` | 6 | 在飞 abort 立刻抛且**非**超时、超时老行为不变、registry → HttpClient 的 signal 是同一个对象、不给 signal 一字不差、abort 后 `usage.jsonl` 不增行 |

「接线」而不只是「内容」：β-1 的契约门禁读的是**生成出来的** `schemas.generated.json`
（类型改了却没转出去 → 红）；β-2/β-3 的门禁跑的是**真管线**（回调没被接到 review.ts 的调用点 → 红）；
β-4 的门禁读的是 **StubHttp 真收到的 init**（透传断在任一层 → 红）。

### 实跑原文

```
$ bun test tests/unit/w10_beta_stream.test.ts tests/unit/progress_emitter.test.ts
 17 pass / 0 fail / 120 expect() calls

$ bun test tests/unit/w10_beta_pipeline.test.ts
 6 pass / 0 fail / 45 expect() calls

$ bun test tests/unit/w10_beta_cancel.test.ts
 6 pass / 0 fail / 14 expect() calls

$ bun test tests/unit/v172_literature_pipeline.test.ts tests/unit/literature.test.ts tests/unit/lit_review_record.test.ts
 96 pass / 0 fail / 401 expect() calls

$ bun test tests/unit/http_client.test.ts tests/unit/connectors.test.ts tests/unit/connector_manifest.test.ts
 60 pass / 0 fail / 459 expect() calls

$ bun test tests/unit/contract.test.ts
 25 pass / 0 fail / 88 expect() calls

$ npx tsc --noEmit -p tsconfig.json
（无输出）
```

## 阴性对照（每条都实跑变红，改动前已 commit）

| # | 怎么破坏 | 结果（原文） |
|---|---|---|
| ① | `progress.ts` 的 emit 不再带 `etaMs` | `(fail) β-1 … etaMs：execute 段有样本才给…` · 7 pass 1 fail |
| ② | `server/types.ts` 不再转出 `ProgressEvent`（重生成 schema） | `error: ProgressEvent 没进 schemas.generated.json —— server/types.ts 没转出去` · 7 pass 1 fail |
| ③ | 摘掉 `partial("papers", …)` 调用点 | `(fail) β-2 … 检索一回来就推候选清单…` · 5 pass 1 fail |
| ④ | 摘掉 `partial("card", …)` 调用点 | 两条红（papers 顺序断言 + 一卡一条）· 4 pass 2 fail |
| ⑤ | 管线不再把 `onDelta` 透给 `reviewer.generate` | `error: 综述没有逐块到达——onDelta 没被接到 review.ts 的调用点` · 4 pass 2 fail |
| ⑥ | `base.requestRaw` 不再透传 signal | `error: signal 没到 HttpClient —— 透传断在 registry 或 base.requestRaw` · 4 pass 2 fail |
| ⑦ | `client.ts` 去掉「取消优先于超时」那一行 | `error: 取消被伪装成超时…` · 两条红 |
| ⑧ | 台账那条的假 LLM **忽略 signal**（= 不透传） | `error: abort 之后调用居然还成功了——signal 没被透传下去` · 5 pass 1 fail |

⑧ 就是任务书要求的那条：不透传 signal → 台账继续增 → 红。

---

## 收口 diff

两个枢纽文件本 lane **一行未碰**。为了把 diff 压进 10 行，收口要用的字段已经在
`agents/progress.ts` 里定义好了（`StreamHooks`、`DeltaEvent`、`PartialEvent`、`createRevisionCounter`）。

### ① `backend/src/server/routes/session.ts`（SSE 出口，6 行）

```diff
@@ app.post("/stream")
     return sseResponse(
       (sender) => {
         sender.send("start", { sessionId, mode, at: new Date().toISOString() });
+        // β-4：客户端一断开就取消整条管线（V156 ③）。
+        const cancel = new AbortController();
+        c.req.raw.signal.addEventListener("abort", () => cancel.abort(), { once: true });
         void (async () => {
@@
               onProgress: (event) => { if (!sender.closed) sender.send("progress", event); },
               onDelta: (chunk: string) => {
-                if (!sender.closed) sender.send("delta", { chunk });
+                // β-3：老 delta 补 target/revision（只增字段，读 chunk 的旧消费端不受影响）。
+                if (!sender.closed) sender.send("delta", { chunk, target: "summary", revision: 1 });
               },
+              onPartial: (event) => { if (!sender.closed) sender.send("partial", event); },
+              onDeltaEvent: (event) => { if (!sender.closed) sender.send("delta", event); },
+              signal: cancel.signal,
             });
```

**配套门禁**（收口时加进 `tests/unit/server_session.test.ts`）：一次 `/stream` 请求里，
文献流程产生的 `partial` 与 `delta` 事件都能在 SSE 流里读到，且事件序列仍以
`start` 开头、`done` 结尾（既有那条「依次发 start → progress → result → done」的断言不变）。

### ② `backend/src/agents/orchestrator.ts`（透传，9 行）

```diff
@@ imports
-import { createProgressEmitter, type ProgressEmitter, type ProgressListener } from "./progress";
+import { createProgressEmitter, type ProgressEmitter, type ProgressListener, type StreamHooks } from "./progress";
@@ private llmFor(sessionId: string | null)
     const withModel = (o: string | CallOptions = {}): CallOptions => {
       const c: CallOptions = typeof o === "string" ? { model: o } : o;
-      return model ? { ...c, model } : c;
+      const signal = sessionId ? this.sessionSignal.get(sessionId) : undefined;   // β-4
+      return { ...c, ...(model ? { model } : {}), ...(signal ? { signal } : {}) };
     };
@@ processRequest / processRequestWithTools 的 options 类型（两处同改）
-    options: { onDelta?: (chunk: string) => void; onProgress?: ProgressListener } = {},
+    options: { onDelta?: (chunk: string) => void; onProgress?: ProgressListener } & StreamHooks = {},
@@ executeTask 里的 runLiteraturePipeline(...)
                 note: (m) => { … },
+                emitPartial: options.onPartial,   // β-2
+                onDelta: options.onDeltaEvent,    // β-3
+                taskId: task.id,
@@ async chat(req)
     onProgress?: ProgressListener;
+    onPartial?: StreamHooks["onPartial"];      // β-2
+    onDeltaEvent?: StreamHooks["onDeltaEvent"];// β-3
+    signal?: AbortSignal;                      // β-4
@@ chat() 体内
+    if (req.signal) this.sessionSignal.set(req.sessionId, req.signal);   // β-4（chat 结束时 delete）
-    const result = await this.processRequest(req.message, req.sessionId, { onDelta: req.onDelta, onProgress: req.onProgress });
+    const result = await this.processRequest(req.message, req.sessionId, { onDelta: req.onDelta, onProgress: req.onProgress, onPartial: req.onPartial, onDeltaEvent: req.onDeltaEvent, signal: req.signal });
```

（`options` 要顺着 `executeTask` 的调用链多传一层——`executeTask` 现在只拿到 `progress`。
这是这段 diff 唯一的结构性改动，收口时按实际签名落，行数以 9–12 行计，**如实说：不止 10 行**。）

**配套门禁**（收口时加）：一次 `chat()` 里，`onPartial` 收到的 card 事件数 = 精读卡数；
`req.signal` abort 之后 `usage.jsonl` 不再增行（把 `w10_beta_cancel.test.ts` ③ 那条搬到 chat 层）。

---

## 与 lane α 的文件交叉点（收口要合的地方）

| 文件 | β 动了什么 | α 预计动什么 | 合的办法 |
|---|---|---|---|
| `agents/literature_pipeline.ts` | deps 加 `emitPartial` / `taskId` / `onDelta` 三个字段；检索后两个 emit 点；`generateMany` 的 options 里加 `onProgress` + `onDelta`；`reviewer.generate` 的 options 里加 `onDelta` | S9 两档综述、预筛、精读并行（`generateMany` 的 `concurrency`）、S10 | β 的改动全是**新增字段与新增调用**，没有移动/删除任何既有语句；α 若改写了 `generateMany(...)` 那一处调用，把 β 的 `onProgress` / `onDelta` 两个字段原样搬进新写法即可 |
| `literature/reading.ts` | `GenerateCardOptions.onDelta?`；`generate()` 里多一条流式分支 | 并发、maxTokens | 两边都动 `llm.call(...)` 那几行：**maxTokens 加在 options 对象里，与 onDelta 不冲突**；合的时候让非流式分支也带上 α 的 maxTokens |
| `literature/review.ts` | `GenerateDraftOptions.onDelta?`；同上 | S9 两档综述（quick 档新调用点）、maxTokens | 同上；quick 档的新调用点也要接 `onDelta`（否则 quick 档综述不流式），收口时补一行 |
| `connectors/base.ts` / `registry.ts` | `ConnectorCallOptions` + signal 透传 | α-5 按 host 令牌桶（`http/ratelimit.ts`） | 不同层，不冲突；令牌桶等待期间也应当响应 signal——**登记为收口后的跟进项**（见下） |

## 如实交代（没做完的 / 拿不准的）

1. **e2e 跑在管线层，不是 HTTP/SSE 层**。因为 `/stream` 出口与 orchestrator 透传是收口专属文件，
   本 lane 不改它们，所以「检索完成 ≤ 10s 收到 `partial.papers`」这条我钉的是**事件在管线里的位置**
   （在下载与精读之前、时间戳距开跑 < 10s，假 LLM 下），**不是**浏览器里真的 10 秒。
   真实 10s 取决于检索耗时（lane α 的活）与收口后的 SSE 出口，R7 复测时才算数。
2. **断连取消的端到端没实测**：③ 那条门禁证明的是「signal 透传到调用层 → 后续调用不发生 → 台账不增行」，
   以及 HttpClient/connector 这一路的透传是通的。**从 `/stream` 断开到 `llmFor` 的那几行还没接**
   （收口 diff ②）。V156 ③ 的验收要等收口后再跑一次真连接。
3. **connector 子类的 handler 内部没有转发 signal**：`call()` 把 options 递给 handler 了，
   但各子类 handler 内部再调 `requestRaw` 时多数没带上——那些源上「在飞的那一次请求」不会被取消，
   下一次请求才会。子类在 `connectors/**`（α/γ 的地），本 lane 不逐个改，登记为收口后的跟进项。
4. **令牌桶等待期间不响应 signal**：`RateLimitedHttp` 排队等待的那段时间里 abort 不会提前结束等待
   （等待结束后才发现 signal 已 abort）。同样登记为跟进项。
5. **`relevance` 恒为 `null`**：管线目前不产出相关性分，等 α-1 的批量预筛落地后填。
   现在填 0 会被前端读成「判定为不相关」。
6. **eta 的口径很朴素**（等权平均、只在 execute 段）。文献流程那种「一个任务内部跑 5 分钟」的场景，
   任务级平均给不出有用的 eta——那种情况下 `taskNote` 事件根本没有 `complete` 增量，所以按规则
   **不给 etaMs**，不是给了个烂数。要做得更准得按阶段均值建模，那是 v0.10 之后的事。
