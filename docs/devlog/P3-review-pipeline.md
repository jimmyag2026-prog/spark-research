# P3 · 文献域：综述与引用核验（devlog）

> 分支：`feat/p3-review-pipeline` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)「P3 文献域 · 综述与引用核验」；设计依据：[DESIGN.md](../DESIGN.md) 域 A3、域 E1、域 C1

## 一、做了什么

### 1. 精读卡 pipeline（`backend/src/literature/reading.ts`）

库内论文 → LLM → 结构化五段卡片（研究问题 / 方法 / 核心结论 / 局限 / 与本项目关系）→ record。

- **schema 校验是硬门**：`validateReadingCardPayload` 要求三个非空字符串字段 + `keyFindings` 至少 1 条 + `limitations` 必须是数组（可空）。不合格 → 把**校验失败原因回灌**给模型重试一次 → 仍不合格就抛 `ReadingCardError`，带上失败清单与原始输出截断片段。**不落半成品 record**——半成品会成为后续引用核验的错误对照基准，比没有更糟。
- `extractJsonObject` 容忍 ```json 围栏与前后夹带的解释文字，但**不做字段级修补**：提取不出就是失败。
- 落 record：`type=observation`、`evidence=sourced`、`metadata.kind="reading_card"`，并加 `cites` 边指向该论文的 `paper` record（P2 入库时建的锚点）。生成成功顺带把库内 `reading_status` 推进到 `read`。
- `generateMany` 逐篇独立结算，返回 `failures`；CLI 把失败逐条打到 stderr，**不允许被「成功 N 张」盖过去**。
- `cardBaselineText()` 是给核验用的对照摘要，**刻意剔除 `relationToProject`**——那是对本项目的推断，不是论文的陈述，拿它判引用冲突必然误判。

### 2. 综述草稿生成（`backend/src/literature/review.ts`）

精读卡 → Markdown 草稿（`[@bibtexKey]` 引用）→ artifact + record。

- **引用白名单双保险**：prompt 层给出 key 白名单（「白名单之外的 key 一律不许出现，包括你记得的真实文献」）；生成后用 `citedKeys()` 校验，越界就带着越界清单重试一次，**仍越界则抛错且不落 artifact**。第二道保险是 `citation-integrity` 检查器，对**任何来源**的草稿都重验一遍（人写的、别的 agent 写的同样过闸）。
- 参考文献区由库内真实条目渲染，key 与 `lit export --format bibtex` 完全一致——读者可以拿 .bib 逐条对照。
- 落图：artifact record（`evidence=inferred`）+ `derives_from` 边连每张卡片 + `cites` 边连每篇被引论文。从草稿出发两跳可达原始论文 record（e2e 里断言了这条）。
- `allowUnknownKeys` 选项只给对抗测试与「先出草稿交由检查器兜底」的场景，默认关。

### 3. Reviewer 新检查器 `citation-integrity`（`backend/src/reviewer/rules.ts`）

纯函数 + 可注入判定器，零 IO，独立可单测。

| 情况 | 严重度 | 理由 |
|------|--------|------|
| key 不在库内（编造的 key / 库外真文献） | **hard → veto** | 读者无法从项目库核对这条引用 |
| key 在库但陈述与精读卡冲突 | soft（标 `inferred`） | 判定本身是 LLM 推断，单凭它否决会误杀 |
| 强断言句（证明/首次/显著优于/proves/SOTA…）无引用 | soft | 可能是常识句，也可能是漏引 |
| 判定器故障 | soft（`citation_judge_unavailable`） | 没跑成的检查必须明说没跑，不能伪装成「全部通过」 |

配套：`parseCitations`（支持 `[@a]`、`[@a; @b]`、`[@a, @b]`，跳过围栏与行内代码）、`splitSentences`、`isStrongClaim`、`isReferenceEntry`。
`LlmCitationJudge`（`backend/src/reviewer/citation_judge.ts`）把 LLM 判定隔离在单独文件，判不出来一律抛异常。

`ReviewerAgent` 加了可选的 `citations` 配置（第 4 个构造参数），不注入时行为与 P1/P2 **完全一致**（有专门的回归用例守这条）。

### 4. 技能 `literature-review` + CLI

- `backend/src/skills/literature-review/SKILL.md`：检索 → 入库 → 精读卡 → 综述 → 核验全链路，含 4 条铁律与 6 条反模式（「把『我知道这篇论文存在』当成可以引用的理由」「换个库内 key 硬凑来消掉告警」）。
- `spark-research lit read <paper-id> | --all [--tag]`、`spark-research lit review [--topic] [--out] [--no-judge]`；hard finding 时退出码 1。

## 二、对抗测试结果矩阵（退出标准）

`tests/unit/citation_adversarial.test.ts`，矩阵由测试自身打印（下表是跑出来的，不是手写的）：

| 模式 | 变体 | 期望 | 检出 | 实际严重度 | 命中 key |
|------|------|------|------|-----------|---------|
| A 编造 key | A1 凭空捏造的作者+年份+词 | hard | ✅ | hard | zhang2019foldsolver |
| A | A2 库内真 key 的形近错拼 | hard | ✅ | hard | jumper2021highy |
| A | A3 编造 key 混在真引用之间 | hard | ✅ | hard | wang2022superfold |
| B 真 key 假内容 | B1 把卡片里的局限说成成果 | soft | ✅ | soft | jumper2021highly |
| B | B2 把结论方向说反 | soft | ✅ | soft | baek2021accurate |
| B | B3 张冠李戴地拔高结论 | soft | ✅ | soft | lin2023evolutionary |
| C 库外真文献 | C1 Attention Is All You Need | hard | ✅ | hard | vaswani2017attention |
| C | C2 AlphaFold-Multimer | hard | ✅ | hard | evans2021protein |
| C | C3 ResNet（跨领域） | hard | ✅ | hard | he2016deep |
| 阴性 | N1 三条真引用、陈述与卡片一致 | 0 hard | ✅ | — | — |
| 阴性 | N2 并列引用 `[@a; @b]` | 0 hard | ✅ | — | — |
| 阴性 | N3 强断言但带了引用 | 0 hard | ✅ | — | — |
| 阴性 | N4 代码块里的示例 key | 0 hard | ✅ | — | — |

**伪造引用检出率 9/9 = 100%；阴性对照 4/4 全部 0 hard finding（无误杀）。**

另有三条整体性断言：模式 A/C 的 6 个假 key 全部落进 `unknownKeys` 且真引用不受牵连；模式 B 的三条冲突全部判定为 conflict 且 **0 hard**；没有 judge 时如实降级（`judgedCount=0`，不报冲突也不假装检查过）。
e2e 对抗路径（`review_e2e.test.ts`）再验一次：三种模式混在一篇 10 篇文献的真实草稿里 → Reviewer `approved=false`、2 条 hard（正是那两个库外 key）+ 1 条 soft conflict。

### 关于 A 与 C 是同一条判据

对检查器而言，模式 A（编造）与模式 C（库外真文献）是同一件事：**这个 key 不在项目文献库里**。这是有意的口径——一条引用能不能被核对，取决于它在不在库内，而不取决于这篇文献在世界上是否存在。好处是检出能力不依赖任何外部 API 可用性；代价是检查器不会告诉你「这篇其实是真的，去入库就行」。分成两组列，是为了证明「真实存在」这个属性不会让检查器放松：C 的三个变体都是货真价实、key 形态完全合理的论文。

## 三、测试结果

```
$ bun run typecheck
（无输出，clean）

