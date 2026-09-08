# P4 · Co-explore 思路库与 Novelty check（devlog）

> 分支：`feat/p4-ideation` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)「P4 Co-explore 与 Novelty」；设计依据：[DESIGN.md](../DESIGN.md) 域 A4、域 D、域 C1

## 一、做了什么

### 1. Idea 卡与思路库（`backend/src/ideation/models.ts` + `store.ts`）

Idea 卡 = 假设陈述 + 支持文献 + 反对文献 + 待验证点 + novelty 状态，落成 `idea` record（`evidence=inferred`，`metadata.kind="idea_card"`），**不新增 record 类型**（C1 的 8 类不变）。

- **两条硬门**（就是「批判性」三个字的可执行形式）：
  1. 每条证据要么给库内 bibtex key，要么显式 `inferred:true`。库外 key 与 P3 的口径完全一致——视同伪造引用，直接判不合格，不是「顺手丢掉」。
  2. `contradicting` **至少 1 条**。给不出反面证据的「共探」只是附和；库里没有反证就明说，并把复杂化点标成 inferred 写清推理。
  另有一条兜底：库非空时整张卡至少要有一条**文献支撑**的证据，否则「全部标 inferred」就能绕过 grounding，卡片退化成纯臆想。
- **证据边方向按语义**：`paper --supports--> idea`（这篇论文支持这条思路）。这与 P3 的 `cites`（新产物 → 被引论文）方向相反，是有意的：`supports` 的字面语义就是「A 支持 B」，反过来写才是错的。查一条 idea 的支撑文献 = 看它的 **incoming** 边。
- `IdeaStore.fromRecord()` 每次都拿**当前库**重新校验证据 key（同 P3「卡片 key 按当前库重算」的纪律）：论文被移出文献库后，那条证据自动不再算数。

`RecordStore` 新增窄口 `update(id, {title?, content?, metadata?})`：只能改这三样，`type/evidence/origin/artifactId/createdAt` 一律不可变。理由见决策 D2。

### 2. Co-explore 会话模式（`backend/src/agents/prompt/coexplore.txt` + `ideation/coexplore.ts`）

workflow prompt 走 P1 的双层 prompt 结构（provider-neutral core + workflow），内容是苏格拉底式的立场约定：**你的角色不是鼓励师**；每个实质性观点带 `[@key]` 或显式 `(inferred)`；至少给一条反对/复杂化证据；四个值得做的动作（收紧 / 定位 / 进攻 / 成本）。

管线纪律与 P3 完全一致：schema 校验是硬门 → 不合格把失败原因回灌重试一次 → 仍不合格抛错、**不落半成品 record**。半成品 idea 卡比没有更糟——它会被 novelty check 当成待检验的创新点，把一次无效输出放大成一份煞有介事的报告。

`groundingCheck()` 复用 P3 `reviewer/rules.ts` 的 `parseCitations` / `splitSentences` / `isStrongClaim`，不另起一套口径：库外引用 = 硬错误（触发重试/拒绝），强断言句既无引用也无 `(inferred)` 标记 = soft 提示（如实报出，不拦）。

orchestrator 挂上会话模式：`chat({mode:"coexplore"})` 与默认 chat **并列**，不走规划/执行/review 循环。`mode` 缺省时行为与 P1-P3 逐字节相同（有专门的回归用例守这条）。多轮共探由 `turn()`（只讨论）+ `save()`（定卡入库）两段构成，CLI 的 `/card` 就是这条边界。

### 3. Novelty check pipeline（`backend/src/ideation/novelty.ts` + `affinity.ts`）

六步：claim 提取 → 密集检索 → 确定性相似度 → 对比评级 → **评级校验层** → 引用核验 + 回写。

- **claim 提取**：1-5 条可被一篇论文证伪的陈述，每条配 2-3 个**英文**检索式（主流文献库对中文查询召回极差）。claim id 由代码分配（`c1..cN`），不信任模型给的 id——重复/缺失的 id 会让整份报告错位。
- **密集检索**：每条检索式各走一次 P2 的统一检索（多源并发 + 去重合并），检索式之间**串行**（同 P2 PDF 下载的礼貌纪律）。跨 claim 维护一个全局候选池：同一篇论文在不同 claim / 不同检索式下必须拿到同一个引用 key，否则同一份报告里会出现两个 key 指向同一篇文献。
- **key 分配**：库内论文与库外候选在**同一个 `assignBibtexKeys` 序列**里分配，库内在前。所以库内论文的 key 与 `lit export --format bibtex` 完全一致（P3 的引用体系不受影响），库外候选只可能拿到后缀更靠后的 key，撞不掉库内 key。
- **对比评级**：模型只负责 `sameness / difference / verdict` 这些需要判断力的字段，key **必须**来自该 claim 的候选清单（生成器闸门，同 P3 综述白名单）。报告正文由**代码**渲染——引用形态、相似度、评级校正记录都得是确定的。
- **引用核验**：报告过 `citationIntegrity`，`knownKeys = 库内 key ∪ 本次候选 key`。关掉了强断言检查（`checkUnsupportedClaims:false`）：报告里「评 existing」这类措辞不是学术强断言，开着只会刷噪声，真正的约束在评级校验层。

