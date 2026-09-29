---
name: cross-domain-bridge
description: "跨领域桥接：把一个研究问题剥离领域术语写成结构签名，唤醒研究过同一结构的其他领域，并行派子代理以各领域资深研究者身份独立盲写迁移提案（带承重映射表），确定性脚本做同构审计与 Uzzi 门，两两 Elo 锦标赛排名，最后以各领域专家第一人称回复。触发：消息以「--cross-domain-bridge」或「/cross-domain-bridge」开头，或用户说「从其他学科找思路」「别的领域有没有现成解法」「这个问题在物理/经济/生态里叫什么」「帮我找同构问题」。"
version: 0.1.0
author: jimmy
license: MIT
tags: [research, ideation, cross-disciplinary, subagents]
---

# Cross-domain bridge（跨领域桥接）· Hermes 版

`SKILL_DIR` 指本文件所在目录。确定性部件在 `SKILL_DIR/scripts/bridge_tools.py`（零依赖 Python，`python3 SKILL_DIR/scripts/bridge_tools.py --help`）。
参考资料按需读：`SKILL_DIR/references/method_catalog.md`（可迁移方法目录）、`SKILL_DIR/references/historical_bridges.md`（历史跨领域突破）。

## 为什么这样做（读一遍，别当普通 brainstorm）

模型的知识按领域**词汇**分区存储：用生物学术语提问，唤醒的只是生物学分布，物理学里的同构解法在睡觉。
这条流程把人类跨学科协作里有实证的机制做成结构，而不是靠"多想想"：

| 阶段 | 做什么 | 依据 | 谁说了算 |
|------|--------|------|---------|
| ① 结构签名 | 剥掉术语，写成对象/关系/动力学/约束/目标/可观测量 | Galison trading zone；Heilmeier「不许用术语」 | 你写，**脚本**核对无术语 |
| ② 唤醒 | 哪些领域研究过这个结构、叫什么、标准解法 | 同一结构在不同领域名字不同 | 你 |
| ③ 盲写 | 每领域一个子代理，只看签名，写提案 + 映射表 | Janelia 独立小组；小团队挖老文献 | 子代理（`delegate_task` 天然互不可见） |
| ④ 审计 | 承重映射 ≥2、常规骨架 ≥2、一处非典型注入、伪证可排期 | Uzzi 2013：高影响 = 常规骨架 + 一处非典型注入 | **脚本** |
| ⑤ 锦标赛 | 两两对决、Elo 计分，评委只看两份 | co-scientist；Talk Isn't Always Cheap（群聊让正确者从众翻车） | 子代理裁决，**脚本**计分 |

## 铁律

1. 签名过不了脚本的术语门就重写，不许绕过、不许改术语表凑数。
2. 提案没有映射表就不是提案；承重对应不到两条脚本会杀，你不要替它求情。
3. 不按新奇度排序。评委 prompt 里明令不看新奇度。
4. 子代理之间**不许互看**：每个 task 的 context 只放签名和它自己的领域，绝不放其他领域的提案或名字。
5. 一切都是推断。references 是自由文本，不许说成已核实引用；最终回复末尾要写明。
6. 脚本返回退出码 1 = 校验失败，stdout JSON 的 `errors` 是原因。按原因改，不要静默跳过。

## 流程

### 0. 取参（你先填好，用户只做确认）

从用户消息里拿到问题陈述。**不要向用户抛开放式问题**——先自己把下面三样填好，用 `clarify` 一次性展示草稿请他确认或改，用户回「好」「可以」「跳过」或没回应就按草稿走：

