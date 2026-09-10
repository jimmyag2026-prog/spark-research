# W4-d · 装载强度③「外部 MCP client」（v0.4 P15 X-c，扩展三强度里的第三种）

lane：`W4-d`（波次 W4，第 4 条）· 模型：Opus 5 · 分支：`feat/W4-d`

## 交付了什么

- `backend/src/extensions/mcp_client.ts`（新建）：装载强度③的核心实现。
  - `McpClientConfig` / `validateMcpClientConfig` / `loadMcpClientConfig`：`mcp.json`
    的 schema（command / args / cwd / env 白名单 / credentials 映射 / 超时 / `verifySample`）。
  - `resolveMcpChildEnv()`：凭据 → 子进程环境变量的**唯一**合法路径，经
    `buildExtensionContext()`（W2-c 交付，只读复用），声明+授权缺一不可。
  - `connectExternalMcp()`：启动子进程、握手、`listTools()`，全程吞异常返回结构化
    `{ok, reason}` / `{ok, session}`，绝不向上抛出未捕获异常。
  - `ExternalMcpSession.call()`：外部工具调用的**唯一**入口，每次调用（成功/失败/
    超时/未知工具）返回前必落一条执行记录（`appendMcpCallRecord`）——差异化点的
    结构性保证。
  - `discoverExternalMcpTools()` + `.mcp_discovery.json` 发现缓存：`capabilities.ts`
    读它判定 mcp_client 扩展状态，不为了回答"有什么工具"顺手再起一次子进程。
  - `ExternalToolRegistry`：`mcp:<extension>:<tool>` 前缀路由表，`specs()`/`has()`/`call()`。
  - `createExternalToolRunner()`：`async` 工厂，返回"`McpToolRunner` 的实例，但外部
    工具名路由给 registry"——**不是**顶层 `class X extends McpToolRunner`，原因见下方
    「一次真实的循环依赖事故」。
- `backend/src/extensions/mcp_client_verify.ts`（新建）：`ext verify` 对
  `kind=mcp_client` 的契约化验收——`mcp.json` 校验 + 真实连接一次 + `listTools()`
  非空 + 如果声明了 `verifySample`，真实调用一次并确认执行记录确实新增。
- `backend/src/extensions/types.ts`：`ExtensionKind` 加 `"mcp_client"`；
  `requiresTrust()` 的默认规则（`!== "connector"`）天然覆盖它，未改逻辑。
- `backend/src/extensions/loader.ts`：加一段 `kind === "mcp_client"` 分支——校验
  `mcp.json`、TOFU 信任检查（指纹覆盖 `mcp.json` 而不是某个 TS 文件）、**不**在装载
  时启动子进程（装载 ≠ 连接，与"能装上不等于装好了"是两件事）。
- `backend/src/extensions/verify.ts`：加 `case "mcp_client"` 分发给
  `verifyMcpClientExtension`。
- `backend/src/extensions/verify_cache.ts`：`subjectPathFor()` 加 `mcp_client` 分支
  （校验对象是 `mcp.json`）。
- `backend/src/extensions/capabilities.ts`：`ExtensionCapability` 加
  `origin`（`"external_mcp_server"`）/ `mcpTools` / `mcpDiscoveredAt` 三个字段；
  `mcp_client` 扩展的状态叠加读一次 `.mcp_discovery.json`——发现失败时状态变成
  `"failed"`（`needs_grant` 优先展示，因为那是用户能直接采取行动的那一档）。
- `backend/src/extensions/cli.ts`：新增 `ext add-mcp <name> --cmd "..." [--trust]
  [--env VAR]... [--credential <id>:<field>:<envVar>]... [--description <text>]`——
  写 `extension.json` + `mcp.json`，`--trust` 后跑一次 `discoverExternalMcpTools()`。
  **这条命令不需要改 `index.ts`**：`case "ext":` 早在 W2-c 就已经把整个 `ext` 子命令
  空间转交给 `runExtCommand()`，`add-mcp` 只是这个 switch 里新增的一个 case，天然
  可达，不存在"等收口接线"的问题。
- `tests/fixtures/mcp/`（新建）：三个假的外部 MCP server（真实 stdio 协议，
  `command: process.execPath` 现场 spawn）——
  `good_server.ts`（echo/whoami/slow 三个工具）、`dead_on_arrival.ts`（立即非零退出）、
  `silent.ts`（spawn 成功但从不回应，用来触发启动超时而不是启动失败）。
