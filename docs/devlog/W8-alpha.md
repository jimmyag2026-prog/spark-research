# W8-1 α · 检索收口（V67 · V86 · V87 · V73）

lane：`W8-1-alpha`（波次 W8）· 分支：`lane/W8-1-alpha`
设计真源：`docs/DEVELOPMENT_PLAN_v0.8.md` §三 α 行 · `docs/BACKLOG.md` V67/V86/V87/V73 ·
任务书 `~/Desktop/AI4S/spark-research-v0.8-plan/lanes/W8-alpha.md`（共同纪律
`lanes/_COMMON.md`）。

基线：`f16a5d4`（`v0.8.0-alpha.1`）。中途一次网络中断，主会话落过一个 wip commit
（`907492c`，标「未经任何验证」）——本文件记录的六套件数字与阴性对照均在网络恢复
后**重新实跑**，wip commit 里的内容与我原地写的完全一致（已核对 diff），未额外
改动。

---

## 一、V67 + V86 · 有礼貌池后的真实召回基线

### 1.1 方法

`SPARK_RESEARCH_DATA_DIR` 指向 `mktemp -d` 的临时目录（`/private/tmp/claude-502/
.../scratchpad/w8-alpha-recall.A7Qmxm`），未碰 `~/.spark-research`。`config set
contactEmail jyh96321@gmail.com` 进 polite pool（用户邮箱，只用于 OpenAlex/CrossRef
的礼貌头，不做其它用途）。新建临时项目 `w8-alpha-recall`。

检索式与冻结基准取自仓库里的 `docs/taskbooks/v0.6/T{1,2,3,4}_*.md`（已冻结
2026-09-11，与 `docs/BACKLOG.md` V67/V86/V87 行、`spark-research-v0.7-plan/R4/` 的
四份报告互相印证一致）：

- T1 蛋白结构：3 条英文检索式，8 篇基准（全部 DOI，默认 6 源可达）。
- T2 单细胞聚类：3 条英文检索式，8 篇基准（全部 DOI，默认 6 源可达）。
- T3 脑机接口：任务书 8 篇基准里只有 3 篇是 DOI 形态（Nature/Nature
  Neuroscience）、默认 6 源理论可达；另 5 篇是 AMiner 内部 id（3 篇中文原生 +
  2 篇 AMiner 英文），**结构性不可达**——本 worktree 未配置 aminer 凭据
  （`lit sources` 核实过），与 `docs/devlog/W7-B1.md`/`W7-B2.md` 的既有先例一致，
  如实排除，T3 满分基准从 8 降到 3，检索式用任务书里的英文对照组
  `brain-computer interface neural decoding`（中文 aminer 主检索式因无凭据不跑，
  跑了也是 100% skipped，不产生召回信息）。
- T4 钙钛矿稳定性：同理，8 篇基准里 3 篇中文原版是 AMiner id，结构性不可达；
  5 篇英文 DOI 可达，检索式用任务书的英文混检式 `perovskite solar cell stability
  encapsulation`。

每条检索式对 `blended`（默认，perSource=30）、`hits`、`citations`、`recent`
（perSource=10，CLI 现有的 `--per-source` 与 `--limit` 解耦逻辑决定，未改动）各跑
一次 `lit search --project w8-alpha-recall --limit 10 --rank <mode>`，同课题内
多条检索式的命中结果取**并集**（与 `docs/devlog/W7-B1.md`/`W7-B2.md` 同一方法，
可比）。命中判据：DOI 精确匹配任务书里程碑表。

### 1.2 recall@10 结果表（真实网络，2026-09-12）

| 课题（可达基准数） | blended（默认，perSource=30） | hits | citations | recent |
|---|---|---|---|---|
| T1 蛋白结构（8） | **5/8** | 3/8 | 3/8 | 0/8 |
| T2 单细胞聚类（8） | 2/8 | **3/8** | **3/8** | 0/8 |
| T3 脑机接口（3，结构性可达） | 0/3 | 0/3 | 0/3 | 0/3 |
| T4 钙钛矿稳定性（5，结构性可达） | **1/5** | **1/5** | **1/5** | 0/5 |
| **合计（24 项可达基准）** | **8/24** | 7/24 | 7/24 | 0/24 |

