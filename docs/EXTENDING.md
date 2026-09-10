# 扩展 Spark Research

> 面向想把自己的数据源 / 仿真平台 / 实验设备 / 领域知识接进来的科研人员与开发者。
> 状态：P9（v0.2.0）· 配套：[DESIGN.md](DESIGN.md)（设计真源）· [BACKLOG.md](BACKLOG.md)（未决事项）

Spark Research 有**六个扩展点**。每一节的结构相同：契约 → 最小可运行示例 → **怎么测** → **放哪里**。

先跑一次这条命令，看清当前这台机器上已经有什么：

```bash
spark-research capabilities            # 人看的表格
spark-research capabilities --json     # agent 看的清单（schema + 可用性）
spark-research capabilities --probe    # 顺带真去探测 openmm / opentrons 装没装
```

清单**从真实注册表生成**，不是手写的。你按本文档接进来的东西，注册之后会自动出现在里面。

三个扩展点有脚手架，别手抄：

```bash
spark-research new skill <name>
spark-research new connector <name> [--with-key]
spark-research new platform <name>
```

脚手架生成的模板里注释比代码多，那是有意的：样板不长，但样板里的纪律很长，而那些纪律是 P2–P6 实测踩出来的。

---

## 0. 先理解三条贯穿全局的纪律

接任何东西之前，这三条会反复出现：

**① 凭据只在 daemon 进程（AD-2）。**
带凭据的外部访问只发生在 daemon 内的 connector 里。凭据存在 `~/.spark-research/credentials.json`（0600），不进环境变量、不进 prompt、不进日志、不进错误消息。kernel / 沙箱子进程永远拿不到凭据本体，只能请 daemon 代为访问。
这条不是洁癖：它来自对 OpenScience 沙箱的实测——那套三层隔离让自定义付费数据源在 agent 内根本用不了，只能 fork 改源码。我们把这个教训做成了原生设计。

**② 失败要可分辨。**
「没配凭据」不是「调用失败」，「检索不到」不是「不存在」，「进程被杀」不是「算例跑挂」。每一处降级都要留下能区分这些情况的字段，因为下游的判断完全不同（重试 / 换源 / 改参数 / 告诉用户去配 key）。

**③ 模型给的结论要被确定性代码约束（AD-8）。**
凡是「模型给结论、结论会影响下游动作」的地方，都要有一层零 IO、纯函数、可单测的代码按可计算特征约束它，并把「模型原判」与「校正后」都留在产物里。

---

## 1. Skill

技能是**给 agent 看的操作手册**：怎么组合已有能力、什么情况下不该做什么。它不实现能力——能力在 `backend/src/` 里，文档漂移了以代码为准。

### 契约

一个目录，一个 `SKILL.md`，YAML frontmatter + 正文。frontmatter 的 schema 真源是 `backend/src/skills/frontmatter.ts`，CI 门是 `tests/unit/skill_frontmatter.test.ts`。

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | 小写 kebab-case，**必须与目录名一致** |
| `description` | 是 | 同时说清「做什么 + 何时用」，≥40 字符。agent 靠它决定是否加载 |
| `category` | 是 | `literature` / `ideation` / `experiment` / `report` |
| `domain` | 是 | DESIGN 的五大功能域 A–E，可用 `/` 连接（`C/E`） |
| `triggers` | 是 | **用户会怎么开口**。机器可读，是 agent 选技能的第一判据；至少一条 |
| `connectors` | 是 | 依赖的 connector id（校验器核对其真实存在）；无依赖写 `[]` |
| `platforms` | 否 | 依赖的仿真平台 id |
| `validation` | 是 | 配套验证的测试文件路径。**校验器会去磁盘核对文件存在** |
| `allowed-tools` | 否 | 预期用到的工具 |

三条容易忽略的约束：

- **未知字段一律拒绝**。拼错的 `trigger:`（少个 s）静默失效比报错糟糕得多。
- `triggers` 写「用户会怎么开口」（"这个想法有没有人做过"），不是能力名（"novelty check"）。agent 匹配的是用户的话。
- `validation` 让 AD-5「技能必须有配套 e2e 才算完成」从口号变成一道门。写一个还不存在的测试文件路径，CI 立刻红。

正文必须有 **反模式** 小节。说清什么时候**不**该用，比说清用法更能防止 agent 越界——现有 10 个技能全部遵守这条。

### 最小可运行示例

```bash
spark-research new skill hello-source
```

生成两个文件：`SKILL.md`（frontmatter 已合规，正文是待填的骨架）与一个配套测试。生成的测试当场就能跑——它先验 frontmatter 合规，然后留一个 TODO 提醒你把技能声称的能力逐条验起来。

参照现成的写法：`backend/src/skills/literature-search/SKILL.md`（能力边界表 + 读懂 `sources` 状态那一步 + 四条反模式）是最完整的一个。

### 怎么测

```bash
bun test tests/unit/skill_frontmatter.test.ts     # schema 门：10 个技能逐个过
bun test tests/unit/skill_hello_source.test.ts    # 你新技能的配套验证
```

frontmatter 合规只是起点。AD-5 要的是「文档说的能力真的存在」：技能说「检索失败时会明确报告 failed 而不是静默吞掉」，那就写一个注入失败源的用例断言 `outcome === "failed"`。

### 放哪里

```
backend/src/skills/<name>/
  SKILL.md          必需
  scripts/          可选：技能专用脚本
  references/       可选：按需加载的长文档（不预填 context）
tests/unit/skill_<name>.test.ts    配套验证
```

装好之后在 `backend/src/skills/README.md` 的技能表里加一行。`spark-research capabilities` 会自动列出它。

---

## 2. Connector

Connector 是**幂等的数据读取**：给定参数返回数据，没有生命周期。需要长任务生命周期的东西（提交、轮询、回收）是 SimulationPlatform，不是 connector——这是 AD-4 的分界。

### 契约

契约只有三件事（基类 `backend/src/connectors/base.ts` 把 HTTP 调用、路径参数替换、错误处理都做完了）：

1. 一份 `HttpConnectorConfig`：`baseUrl` + `tools[]` + `metadata`
2. 可选覆写 `headersFor(toolName)` / `queryFor(toolName)`：礼貌头、鉴权头、`mailto`
3. 需要自定义解析或降级时：在构造函数里 `this.handle(toolName, fn)` **显式注册** handler。
   `fn` 内部要落到通用 URL 拼装路径时调 `this.requestRaw(toolName, params)`，**不要**调
   `super.call(...)`——那会重新查一遍 handler 表，对同一个 `toolName` 就是自己调自己，
   死循环。