- `tests/unit/mcp_client.test.ts`（新建）：45 个测试，覆盖 §1 mcp.json schema
  §2 凭据→env（含阴性对照③）§3 真实 spawn 往返 §4 外部 server 挂了/超时（含阴性
  对照②第一支）§5 执行记录（含阴性对照①）§6 发现缓存 §7 loader TOFU §8 ext verify
  §9 capabilities（含阴性对照②第二支）§10 `ext add-mcp` §11 registry/runner 接线证明
  §12 授权账本共用。
- `tests/unit/extensions.test.ts`：未改动内容（新增的 `mcp_client` kind 没有破坏
  这个文件里任何既有断言——`requiresTrust` 测试只枚举了五个具体值，不做穷举检查；
  重新跑过一遍确认零回归，44 pass 不变）。
- `docs/EXTENDING.md`：§8 补三种强度表格第三行 + 新增"强度③详解"整节（`mcp.json`
  形状、`ext add-mcp` 用法、安全边界"挡什么/不挡什么"、ToolBus 接线方式）；§9 的
  `ext verify` 表格补 `mcp_client` 行。
- `llms-full.txt`：改了 `docs/EXTENDING.md` 后 `bun test tests/unit/llms_txt.test.ts`
  的幂等门变红，按提示跑了一遍 `bun scripts/gen-llms-txt.ts`——`scripts/gen-llms-txt.ts`
  本身未改动，只是运行它的确定性重新生成结果；`llms.txt`（索引）无变化。
- 本文件。

## 接入形态

```
spark-research ext add-mcp my-server --cmd "node path/to/server.js" --trust
```

写入 `~/.spark-research/extensions/my-server/{extension.json, mcp.json}`，`--trust`
通过后跑一次 `discoverExternalMcpTools()`：连接、`listTools()`、断开，把结果写进
`.mcp_discovery.json`。**装载（`ext load`）与连接是两件事**——`loadExtension()` 对
`kind=mcp_client` 只做 `mcp.json` 校验 + TOFU 信任检查，不启动子进程；真正建立连接
（用于往 ToolBus 里挂工具）是 `connectExternalMcp()`，由收口在 daemon 启动时或
`ext add-mcp`/`ext verify` 这类一次性探测场景里显式调用。

## 一次真实的循环依赖事故（读代码前必读）

第一版实现把 `McpToolRunnerWithExternal`（`McpToolRunner` 的子类）直接写在
`mcp_client.ts` 顶层，静态 `import { McpToolRunner } from "../mcp/server"`。六套件
第一次全跑时，`cli_entry.test.ts` 里 7 个"真进程冒烟"测试全部失败——用真进程复现：

```
$ bun backend/src/index.ts --version
535 | export class McpToolRunnerWithExternal extends McpToolRunner {
                                                       ^
ReferenceError: Cannot access 'McpToolRunner' before initialization.
      at /…/backend/src/extensions/mcp_client.ts:535:48
EXIT=1
```

根因是一个模块初始化环：`backend/src/capabilities/index.ts` 早就 import 了
`backend/src/extensions/capabilities.ts`（W2-c 交付时接的线），我这次改动让
`extensions/capabilities.ts` 多 import 了 `mcp_client.ts`（拿 `readMcpDiscoveryCache`）；
`mcp_client.ts` 当时静态 import 了 `../mcp/server`（拿 `McpToolRunner`）；`mcp/server.ts`
import `../server/app`；`server/app.ts` import `../capabilities`（`buildCapabilities`）——
绕回 `capabilities/index.ts`，环闭合。`bun test tests/unit/` 本身没测出来（`bun test`
的模块加载顺序恰好没有先触发这条链路），只有跑真进程 `bun backend/src/index.ts` 才
复现——这也是 `cli_entry.test.ts` 这类"真进程冒烟"测试存在的意义。

修法：`mcp_client.ts` 对 `../mcp/server` 只保留 `import type`（编译期整体擦除，
不产生运行时边）；真正需要**运行时**拿到 `McpToolRunner` 值去继承的
`createExternalToolRunner()`，改成 `async` 工厂函数，内部用动态 `await
import("../mcp/server")`——动态 import 在模块图的初次同步求值阶段之后才解析，
不参与上面那条环的 TDZ 判定。修复后 `bun backend/src/index.ts --version` 恢复正常
（见下方六套件数字），且这个函数因此不能是一个能被 `new` 的具名导出类，只能是
`async` 工厂——接口形状变了，devlog 这里如实记一笔。

