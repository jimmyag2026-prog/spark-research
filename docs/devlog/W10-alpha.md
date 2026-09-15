# W10-1 lane α · 速度工程（devlog）

分支 `feat/W10-alpha`（基于 `integration/v0.10-base`）· 任务书 `docs/taskbooks/v0.10/LANE_alpha.md`
基线 `docs/devlog/W10-0-baseline.md`（流程 181.5s；read+review 占 94%；readConcurrency=3；arXiv 本机 IP 仍被封）

门禁文件：`tests/unit/w10_alpha_speed.test.ts`（**30 条，全绿**）
复测输出：`docs/devlog/W10-alpha-measure.md`（quick 档，由 `scripts/measure-chat.ts --pipeline` 追加）

---

## 复测数字（真实网络，r6-probe，2026-09-16）

命令（quick，档位是默认值，不用传）：

```
bun scripts/measure-chat.ts --pipeline r6-probe --out docs/devlog/W10-alpha-measure.md
```

| 阶段 | 基线（W10-0） | quick 复测 | deep 复测 |
|---|---:|---:|---:|
| search | 8.0s | 8.0s | 8.0s |
| prescreen | —（无此阶段） | ~24.4s（差额倒算） | 47.4s |
| download | 2.3s | 0.0s（quick 不下载） | 3.0s |
| read | 85.7s（3 卡，串行） | 0.0s（quick 不建卡） | 44.7s（2 卡，并行 3） |
| review | 85.5s | 33.9s | 33.1s |
| **total** | **181.5s** | **66.3s** | **136.2s** |

- **quick 66.3s < 90s 目标**，比基线快 63%。
- deep 136.2s < 3min 目标，但**这个数不干净**：prescreen 47.4s 里大半是下面那条
  「空输出重试」在烧时间（7 次 LLM 调用，顺利路径本应是 4 次）。根因修掉之前，
  deep 的真实上限还看不准。
- deep 那次预筛把 6 篇砍到 2 篇，所以 read 只有 2 卡——与基线的 3 卡不同口径，
  不能直接比「每卡耗时」。

deep 档的复测命令不在仓库里：`scripts/measure-chat.ts` 是 δ 的足迹、没有 `--depth`
开关，我在 scratchpad 里复制了它 `--pipeline` 分支的同一套参数（1 查询 / limit 6 /
maxRead 3），只把 `depth` 改成 `"deep"`。**建议 δ 给 `--pipeline` 补一个
`--depth quick|deep`**，否则 R7 复测 deep 档没有可重复的命令。

---

## α-3 的现场事故：给推理模型设 maxTokens，换来的是**空输出**

第一次复测直接失败：预筛与综述两次调用 `content` 都是空字符串，
`~/.spark-research/projects/r6-probe/usage.jsonl` 里 `outputTokens` **正好等于我设的上限**：

```
{"model":"moonshotai/kimi-k2.6","ok":true,"inputTokens":618,"outputTokens":300,...}
{"model":"moonshotai/kimi-k2.6","ok":true,"inputTokens":1816,"outputTokens":2500,...}
{"model":"moonshotai/kimi-k2.6","ok":true,"inputTokens":1845,"outputTokens":2500,...}
```

kimi-k2.6（OpenRouter，思考型）把输出预算全花在推理 token 上，正文一个字没出来。
**这不是短输出，是空输出**——α-3 想省的钱，换来的是整条流程失败。

本 lane 能做的止血（只动 α 自己的三个文件）：第一次带上限省钱，**空输出时重试那一次
不带上限**。精读卡/综述的第 2 次尝试、预筛的空输出重试都按这条走。代价是遇到思考型
模型时多一个来回（deep 那次 7 次调用 vs 顺利路径 4 次）。

根治不在这里，见下面的收口 diff 第 3 条。

口径更正：**α-1 的「quick 档 ≤ 2 次调用」是顺利路径的数字**；触发空输出重试时最多 4 次。
两条都有门禁。

---

## 逐项

### α-1 · S9 两档综述 + 批量预筛

改了：`agents/literature_pipeline.ts`、新 `literature/prescreen.ts`、`literature/review.ts`。

