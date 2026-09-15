# 本地使用窗口 · 时间线留档（2026-09-15 / 09-16）

**分支** `fix/ux-U38-U40` · **条目** `USAGE_LOG.md` U38–U46 · **登记** `BACKLOG.md` V171–V176
**现场记录** [`docs/UX_TEST_v0.9.0.md`](../UX_TEST_v0.9.0.md) · **修复说明** [`UX-window-fixes.md`](UX-window-fixes.md)

> 这份文件是**档案**，不是评审：只把「发生了什么、证据是什么、改了哪一行、门禁在哪」按时间摆开，让第三方能自己复核。
> 判断性的结论留在各自的 U 条目与 BACKLOG 里。文中数字全部取自 `git show` 与 `tests/unit/ux_window.test.ts`，读不到的写「未记录」。

---

## 一、背景

owner 第一次以**普通用户**身份使用 v0.9.0（本机 `http://127.0.0.1:4321`，源码 `~/Desktop/AI4S/spark-research` main@16c0605）。
两次真实需求，两次都没拿到结果：

| # | 时间 | 项目 | 需求（原话） | 结果 |
|---|---|---|---|---|
| 会话一 | 2026-09-15 11:31 | `spark` | 「帮我下载关于 mRNA 最新的研究综述论文吗？和 AI 主题相关的更好」 | **0 篇 0 PDF**，约 46s，2 次 LLM 调用 |
| 会话二 | 2026-09-15 20:3x（台账 UTC `2026-09-15T12:32:11.706Z`） | `spark0915` | 「rsi 领域最近中国和美国有怎样的进展」 | 检索全空转；一次子代理调用 **129,865 输入 token / $0.058** |

同一需求走成熟 CLI 管线作对照：`lit search "mRNA vaccine machine learning review" --project spark --limit 5` → **26s 出 5 篇，全部有 OA PDF，零 LLM 调用**。

会话二开始前，server 已切到含 U38/U39/U40 修复的 `fix/ux-U38-U40`——也就是说 U44/U45/U46 是**修完第一批之后才露出来的**下一层。

---

## 二、两次会话的逐步失败表

### 会话一 · session `web_1789471590880`（项目 `spark`，7 步计划）

证据来源：`raw/llm/2026-09-15.jsonl` 与 `api_calls.jsonl` 里 summarize 收到的执行摘要原文。

| 步 | kind | 平台记的 | 实际发生 | 归到 |
|---|---|---|---|---|
| t1 | 未记录 | 未记录 | 未记录（执行摘要里没有这一行） | — |
| t2 | connector · pubmed search | `ok` | `{"ok":false,...,"error":"HTTP request timed out after 30000ms"}`。事后直连 NCBI 三次 0.8 / 0.9 / 1.1s，polite 头与 `httpTimeoutMs=30000` 均正确 → **上游瞬时抖动，不是缺陷**，但它暴露了信封没被解包 | **U38** |
| t3 | connector · arxiv search | `ok` | `{"ok":false,...,"error":"Connector \"arxiv\" tool \"search\" failed: HTTP 429"}` | **U38**（429 本身 = 已登记的 U27 / V165） |
| t4 | code | `failed`（空输出） | 代码原文 `open('/workspace/artifacts/t2_pubmed.json')`；session workspace `~/.spark-research/workspaces/web_1789471590880/` 实测是空目录 | **U41** |
| t5 | connector · europepmc search | `ok` | HTTP 200 但响应只有 `{"version":"6.9"}`，既无 `hitCount` 也无 `errCode`。换 4 种合法写法均回 hitCount 41514 / 35814 | **U40** |
| t6 | code | `failed`（空输出） | 同 t4：读不到前一步产物 | **U41** |
| t7 | subagent | `failed` | `undefined is not an object (evaluating 'defaults.grants')`。模型写的是 `params: {"subagent":"Review"}`（大写 R）；实测 `"Review"` 抛 TypeError、`"review"` 正常 | **U39** |
| 全程 | — | — | 7 步手搓 connector = 0 篇 0 PDF + 1 次崩溃；同需求 `lit search` 一条命令 26s 出 5 篇全带 OA PDF | **U42** |
| 配置面 | — | — | `searchSources` 里没有 `aminer`（凭据已配），清单里的 `semanticscholar` 反而没凭据 | **U43** |