### 4. 评级校验层（本阶段的核心，`constrainRating`）

没有这层，「新颖性评级」就等于让模型给自己的想法打分，检索结果只是装饰。五条规则，纯函数、零 IO：

| 规则 | 触发 | 后果 |
|------|------|------|
| `no_candidates` | 检索一条候选都没返回 | 结论不可用（**检索不到 ≠ 新颖**） |
| `rating_without_nearest` | 有候选却一条最近邻都不列 | 结论不可用 |
| `unknown_work` | 引用了候选清单外的 key | 结论不可用 |
| `existing_without_high_affinity` | 评 existing 却没引到高相似候选 | **降级**为 incremental |
| `novel_despite_high_affinity` | 存在高相似候选却评 novel | **升级**为 existing |

聚合：全部 claim 结论可用时取最保守的一条（任一 existing → `checked-overlap`；否则任一 incremental → `checked-incremental`；全 novel → `checked-novel`）；**任一 claim 结论不可用 → 状态维持 `unchecked`**，但报告指针仍写回 idea——「查过但没查出来」与「没查过」必须能区分。

### 5. 确定性相似度（`affinity.ts`）与阈值标定

`affinity = max over [claim 陈述, 各检索式] of coverage(text, 候选标题+摘要+venue)`，coverage = 内容词覆盖率。

三个设计取舍：
- **用覆盖率不用 Jaccard**：claim 陈述往往比标题长得多，Jaccard 会因为分母里的论文词把真正的命中稀释掉。
- **取 max 不取平均**：中文陈述对英文论文覆盖率天然为 0，取平均会把命中的英文检索式抹平。
- **中文按二元组切**：不需要词典，「序列转导」这类术语能产生可匹配的片段。

阈值 `HIGH_AFFINITY = 0.75` 是在**真实检索样本**上标定的，不是拍的。下表是本阶段录制的 fixture 跑出来的：

| 场景 | 候选 | 相似度 |
|------|------|--------|
| (a) 已发表 claim | **Attention Is All You Need** | **1.00** |
| (a) | Attend and Diagnose（同领域邻近） | 0.86 |
| (a) | Multiresolution Transformer Networks | 0.86 |
| (a) | 其余 13 条 | ≤ 0.57 |
| (b) 杜撰组合 claim | Illuminating protein space（最近邻） | 0.67 |
| (b) | Modeling Boltzmann-weighted structural ensembles | 0.56 |
| (b) | 其余 11 条 | ≤ 0.44 |

0.75 把「就是这件事」（1.00）与「同一个领域」（≤0.86 但语义上不是同一件事）分开，(b) 的最近邻 0.67 落在门槛下方，两侧都有余量。**已知局限**：这是词面覆盖率不是语义相似度，会把用词高度重合的邻近工作算得偏高（0.86 那两条就是），所以它只用来做**约束**（不许在有高相似候选时说 novel），不用来直接下结论。

### 6. 技能 ×2 + CLI

- `backend/src/skills/idea-coexplore/SKILL.md`：4 条铁律 + 6 条反模式（「用『这是个很有意思的方向』开头然后顺着用户说下去——那不是共探，是复读」）。
- `backend/src/skills/novelty-check/SKILL.md`：管线六步表 + 评级校验规则表 + 7 条反模式（「检索空了就写『未见相关工作，属于原创』——这是本管线存在的理由」）。
- `spark-research idea new [-m …] | list [--status] | check <record-id> [--sources] [--out]`。`idea new` 不带 `-m` 进多轮交互（`/card` 定卡，exit 退出）；`idea check` 在「报告有 hard finding」或「结论不可用」时退出码 1。

## 二、双向对照 e2e 结果（退出标准）

`tests/unit/novelty_e2e.test.ts`，检索数据是本阶段真实录制的 fixture 回放，LLM 全 fake。