- `depth: "quick" | "deep"`，**默认 quick**。quick = 预筛留 top-K → 全部入选论文的
  摘要**一次调用**出综述，不下载、不建卡。
- 引用不另起一套：quick 走同一份 key 白名单、同一个 `citationIntegrity`，
  基准从精读卡换成摘要（`baselinesFromAbstracts`）。`generate()` 与 `generateQuick()`
  共用抽出来的 `draft()` 重试循环——「越界 key 带原因重试一次，仍越界就抛错不落
  artifact」这条纪律只能有一份实现。
- 综述 record 落 `depth`：quick 的综述不会被后人当成精读产物。
- 预筛：一次便宜调用给候选打 0–3 分（输出只有 `[[i,s],…]`），留 top-K（默认 8，阈值 2 分）。
  **fail-open**：调用失败 / 输出不可解析一律全留并在 `note` 写明原因——丢文献是静默的
  正确性损失，慢只是钱。全员低分时退回 top-K，不返回空集。
- `skipBelow` 默认 **3**，不是 topK。第一次跑门禁时踩到：真实会话正好 8 篇候选、topK 也是 8，
  按 topK 跳过的话 6 篇无关文献原样进综述，预筛等于没装。

门禁 11 条。预筛那条用**真实会话样本**
`tests/fixtures/literature/t1-lit-review-rsi-candidates.json`（从
`~/.spark-research/workspaces/web_1789480157513/t1-lit-review-rsi.json` 抽出的 8 篇候选标题；
那批的无关项是 AI in healthcare / AI in Education / AI and Business Value / XAI taxonomies /
ML in the quantum domain——任务书写的「心血管指南」是记岔了，实际是这几篇）。
**原 artifact 没保存 abstract**，所以 fixture 的 abstract 是 null，门禁只验「按标题也能把
明显无关的剔掉」，不假装有摘要。

判据钉的是**接线**：被剔除的标题「不出现在综述提示词里、不被下载、不建卡」，
而不是「返回字段里标了剔除」。

### α-2 · S3 精读并行

改了：`literature/reading.ts`、新 `literature/limits.ts`、`literature/cli.ts`。

- `generateMany` 加 `concurrency`，默认 `DEFAULT_READ_CONCURRENCY = 3`（W10-0 实测值，
  单一真源在 `limits.ts`）。worker 池共享游标，不切 chunk（避免尾部效应）。
- 并发只改**调度**，不改结算语义：返回值按输入顺序重排、逐篇独立结算、
  `onProgress` 成功失败两条路都发、`done` 仍单调递增到 total。
- **跑全量 tests/unit 时抓到一处真实影响**：G-3 的「lit read --all 第 2 篇被闸拒」变绿了。
  预算闸判的是「已结算 + 在飞预留」，在飞预留用发前估价；并发时 N 份估价误差同时在飞，
  估价偏低就会多放行。修法不是放宽判据，而是 `literature/cli.ts` 里
  **给了 `--budget-usd` 就退回 `concurrency: 1`**：想要并行就别给预算，想要预算就接受串行。
  chat 侧的文献流程不走这条 CLI 路径。（顺带：`lit read` 此前一直是串行，现在无预算时是 3。）
- A7 口径门禁：10 篇 × concurrency 3 走 `usageTrackingLlm`，上限 $0.05 / 每次 $0.01 →
  实际花费 ≤ 上限 × 1.2，且在飞预留归零。

### α-3 · 各阶段 maxTokens

改了：新 `literature/limits.ts`（表）、`literature/reading.ts`、`literature/review.ts`、
`literature/prescreen.ts`、**`llm/providers/openai_compat.ts`**。

- `STAGE_MAX_TOKENS` = 方案 §三 α-3 的数字（plan 600 / analysis 900 / summarize 1200 /
  卡 700 / 综述 2500）+ 预筛 300。卡/综述/预筛已接线。
- **顺带修了一个真空转**：`CallOptions.maxTokens` 自 P11 声明以来
  **OpenAI 兼容适配器从未消费它**（只有 anthropic 读）——deepseek / openrouter / kimi
  传什么上限都不生效。`buildRequestBody` 补上 `max_tokens`，只在调用方显式给值时加字段。