### 会话二 · session `web_1789475371793`（项目 `spark0915`）

| 步 | kind | 平台记的 | 实际发生 | 归到 |
|---|---|---|---|---|
| t1 | 未记录 | 未记录 | 未记录 | — |
| t2 | connector · pubmed search | `{"ok":true,...}` | `{"result":{"esearchresult":{"ERROR":"Empty term and query_key - nothing todo"}}}`——模型按 NCBI 官方文档写了 `term`，被连接器算出的空串覆盖 | **U45** |
| t3 | connector · pubmed search | `{"ok":true,...}` | 同 t2，第二次空转 | **U45** |
| t4 | connector · cnki search | 失败 | `ERR_TLS_CERT_ALTNAME_INVALID`（`https://kns.cnki.net/kns8s/brief/grid`）——而 `china.ts` 里 cnki 早标着 `status: "placeholder"`，caveat 写着「调用会失败」 | **U46** |
| t5 | connector · wanfang search | 失败 | `HTTP 404`（`https://api.wanfangdata.com.cn`）——同样是 `status: "placeholder"` | **U46** |
| t6 | 未记录 | 未记录 | 未记录 | — |
| t7 | subagent（explore） | `ok` | 输入 **129,865 token / $0.058**（`deepseek-v4-flash`）。raw 层 prompt blob 428,696 字节，9 条消息里三次 `lit_search` 返回占 81,707 + 105,448 + 197,383 = **384,538 字符**；同一轮里还有一次 `lit_search` 30s 超时，那条只回 65 字符 | **U44** |

监控侧同刻的两条记录（`UX_TEST_v0.9.0.md` §四）：

- `20:34 spark0915` **COST 告警**：一次 `chat:subagent` 输入 129,865 token / $0.058。
- `20:34 spark0915` **监控脚本自身崩了**（非法 f-string 转义）——真出错时反而不报。

---

## 三、九条发现一览（U38–U46）

| 编号 | 一句话 | 严重度 | 状态 | V 号 |
|---|---|---|---|---|
| U38 | `connector` 任务失败被记成 `ok: true`——三次连接器失败在执行摘要里全是「ok」 | **高** · 正确性 | ✅ 本地已修 | — |
| U39 | `subagent` 任务的 type 不校验，模型写 `"Review"` → `TypeError` 冒给用户 | **高** · 正确性 | ✅ 本地已修 | — |
| U40 | EPMC 查询语法不合法时回 `{"version":"6.9"}` 空壳 + HTTP 200，平台当成功 | 中 · 正确性 | ✅ 本地已修 | — |
| U41 | 多步计划里 `code` 任务读 `/workspace/artifacts/tN_*.json`，而 `connector` 产出从不落盘 | **高** · 设计 | 登记不做 | **V171** |
| U42 | chat 绕开成熟的 `lit search` 管线，让模型手搓 connector（`skill` 任务只加载提示词从不执行） | **高** · 设计 | 登记不做 | **V172** |
| U43 | 凭据与检索源勾选不关联：aminer 有 key 不在清单，semanticscholar 在清单没 key | 中 · 配置 | 登记不做 | **V173** |
| U44 | 工具返回整份 JSON 进对话历史 → 单次子代理调用 13 万输入 token / $0.058 | **高** · 成本/性能 | ✅ 本地已修（残余登记） | **V174** |
| U45 | PubMed 只认 `query`，模型按 NCBI 官方文档写的 `term` 被静默覆盖成空串 | **高** · 正确性 | ✅ 本地已修（残余登记） | **V175** |
| U46 | `status: "placeholder"` 的连接器仍真发网络请求，把 TLS 错 / 404 丢给 agent | 中 · 体验 | ✅ 本地已修（残余登记） | **V176** |

---

## 四、修了什么（按提交顺序）

`git log --oneline main..HEAD`（旧 → 新）：