- **术语表**：问题里最领域化的 3–8 个名词。作用是签名阶段的硬门：签名里一个都不许出现，逼你把问题翻成别的领域能读懂的话。你自己从问题里挑；用户给了就并入。
- **死路**：用户已经知道走不通的方向。这是模型没有、只有用户有的隐性知识，所以草稿里留空并明确问一句"有没有你已知走不通的方向？没有就空着"。提案撞上死路会被标出。
- **原领域**：问题属于哪个学科。你自己判断，用户改就改。作用是唤醒时避开它，审计时挡同域提案。
- **交叉领域探索**：你打算派哪几个领域的专家来写提案，先给一份初稿让用户看见、可增删。凭问题本身先猜（此时还没有签名），要求互不相同、尽量远离原领域、优先有成熟数学工具或老文献的领域。默认 4 个；用户说"多"给 6 个。评委对决数按 n(n−1)/2 涨，6 个领域 15 场。

草稿格式（一条消息说完）：

```
我打算这样跑，直接回「好」或改：
术语表：别构位点, 注意力图, 蛋白语言模型, 变构, 残基
原领域：结构生物学
交叉领域探索：统计物理（自旋玻璃/逆伊辛）/ 控制理论（可控性 Gramian）/ 实验设计与筛选统计 / 程序分析（故障定位）
死路：（你已知走不通的方向，没有就空着）
```

用户在"交叉领域探索"里增删了领域，就以他改过的为准；他加的领域即使你觉得近，也要派。

用户消息里若已含这些信息（任意写法），直接解析、不再确认。非交互场景（一次性 query、没法反问）按草稿直接跑，并在最终回复开头一句话交代你拟定的术语表与原领域。

建工作目录：`RUN=~/.hermes/cross-domain-bridge/runs/$(date +%Y%m%d-%H%M%S)`，`mkdir -p $RUN/proposals $RUN/verdicts`。把术语表、死路、原领域写进 `$RUN/card.json`。

### 1. 结构签名

写一个 JSON 到 `$RUN/signature.json`：

```json
{"objects":["≥2 个：系统里有哪些东西"],"relations":["它们之间什么关系"],"dynamics":"随时间/迭代怎么变（可数组）","constraints":["..."],"objective":"要优化/判定什么","observables":["实际能测到什么"]}
```

目标读者是**完全不懂该领域的另一位科学家**。专有名词（模型名、蛋白名、算法名）全部换成结构描述。然后：

```bash
python3 SKILL_DIR/scripts/bridge_tools.py signature $RUN/signature.json --terms "术语1,术语2,..."
```

退出码 1 → 按 `errors` 重写再跑，最多两轮；两轮仍不过就告诉用户术语表里哪个词太泛，停下。退出码 0 时 `rendered` 字段是签名的可读版，后面每个子代理都只拿这个。

### 2. 唤醒领域

以第 0 步用户确认过的"交叉领域探索"清单为基础，对着 `rendered` 给每个领域补齐：这个结构在该领域叫什么、标准解法是什么。签名写出来后若发现某个你自己猜的领域其实对不上这个结构，可以换掉，但要在最终回复里说明"原拟 X 换成了 Y，因为…"；**用户亲手加的领域不许换**。领域不够远就翻 `references/method_catalog.md` 逐条问"适用吗、哪条对应承重"。写进 `$RUN/fields.json`。

### 3. 并行盲写（子代理）

用 `delegate_task` 的 **batch 模式**，每批不超过 `delegation.max_concurrent_children`（本机 3），领域多就分两批。每个 task：

- `goal`：`你是「<领域>」领域的资深研究者。把你领域处理「<该结构在你领域的名字>」的方法（<标准解法>）迁移到下面的结构上，只输出一个 JSON 对象。`
- `context`：签名 `rendered` 全文 + 下面的输出契约 + 「用中文回答」。**不放**其他领域的任何信息。
- 输出契约（原样放进 context）：

