# W4-c · 长任务句柄落盘 + MCP 进度回传 + probe 缓存（v0.4 波次 W4）

> 三条互相独立、但都属于「长任务在外部 agent 眼里到底靠不靠谱」这同一类问题：
> 句柄能不能扛得住重连/重启（V11）、等待期间有没有反馈（V17）、反复探测会不会白等（V18）。

## 1. V11：长任务句柄落盘

### 1.1 存储形态

`<root>/tasks/<id>.json`，一个任务一个文件，内容就是完整的 `TaskSnapshot`（与内存里的
形状逐字段一致，不做二次编码）。每次 `emit()`（状态迁移 / `task.progress()` / 结果 /
错误）之后原子覆写：写一个 `<id>.json.tmp-<uuid>` 临时文件，再 `renameSync` 盖过去
——避免另一个读者（比如同一个 root 上刚构造的新 `TaskRegistry`）在写到一半时读到截断
的 JSON。这一整套形态照抄的是 `simulation/run_store.ts`（P5）已经验证过的「磁盘是真源」
思路，只是从「一个目录一个 `run.json` + 单独一个 `done.json`」简化成「一个文件、状态
本身就是判据」——长任务这边没有 P5 那种「编排进程与执行子进程分离、子进程自己写
done.json」的结构，一个文件足够。

`TaskRegistry` 的构造函数新增可选的 `root`：不给就是纯内存实现，与 V11 之前逐字节
一致（`tests/timeout/server_task.test.ts`、绝大多数 `new TaskRegistry({timeoutMs...})`
的现有用法完全不受影响）；给了才会 `mkdirSync(<root>/tasks)` 并在构造时把磁盘上已有的
快照读回内存（`hydrate()`）。

### 1.2 僵尸任务判定

判据是 `RunStore` 的「done.json 优先」思路的同构版本，见任务书提示，没有做进程
start-time 交叉核验（那是 BACKLOG V3 的范围，本 lane 不做）：

- 磁盘快照如果是终态（`succeeded`/`failed`）：**直接信**。这要么是任务体自己写下的，
  要么是 D-2 的 `TaskTimeoutError` 兜底写下的，不会说谎。
- 磁盘快照如果还是 `running`/`pending`：本进程压根没有那个 `run()` 闭包（闭包没法
  跨进程序列化），不可能真的在跑它——**继续报 `running`（安全方向：不谎称 `failed`，
  也不谎称 `succeeded`），但打上 `recovered: { at, reason: "no-terminal-record-on-disk" }`
  标记**。这个标记本身也会落盘，重启两次不会重复计算/重复告警（`recovered.at` 钉在
  第一次恢复的时刻）。

`TaskEntry` 新增 `live: boolean`：`start()` 创建的条目 `live=true`，`hydrate()` 读回来
的条目 `live=false`。`subscribe()` 对非 `live` 的条目和终态条目一视同仁——只补一次历史、
不挂订阅（挂了也永远不会被触发，本进程没有任何东西会再往里 `emit()`）。`settle()` 对
`hydrated` 记录也不会挂死：没有真实 `run()` 在跑，只能诚实地立刻返回当前快照（`running`
+ `recovered`），不装作在等一个永远不会来的结果。

`tests/unit/tasks.test.ts` 新增 7 条用例：不给 root 零痕迹、progress 与终态正确落盘、
跨实例读回终态（模拟重启，不需要重跑）、僵尸任务打标记、标记只计算一次（第三次重启
`recovered.at` 不变）、损坏/半写文件被跳过不拖垮 hydrate、超过 capacity 淘汰时磁盘文件
一并删除。

### 1.3 诚实说明：`ServerContext` 没有接线

`backend/src/server/context.ts` 里 `this.tasks = deps.tasks ?? new TaskRegistry();`
**没有传 `root`**——生产的 HTTP/MCP 长任务眼下仍然是纯内存实现，重启依然会丢句柄。
这不是遗漏，是本 lane 的文件所有权边界决定的：任务书只把 `backend/src/server/tasks.ts`
划给本 lane，`context.ts` 不在列表里（对比 W3-c 的先例：`ReviewerAgent` 的 findings 接线
同样做成「接口就位、调用方需要的时候自己配」，orchestrator.ts 的默认构造路径没有被那个
lane 碰）。`TaskRegistry` 本身已经按「caller 显式给 root 才启用持久化」的口径设计好、
测试也证明这条路径真实可用——接上 `context.ts` 只需要一行
`new TaskRegistry({ root: dataDir(...) })`，留给后续收口 lane。