> ⚠️ **v0.3 起不再支持「与 tool 同名的方法自动被当 handler」**。这套反射分发在 P9 及
> 更早版本里是隐式契约（方法名恰好等于 tool 名就自动生效），P10-a 外部评审判定它是
> 坏抽象：并发调用同一个 connector 实例时，旧实现靠一个跨请求共享的实例字段判断
> 「是否正在处理这个工具」，会被并发请求互相污染，导致 handler（参数映射、AD-2 的
> 凭据缺失检查）被静默跳过、退化成不带任何自定义逻辑的零参数直通——而且是偶发的，
> 单元测试测不出来，只在生产的并发场景下现身。修复不是把这个反射分发做成竞态安全的
> 版本，而是把它换成显式注册：`handlers` 是构造期一次性写入、运行期只读的表，`call()`
> 只有「查表命中就走 handler，否则走通用路径」两条路，不存在任何跨请求共享的可变状态。

`tools[].endpoint` 里的 `{name}` 是路径参数占位符，基类会用同名入参替换并 URL-encode，剩下的入参进查询串。

`metadata` 三个字段决定它在 `capabilities` 里长什么样：

| 字段 | 作用 |
|------|------|
| `apiKeyRequired` | 决定可用性档位：需要凭据但没配 → `needs_credential`（检索时被 **skip**，不是失败） |
| `status` | `available` / `placeholder`（占位实现，调用会失败——cnki / wanfang 是这一档） |
| `caveat` | **已知的坑**。`available` 说的是「接口实现了」，不等于「无条件可用」 |

`caveat` 值得单独说：Semantic Scholar 的 `apiKeyRequired` 是 `false`，但 P2 实测匿名请求持续 429（7 次尝试全挂）。这种「能调但会撞墙」的事实必须让使用者在选源之前就看到，所以它是元数据的一部分，会原样出现在 `capabilities` 输出里。

> ⚠️ **命名历史包袱已在 P9 修正**：基类原名 `MCPConnector`，但它与 Model Context Protocol 毫无关系——名字来自 v0.1 的早期设想（那时打算让每个数据源都是一个 MCP server）。真正的 MCP 实现在 `backend/src/mcp/`。两个东西同名会让读者以为 connector 层在说 MCP 协议，所以在 v0.2.0 把公开 API 定下来**之前**改名为 `HttpConnector` / `HttpConnectorConfig` / `HttpTool`。旧名保留为 deprecated 别名，外部代码不会断；仓库内部一律用新名。

### 最小可运行示例（免 key）

```bash
spark-research new connector openfree
```

核心就这么点：

```ts
export const openfreeConfig: HttpConnectorConfig = {
  baseUrl: "https://api.example.org/v1",
  description: "（一句话说清覆盖什么、不覆盖什么）",
  tools: [
    { name: "search", description: "检索。参数示例：{ q: 'crispr off-target', limit: 10 }", endpoint: "/search" },
    { name: "getRecord", description: "按 id 取单条。参数示例：{ id: 'ABC123' }", endpoint: "/records/{id}" },
  ],
  metadata: { domain: "api.example.org", apiKeyRequired: false, status: "available" },
};

export class OpenfreeConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("openfree", openfreeConfig, options);
  }

  protected headersFor(): Record<string, string> {
    // 礼貌头：免 key 的公共 API 靠它认出你是谁。别硬编码个人邮箱——走配置。
    return politeHeaders({ userAgent: this.options.userAgent, contactEmail: this.options.contactEmail });
  }
}
```

参照实现：`backend/src/connectors/literature.ts` 的 `OpenAlexConnector`（`queryFor` 里加 `mailto` 进 polite pool）。

### 最小可运行示例（带 key，走 AD-2）

```bash
spark-research new connector paidsource --with-key
```

带凭据的版本多三段，三段都是纪律：

```ts
export class PaidSourceConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("paidsource", paidsourceConfig, options);
    // 显式注册——不要靠方法名恰好叫 "search" 让基类反射发现（v0.3 已移除）。
    this.handle("search", (p) => this.searchImpl(p));
  }

  // 凭据分层（AD-2）：connector 只声明自己需要什么，值本体由 daemon 内的
  // CredentialStore 提供。能拿到值是因为 connector 本来就跑在 daemon 进程里。
  private credential(): string | null {
    return this.options.credentials?.get("paidsource")?.api_key ?? null;
  }

  protected headersFor(): Record<string, string> {
    const key = this.credential();
    return {
      ...politeHeaders({ userAgent: this.options.userAgent }),
      // 没配凭据时不要塞空 Authorization 头：那会把 401 变成更难查的 400。
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  // 未配置凭据 → 明确回「未配置」，不是抛错。统一检索据此标 skipped 而非 failed。
  private async searchImpl(params: Record<string, unknown>): Promise<unknown> {
    if (!this.credential()) {
      return { configured: false, source: "paidsource", results: [], note: "未配置凭据…" };
    }
    // 落到通用路径调 requestRaw，不要调 super.call("search", ...)——对同一个
    // toolName 那会重新命中上面刚注册的 handler，自己调自己死循环。
    return this.requestRaw("search", params);
  }
}
```

配置凭据（值以 connector id 为键存进 `credentials.json`，0600）：

```bash
# 凭据由 daemon 的 CredentialStore 管理；CLI 侧只看得到「是否已配置」
spark-research lit sources          # 看哪些源需要 key、哪些已配
```

参照实现：`backend/src/connectors/aminer.ts`（29 个 API 里先接 search / paper-detail 两个核心，未配置时统一降级）。

### 怎么测

**不打真实网络。** 注入一个假的 `HttpClient`，断言「发出去的请求长什么样」与「响应被怎么解析」。真实验证只在本地跑一次并录制成 fixture（`tests/fixtures/literature/`），CI 永远回放。

脚手架生成的测试已经覆盖五件事：工具清单形态、查询参数进 URL、路径参数被替换而不是拼成查询串、未知工具名报错、（带 key 时）未配置的降级路径 + **凭据值不出现在任何错误消息里**。