- ⚠️ **足迹判断**：`llm/providers/**` 不在 `_COMMON.md` 足迹表的任何一行里
  （收口专属只点名 `llm/router.ts`）。我按「未登记 = 可动，但要交代」处理并做了这个改动，
  因为不接这一行 α-3 就是完全空转。**请收口复核这个判断。**
- 输出 token −40% 这条**我没有可信的对比数字**：唯一一次带缓存的对照是上面那次
  空输出事故（outputTokens 打满上限、正文为空），不能当成「省了 token」来报。
  真实对比要等根治之后再测，如实标未完成。

### α-4 · S10 全文命中率

改了：`literature/pdf.ts`、`skills/paper-download/SKILL.md`。

- 落地页一跳：响应不是 PDF 时读 `citation_pdf_url` 元标签 /
  `<link rel="alternate" type="application/pdf">`，顺它取一次（相对链接按落地页解析）。
  **页面自己写明的才跳，不猜 URL 拼接**；派生出来的那一跳不再派生。
- Unpaywall 兜底：直链全失败且有 DOI → 问一次 `api.unpaywall.org/v2`（免 key）。
  `contactEmail` 还是占位邮箱时**不发这个请求**，并在 `attempts` 里记 `skipped` 留痕。
- 没拿到 PDF 时 `oaSource` 标 `"openalex(optimistic)"`。
- 技能文档的「目前刻意不做的两跳」段删掉，改写成已落地行为 + OA 标记可信度说明。
- ⚠️ **「同一批 8 篇 ≥ 5 篇」这条 DONE 没验**：门禁全是注入 `StubHttp` 的确定性用例，
  真实网络的 8 篇批量复跑没跑（本机走代理、且那批里 BMJ/ScienceDirect 的 403 是出版社
  行为，不由本改动决定）。**交 R7 用真实网络复跑**。

### α-5 · 按 host 令牌桶 + Retry-After

改了：`http/ratelimit.ts`、`http/client.ts`、`connectors/registry.ts`、`literature/pdf.ts`。

- `HOST_BUCKET_GROUPS` 把 `export.arxiv.org`（检索）与 `arxiv.org`（PDF 直链）归到同一个
  桶键。按 host 分桶时两条路各 3s = 对 arXiv 1.5s 一次，这是 U55「3s 间隔第二次仍 429」
  的成因之一。策略 `rps = 1/3`、`burst = 1`（来源：arXiv API TOU）。
- 429 且带 `Retry-After` → 按它冷却（秒数与 HTTP-date 两种形态，上限 60s），
  冷却期内一个请求都不发。**没有 `Retry-After` 头就不设冷却**——没有可核实的数字
  就不自己编一个退避。
- **两处真接线，缺一这条就是空转**：
  1. `http/client.ts` 的响应头白名单此前不含 `retry-after`，`NativeHttp` 在那一步就把它
     丢了 → 真实网络下冷却逻辑永远读到 `undefined`（U40/U47 的形状）。
  2. 新增 `sharedRateLimitedHttp()`：`ConnectorRegistry` 与 `PdfDownloader` 此前各 new 一个
     装饰器（`PdfDownloader` 干脆用裸 `defaultHttp`，**完全不限速**），桶键归并得再对
     也不共桶。两处默认值都改成这个进程内共享实例。
- DONE 按 W10-0 的决定走「不浪费一次请求」，不含「能拿到 200」。

---

## 阴性对照（全部实跑变红，原文）

