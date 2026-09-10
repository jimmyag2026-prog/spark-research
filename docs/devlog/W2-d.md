# W2-d · B-b/B-c 向导 + 离线 demo + SSE 流（v0.4 P14）

lane：`W2-d`（波次 W2，第 4 条）· 模型：Opus 5 · 分支：`feat/W2-d`

## 交付了什么

- `backend/src/onboarding/providers.ts`（新建）：`detectProviders(env)`（6 个云端
  provider 的配置状态 + 能力位，**未配置的不猜能力位**）、`detectLocalOllama(env,
  fetchImpl)`（本地 Ollama/兼容端点探测，纯环回请求，失败不抛）。
- `backend/src/onboarding/init.ts`（新建）：`runInit()` —— `spark-research init` 向导
  的完整实现（建项目 → provider 探测 → 真实文献检索 → 证据图 → 下一步三条命令）。
- `backend/src/onboarding/demo.ts`（新建）：`runDemo()` —— `spark-research demo` 的
  完整实现（复用 `scripts/demo-research-thread.ts`，加人看得懂的输出 + 编译产物诊断）。
- `backend/src/index.ts`：只加了 `init` / `demo` 两个 `case` 分支 + 对应的两行
  `import`。**没有动 `HELP` 常量、没有动 `welcome()`**（零参数行为是 W1-d 的所有权）。
- `backend/src/server/routes/session.ts`：`/stream` 加了一层「预览流」（P14 SSE token
  流），只改了这一个路由文件。
- `frontend/workspace/src/lib/api.ts` / `frontend/workspace/src/components/center.tsx`：
  消费 `delta` SSE 事件，实时渲染预览文字，`result` 到达后用权威正文整体替换。
- `tests/unit/onboarding.test.ts`（新建）：13 个用例，覆盖 provider 探测、本地 Ollama
  探测、init 全流程（含幂等/默认 slug）、demo 离线保证（含阴性对照①）。
- `tests/e2e/workbench.spec.ts`：只加了一条新用例（⑬），未改既有 13 条。
- 本文件。

## `init` 向导的交互流程

```
$ spark-research init [slug] [--query "…"] [--name …] [--description …]
```

非交互式（**不用 readline**，见 `init.ts` 顶部注释的三条理由：向导产出要能在
CI/测试里确定性断言、`auth` 已经是仓库里交互问答的先例不需要第二种范式、slug 不给
就用时间戳生成 + `openOrCreate` 幂等）：

1. **建项目**——`ProjectManager.openOrCreate(slug, …)`，已存在就直接打开（重复跑
   `init` 不报错）。
2. **探测 provider**——6 个云端 provider（kimi/openai/anthropic/deepseek/qwen/
   openrouter）逐个报「已配置/未配置」+ 能力位（tool_calling/json_mode/streaming），
   **未配置的一律不猜能力位**（见下方「关键设计决策」）；再探测本地 Ollama
   （`SPARK_LOCAL_LLM_BASE_URL` 或默认 `127.0.0.1:11434` 打 `/api/tags`，800ms 超时，
   纯环回请求）。全部未就绪时额外给一句提示（文献检索不需要模型仍可跑）。
3. **真实文献检索**——复用 `runLitCommand(["search", query, "--limit", "10",
   "--add"], {manager, out, err})`（生产路径默认走真实 `ConnectorRegistry` +
   `CredentialStore`，测试路径靠 `InitOptions.searcher` 注入 cassette）。检索失败
   （没网络/来源要凭据）不中断向导，只提示。
4. **展示证据图**——`reportFor(project).counts` 逐行打印（papers/readings/ideas/
   dryExperiments/…/decisions）。
5. **下一步三条命令**——`lit search --add` / `report export` / `server`。

**关键设计决策——为什么不能天真地对每个 provider 都查 capabilities**：
`LLMRouter.resolve()`（router.ts，只读不改）对「优先 provider 没配 key」有隐式回退：
会退到任一已配置的 provider。如果 `detectProviders` 不管三七二十一都
`capabilitiesFor(某 provider 的代表模型)`，回退机制会让**所有**未配置的 provider
看起来都「有能力」——因为查询实际上被路由去问了别的、已配置的 provider。做法是：
只有确认这个 provider 自己的环境变量已经设置，才去查它的 capabilities；没配置就
诚实返回 `capabilities: null`。这正是阴性对照②要卡住的坑，见下文实跑记录。