```bash
bun test tests/unit/connector_openfree.test.ts
bun test tests/unit/connectors.test.ts        # 全体 connector 的公共契约
```

### 放哪里

```
backend/src/connectors/<name>.ts                 实现 + config
tests/unit/connector_<name>.test.ts              契约测试
tests/fixtures/<domain>/<cassette>.json          真实响应录制（可选）
```

注册两处（漏了第二处会静默退化成不带自定义头的通用 `HttpConnector`）：

- `backend/src/connectors/registry.ts` 的 `BUILTIN_CONNECTORS`：按域加 `{ name, config }`
- 同文件的 `CONNECTOR_CLASSES`：加 `name: YourConnector`

注册后 `spark-research capabilities` 自动列出，无需手写清单。

---

## 3. SimulationPlatform

干实验平台。与 connector 的分界（AD-4）：connector 是幂等读取，仿真是**长任务生命周期**——prepare / submit / poll / collect / cancel。

### 契约

继承 `SubprocessSimulationPlatform`（`backend/src/simulation/platform.ts`）后只剩三个抽象方法：

| 方法 | 职责 |
|------|------|
| `normalize(kind, params)` | 参数归一化 + 预期产出清单。非法参数当场抛 `SimulationSpecError` |
| `entryPointFor(kind)` | runner 脚本的绝对路径 |
| `probeCode()` | 可用性探测：一段跑得通就算可用的 python |

外加三个属性：`id` / `description` / `deterministic` / `kinds`。

生命周期、磁盘状态真源、断点续跑全在基类里，**不要在子类里重新发明**。

四条来自 P5 实测的硬要求：

1. **submit 不阻塞**（基类保证）。编排进程被杀之后，任务还得活着。
2. **runner 自己写 `done.json`，且写完全部结果才写它**。`poll` 先看 `done.json` 再看 pid：结果在就以结果为准，PID 复用最坏只让已死任务多「运行中」一会儿，不会把失败报成成功。
3. **失败也要写 `done.json`**（`status: "failed"` + `error`），否则编排侧只能猜。用「先写临时文件再 rename」的原子写，避免 poll 读到半个 JSON。
4. **`deterministic` 位要诚实**：同一 spec 逐位可复现才是 `true`。pyref 是 `true`；OpenMM 在 CPU 上是 `false`（多线程浮点归约）。填错会让下游结论用「逐位对账」的措辞去描述一个不可复现的结果——P8 的 `capability-labeling` 检查器会因此把结论判成 hard veto。

`normalize` 里还有一个容易漏的点：**警告 ≠ 拒绝**。参数合法但大概率跑不通的组合（步长远大于固有周期、截断半径超过半盒长）要在 prepare 阶段就说出来，而不是等算例跑挂了让人从 stderr 里猜。

### 最小可运行示例

```bash
spark-research new platform demoplat
```

生成实现 + `runner.py` + 契约测试接线三个文件，**当场全绿**。

参照实现：`backend/src/simulation/pyref/`（阻尼谐振子，零依赖 + 有解析解可对照）与 `backend/src/simulation/openmm/`（真实 MD）。

### 怎么测

**新平台的验收 = 直接复用 P5 的契约测试套件**，不需要自己发明测试：

```ts
import { describeSimulationContract } from "../helpers/simulation_contract";

describeSimulationContract({
  name: "demoplat",
  make: (root: string) => new DemoplatPlatform({ root }),
  okSpec: { platform: "demoplat", kind: "demo-run", params: { steps: 50 } },
  equivalentSpec: { /* 显式写出默认值 + 换书写顺序 → specHash 必须相同 */ },
  differentSpec: { /* → specHash 必须不同 */ },
  slowSpec: { /* 跑得够久，让 cancel 有机会打断 */ },
  failingSpec: { /* 参数合法但算例真的会失败 */ },
  invalidSpec: { /* prepare 就该拒绝 */ },
  expectedOutputs: ["series.csv", "final_state.json"],
  summaryKeys: ["steps", "final"],
  runTimeoutMs: 60_000,
});
```

openmm 与 pyref 跑的是逐字节相同的断言（13 条）：平台自述、可用性探测、prepare 幂等与 specHash、submit 非阻塞、poll 状态机、collect 校验产出、cancel、跨实例重连、参数非法当场拒、算例失败与进程丢失可分辨。填对 case 就全跑在你的实现上。

填 case 时最容易错的两处：

- `failingSpec` 要一条**参数合法但算例真的会失败**的路径（数值发散、约束冲突），不是人为的 error 开关。假的失败开关验不出真实的失败处理。
- `slowSpec` 要跑得足够久。太快的话 cancel 测试会在任务已经结束之后才发出。

```bash
bun test tests/unit/platform_demoplat.test.ts
bun test tests/unit/simulation_contract.test.ts   # 内置两个实现
```

### 放哪里

```
backend/src/simulation/<name>/
  index.ts       平台实现
  runner.py      子进程 runner
tests/unit/platform_<name>.test.ts    契约测试接线
```

注册：`backend/src/simulation/registry.ts` 的 `SIMULATION_PLATFORM_IDS` 加 id，`get()` 的 switch 里接上类。

---

## 4. WetLabBackend

湿实验执行端。**这一节请先读完再动手**——当前契约有一个已知的形状问题（BACKLOG V6）。

### 契约

```ts
export interface WetLabBackend {
  readonly id: string;
  readonly description: string;
  available(): Promise<WetBackendAvailability>;
  execute(program: OpentronsProgram, options: WetExecuteOptions): Promise<WetRunResult>;
}
```

现有两个实现在 `backend/src/lab/wet_backend.ts`：`OpentronsSimulatorBackend`（**默认**，官方模拟器）与 `MockDeviceBackend`（单测后端，零依赖）。

保留 mock 的理由与 P5 保留 pyref 相同：契约测试需要一个在任何环境都跑得通的实现。但**默认必须是真模拟器**——mock 只验「管线通不通」，验不了「协议合不合法」。一个 opentrons 拒绝解析的脚本在 mock 上一样会「跑成功」，那是最危险的假绿。

三条 `execute()` 的实现纪律：

