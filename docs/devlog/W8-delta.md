# W8-δ · 文献核验（V92 · V13 · V14 · V51）

lane：`W8-1 δ`（波次 v0.8 W8）· 分支：`lane/W8-1-delta`
设计真源：`lanes/_COMMON.md`（共同纪律）· `lanes/W8-delta.md`（本 lane 任务书）

---

## 一、V92 · 中文引用 key 可见

**问题**：`backend/src/reviewer/rules.ts` 的 `CITATION_TOKEN` 只认 `[A-Za-z0-9_\-:]`。
库内不少 bibtex key 是中文作者名+年份+关键词拼出来的（如 `[@李某2023神经解码]`），
旧正则对这类引用标记整条视而不见——不是「解析出来但查不到库」，是**根本没被
`matchAll` 命中**，两道核验门（① 库外 key 存在性判断、② 送进 judge 的输入提取）
都看不到它，比「库外 key」还糟：连"这条引用被查过、没通过"的记录都不会留下。

**修复**：字符类里加 `\p{Script=Han}`（首字符与续字符两处），正则配 `u` 标志。
`u` 标志下已有的 ASCII 字符类语义不变（`\-` 仍是合法的连字符转义）——手工验证过
中英混排、多 key 一括号（分号/逗号并列）、标点粘连、纯 ASCII key 四种形态，加
`u` 前后 ASCII 路径的解析结果完全一致。

**阴性对照**（`tests/unit/w8_delta_citation_han.test.ts`）：
把修复前的 `CITATION_TOKEN`（原样摘出，仅 ASCII、无 `u` 标志）作为 `PRE_V92_CITATION_TOKEN`
留在测试里做参照物，对同一句"库外伪造中文引用"跑一遍——

| 场景 | 修复前（PRE_V92_CITATION_TOKEN） | 修复后（真实 citationIntegrity） |
|---|---|---|
| `[@张三2099不存在文献]`（库外伪造，中文 key） | 0 处匹配，`unknownKeys` 恒为空——**静默放过（红）** | 正确解析出 1 条引用，`unknownKeys=["张三2099不存在文献"]`，产出 hard finding（**绿**） |
| `[@李某2023神经解码]`（库内中文 key，陈述与卡片冲突） | 引用标记整体不可见，judge 从未被调用 | judge 收到 `{key:"李某2023神经解码", statement:...}`，产出 `citation_conflict` soft finding |

两条都是真跑（不是描述性断言）：见该测试文件 3 个 test，`bun test` rc=0。

---

## 二、V14 · 位置加权豁免白名单

**问题**：`applyLocationWeight`（`backend/src/reviewer/agent.ts`）原来靠一条内联
`if (f.rule === CITATION_RULE) return f;` 把 citation-integrity 排除在「figure/report
里 soft 升 hard」之外——豁免名单只存在于这一行个例判断里，看不出这是一份需要维护
的清单，也没有地方写「为什么豁免」。

**修复**：显式化成 `export const LOCATION_WEIGHT_EXEMPT: Set<string>`（agent.ts），
逐条注释理由；`applyLocationWeight` 改成 `if (f.rule && LOCATION_WEIGHT_EXEMPT.has(f.rule)) return f;`。
对现有行为零影响（唯一一条 exempt 规则不变），只是把隐式判断变成显式数据。
`export` 是为了让阴性对照③能直接操作生产代码里的**同一个**对象，而不是在测试里
另写一份重复判定逻辑。

**阴性对照**（`tests/unit/w8_delta_location_weight.test.ts`，3 个 test）：

| # | 改法 | 结果 |
|---|---|---|
| ① | 真实白名单（含 `CITATION_RULE`）+ `.md`（report）里的强断言无引用 soft finding | 保持 soft（绿，白名单生效） |
| ② | 同一份 `.md` 里 lineage 的 `version_mix`（无 `rule` 字段，不在白名单里） | 从 soft 升级为 hard（白名单外照常加权） |
| ③ | 对①同款 finding：真跑 `reviewer.review()`，**清空** `LOCATION_WEIGHT_EXEMPT`（同一个生产对象，`.clear()`） | citation soft finding 被真实升级为 hard（**红**）；`finally` 里恢复白名单后再跑一遍，回到 soft（**绿**） |

③ 是对生产代码里那个真实 `Set` 对象直接操作，不是重新实现一份判定逻辑——
证明白名单是真正在起作用的那道闸，不是摆设。`bun test` rc=0。

