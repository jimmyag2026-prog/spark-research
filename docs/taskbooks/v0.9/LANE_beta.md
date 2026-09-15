# lane β · 模型控制面（U10 / U9 / U5 / V16）— worktree `~/Desktop/AI4S/spark-research-beta`，分支 `feat/W9-beta`

先读 `_COMMON.md` 逐条遵守，再读 `docs/USAGE_LOG.md` 的 **U5 / U9 / U10** 证据段（U10 的决定性实验必须能被你的门禁复现）。基线 `v0.9.0-alpha.1`。**闸门 I 的盘点名单里 U10 已归你**，检查任务书末尾「追加」段有没有闸门 I 塞进来的新条目。

## 三件事（三个 commit，顺序不能换：β-3 的盘点先于一切）

### β-3 前置 · 在用模型名盘点（新 `scripts/inventory-model-names.ts`）
为什么先做：β-3 要把路由兜底改成抛错，改完之后**正在用的未登记模型会当场失败**。所以先知道有谁在用。
交付：扫 `~/.spark-research/config.json` 的 `defaultModel` / `subAgentModel_*` / `embeddingModel`，以及 `~/.spark-research/projects/*/usage.jsonl` 里出现过的全部 `model` 值；对每个名字调 `providerForModel`（现行逻辑）并标注：显式登记 / 关键词兜底 / 落到默认兜底。输出表格进 devlog。**凡「关键词兜底」或「默认兜底」命中且在用的，本 commit 里补登记进 registry**（β-3 主体做的派生会自动包含它们）。

### β-3 · 路由兜底改显式拒绝 + 两份清单合一（`backend/src/llm/providers/registry.ts`）
现状：`router.ts:126 providerForModel` 结尾 `return "kimi"`（认不出一律当 Kimi，用错 baseUrl 发请求）；`PROVIDER_MODELS`（router.ts）与单价表（registry.ts）各写一份「模型属于哪家」，实测差集 `deepseek-v4-flash · deepseek-v4-pro · kimi-k2.6 · kimi-k3`。
交付：① registry.ts 导出 `MODELS_BY_PROVIDER: Record<Provider, readonly string[]>`，**从单价表派生**（单价表本就是 provider → model → price 嵌套）。② 收口 diff：router.ts 的 `PROVIDER_MODELS` 改为 `import { MODELS_BY_PROVIDER as PROVIDER_MODELS }`，`providerForModel` 末尾 `return "kimi"` 改为 `throw new LlmError({ kind: "unsupported", message: "模型 '<m>' 未登记。已登记：<按 provider 分组列出>。用 spark-research config set defaultModel <名> 指定，或在 llm/providers/registry.ts 登记单价。" })`；关键词兜底分支保留但 **`console.warn` 一行**「模型 X 未显式登记，按关键词判给 Y」。③ `config set defaultModel` 写入时校验（调 `providerForModel`，抛错即拒绝写入）——**这一条与 γ-3 同源，你只做 CLI 侧，γ 做 HTTP 侧，都调同一个校验函数**：把校验抽成 `registry.ts` 的 `assertKnownModel(name)` 导出，γ 会 import 它。
测试 `tests/unit/model_registry_parity.test.ts`：① 单价表与派生清单集合相等（这是对撞门禁）② 未登记名 → `providerForModel` 抛 `unsupported` ③ 关键词兜底命中 → 有 warn（用 spy）④ `config set defaultModel 不存在的名` → 拒绝且 config.json 未改。
**具体坑（U5 证据四）**：`moonshotai/kimi-k2.6` 登记在 openrouter，裸名 `kimi-k2.6` 关键词兜底判给 kimi——两个近似串走两条路由两套单价。β-3 落地后裸名 `kimi-k2.6` 若不在单价表就会被拒绝，这是**期望行为**；把这条写进 devlog 作为行为变更说明。