1. **执行的就是落盘的那个文件**。把 `program.source` 写成 `protocol.py` 再执行它，审计时能拿到与 run log 逐行对得上的源码。
2. **run log 要能锚回编译产物**。编译器在每步前注入 `protocol.comment("[spark-step] <id> <action>")`，解析靠这个锚点绑回步骤，不依赖设备软件的文案措辞（措辞会随版本变）。
3. **没有的硬件不假装有**。Opentrons 上没有的能力（离心、非四档波长读数、低温孵育）编译成 `[spark-note]` 注释并标 `execution: "manual"`，run log 里是 note 不是执行记录。

### 同设备族：即插即用

接另一台 Opentrons（真机、不同型号、别人的模拟器）时，实现上面四个成员即可，`execute()` 照常吃 `OpentronsProgram`。

### 非 Opentrons 设备族：需要先做一次重构（BACKLOG V6）

问题在 `execute()` 的入参类型：`OpentronsProgram` 不是设备无关的中间表示，它已经是 Opentrons 的 deck 布局 + Python 脚本。接一个 Hamilton / Tecan / 自研设备时，你拿到的是「别人家的字节码」。

施工说明（等第二个真实设备族选定再动，遵循 AD-4 的教训：两个真实实现才能验证接口）：

1. **把设备无关的中间表示提出来**。真源是 `backend/src/lab/protocol.ts` 的 `Protocol`（结构化步骤：action / device / params / expectedOutput），它本来就是设备无关的。
2. **把「结构化步骤 → 设备语言」的编译下沉进 backend**。现在这一步在 `backend/src/lab/opentrons_protocol.ts` 里、在 backend 之外完成；重构后每个 backend 自带一个 `compile(protocol) → 自家程序`。
3. **接口改成 `execute(protocol: Protocol, options)`**，backend 内部先 compile 再执行。
4. **`protocolHash` 的语义要跟着搬**：现在它是 `sha256(生成的脚本源码)`，approve gate 批的就是这个 hash。下沉之后，每个 backend 编译出的源码不同、hash 不同——这是**正确的**：换了设备就是换了协议，旧批准本来就不该跨设备存活。但要确保 hash 的计算仍然不含时间戳（含时间戳则每次编译都换 hash，approve 永远失效）。
5. **安全门要能吃新设备的编译产物**。`volume_capacity` 规则依赖 deck 布局；新设备族要么提供等价信息，要么这条规则在该设备上明确降级并说明（不许静默跳过）。

### 怎么测

```bash
bun test tests/unit/wet_loop.test.ts      # 状态机 + approve gate
bun test tests/unit/wet_e2e.test.ts       # 两类协议在**真** opentrons.simulate 下执行
bun test tests/unit/lab_safety.test.ts    # 安全门对抗矩阵
.venv/bin/python -m pytest tests/lab/     # python 侧后端
```

新后端至少要过三关：`available()` 在缺依赖时给出**可操作**的原因（装什么命令）、`execute()` 产出的 `entries` 能锚回 `stepId`、失败时不抛裸异常而是留下 run 目录与 `done.json`。

### 放哪里

```
backend/src/lab/wet_backend.ts     实现（现有两个都在这一个文件里）
backend/src/lab/<name>_backend.py  python 侧执行器（如果需要）
tests/unit/wet_e2e.test.ts         端到端
```

注册：同文件的 `WET_BACKEND_IDS` 与 `wetBackend()` 工厂。默认后端由 `spark-research config set wetBackend <id>` 决定。

### ⚠️ 这一节唯一不可协商的一条

**执行前的人工 approve 是硬门（AD-6）。** 它由状态机守：`wet_run` 的唯一入边是 `awaiting_approval → wet_run`，而这条边只有 `approve()` 会走；`execute()` 还会在执行前把审批的 hash 与当前编译产物的 hash 再对一次（防的是状态机之外的路径）。

新 backend **不许**提供任何绕过这条边的入口。同理，`lab approve` / `lab reject` / `lab simulate` 刻意**不**暴露为 MCP 工具——外部 agent 若能自己批准，approve gate 就退化成注释。详见第 6 节末尾。

---

## 5. 安全门规则

加一条安全规则 = 写一个纯函数 + 一个单测。

### 契约

```ts
export interface SafetyRule {
  id: string;                                        // 机器读，进 record metadata
  check: string;                                     // 人读，显示名
  description: string;
  evaluate(input: SafetyRuleInput): SafetyCheckResult; // { check, passed, detail? }
}

export interface SafetyRuleInput {
  protocol: Protocol;              // 结构化协议
  program?: OpentronsProgram | null; // 编译产物（给了就能看真实 deck 布局）
}
```

三个特点：

1. **纯函数**：零 IO、不读文件、不打网络、不看时间。所以它可以被穷举地对抗测试。
2. **一条规则一个 id**：混在别的规则里的 if 分支没法被单独打——测「超温被拦」时你其实同时依赖了另外几条规则没误报。P6 就是因此把 v0.1 埋在 orchestrator 里的三段 if 拆成了四条独立规则。
3. **有些规则必须吃编译产物**：「这一孔会被加到 600 µL」在自然语言层面完全正常，只有排完 deck、把同一孔的多次加液累加起来才知道会溢。这就是 `SafetyRuleInput.program` 存在的理由。

### 最小可运行示例

完整代码：`examples/extending/flammable_over_heat_rule.ts`（易燃试剂不得在高温步骤中出现）。核心部分：

```ts
export const flammableOverHeatRule: SafetyRule = {
  id: "flammable_over_heat",
  check: "flammable over heat",
  description: `易燃试剂不得出现在高于 ${HEAT_THRESHOLD_C} °C 的加热步骤中`,
  evaluate({ protocol }) {
    const violations: string[] = [];
    for (const step of protocol.steps) {
      const temperature = temperatureOf(step);
      if (temperature === null || temperature <= HEAT_THRESHOLD_C) continue;
      for (const reagent of reagentsOfStep(step)) {
        // 按 reagentId 匹配而不是按 name：name 是自然语言里抄下来的，
        // 「无水乙醇」「Ethanol (200 proof)」是同一个东西，靠 name 匹配必漏。
        const flashPoint = reagent.reagentId ? FLAMMABLE_FLASH_POINT_C[reagent.reagentId] : undefined;
        if (flashPoint === undefined) continue;
        violations.push(`${step.id}: ${reagent.name}（闪点 ${flashPoint} °C）在 ${temperature} °C 加热`);
      }
    }
    return {
      check: "flammable over heat",
      passed: violations.length === 0,
      // detail 写给人看：说清哪一步、哪个试剂、什么温度。
      // 用户拿到一句「不安全」只能全协议重读。
      detail: violations.length ? `flammable reagents heated above limit: ${violations.join("; ")}` : undefined,
    };
  },
};
```