| # | 场景 | 断言 | 结果 |
|---|------|------|------|
| a | 已发表工作的核心 idea（自注意力替代循环做序列转导） | 检索命中 *Attention Is All You Need*；它排候选第一且 affinity ≥ 0.75；评级 `existing` 且 0 违规；报告引到原文；`citation.unknownKeys=[]` 且 0 hard finding；状态回写 `checked-overlap`；`derives_from` 边连 idea；idea 侧 supports/contradicts 各 1 条；报告两跳可达 paper record | ✅ |
| b | 杜撰组合 idea（量子退火采样 × 蛋白语言模型 × 嗜盐菌相分离温度） | 检索**有**结果（否则「查不到 = 新颖」就成立了）；所有候选 affinity < 0.75；评级 `novel` 且列出最近邻；报告点名最近邻与差异；状态 `checked-novel` | ✅ |
| b′ | 同上但模型空手评 novel（不给最近邻） | 违规 `rating_without_nearest`；结论不可用；状态**维持 unchecked**；报告仍落库且指针写回 | ✅ |
| a′ | (a) 场景下模型硬说 novel | 违规 `novel_despite_high_affinity`；评级被**升级**为 existing；状态 `checked-overlap`；报告里「模型原判 novel」可见 | ✅ |
| b″ | (b) 场景下模型硬说 existing | 违规 `existing_without_high_affinity`；评级被**降级**为 incremental；状态 `checked-incremental` | ✅ |
| — | fake 引用没检索到的 key（`vaswani2017attention`） | 生成器重试后仍越界 → 抛错，整份报告不落地，record 数不变 | ✅ |
| — | co-explore prompt 里确实带上库内白名单 | fake 只能从白名单里挑 key | ✅ |
| — | `chat(mode:"coexplore")` | 产出 idea 卡、不跑 reviewer 循环、重开项目能读到卡 | ✅ |

a′ 与 b″ 是这套 e2e 里最重要的两条：它们证明**评级不是 fake LLM 说了算**。fake 从 prompt 里读候选 key（所以它只能引用管线真的检索到的东西），然后故意判错，由 `constrainRating` 按检索证据纠回来。

## 三、真实网络验证（`FIXTURE_MODE=record`，2026-09-09 本地实跑）

`tests/integration/novelty_record.test.ts`，2 条 claim × 2 条检索式 × 4 源 = 16 次请求，录成 `tests/fixtures/literature/novelty-check.json`（515 KB，无凭据）。

逐源结果：

| 源 | (a) q1 | (a) q2 | (b) q1 | (b) q2 | 结论 |
|----|--------|--------|--------|--------|------|
| OpenAlex | ✅ 5 条 / 3.1s | ✅ 5 条 / 1.2s | ✅ 5 条 / 1.0s | ✅ **0 条** / 0.7s | 可用；(b) q2 返回 0 条是真实结果，不是故障 |
| CrossRef | ✅ 5 条 / 1.3s | ✅ 5 条 / 0.7s | ✅ 5 条 / 1.3s | ✅ 5 条 / 1.0s | 完全可用 |
| Europe PMC | ✅ 5 条 / 2.1s | ✅ 5 条 / 0.5s | ✅ 5 条 / 0.5s | ✅ 0 条 / 0.4s | 可用 |
| Semantic Scholar | ❌ HTTP 429 | ❌ HTTP 429 | ❌ HTTP 429 | ❌ HTTP 429 | 未鉴权请求被限流，与 P2 结论一致；无 key 时自动降级为其余源 |

**关键验证点：(a) 的检索式确实能把原文捞回来。** `transformer architecture dispensing with recurrence for sequence transduction` 在 OpenAlex 上把 *Attention Is All You Need* 排在第 1 位（7290 被引，含完整摘要）。第二条检索式 `self-attention replaces recurrent networks for sequence transduction` 一条都没命中原文——这是真实情况，也说明为什么每条 claim 要给 2-3 条检索式而不是 1 条。

**(b) 的检索式都有结果但没有直接匹配**，最近的是 *Illuminating protein space with a programmable generative model*（相似度 0.67）。这正是设计想要的形态：报告给得出最近邻，评级不是空手判 novel。

顺带记一条：CrossRef 对 (b) q2 返回了 3 条**完全同名**的 *Pressure and Temperature Phase Diagram for Liquid–Liquid Phase Separation…*，它们 DOI 不同，按 P2 的去重口径（两边都有 DOI 且不同 → 绝不合并）不会被合并。这是 CrossRef 数据本身的重复条目，不是去重逻辑的 bug。

