# v0.10 开发方案（定稿 v1，2026-09-16）· 回复速度 + 中间过程流式可见 + 文献流程补完

> 前身：2026-09-15 深夜草案（同名文件），用户 2026-09-16 拍板「制订 v0.10 的开发方案，把今晚测的问题优先解决，如果容量可以的话再加上 backlog 里其他的」。
> 真源数字：`docs/devlog/R6-baseline.md` §机制解释、`A8-baseline.md`、`UX_TEST_v0.9.0.md`、`devlog/UX-window-timeline.md`。
> 纪律沿用 v0.9：lane 各自 worktree、枢纽文件收口专属、lane 自报数字不采信、**先 commit 再做阴性对照**、删 worktree 前查后台进程。

## 〇、决定（不再重议）

1. **主题**：一句话问题 P50 从 ~110s 压到 ≤ 20s；文献流程从 5.5 min（U50 后）压到 ≤ 3 min；全程中间产物上屏。
2. **优先级 = 今晚（2026-09-15 本地使用窗口）实测撞到的先做**：它们每条都有现场证据与数字，不是推测。
3. **S4 已在 v0.9.1 落地**（每源 8s deadline + 429 冷却，`a59d138`/`db28d7f`），v0.10 不重做，只补按 host 的令牌桶与 Retry-After。
4. **两档综述（S9）是本版第一个功能点**：第五/六次会话证明精读默认走了「全文级成本做摘要级的事」。
5. **流式协议只增不改**：`start/progress/delta/result/done/error` 六种保留，新增 `partial`，`progress` 补 `ts/elapsedMs/etaMs`，`delta` 补 `target/revision`。
6. 直答路径（S1）的分类判据**规则优先、模型兜底**（AD-8：模型判断之外要有规则层），误判可由用户在选择器强制「研究模式」。
7. 发布 DONE 仍含「CI 结论 = success」与「R7 基线复测」两条硬门。

## 一、时间花在哪（实测，定稿沿用）

| 场景 | 总墙钟 | 主导 | 证据 |
|---|---:|---|---|
| 一句话 chat | 109.6s / 4 调用 / 8590 输出 tok | 78% 是模型生成输出 | R6-baseline §机制解释 |
| 文献流程（kimi 精读） | 1363s | 精读 ×8 串行 1001s（73%） | 会话五 `web_1789480157513` |
| 文献流程（deepseek 精读，U50 后） | 330s | 检索 137s（arXiv 429/超时拖住）· 精读 48s · 综述 20s · 汇总 59s | 会话六 `web_1789482658926` |
| 感知 | — | `delta` 只接汇总；前端一个 spinner；U49 后才有阶段文案 | UX_TEST 第五次会话 |

## 二、W10-0 · 先测再改（主会话，1 天）

- `scripts/measure-chat.ts --pipeline`：对文献流程按阶段打点（search / download / read / review / summarize），输出与 §一 同形状的表 → **v0.10 基线**。
- 并发安全实测：3 路并发打 deepseek-v4-flash / openrouter 各 20 次，记 429 次数 → 定 S3 的 `concurrency` 默认值。
- arXiv 限流复测：冷却 10 min 后 1 req/3s 连打 10 次，记 429 出现位置 → 定按 host 令牌桶参数。
- 没有这三个数不开 W10-1。

## 三、五条 lane（W10-1，并行，各自 worktree）