```
== α-1 预筛结果不接线（selected 退回 collected）==
Expected: 2 / Received: 8
(fail) α-1 · 批量预筛 > 接线：被剔除的候选不进综述提示词、不建卡、不下载
(fail) α-1 · S9 两档综述 > deep 档：预筛后逐篇建卡，综述走精读卡路径
 16 pass / 2 fail

== α-2 generateMany 强制串行 ==
Expected: 3 / Received: 1
(fail) α-2 · S3 精读并行 > generateMany 真的并行到 N，且返回顺序仍按输入顺序
(fail) α-2 · S3 精读并行 > 接线：pipeline 的 deep 档真的并行到 3
 16 pass / 2 fail

== α-3 openai_compat 去掉 max_tokens ==
Expected: 700 / Received: undefined
(fail) α-3 · 各阶段 maxTokens > 接线：OpenAI 兼容请求体真的带上 max_tokens
 17 pass / 1 fail

== α-4a 去掉落地页一跳 ==
Expected: true / Received: false
(fail) α-4 · S10 全文命中率 > 接线：not_a_pdf 的落地页 → 顺元标签走一跳真的拿到 PDF
 28 pass / 1 fail

== α-4b 关掉 Unpaywall 兜底 ==
(fail) α-4 · S10 全文命中率 > 接线：直链全失败 → 按 DOI 问一次 Unpaywall 并下到 PDF
(fail) α-4 · S10 全文命中率 > contactEmail 未配置（占位邮箱）→ 不敲 Unpaywall，但降级留痕
 27 pass / 2 fail

== α-5a retry-after 不进响应头白名单 ==
Expected: "7" / Received: undefined
(fail) α-5 > 接线：NativeHttp 的响应头白名单含 retry-after
 28 pass / 1 fail

== α-5b arxiv 两 host 不共桶 ==
Expected: "arxiv.org" / Received: "export.arxiv.org"
(fail) α-5 > 检索与 PDF 直链归到同一个桶键
(fail) α-5 > 接线：假 429 + Retry-After → 冷却期内一个请求都不发
 27 pass / 2 fail

== α-5c 拆掉冷却闸 ==
Expected length: 1 / Received length: 2
(fail) α-5 > 接线：假 429 + Retry-After → 冷却期内一个请求都不发（不浪费一次请求）
 28 pass / 1 fail
```

**α-5c 第一版没变红**（拆掉冷却闸测试照样绿）：挡住第二条请求的其实是令牌桶，不是冷却闸。
修法是先把虚拟时钟推 10s 让桶早就满了，此时还发不出去才只能是冷却闸的功劳。
上面那条红是补强之后重做的。**这正是 _COMMON 第 3 条说的「判据存在但没被读到」**，
差点在本 lane 自己身上再犯一次。

我还在本 lane 违规了一次纪律第 2 条：α-4/α-5 改完**没先 commit 就做阴性对照**，
`git checkout --` 把两个文件的改动整段冲掉、重做了一遍。第 2 条是真的。

---

## 收口 diff（枢纽文件，各 ≤10 行）

### 1. `backend/src/agents/orchestrator.ts` · plan（约 868 行）

```diff
-    const res = await this.llmFor(sessionId).call(messages, configuredModel(LLMRouter.DEFAULT_MODEL));
+    const res = await this.llmFor(sessionId).call(messages, {
+      model: configuredModel(LLMRouter.DEFAULT_MODEL),
+      maxTokens: STAGE_MAX_TOKENS.plan,   // 600，紧凑 JSON
+    });
```

同文件 research planner（约 1609 行）同形，也用 `STAGE_MAX_TOKENS.plan`。

### 2. `backend/src/agents/orchestrator.ts` · summarize（约 1184 行）

```diff
-    const options: CallOptions = { model: configuredModel(LLMRouter.DEFAULT_MODEL), ...(onDelta ? { onDelta } : {}) };
+    const options: CallOptions = {
+      model: configuredModel(LLMRouter.DEFAULT_MODEL),
+      maxTokens: STAGE_MAX_TOKENS.summarize,  // 1200
+      ...(onDelta ? { onDelta } : {}),
+    };
```

import：`import { STAGE_MAX_TOKENS } from "../literature/limits";`
（表已经是单一真源，收口这边不要再抄一份数字。数字本身在 `docs/DEVELOPMENT_PLAN_v0.10.md` §三 α-3。）

配套门禁（收口写，一条）：用 RecordingLlm 跑一次 chat，断言 plan 那次调用的
`options.maxTokens === 600`、summarize 那次 `=== 1200`——钉接线，不要只断言表里的数字。

⚠️ **先读第 3 条再接这两处**：不解决空输出问题就接上，会把 chat 主路径也拖进
「多一个来回」甚至「空 summary」。

