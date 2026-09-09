# P8 · 功能收口（devlog）

> 分支：`feat/p8-wrapup` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)「P8 收口发布 v0.2」+ [BACKLOG.md](../BACKLOG.md) 的 P8-gate 七项（G1–G7）
> 设计依据：[DESIGN.md](../DESIGN.md) §7 发布判据、域 E1/E2、域 C2

---

## 一、P8-gate 逐条结果

### G1 结论卡 review 门槛（域 E2）✅

新模块 `backend/src/conclusion/`（models / store / reviewer / cli）。

- **结论卡结构补全**：P5/P6 只落了 `metadata.review = "pending"` 一个裸字符串。P8 把它升级成
  可审计的评审记录：`{ state, at, actor, actorSource, hardCount, softCount, findings, reason, decisionRecordId }`。
  `parseReviewStamp` 同时吃两种形态，**没有数据迁移**。
- **解析不了一律落回 `pending`**：一个读不懂的 review 字段绝不能被当成 approved。这条写进了测试
  （`parseReviewStamp({state:"banana"})` → pending）。
- **判定规则不可协商**：任一 hard finding → `vetoed`，零 hard → `approved`。**不提供**「人工推翻 hard」
  的路径；反方向提供 `--veto`（人挡下一条本来会自动通过的结论，理由必填）。
  理由见「二、关键决策 D1」。
- **每次评审落一条 `decision` record**（`kind=conclusion_review`，`derives_from` → 结论卡），
  记谁、何时、判了什么、依据哪些 finding。CLI 落 `$USER` 时 `actorSource=env:USER`；
  HTTP 缺 actor 直接 400 并记 `http:explicit`（AD-6 的 P7 补充）。
- 三个入口：`spark-research conclusion list|show|review`、`GET/POST /api/conclusions*`、
  工作台「结论」页。`show` 顺带跑一次**不落库**的 `assess()`，回答「现在重新评审会是什么结果」。

### G2 数据-结论一致性检查器（域 E1）✅

`backend/src/reviewer/conclusion_rules.ts` 的 `dataConsistency`。

| 情况 | 严重度 | 理由 |
|------|--------|------|
| 结论卡零证据 | hard | 这不是结论，是主张 |
| 引用的 observation 在本项目里不存在（伪造 / 已删除） | hard | 读者无法核对 |
| 引用的 record 属于别的项目 | hard | 同上；有 `foreign` 解析器时把「它其实属于项目 X」写进 finding |
| 引用的 record 不是 observation（idea / paper / 另一条 conclusion） | hard | 结论的数据支撑只能是观察记录 |
| observation 没有 runId 与 experimentId 锚点 | soft | 手工登记的观察是合法的，但要被看见 |
| 证据图上没有 `derives_from` 边 | soft | 数据本身没问题，但顺着图走不到它 |

对抗用例四发（`tests/unit/conclusion_rules.test.ts`）：伪造 id、已删除 record、跨项目引用、
拿 idea 当数据。**「已删除」用的是一个查不到该 id 的 lookup 而不是真删** ——
`RecordStore` 没有 `delete`，证据不可删是有意的设计，这里如实注明。

### G3 统计合理性 soft 提示（域 E1）✅

`statsPlausibility`，**只出 soft**，每条 finding 带 `heuristic: true`。

| 启发式 | 触发 |
|--------|------|
| `small_sample` | 文本里出现的最小样本量 < 6（识别 `n=3` / 样本量 3 / 重复 4 次 / 3 replicates） |
| `multiple_comparisons_uncorrected` | 声明了多组比较或出现 ≥3 个 p 值，且没提任何校正方法（Bonferroni / Holm / FDR / …） |
| `marginal_p_value` | 出现 p ∈ [0.04, 0.05] 的**观测值**（`p < 0.05` 是阈值声明，不算） |
| `overclaim_vs_evidence` | claim 里有因果/普适断言，且证据基础弱（样本小 / 只有 ≤1 条 observation / 来自模拟 / p 边缘） |