$ bun test tests/unit/
 275 pass
 0 fail
 1146 expect() calls
Ran 275 tests across 19 files. [630.00ms]
```

- 基线 **200 个一个没动、全绿**；新增 **75** 个：

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `tests/unit/reading.test.ts` | 15 | schema 校验（6 类非法 payload）、JSON 提取、重试一次成功/失败、失败不落 record 且不标已读、库外论文拒绝、批量独立结算、卡片读回与渲染、对照摘要不含推断字段 |
| `tests/unit/citation_integrity.test.ts` | 25 | 引用解析（并列/代码块/非法形态）、句子切分、强断言中英文、三类 finding、参考文献条目跳过判定、judge 降级可见、`LlmCitationJudge` 解析、ReviewerAgent 接入 5 例（含「不注入时行为不变」回归） |
| `tests/unit/citation_adversarial.test.ts` | 17 | 上表 9 攻击 + 4 阴性 + 4 条整体断言 |
| `tests/unit/review.test.ts` | 15 | prompt 白名单、草稿落图（cites/derives_from 计数）、越界重试与拒绝、空草稿/无引用、卡片对应论文被删、CLI `read`/`review` 正反路径 |
| `tests/unit/review_e2e.test.ts` | 3 | P2 fixture 回放 10 篇 → 卡片 → 草稿 → 核验全过 → Reviewer approved；对抗路径 veto；生成器白名单保险（伪造引用连 artifact 都不落地） |

LLM 调用**全部注入 fake**（`tests/helpers/review_scenario.ts` 的 `FakeLlm` / `FakeJudge`，e2e 里是按 prompt 分派的 `ScriptedLlm`），P3 没有新增任何网络依赖；文献数据复用 P2 的 `search-alphafold` cassette。

### 过程中发现并修掉的三个真问题

**(a) bibtex key 是非确定性的（最严重的一个）。**
写测试时出现约 60% 复现的 flake：同一篇论文的 key 在两次运行之间会变。根因是 `LibraryStore.list()` 按 `ORDER BY created_at, id` 排序，而同一次入库的论文 `created_at` 完全相同、`id` 是随机 uuid → 列表顺序每个进程都不同。因为 **bibtex key 的冲突后缀（a/b/c）按列表顺序分配**，顺序不定就意味着两篇同姓同年的论文的引用 key 可能互换。对「每条引用必须能回链到真实论文」这条主张来说这是致命的。
修法：次序键改 `rowid`（插入序）。同样的问题在 `RecordStore.list()` 上也存在（同毫秒创建的多张精读卡「哪张更新」不确定），一并改掉。改完连跑 10 次 `bun test tests/unit/` 全绿。

**(b) 句子切分把并列引用劈成两半。**
第一版按 `；;` 切句，结果 `[@a; @b]` 被切成 `...[@a` 和 `@b]`，**后一个 key 直接漏掉**——伪造引用可以靠写成 `[@real; @fake]` 逃过检查。改成不按分号切；同时补上英文句点（只在其后跟空白时才算句末，避免把 `10.1000/x.1` 这类 DOI 切碎）。两条都写进了单测。

**(c) 综述草稿会触发 `unverifiable claim` 误报。**
`hasClaim()` 原本是 `extractedCode != null`，而 artifact 的 `save()` 必须传 code 参数。草稿是 LLM 写的 Markdown、没有产生它的 cell，于是每篇草稿都会被 trace-don't-recompute 规则判一条 hard finding。修法：`hasClaim` 收紧为「有**非空**的 extractedCode」，草稿保存时传空串。这不只是绕开——一个空的 extracted code 本来就不是待溯源的代码声明，P8 的报告导出会遇到同样的情况。

另外顺手改掉的两处：精读卡失败消息现在区分「模型两次都没返回内容」与「输出不合 schema」（前者查 key/网络，后者查 prompt/模型，处理动作完全不同）；参考文献条目（行首即 `[@key]`）不再送去做一致性判定——那不是对文献的陈述，白花一次模型调用还容易凭空造误报（key 在库检查照常）。

## 四、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 精读卡用 `observation` record + `metadata.kind`，**不新增第 8 种 record 类型** | DESIGN C1 的 7 类是主会话定的口径，为一个子类型改枚举代价大于收益。`observation` + `evidence=sourced` 已能把「对文献的观察」与「实验产出的观察（observed）」区分开。若 P4 的 idea 卡也需要类似区分，再统一考虑加类型 |
| D2 | A 与 C 合并为同一条判据（key 是否在库） | 见第二节。检出能力不依赖外部 API 可用性 |
| D3 | citation findings **不参与位置加权** | 现有 `applyLocationWeight` 会把 figure/report（含 text/markdown）里的 soft 升成 hard。综述草稿正是 markdown，不豁免的话「soft 只提示不否决」这条口径当场失效，B 类与强断言全部变成 veto。已同步写进 DESIGN §E1 |
| D4 | 冲突判定失败 → 显式 soft finding，不静默 | 「0 conflict」与「没检查过」必须可区分。静默降级会让核验形同虚设 |
| D5 | 对照基准剔除 `relationToProject` | 那是对本项目的推断而非论文的陈述；拿它判冲突会把「综述没提到与本项目的关系」误判成冲突 |
| D6 | 生成器越界两次 → 抛错、不落 artifact；只有显式 `allowUnknownKeys` 才放行 | 不生产已知带假引用的产物。检查器是兜底，不是生成器可以摆烂的借口 |
| D7 | 参考文献条目跳过语义判定 | 条目不是陈述；省 N 次模型调用，也避免对标题行凭空造误报 |
| D8 | 卡片的 key 一律按**当前库**重算（`listReadingCards`） | 库增删会让冲突后缀漂移，卡片里存的 key 可能过期。一次运行内生成与核验用同一套 key，不会自相矛盾 |

## 五、与设计的偏差

1. **未新增 record 类型**（见 D1）。DESIGN 域 A3 已补上 P3 的 record 类型映射口径，C1 的 7 类不变。
2. **`hasClaim` 语义收紧**（空 extractedCode 不再算 claim）。这是对 P1 reviewer 行为的一处修改，现有 5 个 reviewer 测试全部仍绿（它们传的都是非空代码）。
3. **`RecordStore.list()` / `LibraryStore.list()` 的次序键从 `id` 改为 `rowid`**，属于 P1/P2 模块的改动，理由见 (a)。行为差异只在「同一时间戳的多条记录」这一种情况下体现，且改后才是确定的。
4. **模式 B 的判定依赖 LLM**，因此对抗测试用的是关键词驱动的 `FakeJudge` 而不是真实模型。真实模型下的 B 类检出率**没有被本阶段测量**——测的是「判定器说 conflict 时管线是否正确产出 soft finding」。真实模型的判准率需要一批人工标注样本才能评估，建议排进 backlog（见第七节）。
5. **强断言模式表是启发式的**，只覆盖了中英文各 5-6 个高频模式，必然有漏网。它是 soft finding，漏报的代价是「少一条提示」，可接受；不打算把它做成 LLM 判定（那会让每篇草稿多几十次调用）。
6. **`lit review` 一次性对全部精读卡生成综述**，没有做主题聚类/分节委派。10 篇量级下够用；库到几十篇时 prompt 会过长，需要分组综述再合并——留给需要时再做，不预先抽象。

## 六、给主会话的审查重点

1. **D3（citation findings 豁免位置加权）是本阶段最容易引起分歧的一处**。它让 `applyLocationWeight` 出现了第一个例外。备选方案是让位置加权只作用于 lineage 类 finding（白名单制而非黑名单制），语义更干净但要改动 P1 既有行为。现在的做法改动面最小，但例外会不会越加越多，请定个口径。
2. **D1（精读卡复用 `observation`）**。如果主会话认为 record 类型应该忠实反映语义、P4 的 idea 卡也会遇到同样的问题，那么趁 P3 还没合入就加第 8 类 `reading` 代价最小（只是 TS 枚举 + DESIGN 一行，schema 无 CHECK 约束）。越晚改，存量 record 的迁移成本越高。
3. **`rowid` 排序的改动跨了 P1/P2 两个模块**（`RecordStore.list` / `LibraryStore.list`）。虽然是修 bug 且测试全绿，但它改变了「已合入阶段」的行为，请确认这个越界是可接受的（替代方案是给 record/paper 加一个显式的单调序列号，改动更大）。

## 七、留给后续阶段的钩子

- `citationIntegrity` 的入参是 `{draft, knownKeys, baselines, judge}` 四件套，与文献域无耦合。P4 的 novelty check 报告、P8 的研究报告导出可以直接复用，只需换 `knownKeys` 的来源。
- `ReviewerAgent` 的 `citations` 配置已就位，P8 做报告导出时把 knownKeys/baselines 接上即可，无需再改 reviewer。
- `tests/helpers/review_scenario.ts` 的 `FakeLlm` / `FakeJudge` 是 P4 起所有 LLM 相关测试的通用脚手架（按 prompt 分派的 `ScriptedLlm` 见 `review_e2e.test.ts`）。
- **backlog 建议**：真实模型下的 B 类（真 key 假内容）判准率评估，需要一批人工标注的「冲突/一致」样本；这是把 soft finding 升级为可信信号的前提。

## 主会话验收批注（2026-09-09）

- **D1 改判**：采纳「新增 `reading` record 类型」——`observation` 保留给实验产出（P5 即将使用），精读卡独立为 `reading` 类型，避免 P8 报告按证据类型组织时混淆。已随本 PR 修改（models/reading/tests/DESIGN 四处）。
- **D3 维持**：citation findings 豁免位置加权，保住「模式 B = soft 提示不否决」的设计语义；白名单制重构留到有第二个例外出现时再做。
- **rowid 次序键改动**：接受，属真 bug 修复（bibtex key 确定性）。
- **backlog**：模式 B（真 key 假内容）在真实模型下的判准率未测量，排入 P8 前的验证清单。