T1 命中（blended）：AlphaFold3 / RFdiffusion / luciferases 设计 / Illuminating
protein space / protein binder design。缺席：ESMFold（10.1126/science.ade2574）、
Foldseek（10.1038/s41587-023-01773-0）、ProGen2（10.1016/j.cels.2023.10.002）。

T2 命中（blended）：SCANPY（10.1186/s13059-017-1382-0）、regularized-NB
normalization（10.1186/s13059-019-1874-1）。命中（hits/citations，多出的一篇）：
batch-effect correction benchmark（10.1186/s13059-019-1850-9，见 1.4 节的深挖）。
Louvain 原始 2008 论文（10.1088/1742-5468/2008/10/p10008）、Leiden 原始论文
（10.1038/s41598-019-41695-z）、best-practices tutorial（10.15252/msb.20188746）、
MNN batch correction（10.1038/nbt.4091）、clustering trees（10.1093/gigascience/
giy083）四档排序下全部**结果集里完全没出现**（覆盖问题，不是排序问题——不在
本 lane 允许改动的 `search.ts` 覆盖侧范围内，如 V67 一贯的口径）。

T4 命中（blended/hits/citations）：Efficient, stable and scalable perovskite
solar cells using P3HT（10.1038/s41586-019-1036-3）。其余 4 篇英文基准同样是
「完全没出现」的覆盖问题。

T3：0/3，三篇 Nature/Nature Neuro. 论文在 `brain-computer interface neural
decoding` 这条检索式的默认 6 源结果集里完全没出现，四档排序结果一致（覆盖问题）。

### 1.3 V86 核验结论：OpenAlex 429 已解决

R4（`spark-research-v0.7-plan/R4/SUMMARY.md`）记录的是「本轮会话内 openalex 429
率 = 11/11 = 100%」；`docs/devlog/W7-B2.md` 记录的是「T1 之后 openalex 对 T2/T4
的全部查询持续 429」。本 lane 配置 `contactEmail` 后，**38 次真实 `lit search`
调用（含 1.4 节的补充深挖）里 openalex 0 次失败**（`grep -c "❌ openalex"` 全部
输出文件 = 0）。V86 的「等 429 消退后复测」到此可以关闭：礼貌头 + 主机限速
（alpha.6 已加的 `api.openalex.org` 10 rps）组合有效，本次真实复测里 openalex
再没有拖累过任何一次检索。

**如实交代 · 429 记录（不当召回结果）**：本轮 38 次调用里，`arxiv` 21 次 429 + 13
次 30s 超时、`biorxiv` 10 次 30s 超时（`biorxiv` 的复合 search 工具本身较慢，见
`connectors/biorxiv.ts` 既有 caveat）——这两个源不在 V86 范围内（V86 只针对
openalex），但如实记录：本轮召回数字**没有**因为这两个源失败而系统性缺项（它们
不是这批基准论文的主要索引源），只是每次检索的原始结果池比理论上更小一点。

### 1.4 perSource=30 vs 50 补充实验（真实网络）

任务书要求「按数据决定 --rank 默认档与 perSource 默认值」。除默认档位表外，额外
对 T1、T2 用 `--per-source 50`（显式覆盖，走 CLI 现有的 `--per-source` flag）复跑
blended：

| 课题 | perSource=30（当前默认） | perSource=50 | Δ |
|---|---|---|---|
| T1（8 篇基准） | 5/8 | **6/8**（新增 Foldseek） | +1 |
| T2（8 篇基准） | 2/8 | 2/8（无变化） | 0 |

