# v0.10 开发方案（草案）· 回复速度 + 中间过程流式可见

> 状态：**草案（2026-09-15 深夜，本地使用窗口期间起草）**。用户原话：「设计一下怎样提升回复速度，并且要把中间过程流式输出在屏幕上」。
> 真源数字来自 `docs/devlog/R6-baseline.md`（§机制解释）、`A8-baseline.md`、`UX_TEST_v0.9.0.md`（第五次会话）。所有杠杆都带「预期收益」，**发布前必须用 `scripts/measure-chat.ts` 复测**，没有数字的收益不算收益。

## 一、时间花在哪（实测，不是猜）

### 1.1 普通 chat（一句话问题，alpha.3 打点）

| 阶段 | 耗时 | 模型调用 | 输出 token | 备注 |
|---|---:|---:|---:|---|
| plan | 17.4s | 1 | 1586 | 「三句话」问题被拆成 4 个任务，输出整份 research_contract |
| execute（analysis ×2） | 63.9s | 2 | 1486 + 2999 | 每个 analysis 任务写整段分析 |
| summarize | 28.3s | 1 | 2519 | 把上面全部重写一遍 |
| review | ~0 | 0 | — | 规则层 |
| **合计** | **109.6s** | **4** | **8590** | 用户看到 1157 字 |

结论：**78% 的墙钟是模型在生成输出**（glm-5.3-flash ≈ 100 tok/s）；网络与排队不是主因。

### 1.2 文献流程（V172，第五次会话 + 冒烟）

| 阶段 | 耗时 | 为什么 |
|---|---:|---|
| ② 多源检索 | 45s | `Promise.all` **等最慢的源**：arXiv 持续 429/30s 超时，其它六源 1–3s 就回了 |
| ③ PDF 下载 | 5–15s | 每篇串行试 2–3 个候选链接 |
| ④ 精读卡 | **50s × N** | `generateMany` **逐篇串行**；kimi-k2.6 每张 ~50s，deepseek-v4-flash 明显更快；默认 N=8 |
| ⑤ 综述 | 60–120s | 一次长输出（2000+ token）+ 可能重试一次 |
| **合计** | **8–12 min** | 界面上只有一个 spinner，U49 之前连阶段都看不到 |

### 1.3 感知层

- SSE 只有 `start / progress / delta / result / done / error` 六种；`delta` 只接在最后的 summarize 上——前面 80% 的时间用户什么正文都看不到。
- 前端把 `progress.message` 渲染成**一个 spinner 标签**，没有阶段、没有耗时、没有已产出的中间物（检索到的论文、写好的精读卡）。
- 同步 `/api/session/chat` 超过 255s 被 server 掐断（V156），长任务只能走 `/stream`。

## 二、提速杠杆（按「收益 / 改动」排序）

| # | 杠杆 | 改哪里 | 预期 | 风险 |
|---|---|---|---|---|
| S1 | **直答路径**：规划阶段先判「这是问答还是研究任务」；问答 = 一次调用直答 + 规则 review，不进 plan→execute→summarize | `plan()` 前加一个轻量分类（规则优先：无检索/计算意图、长度短 → 直答；拿不准才问模型一次 ≤50 token） | 一句话问题 110s → **~15s** | 误判把研究题当问答 → 答得浅。缓解：直答里明写「如需检索证据请说明」，且用户可在选择器强制「研究模式」 |
| S2 | **各阶段 `maxTokens`** | plan ≤ 600（紧凑 JSON）、analysis ≤ 900、summarize ≤ 1200、精读卡 ≤ 700、综述 ≤ 2500 | 输出 token 减 40–60% → 墙钟同比例下降 | 截断风险：plan JSON 被截断会解析失败退默认计划——**plan 必须设「reply with compact JSON, no prose」并在解析失败时重试一次更小的提示**，不能退默认计划（U29 教训） |
| S3 | **精读并行** | `generateMany` 加 `concurrency`（默认 3）；`usageTrackingLlm` 已有在飞预留，预算闸不会被并发打穿（A7 验证过） | 8 篇 400s → **~140s** | 上游限速；deepseek/openrouter 3 并发实测安全，超过再议 |
| S4 | **检索不等最慢的源** | `LiteratureSearcher.search` 改 `Promise.allSettled` + 每源独立 deadline（默认 8s，可配 `searchSourceTimeoutMs`）；超时的源标 `failed: timeout` 照常返回其它源 | 45s → **~5s**；arXiv 429 不再拖整条 | 慢源永远被标失败 → 用户看不到它的结果。缓解：进度里明说「arxiv 8s 未回，已跳过」 |
| S5 | **模型分工默认值** | `subAgentModel_literature` 默认 deepseek-v4-flash（U50 已接线，改默认值即可）；plan 也可用快模型 | 精读单张 50s → ~20s | 质量差异需 R7 复测精读卡合格率 |
| S6 | **复用已有精读卡** | 精读前查 `listReadingCards`，已有卡的论文跳过 | 第二次问同题接近零成本 | 卡过期（论文更新）——卡带生成时间，>30 天重生成 |
| S7 | **流式正文** | 综述、精读卡的 LLM 调用也接 `onDelta`（分段：卡是 JSON，流「一句 keyFindings」；综述流 markdown） | 感知等待从「最后一刻」变成「持续有字出来」 | 综述重试时前一版正文作废——需要 `delta` 带 `revision` 号让前端清空重画 |
| S8 | **取消与断连** | `/stream` 客户端断开 → `AbortSignal` 透传到 LLM 与连接器，停止花钱（V156 ③） | 不省时间，省钱 | — |