**为什么不干脆默认给一个 `root`（比如读 `SPARK_RESEARCH_DATA_DIR`）**：本仓库测试纪律
的硬底线是「工作区根目录用 mkdtemp，绝不碰 `~/.spark-research`」（`tests/helpers/
server_scenario.ts` 开头就是这句话）。`ServerContext` 目前不会把 `deps.root`（测试传入
的 mkdtemp 路径）转发给 `TaskRegistry`——如果 `TaskRegistry` 在没有显式 `root` 时自己去
读 `SPARK_RESEARCH_DATA_DIR`/`~/.spark-research`，会导致**全仓库所有经 `createApp`/
`startServer` 起服务的测试**（不只是本 lane 的，`server_scenario.ts`/`mcp_scenario.ts`
两套脚手架背后几十个测试文件全部间接使用它）在没有人要求的情况下开始往测试机的真实
home 目录写任务快照文件——这比「暂时没接上持久化」严重得多。所以选择了更保守的
「不给 root 就是纯内存，行为零变化」，把接线的最后一步显式留给能动 `context.ts` 的人。

## 2. V17：MCP 长任务进度回传

### 2.1 事件形状

MCP 协议本身的 `notifications/progress`：

```json
{ "method": "notifications/progress", "params": { "progressToken": <string|number>, "progress": <number>, "total"?: <number>, "message"?: <string> } }
```

`progressToken` 由**客户端**在请求的 `_meta.progressToken` 里主动给（MCP SDK 的
`client.callTool(params, resultSchema, { onprogress })` 会自动带上）；协议原文写明
"the receiver is not obligated to provide these notifications"——所以服务端只在这次
请求确实带了 `progressToken` 时才构造回调，没要的客户端不会被打扰，行为与 V17 之前
完全一致（`tests/unit/mcp_server.test.ts` 的「客户端没有请求 progressToken 时不发通知」
一条专门钉住这点）。

### 2.2 接线位置：`McpToolRunner` 不认识 MCP SDK 的通知类型

`createMcpServer()` 的 `CallToolRequestSchema` handler 现在接收 `(request, extra)`：
从 `request.params._meta?.progressToken` 判断要不要接进度，要的话构造一个闭包
`onProgress`（内部调用 `extra.sendNotification(...)`），传给 `runner.call(name, args,
{ onProgress })`。`McpToolRunner.runLongTask()` 里的 `onProgress` 参数类型是本文件自己
定义的 `TaskProgressPayload`（`{done,total,message}`），**不 import
`@modelcontextprotocol/sdk` 的通知类型**——`McpToolRunner` 完全不知道、也不该知道自己
是不是被真实协议层调用（`McpFixture.call()` 这条测试路径压根不经协议层，见
`tests/helpers/mcp_scenario.ts`，两条路径必须都能用同一个 `McpToolRunner.call()` 签名）。

轮询循环里加了去重：同一个 `{done,total,message}`（`JSON.stringify` 比较）不重复通知
——`pollIntervalMs` 默认 400ms，多数子步骤耗时以秒计，原样转发每一次轮询会刷屏，
掩盖真正有信息量的那几条变化。

### 2.3 测试怎么证明「中途」而不是「结束时补发」

用一个「按需放行」的 fake LLM（`gatedLlm()`）卡住 `idea_coexplore` 内部的 LLM 调用——
这个路由在真正调 LLM **之前**就已经 `task.progress(0,1,"...")` 过一次
（`backend/src/server/routes/ideation.ts`），于是测试能制造一个「第一条进度已经产生、
任务却还没落定」的窗口：先 `waitFor(() => progressEvents.length > 0)`，再显式断言
**此刻 `callPromise` 还没有 settle**（`Promise.race` 探测），最后才 `release()` 放行
LLM、等待完成、确认第二条进度（`1/1`）也到了。这三步缺一不可——只看「最终 progressEvents
里有两条」区分不出「中途送达」和「结束时一次性补发两条」，本 lane 阴性对照②就是靠临时
把回传挪到只在 `state === "succeeded"` 时才发，实测这条测试会**超时**（`waitFor` 等不到
第一条），而不是简单的「值不对」——因为完成前压根不会有任何进度事件。

## 3. V18：`capabilities --probe` 结果缓存

### 3.1 缓存生命周期：模块级、进程内存，不是磁盘