---

## 三、V51 · probe 归位

**做了什么**：
- 新建 `backend/src/simulation/probe.ts`：`probeCodeFor`/`datasetParam` 从
  `simulation/scanpy/probe.ts` **纯移动**过来（函数体逐字未改，只是 `../models` →
  `./models` 的相对路径跟着挪）。原文件头注释早就预告过这是"收口时的一次纯移动"。
- 删除 `backend/src/simulation/scanpy/probe.ts`。
- 三处 import 行改指顶层：`scanpy/index.ts`（`"./probe"` → `"../probe"`）、
  `pydeseq2/index.ts`、`cobrapy/index.ts`（两者 `"../scanpy/probe"` → `"../probe"`）。

**单测**（`tests/unit/w8_delta_probe.test.ts`）：
- 「三平台探测代码由同一函数生成」：`ScanpyPlatform`/`PyDESeq2Platform`/`CobraPyPlatform`
  三个平台实例的 `probeCode()`（下标访问 protected 方法）逐字符等于独立调用
  `probeCodeFor(entryPoint, id, hint)` 的结果；再用去掉平台专属 token 后的"骨架"
  逐行比较，确认三者控制流结构相同（不是长度凑巧一样）。
- 「doctor 探测与平台探测字符串相等」：用系统自带 `/usr/bin/python3`（天然缺
  `openmm`，与 `tests/unit/doctor.test.ts` 同一个环境假设）分别跑
  `new SimulationRegistry({root, python}).get("openmm").available()` 与
  `buildDoctorReport({python, simulationRoot: root, ...})`，断言两条路径产出的
  失败原因字符串逐字相同——doctor 的 science 档探测没有另外维护一份 openmm 探测
  逻辑，走的就是平台自己的 `probeCode()`。
- `datasetParam` 搬家后必填 / 扩展名 / 文件存在性三条校验行为不变。

`bun test` rc=0，9 个新 test 全绿（含 V92/V14/V51 三个文件共 9 个 test）。

**足迹偏差（如实交代，见报告正文「⑤」）**：`openmm/index.ts` 目前仍是内联探测
字符串（未接 `probeCodeFor`）。任务书写「scanpy/pydeseq2/openmm 三处 import 改指
顶层」，但实测 openmm 从未经由 `scanpy/probe.ts` 过（它是独立内联实现），要接上
`probeCodeFor` 需要替换 `probeCode()` 方法体（~11 行），超出任务书给本 lane 的
「各平台对 probe 的 import 行」这一条足迹许可（`openmm/index.ts` 属于「`simulation/*`
其他文件（β）」，禁止列明）。没有直接改，diff 写进报告正文交收口合入。
`cobrapy/index.ts`、`pydeseq2/index.ts` 里各有一行注释仍写着
`../scanpy/probe.ts 的 probeCodeFor 注释（V27）`（指向已删除的文件），同样只是
注释、不在「import 行」许可范围内，未直接改，一并列进收口 diff。

---

## 四、V13 · 凭空归因口径——已尝试定位真实样本，未找到可支撑改动的实例，明确关闭

**任务书要求**：用 R1–R4 真实样本找「草稿给出卡片里没有的归因解释」的实例 ≥ 3 条，
然后**要么**改 prompt 并用这些样本做回归测试，**要么**明确关闭（写理由 + 误报风险）。
不许两头都不做。

**实际做的事**（只读，未写入任何文件到样本目录）：
1. 读了 `~/Desktop/AI4S/spark-research-v0.7-plan/R4/` 四份任务报告
   （T1–T4_report.md）与 `SUMMARY.md`：四个课题的 `lit review` 输出显示
   **citation-integrity 在真实 R4 全量复跑里是 0 hard / 0 soft finding**（T1：
   引用 10 条/解析 76 处/判定 64 处，0/0；T2–T4 同样 0/0，见 SUMMARY.md 表格与
   第 45 行"解析数>判定数"发现）。
2. 抽查了 4 份真实综述草稿的全文（`~/.spark-research/projects/r4-t1/r4-t2/r4-t3`
   的 `artifacts/review-draft-2026-09-11.md`，以及 `~/Desktop/AI4S/spark-research-v0.6-plan/R2`
   对应的 `t4-pero-r2` 项目），逐条核对其中带有明确因果归因措辞的陈述
   （"作者将其归因于……"、"这一结果表明……"）与 `records.db` 里对应精读卡的
   `core.txt`/`limitations` 字段——包括 `[@li2020study]` 的"精度-模型悖论"、
   `[@y2026unified]` 的 PRIScore 提升幅度、`[@yang2020research]` 的"碳电极归因于
   碳阻挡水分"等具体数字与归因表述——**逐条都能在对应精读卡里找到原文依据**，
   没有一条是卡片没写、草稿自己编出来的。