| S9 | **两档综述 + 批量预筛**（用户 2026-09-15 追问「为什么精读要这么久？直接喂给子代理汇总不可以吗」引出）：快速档 = 全部摘要一次调用出综述（引用库内 key，走同一个 citationIntegrity）；精读档 = 有 PDF 或用户点名「深读」时才逐篇建卡；两档之前都先做一次**批量相关性预筛**（一次便宜调用给候选打分，留 top-K） | `literature_pipeline.ts` 加 `depth: "quick" \| "deep"`；plan 提示词默认 quick；预筛复用精读卡的 `relationToProject` 语义但一次判全部 | 摘要级任务 8×50s → **1–2 次调用（1–2 min）**；同时解决 V172 残余「④只产卡不筛卡」 | 快速档没有每篇的证据层——综述里「为什么这篇有用」不可查；用户要追溯时切精读档。第五次会话实证：PDF 0/3，精读全按摘要做，即「用全文级成本做摘要级的事」 |

**优先级**：S4 → S9 → S3 → S2 → S1 → S7 → S5 → S6 → S8（S9 提到 S3 之前：先把不必要的调用砍掉，再谈并行）。前三条是纯工程、零产品判断、收益最大（文献流程 8–12 min → **3–4 min**）；S1 需要一条分类判据（AD-8：模型判断之外要有规则层）。

## 三、流式可见（中间过程上屏）设计

### 3.1 事件协议（在现有六种之上**只增不改**）

```
progress  { stage, complete, total, message, ts, elapsedMs, etaMs? }   // 已有，补 ts/elapsed/eta
partial   { kind: "papers" | "card" | "search_source", taskId, payload }   // 新：中间产物
delta     { chunk, revision, target: "summary" | "review" | "card:<paperId>" }   // 已有，补 revision/target
```

- `partial.papers`：检索一回来就推候选清单（标题/年份/DOI/来源），用户在 5s 内看到论文，而不是 8 分钟后。
- `partial.search_source`：每个源单独回报 ok/failed/timeout + 条数，坏源不再隐身。
- `partial.card`：每张精读卡完成即推「标题 + 一句 keyFindings + 是否相关」。
- `delta.target`：让前端把综述正文和摘要正文分开渲染；`revision` 解决重试作废。
- `etaMs`：按本会话已测阶段均值估（第一张卡 50s → 剩 5 张 ≈ 250s），宁可不给也不乱给。

### 3.2 前端

- 把 spinner 换成**阶段条 + 实时日志 + 正文区**三段：
  - 阶段条：plan → search → download → read → review → summarize，当前阶段高亮，每段显示耗时。
  - 实时日志：`progress` 与 `partial` 逐行追加（可折叠），检索到的论文可点开。
  - 正文区：`delta` 流式 markdown，按 `target` 分区。
- 「停止」按钮 → 关闭 SSE（S8 让后端真的停）。
- 长任务一律走 `/stream`；`chat` 同步接口只留给脚本。

### 3.3 后端接线点（全部在现有结构内）

| 事件 | 接线点 |
|---|---|
| `progress.elapsed/eta` | `createProgressEmitter` 内部记 `startedAt` 与各阶段均值 |
| `partial.papers` / `search_source` | `literature_pipeline.ts` ② 每条查询返回后经 `note`-同级的新回调 `emitPartial` |
| `partial.card` | `generateMany` 的 `onCard` 回调（现在只有 `failures` 汇总） |
| `delta.target=review` | `ReviewDraftGenerator.generate` 接 `onDelta`（`LLMRouter.call` 已支持流式） |
| 取消 | `chat()` 收 `signal`，透传到 `llmFor` 与 `ConnectorRegistry`（`HttpClient` 已有 timeout 机制，加 signal） |

## 四、分批与 DONE

| 批 | 内容 | DONE 判据 |
|---|---|---|
| W10-1 | S4 S9 S3 S2 + 3.1 的 `progress.elapsed` | `measure-chat` 基线：一句话 chat P50 **≤ 60s**；文献流程冒烟（1 查询 / 6 篇 / 精读 3）**≤ 4 min**；两条阴性对照（去掉 allSettled → 回到等最慢；concurrency=1 → 时间回去） |
| W10-2 | 3.1 `partial` + `delta.target/revision` + 3.2 前端三段 | e2e：检索完成后 **≤ 10s** 页面出现论文标题；精读每完成一张页面多一行；综述正文逐字出现 |
| W10-3 | S1 直答路径 + S5 默认值 + S6 复用 | 一句话 chat P50 **≤ 20s**；T5 第 5 步复验「带计数的分段进度」过；R7 精读卡合格率不低于 R6 |
| W10-4 | S8 取消/断连 | 断开 SSE 后 5s 内台账不再新增行（V156 ③） |

**明确不做**：换 message loop 架构；把所有 13 个技能一次接完（V172 后半按盘点表逐个来）；前端引入新 UI 框架。

## 五、先测再改（W10-0）

1. `scripts/measure-chat.ts` 加 `--pipeline` 模式：对文献流程按阶段打点（search / download / read / review），输出与 §1.2 同形状的表，作为 v0.10 基线。
2. 精读并行安全性：3 并发打 deepseek-v4-flash / openrouter 各 20 次，记 429 次数——S3 的 `concurrency` 默认值由这个数定。
3. 这两项做完才开 W10-1；没有基线的提速是 U10 那种「快 2.7 倍」的假数（USAGE_LOG U10 教训）。