`spark-research capabilities --probe` 每次 CLI 调用都是全新进程，模块级缓存跨进程无效
——但这本来就不是这个缓存要解决的问题（一次性 CLI 调用本来就只探测一次）。真正受益的
是**长驻的 MCP stdio 会话**：外部 agent 在同一个进程里反复 `research_capabilities
(probe=true)`，第二次起不用再等子进程（`Bun.spawn` 起 python 问 `import openmm`/起
opentrons 模拟器，秒级）。

### 3.2 失效判据：三段式 venv 指纹，没有 TTL

BACKLOG V18 原话「缓存必须带失效条件（venv 变更），否则它会撒谎」——直接对着这句话
设计判据，而不是引入一个任意时长的 TTL：

1. **解释器路径本身**（`resolvePython()` 的返回值：`SPARK_PYTHON` 换了 / 有没有
   `.venv`）。
2. **解释器文件的 mtime**（`.venv` 整个被重建，`python` 这个文件本身会是新的；
   `resolved` 先用 `Bun.which()` 解析 PATH，解析不到再退回直接 `statSync` 传入的路径
   本身——覆盖 `resolvePython()` 可能直接返回绝对路径的情况）。
3. **解释器所在 venv 的 `lib/python*/site-packages` 目录 mtime**（同一个解释器，
   `pip install`/`uninstall` 了包——新增/删除顶层条目通常会推进这个目录自己的 mtime，
   这是不用真的 spawn 子进程问一遍 `pip list` 就能检测「同一个解释器但装的包变了」的
   办法）。

三段拼成一个 JSON 字符串当 key；探测前先比对，**变了就整批清空**（不是只清被踩到的
那一条）——venv 是所有 python 子进程共享的运行时，一旦变了没有理由继续信任其它条目
的旧结论。

**为什么不加 TTL**：TTL 只会在指纹没变时制造无意义的重新探测（正好违背这个缓存本身要
解决的「白等子进程」），而它能多防住的场景本身就是指纹判据要独立承认的局限（见下面
「已知局限」），加一层 TTL 掩盖不了那个局限，只会在正常情况下拖慢命中率。

### 3.3 已知局限

指纹的第 3 段假设了 `<venvroot>/bin/python` → `<venvroot>/lib/python*/site-packages`
这个标准 venv 布局。不落在这个布局里的解释器——系统 python（比如这台机器上的
`/usr/bin/python3`）、pyenv shim、PEP 668 externally-managed 环境——`readdirSync` 会抛，
指纹退化成只剩「解释器路径 + 解释器文件 mtime」两段。这种退化下，**同一个系统解释器
上单纯 `pip install`/`uninstall` 一个包不会让缓存失效**（因为路径和解释器文件本身的
mtime 都不变）。这是指纹判据的真实局限，不是没想到——三段式已经覆盖了 BACKLOG 点名的
「venv 变更」这个具体场景（`SPARK_PYTHON` 换解释器、`.venv` 重建），系统 python 场景下
`pip install` 频率本来就低得多（生产推荐路径是 `.venv` + `uv pip install`，见
`docs/` 里 opentrons/openmm 的安装说明），可以接受。

### 3.4 测试与阴性对照③怎么证明「不撒谎」

核心测试：`SPARK_PYTHON=python3` 探测两次（第一次 miss、第二次 hit，证明缓存确实在
工作），然后把 `SPARK_PYTHON` 换成一个刚创建的 wrapper 脚本（`#!/bin/sh\nexec python3
"$@"\n`，转发到同一个真实 python3，探测结论本身不变，但路径和 mtime 两段指纹都变了），
第三次探测**必须**是 `miss`。阴性对照③把「探测前比对指纹」那段代码整段跳过（指纹照算
但从不拿去比较、也不清缓存），重跑这条测试：

```
error: expect(received).toBe(expected)
Expected: "miss"
Received: "hit"
(fail) capabilities · --probe 结果缓存（V18） > V18 核心判据：venv 变了（换了解释器路径 + mtime）→ 缓存整体作废，不撒谎报旧结果
```

精确复现了 BACKLOG 点名的失效模式——venv 变了，缓存却继续报旧结论。还原后重跑
`tests/unit/capabilities.test.ts`：31 pass / 0 fail。

## 4. 三次阴性对照（强制项，全部实跑）

流程统一：`Edit` 临时改代码 → 跑对应测试记录红 → `Edit` 还原 → 重跑确认恢复绿 →
`git status --short` 确认工作区只剩预期改动。

### ①（V11）拆掉僵尸任务的 `recovered` 标记 → 新用例变红