| sha | 标题 | 一句话 |
|---|---|---|
| `bc52b9c` | docs：v0.9.0 用户体验测试记录模板（本地先记，U 从 U38 起） | 建 `docs/UX_TEST_v0.9.0.md`，约定 U 从 U38 起编号 |
| `3f88da8` | docs(UX)：首次使用记录——mRNA 综述检索失败的全链路定位；USAGE_LOG 登记 U38–U42 | 会话一的现场与证据入库 |
| `6eca036` | fix(本地使用窗口)：U38 连接器失败不再记成成功 · U39 子代理类型运行期校验（并删 SUB_AGENT_TYPES 副本）· U40 检索空壳响应即失败 | `orchestrator.ts` 新增 `connectorFailureOf()` 解包 `{ok:false}` 信封；`sub_agent.ts` 导出 `SUB_AGENT_TYPES` 并在 `buildSubAgentSpec` 入口校验、`orchestrator.ts` 加 `normalizeSubAgentType()` 并删掉自带的同名副本；`literature.ts` 加空壳判据（位置在下一条被改） |
| `f02538a` | Merge docs/ux-test-v0.9.0（UX 记录 + U38–U42）into fix/ux-U38-U40 | 文档分支并入修复分支 |
| `115c053` | docs(本地使用窗口)：devlog · USAGE_LOG U38–U40 状态 + U43 · BACKLOG V171–V173 · llms 重生成 | 建 `UX-window-fixes.md`；U43 入库；V171–V173 登记 |
| `20f9f05` | fix(U40)：空壳判据从连接器移到编排层且只对 search | 判据从 `EuropePMCConnector.search()` 移出，`connectors/base.ts` 新增导出的纯函数 `searchPayloadProblem()`，由 `orchestrator.ts` 的 `executeTask` connector 分支**只对 `tool === "search"`** 调用；判据只查「有没有计数或结果容器」，不查是不是 0 条 |
| `8fd227d` | docs(UX 窗口)：记录 U40 下错位置被 7 条测试打回的过程与新位置的覆盖边界；补全套件数字 | 把下错位置这件事写进「如实交代」 |
| `86d9a7e` | docs(UX)：记录本轮测试开始（新建项目 spark0915） | 会话二起点入档 |
| `6fa8024` | docs：V172 按用户要求重写 | V172 改写成「chat 要能调用技能完成任务」：13 个技能盘点 + 甲（子代理）/乙（直调）两条路线 + 前置盘点表 |
| `d967790` | docs：U44 / V174——lit_search 工具返回不摘要，单次子代理调用 13 万输入 token（$0.058）；监控脚本崩溃教训 | U44 与 V174 入库 |
| `d1f8a23` | fix(U45)：PubMed 接受 NCBI 原名 term + 空检索词当场失败 + 上游「200 带业务错误」判为失败 | `literature.ts` `PubMedConnector.search` 同时认 `term`/`query`（`query` 优先）且 `rest` 里两个都删，空检索词抛错不发上游；`base.ts` 新增 `upstreamErrorOf()` 并在 `searchPayloadProblem()` 里**排在结果容器判据之前** |
| `c099342` | fix(U44/U46)：工具返回瘦身+截断明示；placeholder 连接器早失败不发请求 | `sub_agent.ts` 的 `toolResultContent()` 加检索结果瘦身 + `TOOL_RESULT_MAX_CHARS = 8000` 截断并明说；`base.ts` 的 `HttpConnector.call()` 开头判 `metadata.status === "placeholder"` 即抛错，一次 HTTP 都不发 |
| `6979f1f` | test(U44)：断言修正——references 出现在 droppedFields/note 里是对的，要钉的是「没有真数据残留」 | 只改测试断言：`references` 作为**字段名**出现在 `droppedFields`/`note` 里是正确的，门禁要钉的是没有真数据残留 |

---

## 五、门禁

单一门禁文件 `tests/unit/ux_window.test.ts`（278 行），**6 个 describe / 20 条 test**：

| describe | 条数 | 钉住什么 |
|---|---|---|
| U38 · 连接器失败不得记成成功的任务 | 3 | `ok:false` 信封 → 这一步 failed 且 error 原文进摘要；成功仍 ok（回归防护）；判据只看 `ok===false`，不去猜结果是不是空的 |
| U39 · 子代理类型是不可信输入 | 4 | `"Review"` → 归一成 `review`、认不出返回 null；未知类型 → `ok:false` 且列出可用类型；`buildSubAgentSpec` 收到未知类型抛带下一步的错误；`SUB_AGENT_TYPES` 只有一份 |
| U40 · search 的响应里至少要有计数或结果容器 | 4 | 空壳 → 点名「空壳」与下一步；有计数或容器就放行（0 条也放行）；非对象响应也拒；编排层 search 拦、`getPaper` 不拦 |
| U45 · PubMed 认 NCBI 原名 term，空检索词不发给上游 | 4 | 只传 `term` 真的带进 esearch；`query` 与 `term` 同给时 `query` 赢；两个都空 → 当场失败不发上游；200 + 业务错误（NCBI `ERROR` / REST `errCode`）判为失败 |
| U46 · placeholder 连接器早失败，不发网络请求 | 2 | cnki / wanfang → 抛「占位实现」+ 下一步且一次 HTTP 都没发；非 placeholder 的源不受影响 |
| U44 · 工具返回进对话历史前先瘦身 | 3 | 检索结果被瘦身（保留每源 outcome/count 与前 10 篇要素、砍 references/authors、注明砍了什么）；认不出形状的大返回截断且**明说**；小返回原样透传 |

