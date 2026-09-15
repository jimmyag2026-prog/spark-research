# 本地使用窗口 · U38 U39 U40 U44–U50 U52 U53 + V171 路线① + V172 前半（U43 登记不做，U51 → v0.10）

**日期** 2026-09-16 · **分支** `fix/ux-U38-U40` · 复跑：typecheck 干净 · unit 2663/0 · concurrency+timeout 37/0 · integration 8/0 · e2e 50/50 · sdk 68/0 · llms 无变化 · 触发：owner 首次以普通用户身份用 v0.9.0，网页端 chat 问「帮我下载 mRNA × AI 的综述」，0 篇 0 PDF。现场记录 `docs/UX_TEST_v0.9.0.md`，条目 `USAGE_LOG.md` U38–U46。第二次会话（`web_1789475371793`，「rsi 领域最近中国和美国有怎样的进展」）又带出 U44 U45 U46，一并在本窗口修掉；完整时间线见 `docs/devlog/UX-window-timeline.md`。

## 先定位，再动手

证据全部来自 `raw/llm/2026-09-15.jsonl`（session `web_1789471590880`）与 `api_calls.jsonl`。summarize 收到的执行摘要原文：

```
- [connector] t2: ok — {"ok":false,"server":"pubmed","tool":"search","error":"HTTP request timed out after 30000ms: ..."}
- [connector] t3: ok — {"ok":false,"server":"arxiv","tool":"search","error":"... HTTP 429"}
- [connector] t5: ok — {"ok":true,"server":"europepmc","tool":"search","result":{"version":"6.9"}}
- [code]      t4: failed —
- [subagent]  t7: failed — undefined is not an object (evaluating 'defaults.grants')
```

| 现象 | 复现 | 判定 |
|---|---|---|
| PubMed 30s 超时 | 事后直连 NCBI 三次：0.8 / 0.9 / 1.1s；polite 头（`tool=`/`email=`）与 `httpTimeoutMs=30000` 均正确 | **上游瞬时抖动，不是缺陷**。但它暴露了 U38 |
| arXiv 429 | 复现 | 已登记 U27 / V165 |
| 三次失败都写着 `ok` | 读 `orchestrator.ts:879`：`dispatch` 不抛异常就无条件 `ok: true` | **U38 成立** |
| `defaults.grants` 崩 | `buildSubAgentSpec("Review")` 实测抛 `TypeError`；`"review"` 正常 | **U39 成立** |
| EPMC 空壳 | 模型原样 args 复现得 `{"version":"6.9"}`；换 4 种合法写法均回 hitCount 41514/35814 | **U40 成立**（查询语法不被接受，上游用 200 回空壳） |
| t4/t6 读不到前一步产物 | session workspace 实测空目录 | **U41 成立**，属设计缺口 → V171 |
| 手搓 connector vs `lit search` | `lit search … --limit 5` 26s 出 5 篇全带 OA PDF，零 LLM | **U42 成立**，属设计缺口 → V172 |

## 改动