## 外部工具怎么进 ToolBus 与 capabilities

**ToolBus（`backend/src/agents/toolbus.ts`，W1-a 交付，本 lane 一行未改）：**

`ToolBusOptions.runner` 的类型是具体的 `McpToolRunner`（不是接口——该类有私有
字段，TS 按名义类型检查，普通"形状匹配"的对象赋值不进去）。不改 `toolbus.ts` 也能
接进去的办法：**子类化**。`createExternalToolRunner(baseOptions, registry)` 返回一个
"`McpToolRunner` 子类的实例"，可以原样赋给 `AgentToolBus` 构造参数的 `runner` 字段。
这样 `AgentToolBus` 已有的三层——① `MCP_WITHHELD` 硬拒绝 ② `grants` 白名单授权
③ `BudgetLedger` 预算 ④ `audit` 回调审计——**不用改一行代码**就对外部工具名（形如
`mcp:my-server:search`）同样生效：`grants` 数组本来就是任意字符串的白名单，收口只
需要把限定名塞进某个会话的 `grants` 里。

**给收口的接线说明（`backend/src/agents/**` 不在本 lane 名下）：**

```ts
// daemon 构造 AgentToolBus 之前：
const registry = new ExternalToolRegistry();
// 对每个已连接（或按需连接）的 mcp_client 扩展：
registry.register(await session连接结果);

const runner = await createExternalToolRunner({ app, timeoutMs, pollIntervalMs }, registry);
const bus = new AgentToolBus({
  runner,                 // 换掉原来的 `new McpToolRunner(...)`
  grants: [...原有内置工具名, "mcp:my-server:search", ...],
  budget,
  audit,
  timeoutMs,
});
```

如果还想让 LLM 看到外部工具的 schema：`AgentToolBus.specs()` 目前只过滤
`MCP_TOOLS`（内置工具表），不认识 `registry` 里的工具——`registry.specs()`
（同形状：`{name, description, inputSchema}`）需要收口自己拼进喂给模型的 tools
列表（`AgentToolBus.specs()` 本身不在本 lane 名下，不能直接改）。

**capabilities（`backend/src/capabilities/**` 不在本 lane 名下，已由 W2-c 接好
`extensions/capabilities.ts` 这条线，本 lane 只是让这条线上多出的条目更丰富）：**

`listExtensionCapabilities()` 对 `kind="mcp_client"` 的扩展额外输出：
- `origin: "external_mcp_server"` —— 标明来源
- `mcpTools: [{name, description}]` —— 上一次发现到的工具清单（来自
  `.mcp_discovery.json`，不实时连接）
- 状态叠加：`needs_grant` 优先展示；其次若发现缓存 `ok:false`，整体 `status` 变成
  `"failed"`，`reason` 带上外部原因；从未发现过则是 `"unverified"`。

不需要额外接线——`backend/src/capabilities/index.ts` 早就 `import
{ listExtensionCapabilities }`，这些新字段随原有调用链路自动出现在
`capabilities --json` 里。

## 执行记录怎么落的（差异化点的结构性保证）

`ExternalMcpSession.call()` 内部有且只有一个记账口——一个闭包 `record(partial)`，
四条分支（未知工具 / 成功 / 业务失败 / 抛异常-含超时）全部**在 `return` 之前**调用
它。落盘位置 `extensions/<name>/.mcp_calls.jsonl`（JSONL，追加写），参数摘要经
`redactSecrets`（复用 `llm/types.ts`，不重写脱敏规则）脱敏。这条记录**不**直接写
进主 project 的证据图（`backend/src/project/**` 不在本 lane 名下）——它是"外部工具
调用确实发生过"的自证结构，收口方决定要不要把它进一步转成一条 project record
（如 observation），本 lane 只保证记录本身的存在性。

## 安全边界（挡什么 / 不挡什么，逐条见 `docs/EXTENDING.md` "强度③详解" 一节）

**挡得住的：**
- 子进程默认只拿到 SDK 内建的最小安全环境变量集合，不继承宿主 `process.env`。
- 凭据默认拿不到（声明 + `ext grant` 缺一不可），唯一取值路径是
  `ExtensionContext`，与②同一套结构性约束。