**阴性对照（全部实跑）**——把判据逐条打回原样，看门禁是不是真的变红：

| 对照 | 结果 |
|---|---|
| U38：退回无条件 `ok: true` | **1 红** |
| U39：退回 `as` 断言 | **1 红** |
| U39：去掉 `buildSubAgentSpec` 入口校验 | **1 红** |
| U40：判据恒真 | **2 红** |
| U44：compact 关掉 | **1 红** |
| U44：截断关掉 | **1 红** |
| U45：`term` 别名去掉 | **1 红** |
| U45：`upstreamErrorOf` 恒空 | **1 红** |
| U46：placeholder 判断恒假 | **1 红** |

第一批（U38/U39/U40）的复跑结果见 `UX-window-fixes.md` 头部：typecheck 干净 · unit 2663/0 · concurrency+timeout 37/0 · integration 8/0 · e2e 50/50 · sdk 68/0 · llms 无变化。

---

## 六、过程中的三次自我纠错（如实记）

**1 · U40 第一版把断言下错了位置，被 7 个既有测试当场打回。**
最初把空壳断言放进 `EuropePMCConnector.search()` 里，结果打红 `literature.test.ts` ×2、`connector_race.test.ts` ×5——连接器层的单测与并发回归大量用 `{}` 或 echo 式桩响应去断言**请求构造**，它们根本不关心响应体。在那一层拦，拦到的全是假红。判据因此移到编排层（模型手写连接器调用的那条路），并收窄到 `tool === "search"`。**这 7 条红不是回归，是位置选错的信号。**
遗留边界：新位置**不覆盖**外部 MCP 客户端直接调连接器 `search` 的路径（它不经过 `executeTask`）；`searchPayloadProblem()` 是导出的纯函数，那条路需要时接一行即可。

**2 · 第一轮阴性对照跑在 commit 之前，被 `git checkout` 冲掉，重做了一遍。**
把判据改回原样验证变红之后，用 `git checkout` 复原，连带把**未提交**的两个文件改动一起冲掉了。纪律：**先 commit 再做阴性对照**，复原靠 `git checkout` 才安全。

**3 · 监控脚本自身有非法 f-string 转义，真出错时反而不报。**
2026-09-15 20:34 那次 COST 事件，监控脚本在报警分支上自己崩了。已重写并用真实台账实跑验证。教训与上一条同形：**监控的失败分支必须先跑一遍**——没跑过的报警路径等于没有报警。

---

## 七、未修的与为什么