阈值定在 60 °C 而不是闪点（13 °C），是因为定在闪点会把 37 °C 孵育里的微量乙醇全部误杀——**一条只会说「不」的规则会在两周内被人注释掉**。

### 怎么测

对抗样例与阴性对照**同等重要**。`tests/unit/extending_examples.test.ts` 里这条规则有 11 个用例：

- 对抗：高温 + 易燃 → 拦下；多个试剂全部列出；阈值边界（等于放行、+1 拦下）
- 阴性对照：37 °C 孵育不拦、高温但试剂不易燃、没有温度参数、试剂没有 `reagentId`
- 形态：纯函数（反复求值结果相同且不改入参）、id 唯一、加进规则集后不误杀合法协议

```bash
bun test tests/unit/extending_examples.test.ts
bun test tests/unit/lab_safety.test.ts        # 内置四条规则的对抗矩阵
```

### 放哪里

```
backend/src/lab/safety.ts          规则实现 + SAFETY_RULES 数组
tests/unit/lab_safety.test.ts      对抗矩阵
```

装上它只要在 `SAFETY_RULES` 数组里加一项。加进去之后 `spark-research capabilities` 会自动列出它。

### 相邻的扩展点：Reviewer 检查器

同样是「一条规则一个纯函数」，但作用对象不是协议而是产物：

| 位置 | 检查什么 |
|------|---------|
| `backend/src/reviewer/rules.ts` | `citation-integrity`：草稿引用 ↔ 库内论文 |
| `backend/src/reviewer/conclusion_rules.ts` | `data-consistency` / `capability-labeling` / `stats-plausibility` |
| `backend/src/ideation/novelty.ts` | 五条 novelty 评级校验规则（AD-8 的第一例） |

写新检查器时的两条口径：**hard 必须是可核对的事实判断**（不提供人工推翻 hard 的路径），**启发式一律只出 soft** 并带 `heuristic: true`。另外，这几个检查器都**豁免位置加权**——结论卡与综述草稿正文都是 markdown，位置加权会把所有 soft 升成 veto，直接毁掉「soft 只提示不否决」。（这个豁免目前靠调用路径隔离实现，改白名单制已登记为 BACKLOG V14。）

---

## 6. Prompt 与模型路由

### 契约：双层 prompt

| 层 | 文件 | 内容 |
|----|------|------|
| provider-neutral 契约 | `backend/src/agents/prompt/core.txt` | 与模型厂商无关的操作契约与诚信规则 |
| agent workflow | `backend/src/agents/prompt/research.txt` | 主 research agent 的工作流 |
| 会话模式 | `backend/src/agents/prompt/coexplore.txt` | Co-explore 的苏格拉底式批判工作流 |
| 子代理 | `backend/src/agents/prompt/reviewer.txt` | 独立 reviewer（trace-don't-recompute） |

加一个会话模式或子代理 prompt = 加一个 `.txt` 文件。`backend/src/agents/sub_agent.ts` 的 `SubAgentFactory` 按类型加载；给不到文件时回落到内联 prompt（不会静默变成空 prompt）。

改 prompt 前先读 `core.txt` 的 Integrity rules——那几条（不编造引用、标注证据类型、失败要如实报告）是整套可信度机制的语言侧，改动它们等于改变系统的承诺。

### 契约：模型路由

`backend/src/llm/router.ts` 的 `LLMRouter` 是模型无关的：支持 kimi / openai / anthropic / deepseek / qwen / openrouter，provider 由模型名推断，BYOK。

每个子代理可以配独立模型：重任务用强模型、检索摘要用快模型。**v0.4（W4-a）起已是用户配置项**——`spark-research config set subAgentModel_explore <model>`（五类各一条，也可用环境变量 `SPARK_SUBAGENT_MODEL_<TYPE>`）。解析顺序：显式 override > 按类配置 > 全局 `defaultModel` > 代码常量。

### 用户配置面

`~/.spark-research/config.json` 是配置真源，设置表在 `backend/src/config/index.ts`。优先级一律 **环境变量 > config.json > 默认值**。

```bash
spark-research config list          # 全部配置项：当前值 / 来源 / 改了影响什么
spark-research config get <key>     # 单项详情（含「影响」段）
spark-research config set <key> <v>
```

| 键 | 默认 | 改了影响什么 |
|----|------|------------|
| `defaultModel` | `moonshotai/kimi-k2.6` | 精读卡、综述、Co-explore、novelty claim 提取与引用判定。换弱模型会直接降低引用核验判准率 |
| `defaultProvider` | — | 没有显式指定模型时挑哪把 key |
| `contactEmail` | 占位邮箱 | OpenAlex/CrossRef 的 polite pool。未配置时请求照走但进不了 polite pool，高频检索更易被限流 |
| `userAgent` | 自动拼 | 文献 connector 的 UA。自定义时请保留可联系到你的信息 |
| `wetBackend` | `opentrons_simulate` | **改成 mock_devices 会让协议不再被 Opentrons 解析**——管线照绿，非法协议也「执行成功」。除非在写单测，否则不要改 |
| `simulationPlatform` | `pyref` | `exp new` 的缺省平台。openmm 的 `deterministic=false`，下游结论会被要求按「区间对账」措辞 |
| `mcpTimeoutMs` | `300000` | MCP 工具同步等待长任务的上限。调小会让综述/novelty 经常走任务句柄路径 |
| `dataDir` | `~/.spark-research` | 一切持久化的根。**只能用 `SPARK_RESEARCH_DATA_DIR` 设**（先有目录才有文件） |
| `KIMI_API_KEY` / `OPENROUTER_API_KEY` | — | 凭据。值永不打印、永不进 env、永不进 prompt |

### 怎么测

```bash
bun test tests/unit/config.test.ts        # 优先级三档、凭据不泄漏、设置表与常量一致
bun test tests/unit/orchestrator.test.ts  # prompt 加载与子代理委派
```

### 放哪里

```
backend/src/agents/prompt/<name>.txt   prompt 文件
backend/src/agents/sub_agent.ts        子代理类型、默认模型、permit set
backend/src/config/index.ts            设置表（单一真源）
```