实测（我本机环境恰好配了 `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` 且本地跑着
Ollama）跑通了一次真实 `init`：3 个 provider 正确报「已配置」带能力位，3 个正确报
「未配置」，本地 Ollama 正确探测到 5 个模型，文献检索命中 openalex/crossref/
europepmc（semanticscholar 429 限流，单个来源失败不影响整体，如实在输出里列出）。

## `demo` ——离线示例项目

**不重造**：完整链路已经是 P8 交付的 `scripts/demo-research-thread.ts`
（`runResearchThread`）——真实 CLI 入口（`runLitCommand`/`runIdeaCommand`/
`runExpCommand`/`runConclusionCommand`），外部依赖换成 cassette 回放
（`tests/helpers/literature_scenario.ts` 的 `searcherWith`）+ 脚本化 fake LLM
（`tests/helpers/ideation_scenario.ts` 的 `ScriptedLlm`）+ **真的** pyref 子进程
（零依赖、秒级、确定性）。`demo.ts` 只是包一层 CLI 输出：逐步打印 `runResearchThread`
的 `log` 回调、证据图统计、完整报告 markdown、`--out` 可选落盘。

实测：源码运行 0.3 秒跑完全部 8 步（提问 → 文献入库 → 精读卡/综述 → co-explore →
novelty check → 干实验 → 结论卡 review 门槛 × 2（一条故意伪造证据被否决，一条通过）
→ 导出报告），远低于 30 秒预算。

### 编译产物里的已知限制（BACKLOG V27）——比预想的范围更大

任务书提醒了 fixture 文件的 `import.meta.dir` 坑，**实测发现问题比这更系统**：
`runResearchThread` 建项目会先经过 `backend/src/project/records.ts` 第 116 行的
`readFileSync(join(import.meta.dir, "schema.sql"))`——这个文件不属于本 lane 所有权，
不能改。用 `bun run build` 编译出真实二进制实测：

```
$ ./dist/spark-research project new binary-baseline-test
❌ ENOENT: no such file or directory, open '/$bunfs/root/schema.sql'
```

**`spark-research project new`（跟本 lane、跟 demo 都无关的既有命令）在编译产物里
本来就是坏的。** 这意味着任何会建项目的命令——`init` 和 `demo` 都在内——在编译产物
里都会在建项目这一步就炸，根本走不到 fixture 读取那一步。这不是本 lane 引入的
回归，是 BACKLOG V27 记录的 17 个文件之一的既有缺陷，超出本 lane 所有权
（`backend/src/project/**`）能修的范围。

处理方式：`init.ts` / `demo.ts` 都在各自的 catch 分支里加了一层运行时判断
（`import.meta.dir.startsWith("/$bunfs")` + 错误信息含 `ENOENT`），编译产物里给出
清楚的诊断而不是让用户看裸堆栈：

```
$ ./dist/spark-research init binary-test2
❌ 建项目失败：ENOENT: no such file or directory, open '/$bunfs/root/schema.sql'
   这是单二进制发行版的已知限制（BACKLOG V27）：编译产物里 import.meta.dir
   指向虚拟路径，建项目读不到 schema.sql。请改用源码运行：`bun backend/src/index.ts init`。

$ ./dist/spark-research demo
❌ demo 在这个单二进制发行版里跑不了（BACKLOG V27 的已知限制，不是网络问题）：
   编译产物里 import.meta.dir 指向虚拟路径 /$bunfs/root/，demo 建项目 /
   读取示例数据依赖的文件路径读不到（ENOENT）。
   请改用源码运行：`bun backend/src/index.ts demo`（或克隆仓库后 `bun run` 跑源码）。
   原始错误：ENOENT: no such file or directory, open '/$bunfs/root/schema.sql'
```

源码运行（`bun backend/src/index.ts init|demo`）完全不受影响，上面「交互流程」/
「离线示例项目」两节的实测都是在源码模式下做的。**需要主会话或
`backend/src/project/**` 的 owner 处理**：`project/records.ts` 的 schema.sql
读取需要按 V27 的通用修法（静态 import，让打包器把内容编译进二进制，像
`backend/src/index.ts` 读 `package.json` 那样）改掉——这是「所有建项目命令」的共同
底座问题，价值比单修 demo 大得多。

## SSE token 流的实现与代价

