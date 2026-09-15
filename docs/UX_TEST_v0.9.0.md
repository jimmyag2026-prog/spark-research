# v0.9.0 用户体验测试 · 2026-09-16 起

> 谁：项目 owner 本人，第一次以「普通用户」身份用 v0.9.0。
> 在哪：本机 `http://127.0.0.1:4321`（源码 `~/Desktop/AI4S/spark-research` main@16c0605，v0.9.0）。
> 怎么记：每做一件事记一行——做了什么 / 期望 / 实际 / 感受（一句话）。问题不在这里展开，转成 `USAGE_LOG.md` 的 U 条目（**从 U38 起**），这里只留编号。
> 监控：主会话在后台盯台账 `usage.jsonl`、`state.json`、server 存活；失败、预算闸、超过 120s 的调用会被推送提醒并补进本表「监控侧观察」。

## 一、准备（做完打勾）

- [x] 新建自己的项目（当前在 `spark`）
- [ ] ~~新建自己的项目~~（不要用 `a8-*` / `t*-r*` / `speed-probe` 这些验收产物）
- [ ] 设置 ▸ 通用：确认 `defaultModel`（现在 `z-ai/glm-5.3-flash`）；想快可换 `deepseek-chat`
- [ ] 设置 ▸ 检索源：勾选真正要用的源
- [ ] 设置 ▸ 凭据：给要用的连接器填 key（AMiner / Semantic Scholar…）

## 二、体验记录

| # | 时间 | 做了什么 | 期望 | 实际 | 感受 / 问题编号 |
|---|---|---|---|---|---|
| 1 | 09-15 11:31 | 网页端 chat：「帮我下载关于 mRNA 最新的研究综述论文吗？和 AI 主题相关的更好」（项目 `spark`，session `web_1789471590880`） | 拿到几篇综述 + PDF | **0 篇 0 PDF**。模型拆成 7 步手搓 connector：PubMed 30s 超时、arXiv 429、Europe PMC 返回空壳、两个 code 步骤读不到前一步产物、子代理崩 TypeError。用时约 46s，2 次 LLM 调用 | 模型的交代是诚实的（没编论文），但**平台把三次连接器失败都记成了 ok**。→ U38 U39 U40 U41 U42 |
| 2b | 09-15 20:0x | 问：查论文时会不会用到 AMiner | 会 | **不会**。`searchSources` 里没有 aminer（虽然它的凭据已配）；清单里的 semanticscholar 反而没凭据。显式 `--sources aminer` 能查，但 9 条结果没一篇与 mRNA 有关 | 配置面把「配凭据」和「勾选源」当成两件无关的事 → U43 |
| 4 | 09-15 21:45 | **热更新 V172**：chat 文献需求改走真流程（关键词拆解 → 多源检索 → 入库 → PDF → 精读卡 → 综述+引用核验） | 问「RSI 中美进展」能拿到真论文与综述 | 门禁 5/5；search 模式真网络 45s 入库 16 篇；review 模式真冒烟见监控表 | 服务已带此重启；其余 11 技能未接（V172 残余） |
| 3 | 09-15 21:21 | 第三次 chat「RSI 中美进展」（session `web_1789477865031`，模型解读为 Recursive Superintelligence） | 拿到中美对比 | **U47 生效**：OpenAlex/Crossref/EuropePMC 4 次检索成功；arXiv 3 次超时/429。但 summarize 只见 `meta.count`（U48），聚合代码 glob 到 496 个仓库 JSON、0 条（U41）→ 无数据草稿 | → U48 已修、U41/V171 已做路线① |
| 2 | 09-15 19:5x | 对照：CLI `lit search "mRNA vaccine machine learning review" --project spark --limit 5` | 同上 | **26s 出 5 篇，全部有 OA PDF**，零 LLM 调用；如实标注 biorxiv 空响应失败 | 同一需求，成熟管线一条命令就成了 → U42 |

## 三、建议走一遍的路径（不必全做，做了就记）

1. chat：问一个你真关心的科研问题，看等待期的进度提示、回复质量、用时。
2. co-explore：同一话题产出 Idea 卡，看反面证据有没有。
3. 文献：`lit search` 入库 → 精读卡 → 综述 → 引用标红情况。
4. 设置面：改一个配置 → 刷新还在不在；填一个假 key → 页面/响应里搜不到。
5. 用量：`usage --project <slug> --json`，看花了多少、有没有失败、errorKind。
6. 断网/换模型/预算闸：故意触发一次失败，看界面多久报错、报得清不清楚。