---

## 7. 把工作台接进外部 agent（MCP）

上面六节是「往里加东西」。反方向——把 Spark Research 当工具箱接进 Claude Code 或其他 MCP 客户端：

```bash
spark-research mcp    # stdio 传输
```

MCP 客户端配置（以 Claude Code 为例）：

```json
{
  "mcpServers": {
    "spark-research": { "command": "spark-research", "args": ["mcp"] }
  }
}
```

外部 agent 接进来之后的第一步应该是 `research_capabilities`——一次调用即可 introspect 整个工作台。

工具实现上只是对 HTTP 端点的一次进程内调用（`backend/src/mcp/tools.ts`），不重实现任何业务逻辑：CLI / HTTP / UI / MCP 四个入口共享同一套 service 层，任何一处修了业务规则四个入口同时生效。

### 刻意不暴露的动作

| 不给 | 为什么 | 人怎么做 |
|------|--------|---------|
| `lab_approve` | AD-6：若 agent 能自己批准，它就能自己编译、自己批准、自己执行，approve gate 退化成注释 | `spark-research lab approve <id> --actor <名字>` |
| `lab_reject` | 拒绝同样是记名决策，由人署名才有审计意义 | `spark-research lab reject <id> --actor <名字> --reason <理由>` |
| `lab_simulate` | 执行只允许从 `awaiting_approval` 经人工批准进入 | `spark-research lab simulate <id>` |
| `conclusion_review` | 结论能否进报告结论区是可信度的最后一道闸，不交给外部 agent 自评 | `spark-research conclusion review <id> --actor <名字>` |
| `project_archive` | 破坏性的组织动作 | `spark-research project archive <slug>` |

这张表不是「未实现清单」，是**设计声明**：它进 `capabilities` 输出，也进 MCP server 的 instructions，外部 agent 读到的是「这些必须人来做，以及人该怎么做」，而不是调用失败后自己猜。`lab_compile` 的返回体里会直接给出该执行哪条命令。

守这条边界的不止是「没做这几个工具」：`tests/unit/mcp_server.test.ts` 里有一条结构性防线，遍历全部已暴露工具的请求构造函数，断言没有任何一个能打到 approve / reject / simulate / archive / 结论评审端点。将来有人加一个叫 `lab_finish` 的工具、内部却 POST 到 `/approve`，那条测试会立刻红。

---

## 8. 扩展装载（第三方 extension，不改仓库源码）

上面 1–6 节讲的是"往仓库里加一个模块"（你有仓库写权限，改完提 PR）。本节讲另一条路：
**不改仓库**，把扩展放进 `~/.spark-research/extensions/<name>/`，运行时装载——
面向不想 fork 仓库的第三方开发者，或者想按用户/环境动态开关的能力。

### 目录布局

```
~/.spark-research/extensions/<name>/
  extension.json      manifest：kind / name / version / entry / requires（必需）
  connector.json       kind=connector 时：声明式 connector 定义（见第 2 节的契约，
                        直接复用同一套 schema——backend/src/connectors/manifest.ts）
  index.ts              kind=skill|platform|backend|rule 时：TS 实现
  SKILL.md               kind=skill 时：同第 1 节的 frontmatter 契约
  mcp.json               kind=mcp_client 时：外部 MCP server 的启动配置（数据，见下）
  tests/                 配套验证
```

### 三种装载强度

| 强度 | 形态 | 是否执行代码 | 需要 `--trust` |
|---|---|---|---|
| ① 声明式 connector | `connector.json` | 否——只是数据，编译成受限的 URL 拼装 + 受限的响应字段抽取（第 2 节 DSL 的边界原样适用） | 否 |
| ② TS 扩展 | `skill` / `platform` / `backend` / `rule` 的 `index.ts` | 是——与宿主进程同 UID、同权限，跟仓库里写的代码没有区别 | **是** |
| ③ 外部 MCP client | `mcp.json` + 一个外部可执行文件 | 不 `import` 任意 TS 代码，但会**启动一个子进程**并用 stdio 跟它说 MCP 协议——本地任意命令执行的风险面不比②低 | **是**（指纹覆盖 `mcp.json`，不是某个 TS 文件） |

`extension.json` 的形状：

```ts
interface ExtensionManifest {
  kind: "connector" | "skill" | "platform" | "backend" | "rule" | "mcp_client";
  name: string;        // kebab-case，须与目录名一致
  version: string;      // "0.1.0" 这类
  description: string;
  entry?: string;        // kind !== "connector" 时用，默认 "index.ts"（mcp_client 不用这个字段）
  requires?: {
    credentials?: string[]; // 想访问哪些 connector 的凭据（申报，不等于拿到）
    tools?: string[];        // 想调用哪些 ToolBus 工具（同上）
  };
}
```

### `--trust`：TOFU 信任模型

TS 扩展与仓库代码同权限执行——`--trust` 不是沙箱开关，是"未经确认的静默执行"的
开关。模型是 trust-on-first-use（同 SSH `known_hosts`）：

```bash
spark-research ext load ~/.spark-research/extensions/my-rule
# ✗ 扩展 "my-rule"（kind 需要代码执行）尚未信任，拒绝装载。
#   入口文件指纹：sha256:3f9c...
#   确认这段代码可信后，重新执行并加上 --trust。

spark-research ext load ~/.spark-research/extensions/my-rule --trust
# ✓ 已装载扩展 "my-rule"（kind=rule）
```

指纹记在扩展目录旁的 `.trust.json`（不是直接改写 `extension.json`——那是用户手写/
版本控制的文件，静默重写它风险大于收益）。第二次装载**不需要**再传 `--trust`，
只要入口文件内容没变；内容一旦变化（哪怕只改一个字符），指纹跟着变，下一次装载
又会回到"未信任"状态，必须重新确认。

**这不是沙箱**：`--trust` 挡的是"没看一眼指纹就被动执行"，挡不住"确认了之后代码
干了什么"——被信任的扩展能做任何仓库代码能做的事（读写文件、发网络请求、…）。
真正的边界在下一段。

### 凭据 / ToolBus 访问：声明 + 授权缺一不可

扩展**默认拿不到任何凭据或 ToolBus 工具**，即使 `extension.json` 里声明了
`requires.credentials` / `requires.tools`——声明只是申报，用户要显式批准：