| 项 | 为什么不在本窗口做 |
|---|---|
| **U41 → V171**（步骤间落盘约定） | 是**设计裁定**：① 每个任务产出按 `<workspace>/<taskId>.json` 落盘并把路径写进任务描述，还是 ② plan 提示词明说「步骤间不共享文件系统」。倾向 ①，但不适合在一次 bug 修复里顺手定。去向 v0.9.x |
| **U42 → V172**（chat 要能调用技能） | 用户 2026-09-16 明确要求「chat 里之后要设置为可以调用 skill 做任何任务」。甲（子代理路线）/ 乙（直调路线）须裁定，**前置是一张 13 个技能的执行入口 / 所需 grants / 是否已有程序化实现盘点表**——没有这张表就开工等于又一次凭想象接线。去向 v0.10 首批 |
| **U43 → V173**（凭据 × 检索源勾选） | 牵动设置面交互，不适合在 bug 修复窗口里改。去向 v0.9.x |
| **U44 残余 → V174** | 本窗口修的是「tool loop 统一出口瘦身 + 截断明示」；`lit_search` 自己的 `present()` 钩子与「单次输入 token 超阈值台账打标」未做。与 V172 同批做——技能一旦可执行，返回体量问题只会更严重 |
| **U44 的形状局限** | 瘦身**只认得「检索结果」这一种形状**（`{query, sources[], papers[]}`），其余工具一律走通用截断。通用截断会丢结构，但它**明说了被截断**。要按工具定制，正路是 `tool.present()` |
| **U45 残余 → V175** | `upstreamErrorOf` 的错误码清单只覆盖 NCBI `esearchresult.ERROR` 加通用三个键（`errCode`/`errMsg`/`error`），其余源的「200 带业务错误」形状没有盘过 |
| **U46 残余 → V176** | CNKI / 万方的真实可用渠道（官方 API 或机构订阅）未接通——老 D3，不在我们手里。本窗口只把「调用即失败」变得诚实。**接通渠道时记得同步把 `status` 从 `placeholder` 改掉**，否则新渠道会被这道闸挡住 |
| `SEARCH_RESULT_KEYS` 按 connector 分表 | 现在只有一例现场证据，按 connector 写死等于凭想象加判据。出现第二例时再收敛成显式表 |

---

# 第二轮（U47–U53 · V171 路线① · V172 前半 · v0.10 草案）

> 上一轮留档收在 `fb30ab6`，覆盖到 U46。此后同一分支 `fix/ux-U38-U40` 又跑了三次真实会话（`web_1789476710763` / `web_1789477865031` / `web_1789480157513`），修了 U47–U53、做了 V171 路线①与 V172 前半、起草了 `DEVELOPMENT_PLAN_v0.10.md`。本节同样只摆事实，判断留在各自的 U 条目与 BACKLOG。
>
> **编号口径**：本文按 session 出现顺序数，`web_1789476710763` = 会话三、`web_1789477865031` = 会话四、`web_1789480157513` = 会话五。`UX_TEST_v0.9.0.md` 的体验表把 `web_1789477865031` 记成「第三次 chat」（那张表只数用户主动发起的 chat 请求），两处口径不同，**如实记，不合并**。

## 八、会话三 · session `web_1789476710763`（U47 的现场）

| 步 | kind | 实际发生 | 归到 |
|---|---|---|---|
| T2 | connector · arxiv search | HTTP 429（已登记 U27 / V165，第三次复现） | — |
| T3 | connector · cnki search | 规划器把 `status: "placeholder"` 的死源排进了计划；U46 的闸让它「调用即失败」，但**计划里本就不该有它** | **U47** |
| T4 | connector · wanfang search | 同 T3 | **U47** |
| T5 | connector · pubmed `esearch` | 工具名 `esearch` **不存在**——registry 里真名是 `search`。规划器照着连接器描述里的字眼猜的 | **U47** |
| T8 | — | **预算耗尽**，计划没跑完 | — |

同一根因：`plan()` 只喂技能描述，不喂**能力清单**，于是规划器一边猜工具名、一边反复把死源排进计划（三次真实会话都犯）。修法见 `3461cdd`：注入纯数据、零网络、906 字符的真实连接器清单（精确工具名 + placeholder 黑名单）。

## 九、会话四 · session `web_1789477865031`（U47 生效之后露出的下一层）

| 步 | 实际发生 | 归到 |
|---|---|---|
| t5 等 ×4 | U47 生效：OpenAlex / Crossref / EuropePMC **四次检索真的成功了**；arXiv 3 次超时 / 429 | U47 已生效 |
| summarize | 模型却汇报「只留下了命中计数（条目级数据未进入可读记录）」——执行摘要每行 223 字符，`e.output.slice(0, 200)` 的前 200 字符对一份 OpenAlex 结果恰好只够到 `meta`，`results[]` 在后面。**模型说的是实话** | **U48** |
| t10（code） | 聚合代码 `glob('**/*.json', recursive=True)` 扫到 **496 个文件、0 条记录**——内核 cwd 是 server 的检出目录（仓库），连接器产出从未落盘 | **U41 → V171** |
| t12（code） | 于是把 `rsi_cn_us_report.md` **写进了仓库工作区**（已移出留存） | **U41 → V171** |

会话四之后做了 `ef2ecd9`（V171 路线①：落盘 + plan 提示词写明绝对路径 + summarize 看形状摘要）与 `d4b4349`（V172 前半：chat 的 skill 任务对两个文献技能真执行）。会话五 `web_1789480157513` 就是跑在 V172 前半上的第一次真实使用，带出 U49 U50 U51 U52 U53。