P11 的 `CallOptions.onDelta` 在 provider adapter 层已经就绪（`openai_compat.ts` /
`anthropic.ts` 都实现了真正的流式解析），但 `OrchestratorAgent.chat()`
（`backend/src/agents/orchestrator.ts`，**不属于本 lane 所有权**）本身不是 token
级流式的——`processRequest` 内部做任务分解 + 执行，往往是不止一次模型调用，也没有
接受 `onDelta` 回调的口子。这条 lane 不能改 `agents/**`，所以做不到「权威回答本身
边生成边流出来」。

做法是加一层**预览流**：`mode === "chat"` 且请求没有显式 `{"preview": false}`
时，在权威 `ctx.agent.chat()` 调用之前，先用同一个 `ctx.llm()` 依赖发**一次独立的、
真正流式**的模型调用，逐块把 `delta` 事件吐给前端；权威调用照常发生，`result`
依旧一次性给完整正文（不变）。前端把预览文字当"模型正在生成"的实时反馈展示，
`result` 到达后整体替换掉预览文字（不是拼接），因为两者内容不保证一致（权威回答
走完整的 plan/execute/review 循环，预览只是一次独立的直接模型调用）。

**代价要如实说**：配置了真实 provider 时，一次 `mode:"chat"` 的 `/stream` 请求会
发生两次模型调用（一次流式预览 + 一次权威调用，后者内部可能还不止一次）。真正的
根治是让 `processRequest` 自己支持 `onDelta`，把预览和权威合而为一——**这需要改
`agents/orchestrator.ts`，交给主会话或该文件的 owner**。预览调用失败（没配
provider / 网络问题 / 注入的测试用 fake LLM 不支持 onDelta）一律安静地不发
`delta`，不影响权威流程；`preview: false` 可以显式关掉这次额外调用。

`app.ts` 不需要改动——`/stream` 路由已经由 W1 期的 `sessionRoutes()` 挂载好，本 lane
只是扩充了这一个 handler 内部的行为，没有新增路由。

前端消费：`frontend/workspace/src/lib/api.ts` 的 `StreamHandlers` 加了 `onDelta`；
`center.tsx` 的 `SessionStream` 累加 `delta.chunk` 实时渲染 markdown（配一条
"预览生成中…" 的 spinner 提示条，跟原来"思考中…"占位区分开），`onResult` 到达后
整段替换。没有任何 `delta` 到达也完全正常（没配 provider / fake LLM 不支持流式），
界面退化回原来的行为，不影响既有 13 条 e2e。

## 三次阴性对照（实跑记录）

### ① demo 断网 + 无 key 仍能跑通

`tests/unit/onboarding.test.ts` 里的常驻用例（不是一次性脚本——把 `globalThis.fetch`
换成必抛错的假实现，证明 demo 全程不依赖网络，而不是侥幸躲过一次真实请求）：

```
$ bun test tests/unit/onboarding.test.ts -t "阴性对照①"
bun test v1.3.14 (0d9b296a)

 3 pass
 10 filtered out
 0 fail
 10 expect() calls
Ran 3 tests across 1 file. [1302.00ms]
```

三个用例分别验证：全局 `fetch` 抛错时 demo 依旧走完 8 步并给出完整报告；两次运行是
确定性回放（结论数字逐位一致）；`--out` 真的把报告落盘。另外命令行手测（真实
`bun backend/src/index.ts demo`，本机有网络）0.3 秒跑完，产出与预期报告结构一致
（见上文「离线示例项目」节的完整输出）。

### ② 向导对「未配置的 provider」报成已就绪 → 测试红

临时把 `detectProviders` 改成不管三七二十一都查 capabilities（复现前面讲的
`LLMRouter.resolve()` 隐式回退陷阱）：

```diff
     const model = PROVIDER_MODELS[id][0];
     return {
       id,
       envVar,
-      configured,
-      capabilities: configured && model ? router.capabilitiesFor(model) : null,
+      configured: true,
+      capabilities: model ? router.capabilitiesFor(model) : null,
     };
```

重跑：

```
$ bun test tests/unit/onboarding.test.ts
...
error: expect(received).toBe(expected)
Expected: false
Received: true
      at .../onboarding.test.ts:34:28
(fail) ... > 没配置任何 key：全部 configured:false，capabilities 全部 null——不猜、不报已就绪
...
(fail) ... > 只配了 KIMI_API_KEY：kimi 报已配置且带能力位，其余仍然 false/null（不被隐式回退污染）

 11 pass
 2 fail
 47 expect() calls
```