样本量与 p 值经常写在 observation 正文里而不是 claim 里，所以检查器同时吃 evidenceText。
带阴性对照：「在 n=30 的样本上观察到…（p=0.002）」→ 零 finding，不制造噪音。

### G4 能力位消费端 ✅

`capabilityLabeling` + 报告措辞两处一起落。

- `simulated=true` 的 observation 被引用、而 claim/limitations 里没有任何模拟标注 → **hard**。
  这一条是 P6 验收批注 R2 的直接兑现：Opentrons 的 0.0 读数不得当真实实验数据进结论。
- `deterministic=false` 的证据 + 「逐位/完全一致」的措辞 → **hard**。
  匹配模式刻意收窄：「可复现」「可重复」不算（那在随机平台上照样成立，靠的是区间对账）。
- `reconciliationMode()` 是**报告与检查器共用的口径真源**：
  全部确定性 → `bitwise`（逐位重算对账）；任一非确定性 → `interval`（区间/趋势对账）；
  没带能力位 → `unknown`（不做承诺）。混合证据取最保守的一条。
- 报告里：结论标题挂 `[模拟数据]`、逐条证据挂 `[模拟执行 · 非确定性平台]` 标签、
  附一句「模拟器验证的是协议在协议引擎里是否合法，不验证生物学」。

### G5 模式 B 真实模型判准率测量 ✅（已测量，结果见下）

`scripts/measure-citation-judge.ts`，**不进 CI 默认路径**。

- **模型**：`moonshotai/kimi-k2.6`（经 OpenRouter，本机 `OPENROUTER_API_KEY`）
- **temperature**：0.2（`LLMRouter` 对两条 provider 路径都固定发 0.2，脚本不覆盖）
- **用例**：8 篇文献 × 3 档 ×（1 真 + 1 假）= **48 条**。难阴性与正例等量——
  误报噪音比漏报更致命，它会训练用户忽略这类告警
- **口径**：正类 = 与精读卡冲突，期望 `conflict`；`unclear` 归到「不报」一侧
  （prompt 明写「拿不准就 unclear」），所以正类判成 unclear 记 FN、负类判成 unclear 记 TN；
  调用/解析失败的用例**不进混淆矩阵**，单列 errors——「没测成」与「判错了」必须分开

三档设计：

| 档 | 考什么 | 例子 |
|----|--------|------|
| easy | 结论方向被说反 / 卡片写明的局限被说成成果 | 卡片「对复合物界面预测较弱」→ 草稿「界面精度同样达到原子级」 |
| medium | 数值与条件口径被篡改，方向不变 | GDT_TS 92.4 → 78.1；n=18 → 1800；11 个任务 → 27 个；10 分钟 → 10 秒 |
| hard | 语义细微偏移 | 条件结论→普适、并列→因果、子集→全体、凭空归因 |

**结果（5 次独立运行，每次 48 条）**：

| 档 | 样本/轮 | precision | recall | 说明 |
|----|---------|-----------|--------|------|
| easy | 14–15 | **100%**（5/5 轮） | **100%**（5/5 轮） | 无一误报、无一漏报 |
| medium | 15–16 | **100%**（5/5 轮） | **100%**（5/5 轮） | 数值篡改全部抓到，包括「把英法的 BLEU 安到英德上」这种同量级替换 |
| hard | 15–16 | **100%**（5/5 轮） | **71.4% – 100%**（中位 ~87%） | 漏报集中在两个固定模式，见下 |
| overall | 45–47 | **100%** | 90.9% – 100% | — |

**precision 在所有档、所有轮次都是 100%**：约 90 次阴性判定里**零误报**。
这对一个「只提示不否决」的 soft 检查器是最关键的性质——它不制造噪音。

难档的漏报是两个**稳定复现**的模式，不是随机波动：

1. **「凭空归因」被判 `unclear`**（jumper hard）。草稿说「精度提升主要来自 MSA 深度而非网络结构」，
   卡片对此只字未提。prompt 写的是「声称了卡片里明确没有的结果 = conflict」，
   模型读成「卡片没覆盖 → unclear」。**两种读法都讲得通，这是 prompt 的歧义，不是模型的错。**
   → BACKLOG **V13**（改口径前要先想清楚：收紧会不会把合法的概括也扫进来，那正是 P3 刻意避免的误报）