- 外部 server 挂了/超时/返回垃圾：一律吞异常，结构化失败，主进程不受影响；
  `capabilities` 会反映成 `status: "failed"`。
- 外部工具调用经 `ExternalMcpSession.call()` 这条路径的，必然落一条执行记录。
- `--trust` 挡"未经确认就静默执行任意命令"。

**挡不住的（如实记录）：**
- 子进程一旦启动，能做任何该 UID 能做的事——`stdio` 只是通信管道，不是沙箱。
- 执行记录的保证只覆盖"经过 `ExternalMcpSession.call()`"这条路径；绕开这个模块
  自己起一个 Client 连同一个外部 server，那次调用不会被记录。
- `--cmd` 是朴素空白切分，不是 shell 解析，也不对 `command` 做白名单——能不能信
  这个命令是人的判断，`--trust` 只是"要求先看一眼再确认"。
- `ext verify`（mcp_client）不提供执行隔离，且没有接入真实 CredentialStore（独立
  CLI 调用，不经过 daemon）——声明了凭据的 verify 场景，凭据变量不会被注入。

## 三次阴性对照（实跑记录，每次都真的改了代码、跑红、再还原）

### ① 外部工具调用不落执行记录 → 测试红

把 `ExternalMcpSession.call()` 成功分支里的 `record({ ok: !isError });` 注释掉，
只跑"成功调用落一条记录"这条测试：

```
253 |     const config = goodServerConfig();
254 |     const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root } });
255 |     const before = readMcpCallRecords(manifest.name, { root }).length;
256 |     await result.session!.call("echo", { text: "x" });
257 |     const after = readMcpCallRecords(manifest.name, { root });
258 |     expect(after.length).toBe(before + 1);
                               ^
error: expect(received).toBe(expected)

Expected: 1
Received: 0

(fail) 执行记录（.mcp_calls.jsonl）：相对 OpenScience 的差异化点 > 成功调用落一条记录 [74.25ms]

 0 pass
 44 filtered out
 1 fail
```

改回 `record({ ok: !isError });`，重跑全量 `tests/unit/mcp_client.test.ts` 恢复
45 pass / 0 fail。

### ② 外部 MCP server 挂掉/超时 → 主进程存活且 capabilities 标 failed

两支证据：

**第一支（`connectExternalMcp()` 级别，不需要改代码，本来就是正向测试的一部分）**：
`dead_on_arrival.ts`（进程立即 `process.exit(7)`）与 `silent.ts`（spawn 成功但从不
回应 MCP 协议）两个 fixture 跑一遍真实 smoke：

```
dead_on_arrival ok= false reason= MCP error -32000: Connection closed elapsedMs= 14
silent(timeout) ok= false reason= MCP error -32001: Request timed out elapsedMs= 1503
main process still alive, exiting normally
```

**第二支（`capabilities.ts` 的状态叠加逻辑，真的改代码验证）**：把
`capabilities.ts` 里 `} else if (!discovery.ok && status !== "needs_grant") {` 的
判定条件临时改成恒 `false`（禁用"发现失败 → status 变 failed"这条覆盖逻辑），只跑
对应测试：

```
487 |     const caps = await listExtensionCapabilities({ root });
488 |     const entry = caps.find((c) => c.name === "cap-failed")!;
489 |     expect(entry.status).toBe("failed");
                               ^
error: expect(received).toBe(expected)

Expected: "failed"
Received: "unverified"

(fail) listExtensionCapabilities · mcp_client > 【阴性对照②·capabilities 侧】发现失败：状态变成 failed，reason 带外部原因 [10.82ms]
```

改回原判定条件，重跑恢复绿。

### ③ 未 grant 却能拿到凭据 → 测试红

把 `resolveMcpChildEnv()` 里 `const record = ctx.credentials.get(mapping.id);`
（唯一合法路径，经过声明+授权的结构性拒绝点）临时换成绕开 `ctx`、直接问
`deps.credentials?.get(mapping.id)`：

