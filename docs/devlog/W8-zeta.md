# W8-1 ζ · V2 embedding 语义化——devlog

分支 `lane/W8-1-zeta`，worktree `~/Desktop/AI4S/spark-research-zeta`。

## 0. 开工前发现的一个大偏差（先说这个，决定了下面所有取舍）

任务书（`W8-zeta.md`）与 BACKLOG.md 行 64 都把这条描述成「从零做」：新建
`llm/embeddings.ts`、把 `novelty.ts` 的 `claimAffinity()` 改成「embedding 余弦 →
词面法降级」、用 68 样本 fixture 重标阈值。

实际打开仓库后发现：**这套东西的绝大部分已经在 v0.5 W5-1（C4 lane，commit
`6fe28e5`，早于本分支切出点 `v0.8.0-alpha.1`）里做完并且在生产路径上跑着**：

- `backend/src/llm/embeddings/{router,openai_compat,types,calibration}.ts`——
  一整套 OpenAI 兼容 `/embeddings` 适配（本机 Ollama 实测过）、批处理、维度校验、
  AD-13 失败契约。
- `backend/src/ideation/affinity.ts` 的 `claimAffinity()`——**词面口径**的相似度
  函数；语义口径的计算其实是 `novelty.ts` 私有方法 `applySemanticAffinity()` 里
  内联算的（不是一个独立导出函数）。也就是说任务书写的「`novelty.ts` 的
  `claimAffinity()`」在当前代码里**根本不存在这个组合**——`claimAffinity()` 在
  `affinity.ts`（不在允许改动列表里），`novelty.ts` 里没有同名函数。
- `applySemanticAffinity()` 已经实现「embedding 余弦 → 词面法降级」双留痕：
  `EmbeddingState.basis`/`modelId`/`degradedReason`，报告与 record metadata 都有。
  「无 key / 调用失败 → 走词面法且行为与 v0.7 逐字节一致」这条也已经成立（未配置
  `embeddingModel` 时 `EmbeddingRouter.embed()` 直接返回 `unsupported` 失败，
  `applySemanticAffinity` 整体退回词面，零向量计算）。
- 阈值重标：`HIGH_AFFINITY`（词面口径）已经在 68 样本 `tests/fixtures/novelty/
  calibration.json` 上重标过，从 0.75 改到 0.70（`novelty_threshold.test.ts`）。
  **语义口径的阈值表 `SEMANTIC_THRESHOLDS` 是刻意留空的**——`calibration.ts` 记录了
  完整的标定过程：bge-m3 在同一份 68 样本语料上跑过一遍，语义并没有比词面更准
  （最优错分 3 vs 1，生产阈值上 3 vs 2，零假阳性点上假阴数打平 4 vs 4），所以
  「没有证据表明语义更好」，没有登记进 `SEMANTIC_THRESHOLDS`。这不是没做完，是
  一个数据支撑的决定。

**真正缺的那一半**：`EmbedUsage.costUsd` 恒为 `null`（`openai_compat.ts` 的注释原话
「单价表由后续 lane 接入 registry」），`registry.ts` 的 `PRICING` 表里没有任何
embedding 模型条目，也从来没有一行 `UsageStore.append` 或 raw `kind:"llm"` 记录
过 embedding 调用——一次 embedding 调用可能真的打了网络、真的花了钱，在整套台账
系统里完全隐身。这正是任务书交付①要求的东西（单价表 + `UsageStore.append` + raw
一行），而且是**真实缺失、没人做过**的部分。

**取舍**：不重写一份平行的 HTTP embedding 客户端（会制造两套语义早晚分叉的实现），
也不重跑语义阈值标定（没有新数据支撑推翻「语义不比词面准」这个已用 68 样本验证过
的结论，重跑只会重复同一个实验）。本 lane 把范围收窄到**真正缺失的那一半**：
成本入账层，接在既有 `EmbeddingRouter` 之上，接进 `novelty.ts` 唯一一处默认构造
语义 embedder 的地方。详见下面 §1-2。任务书交付③（阈值重标）按任务书原文「若时间
不够可留 TODO」处理——见 §5。

## 1. 改了哪些文件

- `backend/src/llm/embeddings.ts`（新）——成本入账层。导出：
  - `embedTexts(texts, options)`：任务书字面签名 `{vectors, usage, provider, model}
    | {unavailable: reason}`。
  - `createTrackedEmbedder(options)`：返回满足 `novelty.ts` 现有 `Embedder` 契约
    （`{embed(texts): Promise<EmbedResponse>; modelId(): string|null}`）的对象，
    `.embed()` 原样转发底层 `EmbeddingRouter` 的 `EmbedResponse`（成功/失败的结构化
    字段一个不丢），额外触发同一套入账副作用。
  - `EmbedAccounting`：入账目的地（`UsageStore` + `command` + 可选 `rawSink`/
    `project`/`sessionId`）。