2. **「线性评估结果 → 不再需要标注」被判 `consistent`**（chen hard）。模型认为这是
   「对核心结论的合理概括」。这条确实站在 conflict/consistent 的边界上——我标它为 conflict，
   是因为「不再需要标注数据」是立场性论断而非卡片里的事实。**如实记录这个分歧。**

**另一个真发现（不是判准率问题）**：每轮有 **1–3 条（2–6%）判定失败**，失败签名统一——
模型只吐了一段思维链正文，`content` 里始终没有 JSON。`finish_reason` **不是** `length`，
所以不是截断，是模型没按格式说话。

这类失败的既有行为是安全的（降级成可见的 `citation_judge_unavailable` soft finding，
不假装通过），但对用户来说就是「这条引用本轮没被检查过」。P8 当场做了两件事：

- `LlmCitationJudge` 解析失败时带上一轮输出 + 「只输出 JSON」的指令**重试一次**；
  调用本身失败（没 key / 上游报错）**不重试**（重试解决不了没有凭据）
- `LlmResponse` 增加 `finishReason`，错误消息区分「输出被截断」与「输出里没有可解析的 JSON」——
  两种病要往不同方向修，混在一条消息里会让人修错地方

重试**治标不治本**（重试后仍有 2–3 条失败）。根治要 JSON mode / structured output →
BACKLOG **V12**。

### G6 删除 deprecated 的 `compute/providers.ts` ✅

`backend/src/compute/` 三个文件（`providers.ts` / `manager.ts` / `job_manager.ts`）+
`tests/unit/compute.test.ts` 一并删除。三者互为唯一调用方，测试也只有一处。

引用残留核对：只剩 `simulation/platform.ts` 与 DESIGN §B1 里两处**说明性注释**
（「为什么另起契约」），已改成过去时并注明模块已删。测试 655 → 643（-12，全部是被删模块的
v0.1 测试）。

### G7 研究报告导出 + research-report 技能 ✅

`backend/src/report/export.ts` + `report/cli.ts` + `server/routes/report.ts` +
`skills/research-report/SKILL.md`（第 10 个技能，凑齐 DESIGN §5.3）。

报告分区：一、问题（项目描述 + idea 卡的 openQuestions + 文献基础统计）／二、思路／三、实验／
四、结论（**只有 approved**）／五、待验证（pending 与 vetoed，逐条列出阻塞它的 hard finding）／
附录 A 证据索引／附录 B 参考文献。

三条不可让步的口径（都有测试守着）：

1. **正文由代码渲染，不经过模型。** 让模型写报告等于给它一次改数据的机会。
2. **门槛看卡上已落的 review 状态，不看「现在跑一遍会通过」。**
   有一条专门的测试：一张检查器全过但没人评审的卡，`approvedConclusions` 必须是 0，
   并且报告要告诉读者「跑一次 `conclusion review <id>` 就能进结论区」。
3. **附录索引里的每个 record id 都必须解析得到**（不许有幽灵条目）。

出口：`spark-research report export [--out] [--verbose] [--json]` / `report stats`、
`GET /api/report[?format=markdown]`（带 `Content-Disposition` 文件名）、工作台顶栏「导出报告」按钮。

---