深挖 T2 为什么无变化：`clustering stability batch effect single cell` 这条查询
用 `--limit 100 --per-source 50` 展开，`10.1186/s13059-019-1850-9`（batch-effect
correction benchmark）确实**在池子里**，排在 blended 第 17 名——比 top10 只差
7 名，但没跨过线；同一查询同一深度下改用 `--rank hits`，这篇论文排到第 **70**
名（更差）。这说明默认档表里「hits perSource=10 反而比 blended perSource=30 多
命中这篇论文」并不是「hits 排序机制更好」，而是**浅池本身竞争少**——perSource=10
时总候选池只有 40~50 篇，这篇论文的被引数（1250）在小池子里足够靠前；perSource
加深到 50 后候选池膨胀到 200+，无论 blended 还是 hits，这篇论文都被更多高命中源
数/高被引论文压下去了。换句话说：默认档表（1.2 节）里 hits/citations 对 T2
「更好」，一部分是「小池子噪音」，不是排序算法本身的优势——如实记录，不据此
推翻「blended 更值得当默认」的判断。

### 1.5 决定：`--rank` 默认档与 `perSource` 默认值均**不改**

**`--rank` 默认档**：维持 `blended`（现状，`models.ts` 的 `DEFAULT_RANK_MODE`
未改动）。依据：24 项可达基准合计 blended 8/24，明显高于 hits/citations 的
7/24、recent 的 0/24；`recent` 在四个课题、四次真实复测里没有命中任何一篇里程碑
论文，确认继续排除它当默认是正确的。T2 单课题内 hits/citations 反超 blended
1 篇，但 1.4 节的深挖表明这更可能是「浅池噪音」而非「hits 排序机制系统性更好」
——没有证据支持因为一个课题的一篇论文改变全局默认。

**`perSource` 默认值**：维持 `30`（`search.ts` 的 `BLENDED_DEEP_POOL` 未改动）。
依据：T1 从 30 加深到 50 只多命中 1 篇（+1/8），T2 加深到 50 反而不变（该论文
排名从 17 名附近的量级并未跨过 10 的门槛，深池只是让候选池整体膨胀，没有针对性
帮到它）；而加深带来的代价是真实的——本轮 21 次 arxiv 429 + 23 次超时已经在
perSource=30 下发生，继续加深会线性增加每源请求量，进一步推高限速风险（V26
纪律：不能为了一个课题的边际收益系统性推高全体用户的限速概率）。收益不确定、
成本确定，维持现状。

**未做但值得记的后续方向**（不在本 lane 范围，留给下一轮）：T2/T4 的多篇基准
论文是「完全不在结果集里」的覆盖问题（不是排序问题），需要更精确的检索式或
額外源（如 T2 的 Louvain/Leiden 原始算法论文可能需要 `network science`/
`community detection` 领域的补充检索式，不是「单细胞」领域词能触达的）；这是
V67 范围之外的覆盖侧工作。

---

## 二、V87 · `lit review` 差额去向

见 `backend/src/reviewer/citation_judge.ts` 新增的 `explainCitationGap()`（头部
注释含完整设计说明）：把「解析 N / 判定 M」的差额分成四桶——去重（同句重复引用
同一文献）/ 自引（引用出现在它自己的参考文献列表行）/ 解析失败·库外（key 不在
库内，或库内但没有精读卡对照基准）/ 其他（安全阀，穷尽分桶下恒为 0，非 0 直接
抛错）。`x+y+z+w = N−M` 是构造性恒等（分桀穷尽），不是凑出来的。

`backend/src/literature/cli.ts` 的 `review` 输出段：
- `handle.note`（生成中的进度提示）与最终 `out()` 都改成「解析 N 处，判定 M 处」
  +「差额：去重 x · 自引 y · 解析失败/库外 z」新一行。
- observation record 的 `content` 字段同步加了这行差额文本（`metadata` 保持不动
  ——`CitationIntegrityReviewMetadata` 类型定义在 `agents/contract.ts`，不在本
  lane 允许改动范围，差额只落自由文本 `content`，不进类型化 `metadata`）。