精确卡住了"未配置报成已就绪"这个回归——正好是断言里点名要防的两条。用备份文件
（`cp`，不用 git）整体回退：

```
$ cp /tmp/providers.ts.bak backend/src/onboarding/providers.ts
$ diff -q /tmp/providers.ts.bak backend/src/onboarding/providers.ts && echo "IDENTICAL - restored"
IDENTICAL - restored
$ bun test tests/unit/onboarding.test.ts
 13 pass
 0 fail
```

### ③ SSE 改成一次性 dump → e2e 红

临时把 `session.ts` 的预览流实现改成攒够全部 chunk 再一次性 `sender.send`：

```diff
                 await ctx.llm().call([{ role: "user", content: message }], {
                   model,
                   onDelta: (chunk) => {
-                    if (!sender.closed) sender.send("delta", { chunk });
+                    __NC3_BUFFER.push(chunk);
                   },
                 } satisfies CallOptions);
+                if (!sender.closed) for (const chunk of __NC3_BUFFER) sender.send("delta", { chunk });
```

重跑 e2e 用例 ⑬：

```
$ SPARK_E2E_PORT=4424 bun run test:e2e --grep "⑬"
  ✘  1 … ⑬ SSE 预览流：delta 事件逐块到达（不是一次性 dump） (401ms)

    Error: expect(received).toBeGreaterThanOrEqual(expected)
    Expected: >= 140
    Received:    0
      426 |     expect(last - first).toBeGreaterThanOrEqual(DELTA_DELAY_MS * (DELTA_CHUNKS.length - 1) * 0.5);

  1 failed
```

首尾时间差精确变成 0（所有 delta 挤进同一个 tick），正是设计要卡住的退化。整体回退：

```
$ cp /tmp/session.ts.bak backend/src/server/routes/session.ts
$ diff -q /tmp/session.ts.bak backend/src/server/routes/session.ts && echo "IDENTICAL - restored"
IDENTICAL - restored
$ SPARK_E2E_PORT=4424 bun run test:e2e --grep "⑬"
  ✓  1 … ⑬ SSE 预览流：delta 事件逐块到达（不是一次性 dump） (405ms)
  1 passed (1.7s)
```

## 为什么 e2e ⑬ 不能用共享 fixture 服务器，也不能在 spec 文件里直接 import 后端

`tests/e2e/fixture_server.ts` 注入的 `ScriptedLlm`（`tests/helpers/ideation_scenario.ts`，
不属于本 lane 所有权）不支持 `CallOptions.onDelta`——它的 `call()` 一次性同步返回整段
文本，永远不会调用 `onDelta`，用它测不出"是不是真的分块"。

第一次尝试是在 spec 文件里直接 `import { startServer } from "../../backend/src/server/server"`
自己起一个独立 server 实例——**实测直接把整个 e2e 套件收集阶段炸掉**：

```
Error: Cannot find package 'bun' imported from .../backend/src/server/app.ts
Error: No tests found
```

原因：`bun run test:e2e` 内部调用 `playwright test`，Playwright 用 **Node.js**
加载/收集 spec 文件（不是 Bun），而 `backend/src/server/app.ts` 间接依赖只有 Bun
运行时才有的模块（`Bun.serve` 相关类型）。

改法：仿照 `fixture_server.ts` 的套路起一个独立子进程，但**不把子进程脚本落成仓库里
的常驻文件**——试过把它写成 `backend/src/onboarding/e2e_delta_fixture.ts` 静态文件，
结果被 `tests/unit/narrative_parity.test.ts`（孤儿模块门禁 AD-12，不属于本 lane
所有权，不能加登记例外）当场拦下：

```
error: 发现未登记的孤儿模块（生产代码里没有任何调用方）。
  backend/src/onboarding/e2e_delta_fixture.ts
(fail) 叙事一致性门禁（AD-12） > 孤儿模块：生产代码零引用者的文件必须在册，且在册理由不许为空
```

最终做法：`workbench.spec.ts` 的 ⑬ 号用例**在测试运行时现写一个临时脚本**（字符串
模板，用绝对路径 `import`，写进 `mkdtempSync` 出来的临时目录），`bun <临时脚本>
<port> <root>` 起子进程（`node:child_process.spawn`），裸 `fetch` 打
`/api/session/stream`，用时间戳断言分块到达——既不进孤儿门禁的射程，也不把 Bun-only
依赖带进 Playwright 的 Node 收集阶段。