## 二、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | **不给「人工推翻 hard finding」留路**，只给反方向的 `--veto` | 三条 hard 全部是**可核对的事实判断**（证据不存在 / 类型不对 / 模拟数据没标注 / 在随机平台上声称逐位复现），不是审美问题。留一个「我看过了没事」的按钮，等于把门槛变成摆设——而这个产品的卖点就是证据可信。要放行就去补证据或改结论 |
| D2 | 结论卡的 review 字段做**向后兼容解析**而不是数据迁移 | P5/P6 已经在真实项目里落了裸字符串形态的卡。迁移脚本要处理「跑到一半失败」，而兼容解析是零风险的；代价只是 `parseReviewStamp` 多十几行。解析不出来一律落回 `pending`，最坏情况是「要重新评审一次」，不会出现「被误当成 approved」 |
| D3 | `stats-plausibility` **只出 soft**，且明确自称启发式 | 它不是统计审稿人。样本量、多重比较这些判断要吃实验设计上下文，正则匹配到的只是文本表象。让它出 hard 会制造大量误杀；出 soft 且标 `heuristic:true`，用户知道该用什么力度看它 |
| D4 | 三个新检查器**豁免位置加权**（沿用 P3 的 D3 口径） | 结论卡正文是 markdown，位置加权会把 figure/report 里的 soft 全升成 hard，直接毁掉 D3 的语义。这是第二个例外了——P3 说「有第二个例外再考虑白名单制重构」，现在到点了，登记给主会话定夺（见「六、审查重点」） |
| D5 | 报告的「问题」一节用**项目描述**，不新增 record 类型 | DESIGN C1 的 8 类是定死的口径。「研究问题」本来就是建项目时写的那句话；为它加第 9 类 record 的代价大于收益。idea 卡的 `openQuestions` 补充「待回答的问题」 |
| D6 | 演练脚本走**真正的 CLI 入口**，不绕过 CLI 直接调模块 | 判据 1 要证明的是「用户敲这些命令能走通」。直接调内部函数能让脚本更短，但那样它就只能证明「内部函数串得起来」——CLI 层的参数解析、退出码、JSON 输出形状全部没被验到 |
| D7 | 版本号收敛到 `package.json` 单一真源 | `/api/health` 此前硬编码 `"0.2.0"`，而 `package.json` 还写着 `0.1.0`，两处不一致没有任何东西会报警。加了一条对照测试当报警器 |

---

## 三、发布判据核验（DESIGN §7 四条）

### 判据 1：一条真实研究线索完整走通 ✅

做成了**可重放脚本** `scripts/demo-research-thread.ts`，CI 入口 `tests/unit/demo_thread.test.ts`。

```
$ bun scripts/demo-research-thread.ts
✅ ① 提出问题 — 端到端方法能否在不引入循环结构的前提下做好序列转导？
✅ ② 文献调研入库 — 10 篇论文，bibtex key 已分配
✅ ③ 精读卡 → 综述 — 综述草稿的引用全部落在库内（citation-integrity 通过）
✅ ④ Co-explore 出 idea — idea e554b472（带支持与反对文献）
✅ ⑤ novelty check — 已发表工作被正确评为 checked-overlap（不是「查不到就算新颖」）
✅ ⑥ 干实验闭环 — pyref 真跑 → observation 8f813aa4
✅ ⑦⑧ 结论卡 → review 门槛 — 伪造证据的结论被否决，证据齐备的通过（各一条对照）
✅ ⑨ 导出研究报告 — 1 条结论 / 1 条待验证 · 引用 9 条 record
全部 8 步通过。
```

脚本自带断言，不放水：novelty 必须把已发表工作评成 `checked-overlap`；结论门槛**同时演两个方向**
（伪造证据的必须被否决、证据齐备的必须通过）；被否决的结论不许出现在报告结论区；
observation id 必须出现在报告里（证据链不许断）。

浏览器版由 Playwright ①–⑫ 覆盖同一条链路（P8 新增 ⑪ 评审门槛全链路、⑫ 导出下载）。

**一处与设计的偏差**：DESIGN §7 判据 1 写的是「干实验（OpenMM）」，演练脚本用的是 **pyref**。
理由：CI 不能依赖 openmm 装没装，而 pyref 零依赖、秒级、确定性。OpenMM 走的是**同一套契约测试**
（`tests/unit/simulation_contract.test.ts`，两个实现共用），并在 P5 devlog 里有真实 MD 任务的记录。
这个替换不削弱判据要证明的东西（闭环通不通），但把它写下来。

### 判据 2：湿实验路径 ✅