**如实交代 · M 的口径变化**：`citationIntegrity`（`rules.ts`，不在本 lane 文件
所有权内）原始的 `judgedCount` 不去重「同句重复引用同一文献」这种情形（两次都
真送进判定循环，即使 `LlmCitationJudge` 的缓存吸收了重复的 LLM 网络调用）。本
lane 的 `explainCitationGap().judged` 在**没有重复引用**时与 `judgedCount` 逐一
致（已用真实 `citationIntegrity` 交叉核对，见下面单测②），但**有**重复引用时
会比 `judgedCount` 更小——CLI 现在打印的「判定 M」用的是去重后的 `judged`，比
原始 `judgedCount` 更精确地反映「多少处**不同**的引用真正被判定过一致性」。这是
本 lane 主动做的口径升级，不是 bug。

### 单测（`tests/unit/w8_alpha_citation_gap.test.ts`，新，4 条）

1. 构造含「重复引用同一句 + 自引（参考文献条目）+ 库外坏 key」的草稿：
   `N=5, judged=2, duplicate=1, selfReference=1, unresolved=1, other=0`，逐项精确
   核对，并核对构造性恒等式。
2. 与真实 `citationIntegrity()`（用 `FakeJudge`）交叉核对：无重复引用场景下
   `gap.judged === check.judgedCount` 逐一致。
3. 全部可判定、无差额 → 四桶全 0。
4. 库内 key 但没有精读卡对照基准 → 归「解析失败/库外」，不归「判定」。

`bun test tests/unit/w8_alpha_citation_gap.test.ts`：**4 pass / 0 fail**。

### 阴性对照（真跑）

**对照①**：把「自引」分支判据临时改成 `if (false && isReferenceEntry(...))`
（永远不生效），重跑同一份测试。

结果：**红**。
```
(fail) 分解数字精确：N/M/去重/自引/解析失败库外 各自对得上
  expect(gap.selfReference).toBe(1)
  Expected: 1
  Received: 0
3 pass / 1 fail
```
改回，重跑：4 pass / 0 fail（绿）。

**对照②**（针对「加断言」本身）：把「去重」分支的 `continue` 删掉（重复引用
同时被计进 `duplicate++` 又落进 `judged++`，破坏分桶穷尽性），重跑。

结果：**红**——不是断言数字不对，是 `explainCitationGap()` 自己抛异常：
```
error: explainCitationGap: 分桶穷尽性被破坏（total=5, judged=3, duplicate=1,
selfReference=1, unresolved=1, other=-1）——理应为 0，说明分类逻辑有遗漏，
需要修复而不是掩盖。
  at explainCitationGap (backend/src/reviewer/citation_judge.ts:323:5)
```
改回，重跑：4 pass / 0 fail（绿）。两次对照均真跑、真复原。

---

## 三、V73 · AMiner 401 观察收结论

**方法**：只读 `~/.spark-research/api_calls.polluted-2026-09-11.jsonl`（59462 行；
本 worktree 与 `~/.spark-research/projects/*/api_calls*.jsonl` 核实过不存在——
没有任何项目落过这个文件名，只有这一份全局台账），未写入、未修改任何文件。
统计脚本见本节末尾（Python，只读 + 聚合，不落盘）。

**统计结果**：
- aminer 总调用 4907 次，401 91 次（1.85%），其余全部 200（0 个 429，与
  T3_report.md 记录完全一致——这是同一份历史台账，不是新采集，交叉核对通过）。
- **401 从不连续出现**：91 次 401 的 run-length 分布是 `{1: 91}`——没有任何一次
  是紧跟着另一次 401（对照：R1/v0.6 复核用「12 并发 burst」验证不出 429/401
  堆积，这与「401 从不连续」相互印证：如果是简单的高并发限速，应该更容易看到
  连续几次都被拦）。
- **401 与「调用间隔」强相关（新发现，此前三轮复核都没测过这个维度）**：78.9%
  的 401 发生在与上一次 aminer 调用间隔 > 30s 之后（60s 门槛下仍有 70%）；对照
  200 的调用只有 0.83%（30s 门槛）/ 0.75%（60s 门槛）前面隔了这么久——两组
  概率相差近 100 倍，不是噪音量级的差异。