## 六套件数字

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（两个 tsconfig 都过；`tests/e2e/tsconfig.json` 不在
  `typecheck` 脚本范围内，单独手测 `bunx tsc --noEmit -p tests/e2e/tsconfig.json`
  与改动前的错误集合**逐字节一致**（`kernels/manager.ts` × 2 + `reviewer/agent.ts` ×
  3，均为既有问题，非本 lane 引入）——已用 `git stash` 在同一 worktree 上切回改动前
  版本核实，随后用 `git stash apply <sha>` + `git stash drop` 安全还原） |
| `bun test tests/unit/` | **1133 pass / 0 fail / 0 skip**（基线 1120 + 本 lane 新增
  13，回归为零） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e`（`SPARK_E2E_PORT=4424`） | **14/14**（既有 13 条 + 本 lane 新增 1 条） |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

## 需要主会话 / 其他 lane 处理的事项

1. **`agents/orchestrator.ts` 加 `onDelta` 支持**（价值最高）：目前预览流是独立的
   第二次模型调用，配置了真实 provider 时每次 `/stream` 请求多付一次调用成本。
   真正的修法是让 `OrchestratorAgent.chat()` / `processRequest()` 接受一个可选的
   `onDelta` 回调，在它自己内部的模型调用上直接转发，这样预览与权威合而为一，
   `session.ts` 的预览层可以整个删掉。不在本 lane 所有权内（`backend/src/agents/**`
   明确禁止触碰）。
2. **`project/records.ts` 的 `schema.sql` 读取要按 BACKLOG V27 的通用修法处理**（价值
   也很高，且比预想的影响面更大）：这不是本 lane 引入的问题，但实测证实它让
   `spark-research project new` 本身在编译产物里就是坏的，进而拖累了本 lane 交付的
   `init` / `demo` 两个新命令。改成静态 import（像 `backend/src/index.ts` 读
   `package.json` 那样）应该能根治，具体交给 `backend/src/project/**` 的 owner。
3. **`HELP` 常量没有收录 `init`/`demo`**：任务书明确写了"只加 init / demo 两个 case
   分支"，本 lane 严格照做，没有动 `backend/src/index.ts` 里的 `HELP` 字符串常量（担心
   跟其他并行 lane 在同一段文本上撞车，且不确定这是不是本 lane 该管的边界）。这带来
   一个小的可发现性缺口：`spark-research help` 目前不会提示这两个新命令存在。建议
   主会话在收口时补两行。
4. **本地 Ollama 能力位是保守上报**（这不是 bug，是如实记录）：`router.ts` 对
   `local/*` 前缀模型一律报 `toolCalling:false, jsonMode:false`——因为无法在不打
   真实网络的前提下探测某个本地模型具体支不支持这些能力。`init` 向导原样转述了
   这份保守值，没有自己去猜。

## 已知未完成 / 诚实报告

- `init` 的文献检索步骤目前固定 `--limit 10`（为了让离线单测能对上
  `tests/helpers/literature_scenario.ts` 录制时用的 `PER_SOURCE=10` cassette 参数）。
  生产环境这个数字是否该做成 `--limit` 命令行参数，留给后续迭代——本 lane 没有加。
- `init` 不支持交互式覆盖已探测到的默认值（比如"要不要现在就跑 auth"）；如上文
  「关键设计决策」一节所述，这是刻意的非交互设计，不是遗漏。
- SSE 预览流只在 `mode === "chat"` 生效，`mode === "coexplore"` 没有预览（
  `CoExploreSession` 的 prompt/grounding 装配更复杂，见 `agents/orchestrator.ts`
  的 `coexplore()`，本 lane 不重新拼一份，只在 `session.ts` 顶部注释里如实写明）。
- `docs/devlog/W1-d.md` 在这个分支上实际不存在（`git log` 显示 W1-d 那次会话额度
  中断在"阴性对照的还原步骤之后"，没能写完 devlog）——本 lane 改为直接读
  `backend/src/index.ts` / `backend/src/doctor/index.ts` 里 W1-d 留下的详细代码注释
  （零参数行为的设计取舍、`import.meta.dir` 在编译产物里的坑）作为替代信源，
  已在「设计决策」与「编译产物限制」两节体现。
