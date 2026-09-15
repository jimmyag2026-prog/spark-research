# W9 lane β · 模型控制面（U10 / U9 / U5 / V16）

worktree `~/Desktop/AI4S/spark-research-beta`，分支 `feat/W9-beta`，基线 `integration/v0.9-base`（f921bf0）。

顺序按任务书：**β-3 前置盘点 → β-3 派生清单与抛错 → β-1 `chat()` 真读 model → β-2 `chat` 旗标**。

---

## β-3 前置 · 在用模型名盘点（`scripts/inventory-model-names.ts`）

为什么先做：β-3 要把 `providerForModel()` 结尾的 `return "kimi"` 改成抛错。改完之后
**正在用、但没显式登记的模型名会当场失败**（U5 的「风险」段原话）。所以先盘点。

扫描面：`~/.spark-research/config.json` 的 `defaultModel` / `subAgentModel_*` / `embeddingModel`，
加 `~/.spark-research/projects/*/usage.jsonl` 里出现过的全部 `model` 值（带出现次数与台账里
实际记下的 provider）。只读，绝不碰 credentials.json，不打印任何 `*_API_KEY`。

实跑结果（2026-09-15，真实数据目录）：

```
$ bun scripts/inventory-model-names.ts
数据目录：/Users/jimmyclaw/.spark-research · 模型名 2 个
```

| 模型名 | 调用次数 | 出现在 | 现行路由 | 判据 | 单价表 |
|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 2137 | `config:defaultModel` + 29 个项目的 usage.jsonl | openrouter（台账记 openrouter） | 显式登记 | 有 |
| `moonshotai/kimi-k2.6` | 108 | `usage:r5-t3`、`usage:r5-t3-copy` | openrouter（台账记 openrouter） | 显式登记 | 有 |

**β-3 影响面：无。** 在用的两个模型名都显式登记且都在单价表里，改抛错不会打断任何正在用的模型。
`subAgentModel_*` / `embeddingModel` 在 config.json 里一项都没配（全部走默认），所以也没有
隐藏的第三个在用名字。

**顺带坐实了 U10。** 盘点是按 `usage.jsonl` 里真实落下的 `model` 字段聚合的：U10 现场跑过
`deepseek-v4-flash` 与 `qwen-max` 两轮，但全库 2245 条调用记录里这两个名字**一条都没有**，
`usage:speed-probe` 那一项只挂在 `z-ai/glm-5.3-flash` 名下。这与 U10 证据一（台账里一条
deepseek 记录都没有）是同一个事实的两次独立观测——模型覆盖从未生效。

---

## β-3 · 模型清单从单价表派生 + 认不出的名字抛错（U5）

### 做了什么

`backend/src/llm/providers/registry.ts`：

- `MODELS_BY_PROVIDER` **从 `PRICING` 派生**。单价表本来就是 provider → model → price
  的嵌套结构，已经携带了「这个模型属于哪一家」这个事实；U5 证据三说的两份手写副本，
  从此只剩一份真源。收口 diff 把 `router.ts` 的 `PROVIDER_MODELS` 改成 import 它。
- `assertKnownModel(name)`：三档返回 `registered` / `keyword` / `local`，认不出抛
  `UnknownModelError`（`kind: "unsupported"`），消息里列出全部已登记模型并指向
  `config set defaultModel` 与单价表。**三处调用方共用这一个判据**：router 的
  `providerForModel`（收口 diff）、CLI 的 `config set`（本 commit）、lane γ 的设置面
  HTTP 路由（γ import 它，不另写一份）。
- 关键词兜底**保留**但每命中一个新名字 `console.warn` 一行（同名只警告一次，避免刷屏）。
  「自动化降级必须 log」是本仓库自己的纪律，U5 指出这里连 log 都没有。
- `PROVIDER_API_KEY_ENV` 改为**惰性求值**（Proxy，值与语义不变）。这是收口 diff 能成立的
  前提：收口让 router import registry 之后，`registry → router`（providerApiKeyEnv）与
  `router → registry`（MODELS_BY_PROVIDER）两条运行期 import 边成环，而原来的写法在模块
  顶层就调进 router，先被求值的一侧会踩 ESM 的 TDZ（router 的 `ADAPTERS` 还没初始化）。
  推迟到第一次真正读这张表时再调，环就是安全的。**已实测**：临时应用收口 diff 后六套件照跑。

`backend/src/config/cli.ts`：`config set defaultModel` / `subAgentModel_*` 写入前调
`assertKnownModel`，未登记直接拒绝（U5「顺带」那条）；关键词兜底放行但当面打一行告警——
不能比运行期更严，否则会出现「配不进去、但直接调用能跑」的怪事。