- 91 次 401 之后紧跟的下一次调用 91/91 全部是 200（不能排除纯粹是 98.15% 底噪
  成功率的贡献——按此成功率算，91 次全部命中 200 纯属巧合的概率约 18%，不是
  决定性证据，但方向上与「间隔关联」一致）。
- 401 没有端点维度可分——台账只记 `host`（恒为 `datacenter.aminer.cn`），不记
  `search`/`getPaper` 哪个端点，无法进一步细分。

**结论（写进 `connectors/aminer.ts` 头部新注释，见「V73」小节）**：与 v0.6/R1
的「高并发触发限速」假说方向相反（该假说已被 12 并发 burst 实测 0 个 401 排除
过）；本轮从历史日志里回溯出一个新的、效应量很大的相关性——**401 更可能发生在
「空闲一段时间后恢复请求」的第一次调用上**，像是 AMiner 侧鉴权/会话在空闲后
需要重新握手。**如实交代**：这是历史日志的统计相关性，不是本 lane 现场用受控
空闲间隔做的因果复现实验（纪律要求只读这两个文件，不做改动性/实时探测）。

**判定为「可复现」（数据里有稳定统计模式，效应量达到数量级差异）**，按任务书
「可复现 → 修」执行：`AMinerConnector` 新增 `requestWithAuthRetry()`，401 只
重试一次（不无限重试——第二次仍 401 就原样抛出，真凭据失效时不会被掩盖成
「看起来正常」）。

### 单测（`tests/unit/w8_alpha_aminer_retry.test.ts`，新，4 条）

1. `search`：第一次 401、第二次 200 → 透明重试后成功，恰好发出 2 次请求。
2. `getPaper`：同上。
3. 连续两次 401（模拟真凭据失效）→ 不无限重试，恰好 2 次请求，原样抛出第二次
   的 `HTTP 401` 错误。
4. 非 401 失败（如 500）→ 不触发重试，只发 1 次请求，原样抛出 `HTTP 500`。

`bun test tests/unit/w8_alpha_aminer_retry.test.ts`：**4 pass / 0 fail**。

### 阴性对照（真跑）

把 `requestWithAuthRetry()` 临时改成直接 `return this.requestRaw(...)`（等价于
修复前行为，去掉重试），重跑同一份测试。

结果：**红**。
```
error: Connector "aminer" tool "search" failed: HTTP 401
(fail) 第一次 401、第二次 200 → search 透明重试后成功，只多发一次请求
error: Connector "aminer" tool "getPaper" failed: HTTP 401
(fail) getPaper 同样重试一次：第一次 401、第二次 200 → 成功
expect(calls).toBe(2)
  Expected: 2
  Received: 1
(fail) 连续两次 401（真凭据失效场景）→ 不无限重试，原样抛出第二次的错误
1 pass / 3 fail
```
改回，重跑：4 pass / 0 fail（绿）。

### 只读证据（统计脚本，未写入任何文件）

```python
import json
from collections import Counter
path = "/Users/jimmyclaw/.spark-research/api_calls.polluted-2026-09-11.jsonl"
aminer = [json.loads(l) for l in open(path, encoding="utf-8") if json.loads(l).get("connector") == "aminer"]
# ... 见本 lane 执行历史；只读聚合，未产生任何写操作
```
（现有 `~/.spark-research/projects/*/api_calls*.jsonl` 逐一 `find` 核实过不存在，
只有全局台账这一份可读。）

---

## 四、足迹

**改动**：
- `backend/src/literature/search.ts`：**未改动**（V67/V86 的结论是「维持现状」，
  见一、1.5 节；任务书允许改但决定不改，原因已写清）。
- `backend/src/literature/cli.ts`：只动了 `review` 输出段（`handle.note`、
  `out()` 差额行、observation record `content` 字段），未碰其它子命令。