`tests/unit/wet_e2e.test.ts`：两类协议（OD600 测定 / 连续稀释）在**真** `opentrons.simulate`
下执行，自然语言 → 编译 → 安全门 → approve → 模拟执行 → observation 全链路。
安全门 4 条规则的对抗矩阵在 `tests/unit/lab_safety.test.ts`。
浏览器版由 Playwright ⑦⑧⑨ 覆盖（含「未批准不能执行」与「approve 弹窗必须填 actor」）。

本轮复验：`bun test tests/unit/` 全绿，其中 `wet_e2e` 是真模拟器执行，不是 mock。

### 判据 3：测试基线只增不减 + 每技能有 e2e + CI 全绿 ✅

```
bun run typecheck                 clean（后端 + 前端各一次）
bun test tests/unit/              711 pass / 0 fail / 3142 expect · 46 files
bun test tests/integration/       8 skip / 0 fail（3 files；这些是**录制**用例，
                                  只在 SPARK_RECORD=1 时跑真实网络，CI 里按设计全 skip）
.venv/bin/python -m pytest tests/ 48 passed
bun run test:e2e                  12 passed（Playwright，含 P8 新增 ⑪⑫）
```

基线轨迹：84（v0.1）→ 655（P7 收尾）→ **711**（P8）。

中途有一次**授权的减少**：G6 删除 v0.1 `compute/` 模块时连带删掉它的 12 条测试
（655 → 643），这是 BACKLOG G6 明文授权的清理，不是基线倒退。此后 643 → 711（+68）。

每技能 e2e 对照（AD-5）：10 个技能的 SKILL.md 末尾「验证方式」小节都指向真实存在的测试文件；
本阶段新增的 research-report 指向 `conclusion_rules` / `conclusion_review` / `report_export` /
`demo_thread` 四个文件。

### 判据 4：文档完备 ✅

- **README 重写**：从「特性罗列」改成按五大功能域组织的工作台说明；含三个赌注、安装
  （Python 侧给的是**实际可跑**的 uv 命令，不是 `requirements.txt` 这种仓库里并不存在的东西）、
  一条完整研究线索的命令序列、能力概览、数据布局、测试入口、P9 扩展点预告
- **CHANGELOG.md**：v0.2.0 条目按 P1–P8 汇总（新增 / 变更 / 移除 / 修复），标注 tag 与 Release 在 P9
- **DESIGN.md 终稿核对**：补 C2 报告导出与 E2 review 门槛的落地口径、§7 四条判据的核验结论表、
  v0.1 资产表登记 compute 模块已删；状态行从「设计定稿待评审」改成「随实现更新」
- **devlog**：9 篇（P0–P8）
- **BACKLOG**：G1–G7 逐条标注结果；新增 V12（LLM 结构化输出）、V13（判定 prompt 对「凭空归因」的口径）

---

## 四、测试数字

| 层 | 命令 | 结果 |
|----|------|------|
| typecheck | `bun run typecheck` | clean |
| 单元/契约/回放 e2e | `bun test tests/unit/` | **711 pass / 0 fail**（46 files, 3142 expect） |
| 集成（fixture 录制） | `bun test tests/integration/` | 0 fail / **8 skip** —— 按设计：只在 `SPARK_RECORD=1` 时打真实网络重录 cassette |
| Python | `.venv/bin/python -m pytest tests/` | **48 passed** |
| 浏览器 | `bun run test:e2e` | **12 passed**（P7 的 10 + P8 的 ⑪⑫） |
| 真实模型（不进 CI） | `bun scripts/measure-citation-judge.ts` | 见 G5 |

P8 新增的测试文件：

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `tests/unit/conclusion_rules.test.ts` | 24 | G2 四种对抗 + G4 模拟未标注/逐位声明 + G3 四类启发式（含阴性对照）+ 旧形态兼容 + 渲染 |
| `tests/unit/conclusion_review.test.ts` | 15 | 门槛判定、人工否决、重新评审翻面、`assess` 不写库、id 前缀撞车、CLI 退出码 |
| `tests/unit/report_export.test.ts` | 12 | 分区归属、门槛不看「会通过」、证据可回溯、能力位措辞、空项目不崩、CLI |
| `tests/unit/server_report.test.ts` | 10 | 结论卡端点、actor 必填、vetoed 仍返 200、report JSON/markdown |
| `tests/unit/demo_thread.test.ts` | 1 | 判据 1 全链路（含真 pyref 子进程） |
| `tests/unit/citation_integrity.test.ts` | +4 | G5 发现的判定器重试与 finishReason 区分 |
| `tests/unit/ui_cli_parity.test.ts` | +1 | 结论评审两侧同形状，只有 actorSource 按设计不同 |
| `tests/unit/server.test.ts` | +1 | 版本号单一真源对照 |