### 行为变更说明（U5 证据四那个坑）

裸名 `kimi-k2.6` 与带前缀 `moonshotai/kimi-k2.6` 此前一个走关键词兜底（kimi）、一个显式
登记（openrouter），两个近似串走两条路由两套单价且**没有任何提示**。派生之后**两个都是
显式登记**（单价表里 kimi 段与 openrouter 段各有一条，价格本来就不同），行为不变但不再
是「一个显式一个兜底」——真正被拒绝的是既不在单价表、关键词也认不出的名字（如
`z-ai/glm-6-preview`），这正是期望行为。

派生后从 `PROVIDER_MODELS` 消失的四个名字（`kimi-k2` / `moonshot-v1-32k` /
`moonshot-v1-8k` / `qwen3`）都不在单价表里：前三个已于 2026-08-31 被 Moonshot 退役，
`qwen3` 不是可计价 SKU。它们仍能经关键词兜底路由（带一行警告），不会当场失败；
盘点证明**没有人在用它们**。

### 阴性对照（真跑）

| 改法 | 结果 |
|---|---|
| 派生清单里手动 `.filter(m => m !== "kimi-k3")` | 🔴 2 fail：「MODELS_BY_PROVIDER 逐 provider 等于单价表的键集合」+「登记不许陈旧」 |
| `assertKnownModel` 的 `throw` 改回 `return { kind:"keyword", provider:"kimi" }` | 🔴 4 fail：抛错两条 + `config set` 拒绝写入两条 |
| 恢复 | 🟢 18 pass / 0 fail |

---

## β-1 · `chat()` 真的读 `model`（U10）

### 做了什么

修复本体落在 `backend/src/agents/orchestrator.ts`——本 lane 的**禁止文件**，所以交付物是
「门禁 + 收口 diff」：`tests/unit/gate_model_override.test.ts` 里的 `applyBeta1Collar()`
把收口 diff 的语义逐行等价地在实例上打了一遍补丁（`sessionModel` Map / `chat()` 开头存删 /
`llmFor()` 返回的 `call` 用它覆盖调用点的默认模型），报告「收口 diff」段贴的就是与它
一一对应的 orchestrator.ts 改动。收口应用 diff 后删掉补丁函数即可，断言一个字不用改。

门禁用的是**真的 `LLMRouter`**（provider 选择、baseUrl、鉴权判断全是真逻辑），只把最外层
`fetch` 换成记录器，env 只有 `OPENROUTER_API_KEY`——U10 现场的配置形状。四条断言：
① 覆盖生效（出站请求的 model 全是 `qwen-max`，一次默认模型都不许有）；
② 硬判据（指定拿不到 key 的 `local/llama3.1` → `kind: "auth"` 失败，同一套配置不带覆盖照常成功）；
③ 不粘连（第二次不传 model 回到默认）；④ 已知残余快照（见下）。

### 为什么硬判据没有照任务书用 `qwen-max` 无 key

任务书原文是「配置里只有 `OPENROUTER_API_KEY`，调 `chat({model:"qwen-max"})` → 必须失败，
`LlmError.kind === "auth"`」。**实测这条在修好 U10 之后仍然不会失败**，原因不在 chat()：

```ts
// backend/src/llm/router.ts · LLMRouter.resolve()
const preferred = ADAPTERS[providerForModel(model)];
if (preferred && this.env[preferred.envKey]) return { ...preferred, wireModel: identity };
for (const provider of implementedProviders()) {          // ← 隐式回退
  const entry = ADAPTERS[provider]!;
  if (this.env[entry.envKey]) return { ...entry, wireModel: identity };
}
```

模型所属 provider 没配 key 时，router 会**隐式回退到任何一个已配置的 provider**
（`capabilities/index.ts:123` 的注释已经点名这个行为，它自己构造单 key 的临时 router 来
绕开）。所以 `qwen-max` 会带着 "qwen-max" 这个模型名被发给 OpenRouter 并正常返回。
**这是「无 key 照常回答」的第二个成因**，与 U10（覆盖根本没被读）叠在一起，现场无法区分。

处理方式（如实交代，不粉饰）：
- 覆盖是否生效改用**出站请求体里的 model 字段**判定——这直接对应 U10 证据一（台账里
  一条 deepseek 记录都没有，全是默认模型），比 auth 失败更贴近现场。