## 四、测试结果

```
$ bun run typecheck
（无输出，clean）

$ bun test tests/unit/
 366 pass
 0 fail
 1419 expect() calls
Ran 366 tests across 23 files. [1068.00ms]
```

- 基线 **275 个一个没动、全绿**；新增 **91** 个：

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `tests/unit/ideation.test.ts` | 31 | idea 卡 schema（8 类非法 payload）、grounding 检查、共探重试/拒绝/失败区分、多轮历史、证据边方向、IdeaStore（前缀取卡与歧义、状态回写、库漂移、过滤）、状态聚合与渲染 |
| `tests/unit/novelty.test.ts` | 39 | 词尾归并与中文分词、覆盖率、候选身份、claim/报告 schema 各 5 类非法输入、**评级校验层 5 条规则逐条 + 边界 + 阈值注入**、key 分配不撞车、报告渲染、管线（回写/cites 边/检索空/schema 失败不落库/dry-run）、检索源状态汇总 |
| `tests/unit/novelty_e2e.test.ts` | 8 | 上一节的双向对照矩阵 |
| `tests/unit/ideation_cli.test.ts` | 13 | `idea new/-m/--json/交互式`、空库警告、生成失败退出码、`list` 过滤、`check` 全链路与报告文件、结论不可用退出码 1、参数错误 |

LLM 调用**全部注入 fake**；文献数据来自 P2 的 `search-alphafold` cassette（文献库）与 P4 新录的 `novelty-check` cassette（检索候选）。连跑 3 次 `bun test tests/unit/` 全绿，无 flake。

## 五、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | `supports`/`contradicts` 边方向 = **paper → idea** | 边类型的字面语义就是「A 支持 B」。与 P3 的 `cites`（新产物 → 被引）方向相反，但两者都是照语义走，反过来写才是错的 |
| D2 | 给 `RecordStore` 加窄口 `update()`，而不是用 `supersedes` 边堆 idea 的历史副本 | novelty 状态是**生命周期字段**（同 `library.reading_status`），不是新的证据。审计痕迹由 novelty 报告 record + `derives_from` 边承担。`update` 只放开 title/content/metadata，身份字段（type/evidence/origin/createdAt）一律不可变；真正的思路修订仍走 `supersedes` |
| D3 | 报告正文由**代码**渲染，模型只填 sameness/difference/verdict | 引用形态、相似度、评级校正记录必须是确定的。让模型写 Markdown 就等于把这些也交给它 |
| D4 | 「检索为空」→ 结论不可用，而不是 novel | 这是本管线要防的头号失效模式。查不到只说明这几条检索式没查到 |
| D5 | 评级校验层对 existing 是**降级**、对 novel 是**升级**，两者都保留模型原判 | 两个方向都是往「更保守」走。保留原判是为了让「谁改了」在产物里看得见，而不是偷偷替模型圆场 |
| D6 | novelty 状态取最保守的一条 claim | 一个 idea 里只要有一条创新点已经被做过，整条思路就不该显示为 novel。宁可低估新颖性，也不给虚假的安心 |
| D7 | 相似度用词面覆盖率而非语义嵌入 | 零依赖、确定性、可复现，CI 与本地必然一致。代价是把用词重合的邻近工作算得偏高，所以只拿它做约束不做结论（见 backlog） |
| D8 | 库外候选与库内论文共用一套 bibtex key 分配序列 | 库内 key 与 `lit export` 完全一致（P3 引用体系不受影响），库外候选撞不掉库内 key；同一篇论文跨 claim 拿到同一个 key |
| D9 | 报告的 citationIntegrity 关掉强断言检查 | 报告里「评 existing」不是学术强断言；开着只刷噪声，真正的约束在评级校验层 |

## 六、与设计的偏差

