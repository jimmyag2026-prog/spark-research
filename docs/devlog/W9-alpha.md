# lane α devlog · 交互链路的速度与稳定性（W9-1）

分支 `feat/W9-alpha`，基线 `integration/v0.9-base`（f921bf0）。本文件边做边写，
供中断后接手。**本 lane 经历两次代理中断**（Anthropic API 连接被拒），第三个代理接手续做。

---

## α-0 · 接手前的状态复核（第三个代理）

上一个代理留下 `5f0ebcd wip(lane alpha)`，commit message 自述「未经任何验证」。
先实跑再决定沿用还是重做，结论是**沿用**——落盘的代码质量可用，只有三处小伤：

| 症状 | 实跑输出 | 根因 | 处置 |
|---|---|---|---|
| `llm_watchdog.test.ts` 1 fail | `expect(...).not.toContain("总时长超时")` 收到静默超时文案 | `idleTimeoutMessage()` 措辞里写了「这不是总时长超时」，把另一条标签**字面**带了进去；测试按标签判型于是两条都匹配 | 改措辞，两条 message 各自只含自己的标签 |
| `provider_error.test.ts` 1 fail | `TypeError: Header 'retry-after' has invalid value: '不是数字也不是日期'` | 测试 bug，不是源码 bug：`Headers` 只接受 ISO-8859-1，中文在**构造**时就抛，测的已不是 `parseRetryAfterMs` | 换成 ASCII 垃圾串 `neither-number-nor-date`，断言意图（不可解析 → undefined）不变 |
| `typecheck` 3 errors | `anthropic.ts:514 Property 'type' does not exist on type 'never'` | `streamError` 只在 `processLine` 闭包里赋值，TS 的 CFA 看不见，出循环后窄化成 `never`。基线代码原本用 `as` 断言绕过，上一个代理改写时把断言丢了 | 沿用基线的断言，但提到一处 `const framed`，读取点不再各自断言 |

**关于「const 加类型标注能不能代替断言」**：不能，先试过。`const framed: T | null = streamError;`
的声明类型虽是 `T | null`，CFA 仍按初始值的 `never` 窄化该 const，三条报错原样复现。
换回 `as` 才绿。这条记下来，免得下一个人再试一遍。

修复后：`bun test tests/unit/llm_watchdog.test.ts tests/unit/provider_error.test.ts` → **30 pass / 0 fail**；
`bun run typecheck` → 无输出（绿）。

---

## α-1 · 输出看门狗（`backend/src/llm/watchdog.ts`）

移植自上游 `output-watchdog.ts` 的计时状态机（Apache-2.0，文件头保留来源注释）。两处本仓库新增：

1. **时钟注入**（`WatchdogClock`）——单测用假时钟把整条时间线走完，不真 sleep；
2. **总时长硬上限**——上游只有静默超时，但一个「无限续期的病态流」会永远不结束。

语义要点：`progress()` 在**真实内容增量**到达时把剩余预算重置为满额；`delta("")`（role 帧 /
空 delta / 折叠成空串的 usage 帧）**不续期**。把「哪种帧算数」的判断收在 `delta()` 一处，
而不是散到每个调用点——散出去就会各写各的。

**两个超时的 message 必须互不包含对方的标签。** 第一版写的是「静默超时：…这不是总时长超时——」，
按标签判型的断言会同时匹配两条。两条 message 现在各自只含自己的标签，`IDLE_TIMEOUT_LABEL` /
`TOTAL_TIMEOUT_LABEL` 都导出，调用点与测试都按它判，不按自然语言判。

**非流式调用不开静默看门狗**（`resolveCallTimeouts` 里 `capabilities.streaming && options.onDelta`）：
非流式根本没有中途事件，对它开静默看门狗等于用一个更短的名字重新实现总超时，会把正常的慢响应杀掉。
——这一行同时是闸门 I 里 `ProviderCapabilities.streaming` 的**第一个真实读者**。

## α-2 · 错误规范化（`backend/src/llm/provider_error.ts`）

分类骨架移植自上游 `retry.ts`（只抄机制不抄类型：上游入参绑死在 Vercel AI SDK 的 `APIError`，
这里改成「HTTP 响应体 + 头」与「流内错误帧」两种来源）。

**前置（任务书要求的两条，都做了）**：两个 adapter 的失败路径现在都读 `response.headers`
（`Retry-After` / `retry-after-ms` 此前白扔），错误体截断从 200 / 400 字符放宽到
`MAX_ERROR_BODY_CHARS = 4000`——一条 OpenRouter 的错误 JSON 通常比 200 长，
截断点常常正好落在 `error.message` 中间。