- 「必须失败」的硬判据换成 `local/llama3.1` + 未设 `SPARK_LOCAL_LLM_BASE_URL`：本地端点
  **不参与**那条隐式回退（router.ts 注释写明「它是显式 opt-in，不应该在用户没提到
  local/ 时悄悄替对方发请求」），所以失败与否只取决于覆盖有没有生效，回退救不了它。
- 隐式回退本身钉成第四条用例（当前行为快照）。改它要动 `router.resolve()`，是枢纽文件，
  **不在本 lane 足迹内**，且会影响 capabilities 探测的既有绕法——列进报告交收口决定。

### 阴性对照（真跑，红/绿原样）

改法：`applyBeta1Collar` 里 `const read = opts.readSessionModel !== false;` →
`const read = false;`（= `llmFor` 不读 `sessionModel`，U10 的原状），其余一个字不动。

🔴 红（3 条 fail，摘出判据行）：

```
133 |       expect(new Set(outbound.map((o) => o.model))).toEqual(new Set(["qwen-max"]));
error: expect(received).toEqual(expected)
  Set {
-   "qwen-max",
+   "moonshotai/kimi-k2.6",
  }
(fail) 闸门 · chat(req.model) 必须真的改变发出去的那次调用（U10） > 覆盖生效：chat({ model: 'qwen-max' }) → 每一次出站请求带的都是 qwen-max，不是配置默认模型

153 |       expect(responses.every((r) => !r.ok)).toBe(true);
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) 闸门 · chat(req.model) 必须真的改变发出去的那次调用（U10） > 覆盖生效的硬判据：指定一个拿不到 key 的模型 → 调用必须失败（kind=auth），不许静默照常回答

170 |       expect(new Set(outbound.map((o) => o.model))).toEqual(new Set(["qwen-max"]));
error: expect(received).toEqual(expected)
  Set {
-   "qwen-max",
+   "moonshotai/kimi-k2.6",
  }
(fail) 闸门 · chat(req.model) 必须真的改变发出去的那次调用（U10） > 不粘连：同一会话第二次 chat() 不传 model → 回到默认模型
```

**这就是 U10 的复现**：传 `qwen-max`，发出去的却是默认模型，调用照常成功，没有任何报错。

🟢 绿（恢复后）：

```
bun test v1.3.14 (0d9b296a)
 4 pass
 0 fail
 16 expect() calls
Ran 4 tests across 1 file. [690.00ms]
```

---

## β-2 · `chat` 子命令补旗标（U9）

### 做了什么

`backend/src/cli/chat_args.ts`（新，**纯解析，不碰 I/O**）：`parseChatArgs(argv)` →
`{ help, message, model?, budgetUsd?, allowUnpriced?, project?, error? }` + `CHAT_HELP`。
三条硬规则：① `--help`/`-h` 优先，返回后调用方只打印帮助；② `--` 之后全部当消息；
③ **未识别的 `--xxx` 报错**而不是塞进消息——U9 的根因就是「认不出的东西默认当消息」。
另支持 `--name=value` 写法，`--budget-usd` 非数字/负数直接报错。

接线（`index.ts` 的 `case "chat"` + `chatOnce`）是枢纽文件，归收口；模块已按纪律登记进
`tests/unit/narrative_parity.test.ts` 的 `ALLOWED_ORPHANS`（「等收口接 β-2 diff」）。

### 门禁 `tests/unit/gate_help_no_llm.test.ts`

命令清单**从 `contract` 枚举**（真源 = `contract/cli_registry.ts` 的 `CLI_COMMANDS`
+ 从各模块 HELP 文本提取的子命令），共 96 条命令/子命令，每条起一个真进程跑
`<cmd> [sub] --help`，用 `bun --preload` 在子进程里把 `LLMRouter.prototype.call` 换成
记录器（写 marker 并抛错），断言 marker 为空。**为什么不是手写清单**：V128 修过同名问题
却漏了 `chat`，靠人记不住；新增命令会自动进入这条门禁。

两张必须带理由的登记表，都有陈旧检查：
- `SKIP_NON_TERMINATING`（cli / mcp / server / init / demo）：常驻进程或交互式向导，
  「起进程等它自己退出」这条判据对它们不适用，**不是豁免**。每条都核实是真实命令。
- `HELP_LLM_PENDING`（当前只有 `chat`）：修复在禁止文件里，**自退役**——「登记不许陈旧」
  那条断言要求登记的命令此刻**必须真的还在调模型**；收口接上之后它会红，逼着删登记。

子进程 env 里放了占位 `KIMI_API_KEY`：没有 key 时 `chatOnce` 会提前 return，那样即使
没修好也「碰巧」不调模型——**那是假绿**，必须堵掉。