## 十、U47–U53 一览表

| 编号 | 一句话 | 严重度 | 状态 | 对应 V |
|---|---|---|---|---|
| U47 | plan 提示词不含真实连接器清单：规划器猜出不存在的 `pubmed.esearch`，并反复把 placeholder 死源排进计划 | **高** · 正确性 | ✅ 本地已修 | — |
| U48 | summarize 只看每步输出前 200 字符——连接器成功了，模型只见到 `meta.count` | **高** · 正确性 | ✅ 本地已修（与 V171 路线①同一提交） | V171 |
| U49 | 文献流程精读 8 篇期间界面无任何进度（阶段只进执行日志，没推 SSE），用户以为卡死 | 中 · 体验 | ✅ 本地已修 | — |
| U50 | 精读卡 / 综述没读 `subAgentModel_literature`，跟着聊天选择器走（选了 kimi 就 8 篇全 kimi） | 中 · 配置 | ✅ 本地已修 | — |
| U51 | OA 全文命中率低（8 篇标 OA 只拿到 2）：`pdfUrl` 常是落地页而下载器不解析一跳，失败后无 DOI 兜底 | 中 · 功能缺口 | 登记不做 | **v0.10 S10 / S9** |
| U52 | 右侧打开一条记录 / 文献后没有关闭按钮回总览 | 中 · 体验 | ✅ 本地已修 | — |
| U53 | 生成的产物（综述草稿）只以纯文字 id 出现在回复里，聊天框没有可点链接 | 中 · 体验 | ✅ 本地已修 | — |

另两项**本轮做掉的登记项**：**U41 → V171 路线①**（已做）、**U42 → V172 前半**（已做，其余 11 个技能仍只加载上下文）。

## 十一、修了什么（按提交顺序）

`git log --oneline fb30ab6..HEAD`（旧 → 新）：

| sha | 标题 | 一句话 |
|---|---|---|
| `3461cdd` | fix(U47)：plan 提示词注入真实连接器清单 | `connectors/registry.ts` 新增清单渲染（精确工具名 + placeholder 黑名单，纯数据零网络 906 字符），`orchestrator.ts` 把它拼进 plan 提示词 |
| `daa6d67` | test(U47)：补钉「清单真的进了 plan 提示词」 | 阴性对照反过来抓出门禁自身只钉清单内容、不钉接线（AD-17 形状），补一条断言 |
| `7f5f0a8` | docs：校正留档子代理报出的三处不一致 | 门禁条数、U44 倍数（20→40，与正文一致）、U44 时间口径以台账 UTC 为准 |
| `85777d3` | docs(UX)：记录两次超长输出（6704 / 7040 tok） | 归 v0.10「各阶段设 maxTokens」 |
| `ef2ecd9` | fix(V171/U48)：连接器产出落盘 + 规划器被告知绝对路径约定 + summarize 看形状摘要 | 产出落 `<workspace>/<sessionId>/<taskId>.json`；plan 提示词写明绝对路径；digest 认 openalex / crossref / europepmc / pubmed 四种形状（条数 + 前 5 条标题 + 落盘路径），其余截 600 |
| `0b6d23f` | docs：U48 登记并关；U41/V171 路线①已做；UX 记录第三次会话 | 条目入库 |
| `c8e7290` | docs：V172 写入用户定义的五步文献流程作为验收口径 | ①关键词拆解 → ②多源检索取索引 → ③connector 下载 → ④读取确认 → ⑤综述总结 |
| `d4b4349` | feat(V172)：chat 的 skill 任务对 literature-search / literature-review 真执行 | 新文件 `agents/literature_pipeline.ts`（233 行），复用 searcher / library / pdf / reading / review / citationIntegrity；`case "skill"` 只对两个文献技能真执行；plan 提示词要求文献需求走 skill 而非 connector |
| `8f3a0b4` | docs：V172 前半登记、UX 记录热更新、devlog 追加 | 登记入库 |
| `ce81e08` | docs：V172 review 真冒烟数字与残余 | 记下 ④只产卡不筛卡 |
| `3bd62d9` | fix(U49/U50)：各阶段推 progress 事件；精读/综述模型三级选择 | `progress.ts` 新增 `taskNote()`（计数不变只换文案）；模型顺序 = 会话覆盖 > `subAgentModel_literature` > 默认 |
| `e757223` | docs：U49 U50 登记并关；UX 记录第五次会话 | 条目入库 |
| `5cffd4a` | docs：v0.10 方案草案 | 回复速度（8 条杠杆，实测归因）+ 中间过程流式可见（事件协议 / 前端三段 / 接线点）+ 分批 DONE + 先测再改 W10-0 |
| `428a2d5` | docs(v0.10)：S9 两档综述 + 批量预筛 | 摘要级任务不该付全文级成本；优先级提到 S3 之前 |
| `681f885` | docs(skill)：paper-download 补三节；U51 登记；v0.10 加 S10 | 「下载前置条件」「真实批次命中率 2/8 与真因」「目前不做的两跳」 |
| `ab37299` | fix(U52/U53)：详情加「返回总览」；chat 结果携带产物链接 | `right.tsx` 详情头部 `← 返回总览`；`ExecutionOutcome.artifacts[]` → `OrchestrationResult` → `chat()` → SSE `result.artifacts[]`，前端渲染成按钮；`ChatResponse.artifacts` 从无人填写的 `unknown[]` 收成 `Array<{id,label}>` 并重生成契约 |
| `e2f2db0` | docs：U52 U53 登记并关 | 条目入库 |