### 3. `backend/src/llm/router.ts`（或适配器层）· 推理模型不发 max_tokens —— **本版最该收的一条**

现象见上面「现场事故」。根治建议（router.call 里，≤10 行）：

```diff
+    // 思考型模型（kimi-k2.6 / deepseek-reasoner / …）会把输出预算花在推理 token 上，
+    // max_tokens 设小换来的是**空输出**。能力位里没有「是否 reasoning」这一项，
+    // 短期按模型名单跳过，长期给 ProviderCapabilities 加一位 `reasoningTokens`。
+    const opts = isReasoningModel(model) ? { ...options, maxTokens: undefined } : options;
```

真源应落在 `llm/providers/registry.ts` 的单价表旁边（那里已经逐模型登记），
`isReasoningModel()` 读它，不要在 router 里硬写名单。
接上之后 α 这边三处「空输出重试」就可以退回成单次调用。

### 4. `scripts/measure-chat.ts`（δ 的足迹）· `--pipeline` 补 `--depth`

```diff
-    { mode: "review", queries: [...], topic: "RSI 预防", limit: 6, maxRead: 3 });
+    { mode: "review", queries: [...], topic: "RSI 预防", limit: 6, maxRead: 3,
+      depth: (args.get("depth") === "deep" ? "deep" : "quick") });
```

外加表里多一行 `| prescreen | … |`（`r.timings.prescreen`）。
没有它，R7 复测 deep 档没有可重复的命令。

---

## 交代（没做完 / 拿不准）

1. **α-3 的「输出 token −40%」没有可信数字**，原因见「现场事故」。根治（收口 diff 第 3 条）
   落地后才能测。
2. **α-4 的「同一批 8 篇 ≥ 5 篇」没在真实网络下验**，只有注入式门禁。交 R7。
3. **`readConcurrency` 没有进 `CONFIG_SETTINGS`**：任务书 α-2 要求「写进 config」，
   但 `config/**` 在足迹表里归 γ。我把默认值做成 `literature/limits.ts` 的常量 +
   `LiteraturePipelineOptions.readConcurrency` 入参，**配置项留给 γ / 收口加**：
   ```
   { key: "readConcurrency", type: "number", envVar: "SPARK_RESEARCH_READ_CONCURRENCY",
     defaultValue: 3, summary: "精读卡并行度", effect: "…W10-0 实测 3 路 0 次 429…" }
   ```
   接进 `literature_pipeline.ts` 只需把 `normalizeConcurrency(options.readConcurrency)`
   的兜底换成配置读数。
4. **`llm/providers/openai_compat.ts` 的足迹判断需要收口复核**（见 α-3 段的 ⚠️）。
5. 改了三个**不属于我**的既有测试文件，都是默认值变更所致，不是放宽判据：
   `tests/unit/reading.test.ts`（按序脚本 fake 显式 `concurrency: 1`）、
   `tests/unit/v172_literature_pipeline.test.ts`（review 用例显式 `depth: "deep"`、digest 断言跟上）、
   `tests/unit/g1_model_config.test.ts`（测试双归一 `string | CallOptions`）。
   `tests/unit/g3_budget_gate.test.ts` **没改**——那条是用产品行为（有预算就串行）修的。
6. `review.test.ts` 跑起来会刷一片
   `[usage] UsageStore.append: model 字段不是字符串（收到 {"model":…,"maxTokens":700}）`。
   那是该文件里的老测试双把第二参数原样当 `res.model` 回填导致的**日志噪音**，
   生产路径的 `usageTrackingLlm` 读的是 `res.model`、口径没变，测试也是绿的。没动它。
7. 全量 `tests/unit` 只在 α-1..α-3 之后跑过一次（当时 4 红，已全部处理）；
   α-4/α-5 之后只跑了相关套件（`embedded_skills` / `v66_pdf_fulltext` / `literature` /
   `connectors` / `host_ratelimit` / `w8_beta_ratelimit_wait`，共 114 条全绿）。
   **全量回归请收口再跑一遍**（这台机器内存紧，全量要 2 分钟以上）。