把 `hydrate()` 里打标记的两行换成 `void nonTerminal;`（不再设置 `snapshot.recovered`），
重跑 `tests/unit/tasks.test.ts -t "僵尸任务"`：

```
error: expect(received).toBe(expected)
Expected: "no-terminal-record-on-disk"
Received: undefined
(fail) TaskRegistry 落盘（V11） > 僵尸任务：进程重启后，磁盘上还是 running 的快照被诚实地打上 recovered 标记（不撒谎报成功/失败）

 0 pass
 12 filtered out
 1 fail
 4 expect() calls
```

证明「僵尸任务被报成 running 且无法分辨」这个判据真的靠这段代码撑着。还原后重跑
`tests/unit/tasks.test.ts`：13 pass / 0 fail。

### ②（V17）把进度回传挪到只在任务落定时补发一次 → 新用例超时变红

把轮询循环里的 `reportProgress(last.progress ?? null)` 挪到只在 `last.state ===
"succeeded"` 分支里才调用（模拟「进度回传接反：只在结束时发一次」），重跑
`tests/unit/mcp_server.test.ts -t "进度经 notifications"`：

```
(fail) MCP · 长任务进度回传（V17） > 进度经 notifications/progress 中途送达，不是结束时才补发一条 [5000.43ms]
  ^ this test timed out after 5000ms.

 0 pass
 19 filtered out
 1 fail
```

超时本身就是最直接的证据：测试在等「完成前至少有一条进度」，一旦进度只在结束时发，
这个条件永远等不到（因为要等到的那一刻任务已经完成了，但 gate 还没放行——死锁）。
还原后重跑 `tests/unit/mcp_server.test.ts`：20 pass / 0 fail。

### ③（V18）见 §3.4——最重要的一条，缓存悄悄撒谎，靠断言精确抓到

三次阴性对照结束后 `git status --short` 只剩预期改动：`backend/src/capabilities/
index.ts`、`backend/src/mcp/server.ts`、`backend/src/server/tasks.ts`（均为 M）、
`tests/unit/capabilities.test.ts`、`tests/unit/mcp_server.test.ts`、
`tests/unit/tasks.test.ts`（均为 M）、本文件（新增）——没有在工作区留下阴性对照的痕迹。

## 5. 六套件数字

全部在本 lane worktree（`SPARK_E2E_PORT=4443`）实跑，均为最终态（三次阴性对照的临时
改动已全部撤回后的重跑结果）：

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（`tsc --noEmit` 两遍，含 frontend/workspace） |
| `bun test tests/unit/` | **1311 pass / 0 fail / 0 skip**（基线 1298 + 本 lane 新增 13：`tasks.test.ts` +7、`mcp_server.test.ts` +2、`capabilities.test.ts` +4） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail（7 文件，未新增用例，跑它们只为确认零回归） |
| `bun run test:e2e`（`SPARK_E2E_PORT=4443`） | **14/14 passed** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

六套全绿，没有跳过、没有未跑成的套件。

## 6. 未完成 / 诚实说明

- **`backend/src/server/context.ts` 没有把 `root` 传给 `TaskRegistry`**——见 §1.3，
  文件所有权边界决定的，生产的 HTTP/MCP 长任务眼下仍是纯内存实现，`TaskRegistry`
  本身的落盘能力已就绪且测试完整，接线只差一行，留给后续收口 lane。
- **V18 的 venv 指纹在非标准 venv 布局下会退化**（见 §3.3）——系统 python / pyenv
  shim / PEP 668 环境下缺失 site-packages 探测这一段，纯粹靠解释器路径 + 文件 mtime
  判断变更，`SPARK_PYTHON` 换解释器和 `.venv` 重建这两个 BACKLOG 点名的场景完全覆盖，
  同一个系统解释器上单纯装/卸包不会触发失效——已在 §3.3 承认，不是没想到。
- **`--probe` 结果缓存没有暴露一个 CLI/HTTP 层面手动清空的入口**（`clearProbeCache()`
  只在测试里调用）——生产环境下 venv 真的变了会被指纹自动抓到，理论上不需要手动清空；
  如果指纹判据在某个没预料到的环境里失灵（比如 §3.3 的退化场景真的发生了），眼下唯一
  的绕过办法是重启那个长驻的 MCP 进程。
- 除上述三点外，本 lane 任务书列出的三项工作（V11 落盘 + 僵尸任务判定、V17 进度回传、
  V18 probe 缓存）均已完成并通过全部阶段门，三次强制阴性对照全部实跑并记录在案，没有
  其他已知缺口。