**顺带修掉的一个静默失败**：`openai_compat.ts` 的流内 `data: {"error": {...}}` 帧此前走到
`json.choices?.[0]` 读成 undefined 后被**静默丢弃**，于是一次上游 502 会变成一个 `ok:true`
的空回答——U1 那条「失败没留下证据」的极端形态。现在第一条错误帧即终结本次流并显式失败。
**如实记一条残余**：已经通过 `onDelta` 吐出去的增量不会被撤回，调用方拿到的是「残缺的正文 +
一条明确的失败」。这比返回 `ok:true` 的半截内容诚实（后者会被 review 当成完整产出放行）。

### 与基线的一处冲突，以及怎么收的（重要）

上一个代理把 `overloaded` 收进 `RATELIMIT_PATTERNS`，于是 Anthropic 的 **529 `overloaded_error`
从 `upstream` 改判成 `rate_limit`**，并把这个差异写进了 `provider_error.test.ts` 的期望值。
全量 unit 跑出来才发现：`llm_anthropic.test.ts` 有一条基线断言「529 overloaded_error → upstream，
可重试」被这么改红了。

**测试只增不减——不许为了让新判据成立而把一条基线断言改绿。** 判据改成：

- **显式 5xx 一律走 `upstream`**（5xx 按定义是服务端故障）；
- 限流措辞只在**没有 5xx 状态码**时生效——流内错误帧那种只有措辞可依的场合。

两条路径 `retryable` 都是 `true`，**行为完全一致，差别只在 `errorKind` 这个标签**，
而标签正是 α-4 要落台账的东西，混了等于台账在说谎。「429 优先于溢出」完全不受影响
（429 不是 5xx），对应门禁用例仍绿；`provider_error.test.ts` 补了一条「无状态码的
overloaded_error 仍判 rate_limit」，把两边都钉住。

## α-3 · 三段结构化进度（`backend/src/agents/progress.ts`）

状态放在 emitter 里而不是四个接线点各维护一份计数——否则 `complete ≤ total` 这条不变式
没有任何地方能保证，收口 diff 也压不进 10 行。

**前端兼容性已确认**（任务书要求）：`frontend/workspace/src/lib/api.ts:133` 的消费端签名是
`onProgress?: (data: { message: string }) => void`，`center.tsx:66` 只读 `data.message`
（且只在「还没收到任何增量」时用它占位，不会覆盖正在流入的正文）。`ProgressEvent` 带着
`message: string`，多出来的 `stage` / `complete` / `total` / `decision` 被旧消费端原样忽略
——**前端一行不用改**。

## α-4 · 失败落 errorKind（`backend/src/usage/ledger.ts`）

- `errorKind` 用现成的 `LlmErrorKind`（七值），只在 `ok:false` 时写入。
- `errorMessage` 脱敏**比 `redactSecrets` 更狠**，因为落点不同：`LlmError.message` 是进程内的
  一次性对象，usage.jsonl 是**明文长期落盘**的文件。三层 = `redactSecrets` + 任何 ≥16 位连续
  字母数字串 + 截断 200。**已知代价，如实记**：第二层会把长 request-id 一起抹掉（它们也是
  ≥16 位字母数字串）。诊断主力是 `errorKind`，摘要是补充；宁可少一个 request-id，不可多一个 key 落盘。
- `byErrorKind` 对历史上 `ok:false` 但没有 `errorKind` 的行（α-4 之前写的，U1 现场那一行就是）
  **不计入**——凭空补一个 `unknown` 桶会把「我们当时没记」伪装成「我们记了、就是不知道」。

**落点范围比 U1 要求的大，如实交代**：`[llm] fail provider=… model=… kind=…` 这行日志打在
`usage/ledger.ts`（所有花钱路径的必经点，注释原文：「埋在这一处全体覆盖——不逐模块手写」），
因此 **CLI 路径也会打**，不只 server。U1 只要求 server 侧。判断是收益大于成本（CLI 失败同样
需要留痕，且走 stderr 不污染 stdout 契约），但这是一条**超出任务书范围的决定**，收口可否决。
日志**只打 kind 不打 message**（任务书要求）：message 即便脱敏过也可能带上游回显的请求片段，
而日志的受众比台账更广。

**V77（做到了）**：新增 `noUsage` / `noUsageCalls`，把「上游没返 usage 帧」与「查不到单价」分开——
前者补单价表也救不了，后者补上就解决，混在 `unknownCostCalls` 一个桶里等于把两件事的下一步
混成一件。provider 声称 `usageReported` 却没返 usage 时额外打一行告警（静默降级必须留痕）
——这一行是闸门 I 里 `ProviderCapabilities.usageReported` 的**第一个真实读者**。