## 十二、门禁（第二轮末状态）

`tests/unit/ux_window.test.ts`（378 行）：**8 个 describe / 29 条 test**（上一轮是 6 / 20，新增 U47 与 V171/U48 两组）。

| describe | 条数 | 钉住什么 |
|---|---|---|
| U38 · 连接器失败不得记成成功的任务 | 3 | 见上一轮 §五 |
| U39 · 子代理类型是不可信输入 | 4 | 见上一轮 §五 |
| U40 · search 的响应里至少要有计数或结果容器 | 4 | 见上一轮 §五 |
| U45 · PubMed 认 NCBI 原名 term，空检索词不发给上游 | 4 | 见上一轮 §五 |
| U46 · placeholder 连接器早失败，不发网络请求 | 2 | 见上一轮 §五 |
| U44 · 工具返回进对话历史前先瘦身 | 3 | 见上一轮 §五 |
| **U47 · 规划器拿到真实连接器清单，不再猜工具名 / 不再排死源** | **5** | 清单工具名与 registry 实际暴露的逐字一致（猜出来的 `esearch` 不在其中）；placeholder 源被标不可用并进黑名单、渲染文本点名 cnki / wanfang；渲染出的清单足够小（plan 提示词不能被它顶大——U44 的教训）；**清单真的进了 plan 的提示词**（不只是「存在一个函数」，AD-17）；需凭据的源仍列出来但标注会被跳过（不是黑名单） |
| **V171 / U48 · 连接器产出落盘 + 规划器知道路径 + summarize 看摘要** | **4** | summarize 收到的是「条数 + 标题 + 落盘路径」而不是被 200 字符截断的 meta；结果真的落盘到 `<workspace>/<sessionId>/<taskId>.json` 且内容是完整信封；规划器提示词写明了绝对路径约定（AD-17）；digest 认得四种形状、认不出返回 null |

`tests/unit/v172_literature_pipeline.test.ts`（192 行）：**3 个 describe / 8 条 test**。

| describe | 条数 | 钉住什么 |
|---|---|---|
| V172 · `runLiteraturePipeline` | 3 | search 模式多条查询 → 入库去重 → 摘要列出标题与各源 outcome 且**零 LLM 调用**；review 模式下载（注入失败 → 按摘要）→ 每篇一张精读卡 → 综述 artifact，`ok=true`；没有检索词 → `ok=false` 并说明规划器该给 `queries` |
| V172 · chat 的 skill 任务真执行 | 2 | plan 给 `literature-search` + queries → 流程跑了、产出落盘、摘要进 summarize，未知技能仍只加载上下文；规划器提示词明确要求文献需求走 skill 而不是 connector（AD-17） |
| U49 / U50 · 流程内进度推到界面；精读/综述用文献子代理模型 | 3 | 每个阶段都以 progress 事件推出且计数单调不越界；pipeline 把 `model` 透传给精读卡与综述的每次调用；编排层模型选择顺序 = 会话覆盖 > `subAgentModel_literature` > 默认（源码级钉住接线） |