| 条目 | 改动 | 门禁 | 阴性对照（实跑） |
|---|---|---|---|
| **U38** | `orchestrator.ts` 新增 `connectorFailureOf()`；connector 分支解包 `{ok:false}` 信封 → 任务 `ok:false`，执行日志记 `error` | `ux_window` U38 ×3 | 退回无条件 `ok: true` → **1 红** |
| **U39** | `sub_agent.ts` 导出 `SUB_AGENT_TYPES` 并在 `buildSubAgentSpec` 入口校验；`orchestrator.ts` 新增 `normalizeSubAgentType()`（大小写/空白不敏感），未知类型 → 任务 `ok:false` 且消息列出可用类型。**顺带删掉 orchestrator 里那份同名同内容的 `SUB_AGENT_TYPES` 副本**——研究循环一直在用它做校验，chat 路径却没有，典型的「两份清单、一处校验」 | `ux_window` U39 ×4 | 退回 `as` 断言 → 1 红；去掉入口校验 → 1 红 |
| **U40** | `connectors/base.ts` 新增 `searchPayloadProblem()`（返回原因而非抛），在 `executeTask` 的 connector 分支里**只对 `tool === "search"`** 调用。判据只查**计数或结果容器在不在**，不查是不是 0 条——0 条是合法结果，语法错不是 | `ux_window` U40 ×4 | 判据恒真 → **2 红** |
| **U44** | `sub_agent.ts` 的 `toolResultContent()` 在工具返回进消息历史前瘦身：认得出 `{query, sources[], papers[]}` 的按字段瘦身（每源 outcome/计数 + 前 10 篇要素，摘要截 200 字，砍 authors/ids/url/pdfUrl/references，`_compacted.droppedFields`/`note` 写明砍了什么）；认不出形状的按 `TOOL_RESULT_MAX_CHARS = 8000` 截断并在 `_truncated`/`_note` 里明说 | `ux_window` U44 ×3 | compact 关掉 → **1 红**；截断关掉 → **1 红** |
| **U45** | `connectors/literature.ts` `PubMedConnector.search` 同时认 `term`（NCBI 原名）与 `query`（平台统一名），`query` 优先，`rest` 里两个都删——修前算出的空串排在 `...rest` 之后，把调用方写的 `term` 覆盖掉；检索词为空当场抛错不发上游。`base.ts` 新增 `upstreamErrorOf()`（NCBI `esearchresult.ERROR` + REST 的 `errCode`/`errMsg`/`error`），在 `searchPayloadProblem()` 里**排在「有没有结果容器」之前**——`esearchresult` 本身就在 `SEARCH_RESULT_KEYS` 里，不先判错误信封就会被当成合法空结果放行 | `ux_window` U45 ×4 | `term` 别名去掉 → **1 红**；`upstreamErrorOf` 恒空 → **1 红** |
| **U46** | `connectors/base.ts` 的 `HttpConnector.call()` 开头判 `metadata.status === "placeholder"` → 抛「占位实现 + caveat 原文 + 下一步（换用已可用的源）」，**一次 HTTP 都不发**。修前 cnki 回 `ERR_TLS_CERT_ALTNAME_INVALID`、wanfang 回 404，而两者的 caveat 早就写着「调用会失败」 | `ux_window` U46 ×2 | placeholder 判断恒假 → **1 红** |
| **U47** | `connectors/registry.ts` 渲染一份**真实连接器清单**（每个源的精确工具名 + `usable` 标记 + placeholder 黑名单），`orchestrator.ts` 把它拼进 plan 提示词。纯数据、零网络、906 字符——修前 `plan()` 只喂技能描述不喂能力清单，规划器于是照连接器描述里的字眼猜出不存在的 `pubmed.esearch`，并连着三次会话把 cnki / wanfang 这两个死源排进计划 | `ux_window` U47 ×5 | `usable` 恒真 → **1 红**；tools 改成 `esearch` → **1 红**；清单从 prompt 删掉 → **1 红**（**第一版门禁没抓到**，补钉 `daa6d67` 之后才红） |
| **U48 / V171 路线①** | `orchestrator.ts` 的 `executeTask` 统一出口把每个任务产出落盘到 `<workspace>/<sessionId>/<taskId>.json`（完整信封），plan 提示词写明这条**绝对路径约定**，summarize 收到的执行摘要从 `slice(0, 200)` 改成**形状摘要**：认得 openalex `results[]` / crossref `message.items[]` / europepmc `resultList.result[]` / pubmed esummary map 四种形状 → 条数 + 前 5 条标题 + 落盘路径；其余截 600。修前一份 OpenAlex 结果的前 200 字符恰好只够到 `meta`，模型「只留下了命中计数」说的是实话 | `ux_window` V171/U48 ×4 | 不落盘 → **1 红**；digest 关掉 → **1 红**；prompt 里的路径约定删掉 → **1 红** |
| **U49** | `agents/progress.ts` 新增 `ProgressEmitter.taskNote(message)`——**计数不变、只换文案**；`literature_pipeline.ts` 的 `note()` 同时进执行日志与 progress，检索 / 下载 / 精读 / 综述每个阶段都推一条。修前精读 8 篇（每篇约 50s）期间 SSE 上零事件，用户以为卡死 | `v172_literature_pipeline` U49 ×1 | `taskNote` 删掉 → **1 红** |
| **U50** | `runLiteraturePipeline` 接受 `model` 并透传给 `ReadingCardGenerator` / `ReviewDraftGenerator` 的每次调用；编排层按 **会话覆盖 > `subAgentModel_literature` > 默认模型** 选。修前两个生成器都走 `llmFor(sessionId)`，聊天框选了 kimi 就 8 篇全 kimi，配置里专门给文献子代理留的模型项从未被这条路读到（AD-17 形状） | `v172_literature_pipeline` U50 ×2（含源码级钉住选择顺序） | `model` 透传删掉 → **1 红** |
| **U52** | `right.tsx` 的 `RecordDetail` 头部加 `← 返回总览`（`ws.selectRecord(null)`，`data-testid="record-detail-close"`）。修前只能回时间线再点一次同一条才能取消，列表滚走后详情区就是单行道 | 前端改动，由 e2e 覆盖（无新增单测） | — |
| **U53** | `ExecutionOutcome.artifacts[]` → `OrchestrationResult.artifacts[]` → `chat()` → SSE `result.artifacts[]`，前端把它渲染成「📄 综述草稿」按钮、点了切到产物视图；`ChatResponse.artifacts` 从 `unknown[]` 收成 `Array<{id,label}>` 并重生成契约（`schemas.generated.json` + Python SDK `_types.py`） | 类型 + 契约重生成；前端由 e2e 覆盖（无新增单测） | — |

## 如实交代