---

## 阴性对照（四条全部真跑，逐条贴了输出）

| 条目 | 改法 | 结果 |
|---|---|---|
| α-1 | `progress()` 里删掉 `remaining = input.timeoutMs \|\| 0` | **红** 9 pass / **3 fail**；恢复后 12 pass / 0 fail |
| α-2 | 把「限流最优先」整块搬到溢出判据**后面** | **红** 16 pass / **2 fail**，含「含 'input token count' 的 429」那条；恢复后 18 pass / 0 fail |
| α-3 | 管线里不再调 `taskCompleted()`（模拟接线点漏发） | **红** 5 pass / **4 fail**，含「complete ≤ total」与「execute 至少一次」；恢复后 9 pass / 0 fail |
| α-4 | `redactErrorMessage` 改成恒等（只留截断） | **红** 5 pass / **2 fail**，含「假 key 不得出现在台账」；恢复后 7 pass / 0 fail |

---

## 六套件数字（本 worktree 实跑）

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 绿（无输出） |
| `bun test tests/unit` | **2530 pass / 0 fail**，200 文件，153.33s |
| `bun run test:concurrency` | 33 pass / 0 fail（10 文件） |
| `bun run test:timeout` | 4 pass / 0 fail（4 文件） |
| `bun run test:lab` | **26 passed**, 0 skipped（pytest） |
| `bun run test:e2e` | **25 passed**（chromium，19.8s） |

### ⚠️ 环境陷阱：`http_proxy` 让全部 HTTP 测试假红（值得写进 ops 笔记）

第一次跑全量 unit 是 **165 fail**，而且**基线也一样红**（`git checkout integration/v0.9-base -- backend/`
后复跑，同样 8 fail）。排查路径与结论：

1. 所有失败都是 HTTP 用例，任意路径都返回 **503 且 body 为空**——`app.ts:302` 的 `NOT_BUILT_HTML`
   是有内容的，所以这个 503 根本不是应用发的。
2. 最小复现（与本仓库完全无关）：

   ```ts
   const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("HELLO") });
   await fetch(`http://127.0.0.1:${s.port}/`);   // -> 503 ""
   ```
   外部 `curl` 同样 503，说明是**网络层拦截**，不是 Bun 也不是 Hono。
3. 真凶：shell 环境里有 `http_proxy=http://127.0.0.1:11081`（还有 `https_proxy` / `all_proxy`）。
   于是**连 loopback 的测试流量都被送进那个本地代理**，代理对临时端口一律 503。
4. 解法：`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`。加上之后
   **2530 pass / 0 fail**，而且耗时从 588s 掉到 153s（代理还在给每个请求加延迟）。

**教训**：`0 fail` 固然要信，`165 fail` 也一样要先问「是不是环境」。这次如果直接把 165 当成
自己的回归去修，会把一堆好代码改坏。判据是**基线复跑**——基线同样红，就不是这条 lane 的事。
**收口/CI 跑这套之前请先确认 `NO_PROXY` 覆盖 loopback。**

并行噪音另记一条：全量跑里 `scanpy_contract.test.ts` 与 `simulation_contract.test.ts` 各有 1 条
python probe 用例超时；**单独重跑分别 20/20 与 26/26 全绿**（_COMMON.md 预告过这个形态）。
加了 `NO_PROXY` 之后的那次全量跑里它们也绿了。

---

## 真实核验：**网络前提不达标，未测**

任务书要求先过 `DEVELOPMENT_PLAN_v0.9.md` §〇 第 7 条的网络前提：
`time_connect` 五次中位数 < 1s 且最大 < 3s。实测（`curl -w %{time_connect}` × 6，打 openrouter.ai）：

```
0.000275
FAIL          <- 六次里有一次直接失败
0.000253
0.002416
0.000205
0.000614
```

**这组数字不可用**：全部出向流量都经 `http_proxy=http://127.0.0.1:11081`，
`time_connect` 量到的是**到本地代理的那一跳**（亚毫秒级），不是到 OpenRouter 的建连时间——
判据在这种拓扑下没有意义；六次里还有一次整体失败。

按任务书「不达标就只记『网络不达标，未测』」的规定：**speed-probe 三轮真实核验未执行**，
墙钟 / 模型调用次数 / 失败次数与 errorKind 均无数据。看门狗与规范化的行为证据目前**只有
假时钟单测**，没有真实链路数据——这是本 lane 最大的一块欠账，留给 R6。