```bash
spark-research ext grant my-rule --credential paidsource
spark-research ext grant my-rule --tool lit_search
```

装载器构造的 `ExtensionContext`（`backend/src/extensions/context.ts`）在
**声明过 且 被授权过**的交集之外一律拒绝——manifest 没声明的 id/工具名，授权了也没用；
声明过但没被授权的，同样没用。凭据值本体依然只经过 `CredentialStore`（AD-2 原有边界
不变），扩展代码永远看不到"这个值是怎么存的"，只能通过 context 拿到已授权项的值。

### 装载后出现在 `capabilities` 里

扩展的能力位由 `backend/src/extensions/capabilities.ts` 的 `listExtensionCapabilities()`
产出（`available` / `needs_grant` / `unverified` / `stale_verify` / `failed` 五档），
**不执行任何扩展代码**——只读 `extension.json`（数据）+ 授权记录 + 上一次 `ext verify`
的缓存结论，理由与主 capabilities 模块"静态可用性 vs 探测可用性"的分档一致：一个会被
频繁调用的只读自描述端点，不应该顺手把每个扩展的 `index.ts` 都 import 一遍。

### 强度③详解：外部 MCP client（相对 OpenScience 的净增益点，v0.4 W4-d）

OpenScience 有 MCP client，但外部工具调用不进 provenance。spark 因为统一的 ToolBus
审计，外部工具的每次调用**结构性地**落进一条执行记录——不是文档里的承诺，是
`ExternalMcpSession.call()`（`backend/src/extensions/mcp_client.ts`）的实现方式：
无论调用成功、失败、超时、还是工具名压根不存在，返回结果之前都会先落一条记录，
调用方没有绕过这一步的合法路径（除非绕开这个模块本身直接用 SDK——那属于"不通过
spark 提供的通道"，与 TS 扩展绕过 `ExtensionContext` 直接 `import` 拿凭据是同一类
已知边界，见下方"不挡什么"）。

**`mcp.json` 的形状：**

```ts
interface McpClientConfig {
  command: string;        // 启动外部 MCP server 的可执行文件，不经过 shell
  args?: string[];
  cwd?: string;
  env?: string[];          // 显式白名单：允许透传的宿主环境变量**名**（不是值的拷贝）
  credentials?: Array<{ id: string; field: string; env: string }>; // 凭据 → 子进程 env 的映射
  startupTimeoutMs?: number; // 默认 8000
  callTimeoutMs?: number;    // 默认 30000
  verifySample?: { tool: string; args?: Record<string, unknown> }; // ext verify 用，可选
}
```

**接入一个外部 MCP server：**

```bash
spark-research ext add-mcp my-server --cmd "node path/to/server.js" --trust
# ✓ 已写入扩展目录 ~/.spark-research/extensions/my-server（kind=mcp_client）
# 扩展 "my-server" 信任指纹已记录：sha256:...
# ✓ 发现 3 个外部工具：search, fetch, summarize
```

带凭据的例子（`ext grant` 批准之后，值才会被注入子进程）：

```bash
spark-research ext add-mcp paid-search \
  --cmd "npx some-mcp-server" \
  --credential paidsource:apiKey:UPSTREAM_KEY \
  --trust
spark-research ext grant paid-search --credential paidsource
```

`--cmd` 是朴素的空白切分，**不是**完整 shell 解析——带引号/转义的复杂命令行需要
自己把 `command` 与单个 `args` 拆开（与 `StdioClientTransport` 本身 `shell:false`
的边界一致，不假装支持任意 shell 语法）。

**安全边界（挡什么 / 不挡什么，照 W2-c 的标准写）：**

- **它拿得到什么**：一个独立的子进程，同 UID，但**不与宿主进程共享 V8 堆**——宿主
  不 `import` 它的代码。环境变量默认只有 SDK 自带的最小安全集合
  （`HOME`/`LOGNAME`/`PATH`/`SHELL`/`TERM`/`USER`），**不会**继承宿主进程完整的
  `process.env`；`mcp.json` 的 `env` 白名单可以额外放行具名变量，`credentials`
  映射可以额外注入**已被 `ext grant` 批准过**的凭据值——两条都是显式加法，不是
  默认继承。
- **凭据默认拿不到**（AD-2 在"另一个进程"这个边界上的落点）：manifest 声明过
  **且**被 `ext grant --credential` 批准过的 id，才会被解析出值、注入子进程 env；
  少一个条件都不会。唯一的取值路径是 `ExtensionContext`（同 TS 扩展），
  `resolveMcpChildEnv()` 没有第二条"直接问 CredentialStore"的路。
- **它挂了 / 超时 / 返回垃圾**：`connectExternalMcp()` 与 `ExternalMcpSession.call()`
  一律把异常吞成结构化的 `{ok:false, reason}` / `{ok:false, payload:{error}}`，
  绝不向上抛出未捕获异常——主进程不会被一个失控的外部进程拖垮。`capabilities`
  会把"上一次尝试连接失败"反映成 `status: "failed"`（`ext add-mcp`/`ext verify`
  跑一次发现步骤后写进 `.mcp_discovery.json`，`capabilities --json` 只读这份
  缓存，不会为了回答"这个扩展有哪些工具"而顺手再起一个子进程）。
- **要出现在 `capabilities --json` 里，标明来源**：`kind="mcp_client"` 的条目带
  `origin: "external_mcp_server"` 字段，以及上一次发现到的 `mcpTools` 清单——
  一眼能看出这份能力不是仓库代码，是外部进程提供的。