```
141 |   test("【阴性对照③】未 grant 时，env 里既没有变量名也没有值本体", () => {
142 |     const grant: ExtensionGrant = emptyGrant(); // 没有 ext grant --credential
143 |     const env = resolveMcpChildEnv(manifest, config, grant, { credentials: fakeCredentials });
144 |     expect(env.UPSTREAM_KEY).toBeUndefined();
                                   ^
error: expect(received).toBeUndefined()

Received: "super-secret-value"

(fail) resolveMcpChildEnv：凭据默认拿不到（AD-2 在子进程边界上的落点） > 【阴性对照③】未 grant 时，env 里既没有变量名也没有值本体 [1.43ms]
```

改回 `ctx.credentials.get(mapping.id)`，重跑恢复绿。三次阴性对照之后重新跑了一遍
完整六套件（见下），确认还原干净、没有遗留改动。

## 六套件数字

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（两个 tsconfig 都过） |
| `bun test tests/unit/` | **1343 pass / 0 fail / 0 skip**（基线 1298 + 本 lane 新增 45，回归为零） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e`（`SPARK_E2E_PORT=4444`） | **14/14** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

## 给收口的接线说明（汇总，正文已分散写过一遍）

1. **daemon 启动 mcp_client 扩展**：对每个 `status !== "failed"` 的 mcp_client
   扩展，调用 `connectExternalMcp({manifest, config, grant, deps})`（`deps.credentials`
   传真实 `CredentialStore` 的 accessor），拿到 `session` 后 `registry.register(session)`。
   生命周期（何时 `session.close()`）由收口决定——本 lane 不管连接的存活期。
2. **接进 `AgentToolBus`**：`options.runner` 用
   `await createExternalToolRunner(baseOptions, registry)` 替换
   `new McpToolRunner(baseOptions)`；`grants` 数组里加上要开放的
   `mcp:<extension>:<tool>` 限定名。
3. **喂给模型的 tools 列表**：`AgentToolBus.specs()` 目前只认 `MCP_TOOLS`——需要
   收口在拼 tools 数组时额外拼上 `registry.specs()`（同形状，直接 concat）。
4. **CLI 接线**：`ext add-mcp` 已经通过既有的 `case "ext":`（W2-c 接好，本 lane
   未改 `index.ts`）可达，不需要额外接线。
5. **`.mcp_calls.jsonl` → 证据图**（可选，超出本 lane 范围）：如果想让外部工具的
   每次调用也出现在 project 的证据图里（不只是 `extensions/<name>/.mcp_calls.jsonl`
   这份独立记录），需要在持有 `backend/src/project/**` 的地方读这份 JSONL、转写成
   一种 record（例如 observation），本 lane 没有做这件事——`project/**` 不在本
   lane 名下，且如实说：这份 JSONL 本身已经是"每次调用必留痕"的完整证明，是否
   进一步接进证据图是收口的产品判断，不是本 lane 遗漏。

## 已知未完成 / 诚实报告

- **`ext verify`（mcp_client）没有接入真实 CredentialStore**：如果 manifest 声明
  了 `requires.credentials`，verify 时子进程拿不到任何凭据（因为独立 CLI 调用没有
  daemon 注入的 accessor）——已在 `mcp_client_verify.ts` 注释与本文档里如实说明，
  不是"验证通过"暗示凭据链路被覆盖了。
- **执行记录的落盘位置是 `extensions/<name>/.mcp_calls.jsonl`，不是主 project 的
  证据图**——见上方"给收口的接线说明"第 5 条，这是一个有意的范围边界，不是遗漏。
- **`--cmd` 只做朴素空白切分**，不支持带引号/转义的复杂命令行——用户需要自己拆成
  `command` + 单个 `args`；`ext add-mcp` 目前也没有单独的 `--arg` 重复参数形式
  （只能通过 `--cmd "command a b c"` 一次性给全），如实标注为可用性小缺口。
- **信任指纹只覆盖 `mcp.json` 单文件**，与 TS 扩展的已知限制（fingerprint.ts 只
  覆盖 entry 单文件）是同一类边界：`mcp.json` 引用的外部 `command`（比如一个本地
  脚本路径）如果内容变了，指纹不会跟着变——因为指纹从不读 `command` 指向的文件，
  只读 `mcp.json` 本身。
- **`ExternalToolRegistry`/`createExternalToolRunner` 没有生命周期管理**（连接何时
  建立、何时断开、断线后要不要重连）——本 lane 交付的是"连一次、能调用、能感知
  失败"这层原语，常驻连接池/重连策略是收口在 daemon 里要做的产品决策，超出本
  lane 范围。