**阴性对照（第二轮，全部实跑）**——把判据逐条打回原样，看门禁是不是真的变红：

| 对照 | 结果 |
|---|---|
| U47：`usable` 恒真 | **1 红** |
| U47：tools 改成 `esearch` | **1 红** |
| U47：清单从 plan 提示词里删掉 | **1 红**（**第一版门禁没抓到**，补钉 `daa6d67` 之后才红） |
| V171/U48：不落盘 | **1 红** |
| V171/U48：digest 关掉 | **1 红** |
| V171/U48：prompt 里的路径约定删掉 | **1 红** |
| V172：skill 分支退回只加载上下文 | **1 红** |
| V172：plan 提示词删掉文献指引 | **1 红** |
| V172：综述引用编造的库外 key `fabricated2099` | **被 citation-integrity veto 而红**（验证复用的门真在链上） |
| U49：`taskNote` 删掉 | **1 红** |
| U50：`model` 透传删掉 | **1 红** |

## 十三、第二轮的三次自我纠错（如实记）

**1 · U47 第一版门禁只钉了清单内容，没钉「清单真的进了 prompt」——AD-17 的形状。**
第一版断言渲染出的清单里工具名正确、死源进黑名单、体积够小，全绿。做阴性对照时把「清单拼进 plan 提示词」那一行删掉，**门禁没有变红**——也就是说，只要清单被生成出来、没人读，测试照样通过。这正是 U50（`subAgentModel_literature` 声明了没人读）与 U53（`ChatResponse.artifacts` 声明了没人填）的同一个形状：**声明即须有读者**。补钉见 `daa6d67`，删掉接线后才真的红。这条是**阴性对照反过来抓出门禁自身的缺陷**，不是代码缺陷。

**2 · U40 那次「位置选错」的教训在本轮被主动避开。**
上一轮把空壳断言下进 `EuropePMCConnector.search()`，打红 7 个只关心请求构造的既有测试。本轮两处同类抉择都先问「拦在哪一层才只拦到真问题」：U47 的清单注入放在**编排层的 plan 提示词构造**（而不是让每个 connector 自报），V171 的落盘放在 `executeTask` 的**统一出口**（而不是各 kind 分支各写一遍）。结果两组共 9 条新测试**没有打红任何既有测试**——上一轮那 7 条红确实是位置信号，不是回归。

**3 · 监控脚本自身有非法 f-string 转义，真出错时反而不报。**
09-15 20:34 那次 COST 事件，监控脚本在报警分支上自己崩了（已在上一轮 §六记过，本轮重写后的版本在会话三至五全程真跑，COST / LONG 告警都正常推送，含 21:13 的 LONG ×2 与 21:46 的冒烟记录）。教训不变：**没跑过的报警路径等于没有报警**。

## 十四、会话五的耗时分解（`web_1789480157513`，V172 前半上的第一次真实使用）

来源：`UX_TEST_v0.9.0.md` §四与主会话打点。

| 项 | 数 |
|---|---|
| 模型调用 | 16 次 |
| 连接器调用 | 66 次（AMiner 参与 26 次） |
| 总墙钟 | **1363s** |
| 其中 · 精读卡 8 张 | **1001s**（`moonshotai/kimi-k2.6` 每张 48–205s） |
| 其中 · 综述 / review | 292s |
| 其中 · summarize | 68s |
| 检索 | 6 条查询 → **85 篇入库** |
| PDF | **2/8**（`not_a_pdf` 3、`http_403` 2、`network_error` 1） |

同批的另外两组实测数字：

| 数 | 值 |
|---|---|
| U44 修后本轮最大单次输入 token | **2,266**（修前 129,865） |
| V172 search 模式真网络冒烟 | 45s 入库 16 篇 |
| V172 review 模式真冒烟 | 614s：1 查询 → 6 篇 → PDF 0/3 → 3 张精读卡 → 综述 artifact `b3243824…`，引用 3 条全在库内、库外 0 |

这张表就是 `DEVELOPMENT_PLAN_v0.10.md` §1.2 的来源：**73% 的墙钟花在逐篇串行的精读上，而这一批 PDF 只命中 2/8**——即「用全文级成本做摘要级的事」，S9（两档综述 + 批量预筛）与 S3（精读并行）因此排在最前。