### β-1 · `chat()` 真的读 `model`（U10）
现状：`orchestrator.ts:1053 chat(req)` 声明 `model?: string`，HTTP `/chat` 与 `/stream` 都传了进来（已核实两条路由都传），**函数体从没读过**。`sessionBudget`(460) 的存法是现成套路。
交付（收口 diff，你写 diff + 测试）：`private readonly sessionModel = new Map<string, string>()`；`chat()` 开头 `req.model ? this.sessionModel.set(id, req.model) : this.sessionModel.delete(id)`；`llmFor(sessionId)`(462) 返回的 `call` 在没有显式 model 时用 `this.sessionModel.get(sessionId) ?? configuredModel(DEFAULT_MODEL)`——**改 `llmFor` 一处，覆盖 plan/execute/summarize/review 全部调用点**（它们都经 `llmFor`，见 706/758）。usage 记录的 `model`/`provider` 来自**实际发出的那次调用**（α-4 在改 ledger，你只需保证传给 ledger 的是真实值——在 devlog 里写清你验证的方式）。
**门禁（这是本 lane 最重要的交付）** `tests/unit/gate_model_override.test.ts`：起一个假 daemon，配置里只有 `OPENROUTER_API_KEY`，调 `chat({ model: "qwen-max" })`（已登记、provider=qwen、无 key）→ **必须失败**，`LlmError.kind === "auth"`。**只有覆盖真正生效才通过；静默忽略必然被抓。** 再一条：同一会话第二次 `chat()` 不传 model → 回到默认模型（不粘连）。
测试注释里写：这条门禁抓的是整类「参数声明了要能生效」，形状来源 U10；闸门 I 抓「有没有读」，本门禁抓「读了有没有用」。

### β-2 · `chat` 子命令补旗标（新 `backend/src/cli/chat_args.ts`）
现状：`index.ts:489 case "chat"` 把 `process.argv.slice(3).join(" ")` 整个当消息；`chat --help` 是一次要花钱的模型调用（实测挂两分钟）；`chatOnce` 只传 `sessionId + message`，无预算闸、无 `--project`、无 `--model`。
交付：`parseChatArgs(argv): { help: boolean, message: string, model?, budgetUsd?, allowUnpriced?, project? }`——`--help`/`-h` 优先；`--` 之后全部当消息；**未识别的 `--xxx` 报错退出而不是塞进消息**。收口 diff：`case "chat"` 改调它，`chatOnce` 透传四个参数到 `orch.chat()`（`--project` 走现有 `--project` 全命令覆盖机制，找 `lit` 是怎么做的照抄）。
**门禁** `tests/unit/gate_help_no_llm.test.ts`：对**每个**会调 LLM 的子命令（`chat` `idea` `lit read` `lit review` …，从 `capabilities --json` 或 `contract --json` 里枚举，不要手写清单）执行 `<cmd> --help`，用 spy 断言 `LLMRouter.call` **零调用**。V128 修过同名问题却漏了 `chat`——枚举而不是手写就是为了不再漏。
V16 顺带：`subAgentModel_*` 五个配置项已存在；确认它们经 `sub_agent.ts` 真的被读（闸门 I 的 config_reader_parity 应已核），在 devlog 里记一句即可，不新做。

## 足迹
- 允许：`scripts/inventory-model-names.ts`（新）· `backend/src/llm/providers/registry.ts` · `backend/src/cli/chat_args.ts`（新）· `backend/src/config/cli.ts`（`config set` 校验，只加）· 三个新测试文件 · `docs/devlog/W9-beta.md`
- 禁止：`backend/src/llm/router.ts` · `backend/src/agents/orchestrator.ts` · `backend/src/index.ts` · `backend/src/config/index.ts`（γ 的）· `backend/src/usage/**`（α 的）——全部以 ≤10 行 diff 交收口

## 阴性对照
- β-3：派生清单里手动删一个模型 → 对撞门禁红；`throw` 改回 `return "kimi"` → 测试②红。
- β-1：`llmFor` 里不读 `sessionModel` → `gate_model_override` 红（qwen-max 会静默走 openrouter 成功）。**这条对照的红/绿输出必须原样贴进 devlog，它就是 U10 的复现。**
- β-2：`parseChatArgs` 里把 `--help` 判据去掉 → `gate_help_no_llm` 对 `chat` 红。

## 追加（闸门 I 盘点后由主会话填写）
（空）