---

## 五、与设计的偏差

| # | 偏差 | 处理 |
|---|------|------|
| 1 | 判据 1 的干实验用 pyref 而非 OpenMM | 已在判据 3 说明理由（CI 不能依赖 openmm 是否安装）；OpenMM 走同一套契约测试 |
| 2 | DESIGN E2 只写了「review 状态」三个值，没写谁来评、怎么落审计 | P8 补成完整的评审记录 + decision record，已回写 DESIGN E2 的「P8 落地口径」 |
| 3 | DESIGN C2 只写「按证据图组织，每条带证据链接」 | 分区、门槛在报告里的具体表现、能力位措辞都是 P8 定的，已回写 DESIGN C2 |
| 4 | `compute/` 删除范围超出 G6 字面（G6 只写了 `providers.ts`） | `manager.ts` / `job_manager.ts` 唯一的依赖方就是 `providers.ts`、唯一的调用方就是同一个测试文件；只删 providers 会留下两个编译不过的孤儿。已在 commit 与 BACKLOG 里说明 |
| 5 | 顺手修了两个不在 P8 范围里的东西：版本号不一致、判定器解析失败 | 前者是 P8 要写 CHANGELOG 时撞上的（`/api/health` 说 0.2.0、package.json 说 0.1.0）；后者是 G5 测量跑出来的真问题。都带测试，都在独立 commit 里 |

---

## 六、给主会话的审查重点

1. **D4：检查器豁免位置加权的第二个例外到了。**
   P3 决策 D3 当时的原话是「白名单制重构留到有第二个例外出现时再做」。现在
   `data-consistency` / `capability-labeling` / `stats-plausibility` 三条一起成了例外
   （理由与 P3 相同：结论卡正文是 markdown，位置加权会把 soft 全升成 hard）。
   现在的实现是「这些 rule 的 finding 不进 `applyLocationWeight`」，靠的是调用路径隔离
   （结论评审不走 ReviewerAgent 的 artifact 路径），**不是一个显式的白名单**。
   要不要现在就把它做成显式白名单，请主会话定。

2. **D1：「hard 不可人工推翻」是否太硬。**
   我认为这是对的（三条 hard 全是事实判断），但它意味着：如果某条 hard 判错了
   （比如证据确实存在但 id 写错了），用户唯一的出路是改结论卡再评审，不能「知情放行」。
   这个权衡值得主会话过一眼——尤其是 `no_evidence`（零证据 = hard）这一条，
   它会让「纯文献推导的结论卡」永远进不了结论区。

3. **G5 难档的两条漏报，以及我给的标注是否成立。**
   特别是 `chen2020simple:hard`（「线性评估接近有监督」→「无监督学习不再需要标注数据」）。
   我把它标成 conflict（立场性论断 ≠ 卡片里的事实），模型判 consistent（合理概括）。
   这条**站在边界上**，如果主会话认为模型是对的，那么难档 recall 应该是 100%/87.5% 而不是我报的数。
   标注本身是可争议的，我把分歧写在明处而不是选一个好看的数字。

---

## 七、遗留

全部登记在 [BACKLOG.md](../BACKLOG.md)，P8 新增两条：

- **V12** LLM 结构化输出（`response_format` / JSON mode）—— 根治 2–6% 的判定解析失败
- **V13** 判定 prompt 对「凭空归因」的口径 —— 难档唯一稳定的漏报模式，是 prompt 歧义

P9（扩展面与 LLM 友好化）是发布前最后一阶段，`v0.2.0` tag 与 GitHub Release 在那里打出。