### α · 速度工程（后端 `literature/`、`agents/literature_pipeline.ts`、`llm/`）
| 项 | 内容 | 来源 | DONE |
|---|---|---|---|
| α-1 **S9 两档综述 + 批量预筛** | `depth: "quick"\|"deep"`；quick = 全部摘要一次调用出综述（引用库内 key，走同一个 citationIntegrity）；两档前先一次便宜调用给候选打相关性、留 top-K | 用户追问「为什么精读要这么久」；V172 残余「④只产卡不筛卡」 | 摘要级任务 ≤ 2 次调用；预筛把明显无关（如「prevention」混进的心血管指南）剔除，门禁用真实会话样本 |
| α-2 **S3 精读并行** | `generateMany` 加 `concurrency`（W10-0 定值，预期 3） | 会话五精读 1001s | 8 篇 deep 精读 ≤ 150s；预算闸并发下不被打穿（A7 口径复测） |
| α-3 **S2 各阶段 maxTokens** | plan ≤ 600（紧凑 JSON，解析失败重试一次更小提示，**不退默认计划**）、analysis ≤ 900、summarize ≤ 1200、卡 ≤ 700、综述 ≤ 2500 | 全链路无一处 maxTokens | 输出 token 总量下降 ≥ 40%（基线对比） |
| α-4 **S10 全文命中率** | `not_a_pdf` 时解析落地页一跳（`citation_pdf_url` / `<link rel=alternate type=pdf>`）；`pdfUrl` 失败后按 DOI 查 Unpaywall；OpenAlex OA 标记标「乐观」 | U51：8 篇标 OA 只拿到 2 | 同一批 8 篇 ≥ 5 篇；技能文档「目前不做的两跳」段删掉 |
| α-5 按 host 令牌桶 + Retry-After | `http/ratelimit.ts` 给 arxiv 3s 间隔、尊重 `Retry-After`；PDF 直链与检索共用一桶 | U55 探针：3s 间隔第二次仍 429 | W10-0 复测下 10 次 ≥ 8 次 200 |

### β · 流式可见（`agents/progress.ts`、`routes/session.ts`、`agents/literature_pipeline.ts` 回调）
| 项 | 内容 | DONE |
|---|---|---|
| β-1 `progress` 补 `ts/elapsedMs/etaMs` | emitter 记 startedAt 与阶段均值；eta 拿不准不给 | 事件 schema 门禁 + 前端能显示耗时 |
| β-2 `partial` 事件 | `papers`（检索一回来就推候选清单）、`search_source`（每源 ok/failed/timeout/skipped + 条数）、`card`（每张卡完成推标题 + 一句 keyFindings + 是否相关） | e2e：检索完成 ≤ 10s 页面出现论文标题 |
| β-3 `delta.target/revision` | 综述、精读卡也流式；重试时 revision +1 前端清空重画 | e2e：综述正文逐字出现 |
| β-4 取消 | `/stream` 断开 → `AbortSignal` 透传 LLM 与连接器（V156 ③） | 断开后 5s 内台账不再新增行 |

### γ · 文献质量与配置面（`literature/`、`connectors/`、`routes/settings/`）
| 项 | 内容 | 来源 | DONE |
|---|---|---|---|
| γ-1 V173 凭据 ↔ 检索源关联 | 检索源面板每行显示凭据状态与「本次会不会真查」；凭据写入后若未勾选给可执行下一步 | U43（aminer 配了 key 不在清单） | e2e |
| γ-2 V161 AMiner 检索质量 | 中文主题词先抽/英译再查；零摘要结果标 `abstract: null` 精读跳过 | T3 0/8 | T3 复跑 ≥ 2/8 |
| γ-3 V175 上游 200-带错形状盘点 | 逐源核 `errCode`/`error` 形状，`upstreamErrorOf` 改显式表 | U45 残余 | 每源一条门禁 |
| γ-4 V172 后半：技能执行入口盘点表 | 13 个技能各自「执行入口 / 所需 grants / 是否有程序化实现」，产出表后按乙（直调）/甲（子代理）逐个接 | 用户「chat 要能调用 skill 做任何任务」 | 表入库 + 至少再接 3 个技能（paper-download、research-report、novelty-check） |

### δ · 运维与卫生（`doctor/`、`config/`、CLI、任务书）
| 项 | 内容 | 来源 |
|---|---|---|
| δ-1 V157 验收产物归档 | `project archive` 批量 + 指针落在归档项目时跳到最近活动项目；任务书加「跑完归档」 | U14/U36，工作台默认停在 speed-probe |
| δ-2 V160 + V162 doctor | 探 4321 + 配置端口 + `--port`；「前端未构建」问实例不问 cwd | U24/U33、U16 |
| δ-3 V163 / V169 / V170 文案与文档 | `config list` 省略号；`data import` 文案；T5 第 13 步端点 | 低成本合并做 |
| δ-4 V156 ①② 裁定落地 | 同步 `/api/session/chat` 超阈值改 202+任务句柄；脚本与 UI 一律 `/stream` | U13 |
| δ-5 V167 TTY 门核实 | pty 包装下 `lab approve` 全流程实测，据结果改文档措辞 | A8 U31 |