1. **novelty 状态从 3 态扩到 4 态**：DESIGN D2 原文是 `unchecked / checked-novel / checked-overlap`，实现为 4 态（补 `checked-incremental`）。理由是 D1 的评级本来就是三档（novel/incremental/existing），状态只有两档会把 incremental 挤到某一边，信息丢失。已同步改 DESIGN。
2. **DESIGN D1 从 4 步变 5 步**：插入了「评级校验层」。这是 DEVELOPMENT_PLAN 里「评级由代码根据检索结果特征辅助约束」的落点，已同步写进 DESIGN 并抽象成 AD-8。
3. **`RecordStore.update()` 是对 P1 模块的新增**（跨阶段改动）。只增不改：现有调用方零影响，行为差异只在新增的这个方法里。理由见 D2，请主会话确认这个越界可接受。
4. **未新增 record 类型**：idea 卡用 P1 已有的 `idea` 类型，novelty 报告用 `artifact` 类型 + `metadata.kind`（同 P3 综述草稿的处理）。C1 的 8 类不变。
5. **claim 提取要求英文检索式**：DESIGN 没写语种。这是实测约束——中文查询在 OpenAlex/CrossRef/EuropePMC 上召回极差。中文文献的 novelty check 需要 AMiner/CNKI 路径，本阶段没做。
6. **没有做「语义近邻检索」**：DESIGN D1 第 2 步提到「Semantic Scholar/OpenAlex 的相关论文 API」。本阶段只做了多检索式的关键词检索——因为 Semantic Scholar 匿名请求持续 429（P2 已记录，本阶段 4/4 次请求全部 429），而 OpenAlex 的 `related_works` 需要先有一个种子 work id，而 novelty check 的输入是一句 claim 不是一篇论文。等有 S2 key 后再补。
7. **相似度是词面的**：见 D7。真正的语义近邻需要嵌入模型，会引入新的外部依赖，不在本阶段范围。

## 七、给主会话的审查重点

1. **`supports`/`contradicts` 的边方向（D1）是最容易引起分歧的一处**。我选了「按语义读」（paper → idea），代价是同一张证据图里出现了两种方向习惯：`cites` 是新产物指向旧文献，`supports` 是旧文献指向新思路。备选是全图统一成「新产物指向被引用者」，语义上会别扭（idea supports paper?），但遍历代码更整齐。P8 的报告导出要按边遍历证据图，现在定口径成本最低。
2. **`RecordStore.update()` 的越界（D2、偏差 3）**。它让 record 从「只增不改」变成「metadata/content 可改」。我把可改范围压到了最窄，并且状态变更本身有 novelty 报告 record 作为审计痕迹。但如果主会话认为 record 必须严格 append-only，替代方案是用 `supersedes` 边堆版本，代价是 `idea list` 要做版本解析、supports/contradicts 边要跟着复制。
3. **阈值 0.75 与词面相似度（D7、偏差 7）**。标定表是真实数据跑出来的，但样本只有两个 claim。(b) 的最近邻 0.67 距门槛只有 0.08 余量，换一批检索结果可能就顶上去了——那会让「杜撰的组合」被判成 existing（假阳性方向，比假阴性安全，但仍是误判）。要不要现在就引入嵌入相似度，还是先留 backlog、靠「保留模型原判 + 违规记录可见」来兜住，请定个口径。

## 八、留给后续阶段的钩子

- `constrainRating` / `aggregateNovelty` 与文献域无耦合，入参是 `(declared, candidates)`。P5 的结论卡如果也要「模型给结论 + 代码约束」，可以照这个形状复制（AD-8）。
- `IdeaStore.setNovelty()` 是思路库状态的唯一写入口。P7 前端做思路库导航时按 `noveltyStatus` 过滤即可。
- `affinity.ts` 的 `contentTokens` / `coverage` 是通用的确定性文本相似度，P8 报告导出做「结论卡 ↔ observation 一致性」时可以复用。
- **backlog 建议**：
  1. 语义嵌入相似度替换/补充词面覆盖率（本阶段最大的技术债，见 D7）
  2. Semantic Scholar API key 走凭据服务接上，把「语义近邻检索」这一步真正补齐（偏差 6）
  3. 中文 claim 的检索路径（AMiner），当前只支持英文检索式
  4. 多轮共探的历史压缩：`turn()` 的 history 会随轮数线性增长，长会话下 prompt 会过长

## 主会话验收批注（2026-09-09）

- **边方向（paper→idea）维持**：按字面语义读图最自然；`graph()` 本就双向 BFS，P8 遍历不受影响。方向约定以 DESIGN 本次同步为准。
- **`RecordStore.update()` 接受**：唯一调用方是 novelty 状态回写，content 变更是按新状态的整卡重渲染（派生视图）；身份字段不可变。生命周期字段可变是设计固有（experiment 状态机、conclusion review 状态同理，P5/P8 复用此口）。审计痕迹由报告 record + derives_from 边承担。
- **相似度语义化留 backlog**：0.75 词面阈值 + 评级校验层「保留模型原判、违规可见」的兜底可用；语义嵌入牵涉 embedding provider 依赖决策，与「模式 B 真实模型判准率」一并排 P8 前验证清单。