3. `~/Desktop/AI4S/spark-research-v0.6-plan/R1/R3` 的 novelty-check
   （`check1.json`/`check2.json`）与 `t1x_final_report.md` 的 co-explore 记录
   同样没有发现"库内证据表明"式的凭空归因——反而看到 coexplore 的输出里已经
   显式声明"任何声称库内证据表明……的引用都是捏造，我不会做这种引用"。

**结论**：抽样范围内（R1–R4 四课题的综述草稿 + 两份更早期项目的草稿，共约
6 份带引用的产出物，人工核对 20+ 条具体归因陈述）没有找到 1 条真实的"凭空归因"
实例，更谈不上 ≥3 条——达不到任务书要求的证据门槛，因此**不改 `agents/prompt/*`**。

**为什么不是"没找就算了"**：`coexplore.txt` 已经有等价的显式禁令（"Do not invent
findings, numbers, or baselines... If the library entry does not say it, do not
claim it."），`research.txt`/`literature.txt` 目前没有同等措辞。如果在没有真实
失败样本的前提下现在就加，风险是**把没有事实基础的约束堆到 prompt 里**：
- 误报风险：现有机制（`STRONG_CLAIM_PATTERNS` 强断言检测 + `LlmCitationJudge`
  的 conflict 判定，其 system prompt 已经写明"声称了卡片里明确没有的结果"才算
  conflict）已经覆盖这一类问题的检测面；在 prompt 层再加一条几乎同义的强约束，
  容易让模型对"合理概括"（卡片说"支持"，草稿写"表明有效"这类程度用词差异）
  过度收紧，反而增加误伐——而误伐的代价（drop 掉本来站得住的推断）在综述这类
  产出上并不比漏报更便宜。
- 需要真实反例才能校准："凭空归因"与"合法概括"的边界本身就是判断题，没有
  真实失败案例，写进 prompt 的例子只能是我编的，起不到"用真实案例区分两者"
  的效果（任务书原话）。
- SUMMARY.md 第 45 行记录的「解析引用数 > 判定数」缺口（T1 76/64、T2 86/73、
  T3 59/49、T4 113/98）是一条相关但不同的开放问题——citation-integrity 本身
  的解析/判定链路有多少条引用没被送进 judge、去向不明，这个缺口如果掩盖了
  本该被抓到的 conflict，会让"citation-integrity 全是 0/0"这个漂亮数字产生
  误导。这个问题不在本 lane 任务书范围内（不是 V92/V13/V14/V51 任何一条的
  文字描述），如实记在这里，留给后续 lane 或收口决定是否立项。

**是否需要收口动作**：不需要——本节是"关闭"决定的记录，没有产生需要合入的 diff。

---

## 五、测试隔离

所有新测试用 `mkdtempSync(join(tmpdir(), ...))` 现建临时目录（`ArtifactStore`/
`SimulationRegistry`/`buildDoctorReport` 的 root 全部指向临时目录），R1–R4 样本
与 `~/.spark-research/projects/*` 全程只读（`sqlite3 ... select`、`cat`/`grep`），
未写入任何字节。`bunfig.toml` 的 `SPARK_RESEARCH_DATA_DIR` preload 隔离对这批
新测试同样生效（未绕过）。

## 收口补记（主会话，2026-09-12）
- `cobrapy/index.ts`、`pydeseq2/index.ts` 两处过期注释已改指 `../probe.ts`。
- **openmm 未接 `probeCodeFor`**：收口尝试按 lane 给的 diff 替换 `probeCode()`，实测 openmm 的 `runner.py` 没有 `probe()` 入口（`module 'spark_probe_openmm' has no attribute 'probe'`），探测恒失败 → P5 契约测试整套 13 条 skip。已还原为内联探测。要接上需给 openmm runner 加 `probe()`（python 侧，V51 残余登记 BACKLOG）。
- 主会话复跑：typecheck 0 · unit 2331 全跑无 skip（见 PR）· concurrency+timeout 35/0。