- `backend/src/llm/providers/registry.ts`——追加：
  - `EmbeddingPricing` 类型 + `EMBEDDING_PRICING` 表（openai 两条：
    `text-embedding-3-small` $0.02/M、`text-embedding-3-large` $0.13/M，2026-09-12
    WebFetch 直读 `https://developers.openai.com/api/docs/pricing`）+
    `embeddingPriceFor(provider, model)`（查不到就 null，没有 config 覆盖机制——
    见文件内注释，加覆盖要先在 `config/index.ts` 注册 setting key，那个文件不在
    本 lane 允许改动列表里，留给收口）。
  - `EMBEDDING_CAPABLE_PROVIDERS` + `supportsEmbeddings(provider)`——与
    `llm/embeddings/router.ts` 的 `EMBEDDING_BASE_URLS`（+"local"）手工同步的独立
    表（不能 import 消除重复：会与该文件反向 import `PROVIDER_API_KEY_ENV` 成环），
    风险与做法在文件注释里写明，`w8_zeta_embeddings.test.ts` 有一致性断言防止两边
    分叉。
- `backend/src/ideation/novelty.ts`——**只改了一处 + 一个新可选字段**：
  1. `NoveltyDeps` 加一个可选字段 `embedAccounting?: EmbedAccounting`（连同一段
     说明它只在 `deps.embedder === undefined` 时生效、不影响任何已注入 embedder 的
     调用方）。
  2. `applySemanticAffinity()` 里默认构造 embedder 的唯一一行，从
     `new EmbeddingRouter()` 换成 `createTrackedEmbedder({ accounting:
     this.deps.embedAccounting })`。
  3. 顶部加一行 import。
  没有碰 `claimAffinity()`/`affinity.ts`（见 §0 的偏差说明），也没有碰
  `applySemanticAffinity()` 的降级判断逻辑本身——那部分行为在 W5-1 已经做对，
  这次改动只是把「用什么 embedder」这一个决定换了实现，`Embedder` 契约不变。
- `tests/unit/w8_zeta_embeddings.test.ts`（新）——14 条单测，见 §3。
- `docs/devlog/W8-zeta.md`（本文件）。

## 2. 生产调用方（AD-12）

`ideation/cli.ts` 的 `spark-research idea check` 命令构造 `NoveltyChecker` 时**没有
传 `embedder`**（`deps.embedder === undefined`），`server/routes/ideation.ts` 的
`POST /:id/check` 同样没传。也就是说 `applySemanticAffinity()` 里被我换掉的那一行
默认构造分支，**就是这两条真实生产路径唯一会走到的分支**——`createTrackedEmbedder()`
因此从落地那一刻起就是真实调用方，不是一个只有测试引用的孤儿模块。

但是：这两个调用点目前都**没有传 `embedAccounting`**（cli.ts/server/routes/
ideation.ts 都不在本 lane 允许改动的文件列表里），所以入账副作用在真实 CLI/HTTP
路径上暂时是"配好了但没打开"的状态——`createTrackedEmbedder({ accounting:
undefined })` 是对 `EmbeddingRouter` 的纯直通（这也是刻意设计：novelty 测试从不
显式给这条默认分支传值，行为必须与 v0.7 完全一致）。要让入账真正在生产里生效，
需要下面两处 ≤10 行的 diff，交给收口合入：

### `backend/src/ideation/cli.ts`（约 `spark-research idea check` 处，`new
NoveltyChecker({...})` 内，紧跟已有的 `llm: usageTrackingLlm({...})` 之后）：

```diff
           }),
+          embedAccounting: {
+            store: new UsageStore(join(project.paths.root, "usage.jsonl")),
+            command: "novelty-check",
+            rawSink: project.raw(),
+            project: project.slug,
+            sessionId: flagString(flags.session) ?? null,
+          },
           searcher: makeSearcher(project),
```

（`UsageStore`/`join` 已经在该文件顶部 import 过，`embedAccounting` 类型来自
`llm/embeddings.ts`，需要补一行 import。）

### `backend/src/server/routes/ideation.ts`（`POST /:id/check` 里 `new
NoveltyChecker({...})` 内）：

```diff
             perSource,
             judge: ctx.deps.judge,
+            embedAccounting: {
+              store: new UsageStore(join(scope.project.paths.root, "usage.jsonl")),
+              command: "novelty-check",
+              rawSink: scope.project.raw(),
+              project: scope.project.slug,
+              sessionId,
+            },
           });