- **不挡什么（如实写）**：
  - **子进程一旦启动，它能做任何该 UID 能做的事**——读写文件、发网络请求、
    `fork` 更多进程。`stdio` transport 本身不是沙箱，只是一条通信管道；
    `--trust` 挡的是"未经确认的静默执行"，不是"确认后代码干了什么"，与②的边界
    完全一致。
  - **执行记录的"必然落盘"只覆盖经过 `ExternalMcpSession.call()` 这条路径的调用**。
    如果收口方在别处直接 `new Client(...)` + `StdioClientTransport` 连接同一个
    外部 server，绕开这个模块自己发起调用，那次调用不会被记录——这和"扩展绕开
    `ExtensionContext` 直接 `import` 拿凭据"是同一类边界：结构性保证覆盖"遵守
    约定的调用方"，不是运行时隔离。
  - **`mcp.json` 的 `--cmd` 解析是朴素空白切分，不是 shell 解析**，也不会对
    `command` 本身做白名单校验——`command` 可以是任意本地可执行文件，这正是
    "启动任意 command 等价于本地任意命令执行"的字面意思，`--trust` 挡的是
    "没看一眼就被动执行"，不是"这个命令能不能被信任"这个判断本身（那是人的责任）。
  - **`ext verify`（kind=mcp_client）不是沙箱**——它验证"外部 server 是否符合
    最基本的 MCP 契约、声明的 `verifySample` 能否真的往返"，往返调用本身就需要
    真的执行外部代码，不提供执行隔离。且它**没有**接入真实的 CredentialStore
    （`ext verify` 是独立 CLI 调用，不经过 daemon）——如果 manifest 声明了
    `requires.credentials`，verify 时那些变量不会被注入子进程，这是已知限制。

**接进 ToolBus 的方式**（`backend/src/agents/toolbus.ts` 不在本节涉及的 lane 名下，
只读复用）：`mcp_client.ts` 导出 `ExternalToolRegistry`（工具名 `mcp:<extension>:<tool>`
的路由表）与 `createExternalToolRunner()`（一个 `async` 工厂，返回"`McpToolRunner`
的实例，但外部工具名路由给 registry"）。daemon 接线时，把构造 `AgentToolBus` 用的
`options.runner` 从 `new McpToolRunner(...)` 换成
`await createExternalToolRunner(sameOptions, registry)`——`AgentToolBus` 已有的
授权 / 预算 / 审计三层不需要改一行代码，就对外部工具名同样生效。

## 9. `ext verify`：能装上不等于装好了（AD-11）

```bash
spark-research ext verify ~/.spark-research/extensions/<name>
```

四类扩展各自跑什么、直接复用了哪套既有投资：

| kind | 跑什么 | 复用的既有投资 |
|---|---|---|
| `connector` | 100 并发参数映射一致性（串行 vs 并行逐位比对）+ 凭据不进出站请求 + 错误消息不回显响应体 | `tests/concurrency/connector_race.test.ts` 的手法（v0.3.0 修 P0 竞态的第二次回本）+ W1-c 的 SSRF 白名单（装载路径真的会走到 `assertOutboundUrlAllowed`） |
| `platform` | 生成一个临时 `*.test.ts`，原样 `import { describeSimulationContract }` 并喂给扩展提供的 `contract.json`（`okSpec`/`equivalentSpec`/…/`runTimeoutMs`），spawn 一次 `bun test` 跑完整 13 条契约断言 | `tests/helpers/simulation_contract.ts`（AD-4"两个实现验证接口"的投资在这里第二次回本，跑的断言逻辑一个字都没重写） |
| `rule` | 静态扫描源码有没有明显的 IO / 非确定性原语（`node:fs`/`fetch`/`Math.random()`…）+ 用扩展声明的 `VERIFY_SAMPLE_INPUT` 调用 `evaluate()` 两次比对结果 | —— |
| `skill` | `SKILL.md` frontmatter schema 校验（`backend/src/skills/frontmatter.ts`，P9 真源）+ `validation[]` 声明的 e2e 文件实际存在且 `bun test` 能跑通 | P9 的 frontmatter 校验器 |
| `backend`（WetLabBackend） | **已知限制**：只做结构检查（能 import、导出 `{id, description, available(), execute()}`），不跑 `backend/src/lab/` 的完整契约测试——那套依赖真实 `opentrons.simulate` 且不在本节所有权范围内 | —— |
| `mcp_client` | `mcp.json` 校验 + 真实连接一次外部 server 并 `listTools()`（工具清单非空、名字合法）+ 如果声明了 `verifySample`，真实调用一次并确认往返成功、且 `.mcp_calls.jsonl` 确实新增了一条执行记录（provenance 差异化点的契约化验收） | —— （这一档没有可复用的既有投资：连接一次外部进程是这类扩展契约测试无法绕开的必然要求，与 platform/skill verify"必须执行扩展代码"是同一类必然性） |

`ext verify` 的结论会缓存（扩展目录下的 `.verify.json`，记录结论 + 被校验对象的
sha256），`ext load` 装载时会拿当前内容的指纹跟缓存比对：**从未验证过**、
**验证过但内容已变化**、**上次没通过**，三种情况都会在装载时打印一条不阻断装载的
`⚠️` 警告——AD-11 的字面意思是"能装上不算装好"，所以装载器选择"仍然装上，但把
这件事大声告诉你"，而不是替你做"要不要用一个没验证过的扩展"这个决定。

### 安全边界的准确表述（不重蹈评审 S-3"沙箱一行逃逸"）

- **`ext verify` 不是沙箱，是契约测试**。跑 `platform`/`rule`/`skill` 的 verify 本身
  就需要执行扩展代码（这是运行时契约测试的本质要求），它验证的是"这段代码的行为
  符不符合契约"，不提供任何执行隔离。
- **`--trust` 挡的是"未经确认的静默执行"，不是代码本身的行为**。信任了的扩展与
  仓库代码同权限、同 UID，能读写文件、发任意网络请求。
- **声明式 connector（强度①）不执行任意代码，这是它比 TS 扩展更安全的地方**——
  但它的 SSRF 防护是字面量白名单，不防 DNS rebinding（继承自 W1-c 的已知限制，
  见 `backend/src/connectors/manifest.ts` 头部注释）。
- **`ExtensionContext` 挡得住"扩展代码规规矩矩地"通过 context 访问凭据/工具时
  越界的请求**（声明外的 id/工具名会被拒绝），**挡不住**扩展绕过 context、直接
  `import` 其它模块自己拿凭据/发请求——TS 扩展与仓库代码同权限，这条防线是
  "对遵守约定的代码的结构性约束"，不是运行时隔离。

## 10. 提交前自查

```bash
bun run typecheck
bun test tests/unit/
.venv/bin/python -m pytest tests/ -q
spark-research capabilities        # 你加的东西出现了吗？
```

四条通用要求（`docs/DEVELOPMENT_PLAN.md` 〇 工程纪律）：新模块必须带单测；真实外部依赖本地跑通一次后录制成 fixture，CI 永远回放；对抗测试优先于 happy path；凭据永不进 repo / prompt / 日志。