## 四、监控侧观察（主会话填）

| 时间 | 项目 | 事件 | 说明 |
|---|---|---|---|
| 11:32:10 | spark | 连接器 pubmed **timeout**（30s） | 事后复测 3 次：0.8 / 0.9 / 1.1s，直连 NCBI 正常 → 当时是上游瞬时抖动，**不是配置或代理问题**（`httpTimeoutMs=30000`、polite 头 `tool=spark-research&email=…` 都正确） |
| 11:32:11 | spark | 连接器 arxiv **429** | 已登记 U27 / V165（arxiv 持续限流），本次复现 |
| 11:32:13 | spark | 连接器 europepmc 200 但空壳 | 模型的查询语法（`SRC:MED OR SRC:PPR` + `sort`）让 EPMC 返回 `{"version":"6.9"}`，无 hitCount → U40 |
| 11:31–11:32 | spark | 2 次 LLM 调用（plan 3504 tok / summarize 883 tok），$0.0009 | 无失败、无闸拒 |
| 09-15 20:30 | spark0915 | 新建项目并切为当前项目 | 用户本轮测试开始；server 已切到含 U38/U39/U40 修复的 `fix/ux-U38-U40` |
| 09-15 20:34 | spark0915 | **COST 告警**：一次 `chat:subagent` 输入 129,865 token / $0.058 | 三次 `lit_search` 把 384 KB 原始 JSON 塞进对话历史；单价没问题，是返回体不摘要 → **U44 / V174** |
| 09-15 20:34 | spark0915 | 监控脚本自身崩了（f-string 转义） | 真出错时反而不报——已重写并实跑验证；教训：监控的失败分支必须先跑一遍 |
| 09-15 21:13 | spark0915 | LONG ×2：主路径 chat 单次输出 6704 / 7040 token（glm-5.3-flash） | 都在 plan/summarize 阶段；正是基线里「墙钟七成花在生成输出」的现象。不是缺陷，归 v0.10「各阶段设 maxTokens」（BACKLOG V172 同批） |
| 09-15 21:46 | r6-probe | **V172 review 模式真冒烟**：1 条查询 → 6 篇入库 → PDF 0/3（无 OA）→ 3 张精读卡（按摘要）→ 综述 artifact `b3243824…`，引用 3 条全在库内、库外 0 | 用时 614s（4 次 LLM 调用 + 检索 45s）。**如实交代**：blended 排序把两篇心血管指南混进「prevention」命中，精读卡没挡住、综述照引——④「确认哪些有用」目前只产卡不筛卡，下一步让 `relationToProject` 判无关即剔除 |
| 09-16 | — | **U38–U40 · U44–U47 已修并带门禁**（`tests/unit/ux_window.test.ts` 7 describe / 25 条；十一条阴性对照实跑变红，其中一条反过来抓出门禁自身只钉内容不钉接线） | 见 `docs/devlog/UX-window-fixes.md`；U41 U42 U43 登记为 V171–V173，不在本窗口做 |

## 四·补 · 使用中提出的需求（原话记录）

| 时间 | 需求 | 现状核实 | 去向 |
|---|---|---|---|
| 09-15 20:31 | 「在 chat 里之后要设置为可以调用 skill 做任何任务」 | chat 的 `skill` 任务只 `return skillContextFor(name)`（`orchestrator.ts` `case "skill"`），从不执行；13 个成熟技能在对话里等于不存在 | **V172 已按此重写**（甲子代理路线 / 乙直调路线，倾向甲+乙混合；前置是技能执行入口盘点表）。v0.10 首批 |

| 09-15 21:25 | 「现在是否调用了 skill？基础思路：关键词拆解 → AMiner 等平台检索取 DOI → connector 下载 → 读取确认 → 综述总结」 | 仍未调用：`case "skill"` 只加载上下文。五步在 CLI 里已齐（`lit search/add/pdf/read/review`），缺关键词拆解与接进 chat | **V172 验收口径已按此写定** |

## 五、总结（用完再填）

- 最卡我的第一件事：
- 最好用的一件事：
- 下一版最想要的一件事：