### ε · 前端（`frontend/**`）
| 项 | 内容 | 来源 |
|---|---|---|
| ε-1 阶段条 + 实时日志 + 流式正文三段 | 消费 β 的全部事件；「停止」按钮 | 本版主题 |
| ε-2 V158 / V159 / V166 | 执行段计数进度（已由 U49 部分覆盖，补 `taskStarted`）；设置项 422 行内显示 `message + nextStep`；BudgetInput 说明「本项目累计上限」 | R6 |
| ε-3 V168 令牌计数实时读 | 权限面板 | A8 |
| ε-4 文献列表二期 | 精读卡里抽真关键词进列表（U56 现在显示的是 tags）；PDF 未下载时行内一键下载 | U56 残余 |

## 四、容量外（本版明确不做，登记留着）
V120（偶发 locked，不销号）· V124 / V129（复核不成立，存档）· V131 / V133 / V146 / V155（门禁与契约小项，等下个门禁批次）· V164（请求级日志，等有第二个需要它的场景）· V165 的 biorxiv 半边（上游）· V176（CNKI/万方真渠道，等外部输入）· V174 已由 U44 关闭（BACKLOG 状态本版补标）。

## 五、收口顺序
W10-0 → 五 lane 并行（α 先出 S9 让 β 有东西可流）→ 收口 `integration/v0.10-w1` → alpha.1 → **R7**（T1–T5 复跑 + `--pipeline` 基线复测，零上下文）→ 修复窗口 → alpha.2 → **A9** → v0.10.0。

## 六、DONE（全满足）
- [x] 一句话 chat P50 ≤ 20s（S1+S2），文献流程 quick 档 ≤ 90s、deep 档（8 篇）≤ 3 min——A9：chat P50 4.4s（R7 35.1s）· quick 61.5s · deep(8 候选) 131.6s；发布前主会话复现 deep 165.7s
- [x] 检索完成 ≤ 10s 页面出现论文标题；精读每完成一张页面多一行；综述正文逐字出现——管线内 partial(papers) 8.0s；发布前主会话真 /stream 复现 partial(card)×6、delta(card/review)；e2e 60 绿。**如实**：用户视角首条标题落地 24–49s（plan 那次调用挡在前面）
- [ ] 同一批 8 篇 OA 论文 PDF ≥ 5 篇（S10）——**未达**：A9 3/8（R7 1/8），失败全是出版社 403（ScienceDirect / OUP / 机构仓储），留 v0.10.x
- [x] 断开 SSE 后 5s 内台账不再新增行（V156 ③）——R7、A9 各一次实测增量 0
- [ ] AMiner 参与与否在检索源面板一眼可见（**已做**，四态现场验到）；T3 复跑 ≥ 2/8——**未达**：R7 0/8，γ-2 英译层跑了但没抬起召回，留 v0.10.x
- [x] V172：技能盘点表入库，chat 可执行技能 ≥ 5 个——A9 在 chat 里逐个真执行 5 个
- [x] 验收产物归档，工作台默认不再打开验收项目——R7/A9 收尾各归档一批，指针 spark0915
- [x] R7 与 A9 的 P0/Blocker 全部关闭，且每条经主会话独立复现——U66/U67（alpha.2）A9 复核关；U71/U72（alpha.3）主会话在 alpha.3 真 server 上复现关
- [x] CI 对 v0.10.0 tag 的结论 = success（release.yml run 35052011541 success，3 个 assets）

## 七、不做
换 message loop 架构 · 一次接完 13 个技能 · 引入新前端框架 · 再做上游对比。