- `backend/src/reviewer/citation_judge.ts`：新增 `CitationGapBreakdown` /
  `explainCitationGap()`，追加 import（`isReferenceEntry` / `CitationBaseline` /
  `ParsedCitation` 类型），未改动既有 `LlmCitationJudge` 逻辑一行。
- `backend/src/connectors/aminer.ts`：`search()`/`getPaper()` 改走新增的私有
  `requestWithAuthRetry()`，未改 `headersFor`/`token`/凭据降级逻辑。
- `tests/unit/w8_alpha_citation_gap.test.ts`（新）、
  `tests/unit/w8_alpha_aminer_retry.test.ts`（新）。
- `docs/devlog/W8-alpha.md`（本文件，新）。

**未碰**（任务书禁止列表）：`backend/src/index.ts`、`backend/src/reviewer/
rules.ts`、`backend/src/reviewer/agent.ts`、`backend/src/literature/reading.ts`、
`backend/src/raw/*`、前端、`backend/src/agents/contract.ts`（本 lane 差额分解
只落 observation record 的自由文本 `content`，没有触碰 `CitationIntegrityReview
Metadata` 类型定义，符合「不改禁止文件」）。

**测试隔离**：召回复测用 `mktemp -d` 出的临时 `SPARK_RESEARCH_DATA_DIR`
（`/private/tmp/claude-502/.../scratchpad/w8-alpha-recall.*`），未写
`~/.spark-research` 任何文件；V73 的统计只读了两份既有台账文件，`find` 核实过
`~/.spark-research/projects/*/api_calls*.jsonl` 不存在（没有可读的项目级台账）。

## 五、六套件数字（网络恢复后重新完整实跑，2026-09-12）

- `bun run typecheck`：`rc=0`，0 error。
- `bun test tests/unit`：`rc=0`，**2304 pass / 0 fail**（`Ran 2304 tests across
  161 files`）。基线（alpha.1）2296 + 本 lane 新增 8 条（`w8_alpha_citation_gap`
  4 条 + `w8_alpha_aminer_retry` 4 条）= 2304，逐一对上。
- `bun test tests/concurrency tests/timeout`：`rc=0`，**35 pass / 0 fail**，与
  基线 35 一致，无并行超时噪音，未触发「单独重跑」条款。
- `bun run test:py`：`rc=0`，**73 passed**（0 skip；`tests/lab` 26 + `tests/sim`
  47），与基线 73 一致。
- `bun run test:lab`：`rc=0`，单独跑 **26 passed**（0 skip），与基线 26 一致。
- `bun run test:e2e`：`rc=0`，**20 passed**，与基线 20 一致（本 lane 改了
  `lit review` 的 CLI 输出，`workbench.spec.ts` 的检索/引用相关用例全绿，确认
  未破坏前端集成路径）。第一次尝试因误留了一个后台 `bun run test:e2e` 进程
  抢占 4399 端口而 1 failed/3 did not run，`pkill` 清理残留进程后干净重跑一次即
  全绿——如实记录这次操作失误，不是代码回归。
- AD-12 门禁：`bun test tests/unit/narrative_parity.test.ts tests/unit/
  llms_txt.test.ts` → **21 pass / 0 fail**，两者均绿，未触碰 `docs/llms.txt`。

**阴性对照汇总表**：

| 编号 | 改法 | 结果 |
|---|---|---|
| V87-① | `explainCitationGap` 的自引分支判据改成 `if (false && isReferenceEntry(...))` | 红：`gap.selfReference` 期望 1 实收 0，3 pass/1 fail |
| V87-② | 去重分支删掉 `continue`（重复引用同时计入 duplicate 与 judged） | 红：函数自己抛穷尽性断言错误（`other=-1`） |
| V73-① | `requestWithAuthRetry()` 临时改回直接 `requestRaw()`（去掉重试） | 红：3 条用例失败（401 直接抛出 / 重试次数不对），1 pass/3 fail |

三条对照均**真跑**（先改代码、跑测试记录红、再改回、跑测试确认绿），过程见二、
三节。
