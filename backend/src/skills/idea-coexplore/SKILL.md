---
name: idea-coexplore
description: "思路共探：围绕用户的研究想法做苏格拉底式批判性探讨，每个观点都锚在项目文献库里的真实论文上（[@key]）或显式标注 inferred，产出结构化 Idea 卡入思路库。用于「我有个想法，帮我想清楚 / 帮我挑毛病 / 这个方向值不值得做」。"
category: ideation
domain: A
triggers: [我有个想法, 帮我挑毛病, 这个方向值不值得做, 陪我想清楚这个假设]
connectors: []
validation: [tests/unit/ideation.test.ts, tests/unit/ideation_cli.test.ts]
allowed-tools: [Bash, Read, Write]
---

# Co-explore（思路共探）

## 何时用这个技能

- 用户抛出一个还没成形的研究想法，需要人帮他想清楚
- 用户要你**挑毛病**：这个方向哪里会塌、谁已经做过、最便宜的证伪实验是什么
- 用户已有一段草稿式的思路，需要基于文献的批判性反馈

**不适用**：只想找几篇论文 → `literature-search`；想知道这个 idea 新不新 → `novelty-check`
（先用本技能出卡，再拿卡去查）；想写综述 → `literature-review`。

## 铁律（先读这段）

1. **你的角色不是鼓励师**。每一次回应都必须至少给出一条**反对或复杂化**的证据。
   给不出反面证据时要明说「库里没有反证」，并把复杂化点标成 `(inferred)` 写清推理过程——
   沉默不是同意，是漏了一次检查。管线会拒绝 `contradicting` 为空的卡。
2. **每个实质性观点带来源**：`[@key]`（库内论文）或显式 `(inferred)`。没有第三种。
   「众所周知」不是来源。
3. **只能引用项目文献库里的论文**。库外的文献无论多真、你多确定它存在，都不能引——
   读者没法从这个项目里核对它。要引它就先 `lit search`/`lit add` 入库。
4. **不要替文献说话**。库里那条记录没写的结论、数字、baseline，就当它没说。

## 用法

```bash
# 单条消息模式（适合已经想清楚要问什么）
spark-research idea new -m "我想用蛋白语言模型的注意力图直接预测别构位点"

# 多轮交互（适合边聊边收敛；/card 定卡入库，exit 退出）
spark-research idea new

# 看思路库
spark-research idea list
spark-research idea list --status unchecked
```

程序化调用：

```ts
import { CoExploreSession } from "backend/src/ideation/coexplore";
const session = new CoExploreSession({ llm, library, records, projectContext });
const turn = await session.turn(message, { history });   // 只讨论，不落库
const stored = session.save(turn.card, { sessionId });   // 定卡入库
```

## 产出物：Idea 卡

| 字段 | 含义 |
|------|------|
| 假设陈述 | 收敛成一句**可证伪**的话 |
| 支持文献 | `[@key]` + 为什么支持 |
| 反对 / 复杂化证据 | `[@key]` 或 `(inferred)` + 为什么反对。**至少 1 条** |
| 待验证点 | 还没被证据回答、必须先验证的点 |
| novelty 状态 | `unchecked` → 跑过 `novelty-check` 后变 `checked-*` |

落成一条 `idea` record（`evidence=inferred`），并建证据边：

```
paper --supports--> idea        （这篇论文支持这条思路）
paper --contradicts--> idea     （这篇论文反对/复杂化这条思路）
```

边的方向按**语义**读（「A 支持 B」），所以论文是起点。查一条 idea 的支撑文献 = 看它的 incoming 边。

## 有用的苏格拉底动作

- **收紧**：把「我想做 X 方向」变成「若 M 机制成立，则在 D 数据上应观察到 O」
- **定位**：这条思路最接近哪一条已有工作线？差在哪一步？
- **进攻**：它最可能怎么塌？谁已经试过类似的？
- **成本**：下周就能做的最便宜的证伪实验是什么？

## 反模式

- ❌ 用「这是个很有意思的方向」开头然后顺着用户说下去——那不是共探，是复读
- ❌ 因为库里没有反证就不给反对意见（应该说清「库里没有反证」并给出推断性的复杂化点）
- ❌ 引用一篇你「记得存在」但库里没有的经典论文（这是伪造引用，schema 校验会拒）
- ❌ 把 `(inferred)` 当成万能豁免：整张卡全是推断会被拒（库非空时至少要有一条文献支撑）
- ❌ 库为空时假装有证据基础——应该先说「这次共探没有文献基础，建议先入库」
- ❌ 把「待验证点」写成客套话（「需要更多实验」）；它应该是具体到可以排期的

## 验证方式（AD-5）

- 单测：`tests/unit/ideation.test.ts`（schema 硬门、grounding、重试与拒绝、证据边方向、思路库读写）
- CLI：`tests/unit/ideation_cli.test.ts`（`-m` 模式、交互式 `/card`、空库警告、失败退出码）
- e2e：`tests/unit/novelty_e2e.test.ts` 里共探出的 idea 卡直接进 novelty check 全链路