```

（该文件目前没有 import `UsageStore`/`join`，需要各补一行；两条 diff 都复用了
`llmFor()`/cli.ts 里已经在用的同一个 `usage.jsonl` 路径 + `project.raw()`，与 chat
调用落同一份账本，是有意为之——不另起一份 embedding 专属台账文件。）

## 3. 新增/修改的测试与门禁

新文件 `tests/unit/w8_zeta_embeddings.test.ts`，14 条：

- `embeddingPriceFor` / `supportsEmbeddings`（registry）：openai 有价有来源日期；
  qwen/编造型号/local 查不到返回 null 不是 0；`EMBEDDING_CAPABLE_PROVIDERS` 与
  `embeddings/router.ts` 的 `supportedEmbeddingProviders()` provider 集合一致性
  门禁。
- `embedTexts()`：成功折算成本；成功但查不到单价（unpriced true, costUsd null）；
  失败返回 `{unavailable}`；未配置（kind=unsupported）不落账。
- 成本入账：成功调用落 1 行 usage + 1 行 raw（`payload.options.endpoint ===
  "embeddings"`）；网络层真失败（timeout）仍落 1 行 `ok:false` 的 usage 行；不给
  `accounting` 时纯查询、不碰 store。
- `createTrackedEmbedder()`：`.embed()` 原样转发成功/失败的 `EmbedResponse`
  （novelty.ts 的降级判断依赖的 `error.kind` 等字段不丢）；accounting 副作用与
  `embedTexts()` 共用同一路径；没给 accounting 是纯直通。

没有改动任何既有测试文件（`novelty*.test.ts`、`embeddings.test.ts` 一行未动）。

## 4. 六套件数字（本 lane 分支上实跑，均在 `~/Desktop/AI4S/spark-research-zeta`）

| 套件 | 结果 | rc |
|---|---|---|
| `bun run typecheck` | 通过（`tsc --noEmit` 两个 tsconfig 都过） | 0 |
| `bun test tests/unit` | **2310 pass / 0 fail**（基线 2296 + 本 lane 新增 14） | 0 |
| `bun test tests/concurrency tests/timeout` | 首次跑 34 pass/1 fail（`project_write_race.test.ts` 的 database-lock 计数偶发非 0，与并行跑的其它 lane 抢 IO 有关，跟本 lane 改动的文件毫无交集）；**单独重跑该文件 1/1 绿**；随后完整套件重跑一次 **35 pass / 0 fail** | 0（重跑）|
| `bun run test:py` | **73 passed**（含 lab 20 + sim 45 + protocol_agent 6 + opentrons 20，无 skip） | 0 |
| `bun run test:lab` | **26 passed**（同一 pytest 根目录，`tests/lab` 子集） | 0 |
| `bun run test:e2e` | **未跑**——本 lane 没有碰任何前端/HTTP 响应形状/CLI 输出格式（只加了后端内部模块 + 一个可选 deps 字段，CLI/HTTP 的实际调用点还没接 `embedAccounting`，输出行为零变化），按 `_COMMON.md` 「碰了前端/HTTP/CLI 输出的才跑」的条件不触发 |

`bun run test:lab`：**26 passed**（`tests/lab/opentrons_backend.test.py` 20 +
`tests/lab/protocol_agent.test.py` 6），rc=0，与基线 26 一致。

## 5. 阴性对照表

四条，全部在 `backend/src/llm/embeddings.ts` 上真跑（临时改代码 → 跑对应测试 →
观察红 → 手工核对改回原文 → 再跑一次确认绿），过程：

| # | 门禁/断言 | 改法（临时，已还原） | 结果 |
|---|---|---|---|
| A | 未配置 embedding（kind=unsupported）时不落账 | `recordAccounting` 里把 `if (accounting && attemptedNetwork(response))` 改成 `if (accounting)`，去掉「是否真打了网络」的判断 | 红：`tests/unit/w8_zeta_embeddings.test.ts` 的「未配置…不落账」用例从 `s.readAll()` 长度 0 变成 1，`expect(...).toHaveLength(0)` 失败 |
| B | 成功调用必须真的落 usage/raw | 把 `recordAccounting` 成功分支的 `if (accounting) {...}` 改成 `if (accounting && false) {...}` | 红：「成功调用：usage.jsonl 落一行…」用例 `expect(rows).toHaveLength(1)` 收到 0 |
| C | 查不到单价必须是 `null`，不能编造 `0` | 把 `costUsd` 计算的 `: null` 分支改成 `: 0` | 红：「成功但单价查不到」用例 `expect(result.usage.costUsd).toBeNull()` 收到 `0` |
| D | embedding 路径失败必须返回 `{unavailable}`，不许静默当成功（任务书交付④原文要求的对照） | `embedTexts()` 里把 `if (!response.ok) { return {unavailable...} }` 的判断条件加 `&& false` 短路掉，success 分支改成 `vectors: response.ok ? response.vectors : []` 兜底空数组 | 红：「失败：返回 {unavailable: reason}」用例 `expect("unavailable" in result).toBe(true)` 收到 `false`（调用被静默当成了「成功，空向量」） |

四条改法均已手工核对逐字还原（`git diff backend/src/llm/embeddings.ts` 在本文件
写完时应为空——如果收口发现不是空，说明还原有误，请以 git 历史为准而不是本文件）；
还原后 `bun test tests/unit/w8_zeta_embeddings.test.ts` 复跑 **14 pass / 0 fail**。

## 6. 如实交代

- **任务书与实际代码结构有真实偏差**（§0 已详述）：`claimAffinity()` 在
  `affinity.ts` 不在 `novelty.ts`；`llm/embeddings/` 已经是一个成熟目录而不是要
  新建的单文件。本 lane 的 `llm/embeddings.ts` 是"新文件"没错（满足任务书字面
  要求），但它是**成本入账层**、不是重新实现的 HTTP 客户端——这是我对任务书意图
  的解读，不是字面执行，请收口核实这个解读是否符合预期。
- **交付③（68 样本阈值重标）没有重做**：词面口径（`HIGH_AFFINITY`）已经用 68
  样本标过（W5-1）；语义口径（`SEMANTIC_THRESHOLDS`）刻意留空，理由是已有的
  68 样本标定显示语义不比词面准。本 lane 没有新增样本、没有换模型，所以没有
  重新标定的依据——按任务书原文「时间不够可留 TODO」处理，留在这里当 TODO。
  如果收口认为需要用新的 embedding 模型（比如真的接 OpenAI `text-embedding-3-
  small`，而不是 W5-1 标定用的本地 bge-m3）重新做一次标定，这是一个新的、需要
  真实 API key 的独立任务，本 lane 没有可用的 OpenAI key，无法代做。
- **生产路径的入账目前是"接线好但没打开"**：`ideation/cli.ts` 和
  `server/routes/ideation.ts` 两个真实调用点还没传 `embedAccounting`，需要 §2
  的两处 ≤10 行 diff 才能让 embedding 调用真正落进 `usage.jsonl`/raw。在那之前，
  `createTrackedEmbedder()` 对生产路径而言等价于纯直通的 `EmbeddingRouter`（这也是
  为什么它不会影响任何现有行为/测试）。
- **没有 config 覆盖机制**：`embeddingPriceFor()` 是纯静态查表，不支持
  `SPARK_LLM_EMBEDDING_PRICING_JSON` 这类覆盖（`priceFor` 的同款机制要求
  `config/index.ts` 注册 setting key，该文件不在允许列表里）。如果收口认为这个
  能力值得要，需要在 `config/index.ts` 补一条 `CONFIG_SETTINGS` 条目。
- **qwen（DashScope）embedding 单价没有收录**：WebFetch 官方定价页没找到
  text-embedding 系列的美元单价子页，多个第三方聚合站也查不到一致数字——按仓库
  既有纪律「查不到就是查不到，不编造」，`embeddingPriceFor("qwen", ...)` 恒
  返回 `null`。这意味着即使有人配置了 `SPARK_RESEARCH_EMBEDDING_MODEL=qwen/...`
  并真的调用成功，usage.jsonl 里这次调用的 `costUsd` 也会是 `null`（且不会被
  `unpriced` 标记为——啊不对，会被标记 `unpriced:true`），这是预期行为，不是 bug。
- **`embedTexts()`/`createTrackedEmbedder()` 把 embedding 的 token 计数全部记进
  `UsageEntry.inputTokens`，`outputTokens` 恒 0**：因为 embedding 调用没有「生成」
  这个概念，只有一个 token 计数（`EmbedUsage.tokens`）。这是我做的映射选择，已在
  代码注释里写明，如果台账消费方（比如 usage 汇总面板）以某种方式假设
  `outputTokens>0` 才算「真的调用过」，这里可能需要收口再看一眼。
- **raw payload 的 `endpoint:"embeddings"` 标记位置**：`LlmPayload` 类型（
  `raw/models.ts`，不在允许列表）没有顶层 `endpoint` 字段，标记放在了自由字段
  `payload.options.endpoint`，不是顶层。任务书原文「payload 标 endpoint:
  "embeddings"」没有精确到字段路径，这是我的选择，测试里已经断言了这个具体位置
  （`payload.options.endpoint`）。
- 本 lane 全程没有真实 API key（OpenAI/OpenRouter/DeepSeek 均未配置），所有测试
  都用注入的 stub router，没有打过真实网络——这与「无 key 行为与 v0.7 逐字节一致」
  的验证方式一致（既有 novelty 测试同样全程用 stub/null embedder），但也意味着
  `embeddingPriceFor`/入账逻辑本身没有被一次真实的 OpenAI 调用验证过，只验证了
  「给定一个 EmbedResponse 形状，账算得对不对」这一半。