```
只输出一个 JSON：
{"field":"你的领域","mechanism":"迁移机制","statement":"一句可证伪的话",
 "mapping":[{"source":"你领域的对象/关系","target":"签名里的对象/关系","relation":"保持的是什么关系","loadBearing":true}],
 "conventionalSkeleton":["至少 2 条常规、成熟的组合骨架"],
 "atypicalInjection":"只写一处非典型注入",
 "cheapFalsification":"下周就能做的最便宜伪证实验/计算，写清看到什么就算错",
 "literatureAge":"old|recent|mixed（优先挖 ≥10 年的冷门老文献）",
 "references":["自由文本，不要编 DOI"]}
要求：mapping 至少 2 条 loadBearing=true（断了整个迁移就不成立的对应）；高影响工作=常规骨架+一处非典型注入，不要堆新奇。
```

每个子代理的返回存成 `$RUN/proposals/<序号>-<领域>.json`（只保留 JSON 部分）。子代理返回不是 JSON 或明显缺字段，就对该领域**单独**再派一次并把缺什么写进 context；仍不行就记为"该领域未产出"，不要自己替它编一份。

### 4. 审计（脚本）

```bash
python3 SKILL_DIR/scripts/bridge_tools.py audit $RUN/proposals --dead-ends "死路1,死路2" --source-field "原领域"
```

输出 `passed`（带 id）/ `rejected`（带硬原因）/ `invalid`，并写出 `$RUN/proposals/_passed.json`。被否决的不进锦标赛，但原因要进最终回复。

### 5. 锦标赛（子代理裁决，脚本计分）

通过的 ≥2 份才办。先拿对决清单：

```bash
python3 SKILL_DIR/scripts/bridge_tools.py pairs $RUN/proposals/_passed.json
```

每场一个子代理 task（batch 模式，同样每批 ≤3）。`goal`：`你是评委，只看这两份提案，只输出 {"winner":"A"|"B"|"tie","reason":"一句话"}`。`context`：签名 + 提案 A 全文 + 提案 B 全文 + 评判维度：`承重映射是否真的保持了做功的关系；可检验性；非典型注入是否承重而非装饰。不按新奇度打分。不确定就 tie。`

把所有裁决汇成 `$RUN/verdicts/verdicts.json`：`{"verdicts":[{"a":0,"b":1,"winner":"b"},...]}`（a/b 用 pairs 给的 id），然后：

```bash
python3 SKILL_DIR/scripts/bridge_tools.py tournament $RUN/proposals/_passed.json $RUN/verdicts/verdicts.json
python3 SKILL_DIR/scripts/bridge_tools.py render     $RUN/proposals/_passed.json $RUN/ranking.json   # 先把上一条的输出存到 ranking.json
```

`complete=false` 说明有对决缺失，补派或在回复里说明。

### 6. 回复用户

结构固定：

1. 一段话：结构签名的可读版（让用户确认"翻译对了"）。
2. 按排名，每座桥一节，**以该领域专家第一人称**写：我是谁、我们领域怎么看这个结构、我的迁移主张（statement）、映射表（◆ 承重 / ◇ 装饰）、常规骨架与那一处非典型注入、我建议你下周做的廉价伪证、我依赖的文献年代。
3. 被否决的桥：领域 + 一句硬原因。未产出的领域也列出。
4. 排名表（`render` 的输出）。
5. 收尾固定两句：全部内容为模型推断，参考文献未核实；排名不是真伪，下一步是做排名靠前那座桥自己写的廉价伪证，或拿它去查新颖性。

## 反模式

- ❌ 把签名里的术语换成同义词就算"剥离"了。物理学家读不懂就不算。
- ❌ 一个子代理连写四个领域，或者把前一个领域的提案塞进下一个的 context。那是群聊，不是盲写。
- ❌ 提案不合格自己替子代理补一份。
- ❌ 评委一次看全部提案排序。只许两两对决。
- ❌ 拿 Elo 第一当结论。它没过新颖性核验，也没做伪证。
- ❌ 把 references 当真实引用转述给用户。

## 成本与时长

4 个领域：主模型约 3–4 次、子代理 4 个、评委 6 场，约 3 分钟到 8 分钟，视 `delegation` 配置的模型而定。6 个领域评委升到 15 场，只在用户明确要"多"时用。