- **U40 第一版下错了位置，被测试当场打回。** 最初把断言放进 `EuropePMCConnector.search()` 里，结果打红 7 个既有测试（`literature.test.ts` ×2、`connector_race.test.ts` ×5）——连接器层的单测与并发回归大量用 `{}` 或 echo 式桩响应去断言**请求构造**，它们不关心响应体。在那一层拦，拦到的全是假红。判据因此移到编排层（模型手写连接器调用的那条路），并收窄到 `tool === "search"`。**这 7 条红不是回归，是位置选错的信号**，记在这里免得下次再来一遍。
- 新位置**不覆盖**外部 MCP 客户端直接调连接器 search 的路径（它不经过 `executeTask`）。`searchPayloadProblem()` 是导出的纯函数，那条路需要时接一行即可。
- `SEARCH_RESULT_KEYS` 是一张宽表（12 个常见键名），刻意不按 connector 分表——现在只有一例现场证据，按 connector 写死等于凭想象加判据。出现第二例时再收敛成显式表。
- 本窗口**没有**碰 U41/U42/U43——它们要么是设计裁定（步骤间落盘约定、plan 任务类型表），要么牵动设置面交互，不适合在一次 bug 修复里顺手做。已登记 V171–V173。
- **U44 的瘦身只认得「检索结果」这一种形状**（`{query, sources[], papers[]}`），其余工具一律走通用截断。通用截断会丢结构（模型拿到的是一段 JSON 前缀 + 一个说明），但它**明说了被截断**——静默截断比截断更危险。要按工具定制表现层，正路仍是 `McpToolRunner` 已有的 `tool.present()` 钩子（V174 ①）。
- **U46 之后 `cnki` / `wanfang` 变成「调用即失败」。** 将来真接通了官方 API 或机构订阅渠道，记得**同时**把 `status` 从 `placeholder` 改掉，否则新渠道会被这道闸原封不动地挡在门外。
- 过程失误一条：第一轮阴性对照在 commit **之前**跑，`git checkout` 把未提交的两个文件改动冲掉了，重做了一遍。纪律补充：**先 commit 再做阴性对照**。
- **V172 的精读默认最多 8 篇（`maxRead`）是花钱上限，不是质量上限。** 8 这个数字来自「一次会话愿意付多少钱」，不代表「读到第 8 篇就够了」，也不代表这 8 篇是最相关的 8 篇——它就是入库顺序的前 8 条。会话五实测这 8 张卡烧掉 1001s / 1363s 墙钟，而 PDF 只命中 2/8，等于**用全文级成本做摘要级的事**。v0.10 S9（两档综述 + 批量预筛）就是冲这条来的。
- **用户定义五步里的④「读取文献确认哪些有用」目前只产卡不筛卡。** `runLiteraturePipeline` 给每篇生成精读卡（卡里有 `relationToProject` 字段），但**没有任何一步拿这个字段去剔除无关论文**，综述照单全收。V172 review 模式真冒烟里就撞上了：blended 排序把两篇心血管指南混进「prevention」命中，精读卡没挡住、综述照引。这是 V172 的残余，不是本轮修掉的东西。
- **U53 的 `ChatResponse.artifacts` 此前是一个无人填写的 `unknown[]`。** 类型声明在 `server/types.ts` 里躺了很久，**没有任何代码往里写过一个元素**，前端自然也没读过；文献流程的综述 `artifactId` 只能以纯文字出现在 digest 里。这和 U50（`subAgentModel_literature` 声明了没人读）是同一个形状（AD-17：声明即须有读者）——本轮一口气撞到两例，值得当成一类缺陷看，而不是两个孤立 bug。

## 追加 · V172 前半（chat 真执行文献技能）

用户定义的五步：关键词拆解 → 多源检索取索引 → connector 下载 → 读取确认 → 综述总结。仓库里 ②–⑤ 早已各有实现（`lit search/add/pdf/read/review`），缺的是①与「接进 chat」。

| 改动 | 说明 |
|---|---|
| `agents/literature_pipeline.ts`（新） | `runLiteraturePipeline({llm, project, sessionId, searcher?, downloadPdf?}, {mode, queries, topic, limit, maxRead})`：search 模式零 LLM；review 模式每篇一张精读卡 + 一份综述，全部走会话的 `llmFor`（预算闸生效）；产出摘要 ≤1500 字符给 summarize，完整结果落盘 `<workspace>/<sessionId>/<taskId>.json`（V171 约定） |
| `orchestrator.ts` `case "skill"` | 仅对 `literature-search` / `literature-review` 真执行；其余技能行为不变 |
| `orchestrator.ts` plan 提示词 | 文献类需求必须发一个 skill 任务并在 `params.queries[]` 给 3–6 条拆解后的英文检索词；`connector` 只用于非文献库 |
| 注入点 | `OrchestratorDeps.literatureSearcher` / `literatureDownloadPdf`（测试不碰网络） |

阴性对照（实跑）：skill 分支退回只加载上下文 → 1 红；plan 提示词删掉文献指引 → 1 红；综述引用库外 key `fabricated2099` → 被 citation-integrity veto 而红（验证复用的门真在链上）。

如实交代：① 精读默认最多 8 篇（`maxRead`），是花钱上限不是质量上限；② 引用核验用机械核对（`judge: undefined`），没接 LLM 判定；③ AMiner 是否参与仍由 `searchSources` 决定（U43/V173 未动）。