### 阴性对照（真跑）

| 改法 | 结果 |
|---|---|
| `parseChatArgs` 去掉 `--help`/`-h` 判据 | 🔴 1 fail：`--help / -h 优先：只返回 help，消息为空` |
| 收口 diff 应用后（临时验证） | 🔴 1 fail：`登记不许陈旧：HELP_LLM_PENDING 里的命令此刻必须真的还在调模型`——即门禁翻面，`chat --help` 不再调模型 |
| 交付态 | 🟢 13 pass / 0 fail（8.09s，96 个子进程） |

### V16 顺带确认

`subAgentModel_*` 五个配置项确实有真实读者：`backend/src/agents/sub_agent.ts:254`
调 `configuredSubAgentModel(type, globalDefault, configOptions)`，且
`tests/unit/config_reader_parity.test.ts:62` 把动态 key 族 `subAgentModel_<type>` 钉到了
这个 helper 上。**不新做**，另外 β-3 把 `config set subAgentModel_*` 也纳入了模型名校验。

---

## 收口 diff 的实测验证（重要）

三份收口 diff（router.ts / orchestrator.ts / index.ts）**临时应用后实跑过**，
随后原样 revert，交付树里这三个文件与基线逐字节一致
（`git diff integration/v0.9-base -- <三个文件>` 为空）。

应用后 `bun test tests/unit` = **2514 pass / 5 fail**，5 条红**全部**是「接了就该删」的
自退役登记，没有一条是真回归：

| 红的断言 | 收口同一个 commit 里要做的事 |
|---|---|
| `GATE_I_ALLOWLIST 不许陈旧` | 删 `agents/orchestrator.ts::OrchestratorAgent.chat::req.model`（V145 = U10） |
| `ALLOWED_ORPHANS ... 已不再是孤儿` | 删 `backend/src/cli/chat_args.ts` 一条 |
| `HELP_LLM_PENDING 里的命令此刻必须真的还在调模型` | 删 `chat` 一条 |
| `登记不许陈旧：两张表里的每一条都必须确实还是差集` | 删 `PRICED_ONLY_MODELS` 4 条 + `PROVIDER_ONLY_MODELS` 4 条 |
| `U5 现状复现（收口后必须改）` | 改成 `expect(() => providerForModel("z-ai/glm-6-preview")).toThrow(UnknownModelError)` |

验证过程中抓到并解决的两个真问题（都不是登记表，是代码）：

1. **import 成环**：`registry → router`（`providerApiKeyEnv`）与 `router → registry`
   （`MODELS_BY_PROVIDER`）两条运行期边成环，先被求值的一侧会踩 TDZ。
   两头都改：registry 的 `PROVIDER_API_KEY_ENV` 改惰性 Proxy（已在本 lane 落地），
   router 侧用 **re-export（live binding）** 而不是 `const X = MODELS_BY_PROVIDER`，
   并把 `static readonly PROVIDER_MODELS` 改成 `static get`（静态字段是模块求值期执行的）。
   第一版直接 `export const PROVIDER_MODELS = MODELS_BY_PROVIDER` **实测炸**：
   `ReferenceError: Cannot access 'MODELS_BY_PROVIDER' before initialization`。
2. **记账层被抛错打断**：`usage/ledger.ts:270` 在每次调用前 `providerForModel(requestedModel)`
   只为查 provider 计价；改抛错后 `tests/unit/g1_model_config.test.ts` 的
   「`--model flag-wins` 覆盖 defaultModel」当场红（一个编出来的模型名）。
   补了不抛的 `resolveModelName()`，ledger 两行改动进收口 diff（`usage/**` 是 α 的足迹）。
   另在 `LLMRouter.call()` 里把 `UnknownModelError` 翻译成 `ok:false / kind:"unsupported"`
   ——AD-13 要求 LLM 的失败以响应回到调用方，不是异常穿透。

## 环境坑（会影响所有 lane 报数）

这台机器的 shell 里有 `http_proxy` / `https_proxy` / `all_proxy`（`127.0.0.1:1108x`）。
Bun 的 `fetch` 会把**指向 127.0.0.1 的请求也走代理**，于是所有起本地 server 的用例
（server.test.ts / http_*.test.ts / ui_cli_parity 等）拿到空响应，
`bun test tests/unit` 在基线 f921bf0 上就有 **164 fail**——**与代码无关**。
已用 `git stash` 在干净基线上复现确认。**报数一律加 `no_proxy="*" NO_PROXY="*"`**，
加了之后基线与本 lane 都是 0 fail。
