---
name: cross-domain-bridge
description: "跨领域桥接：把一个研究问题剥离领域术语写成结构签名 → 唤醒研究过同一结构的其他领域 → 每个领域独立盲写迁移提案（带承重映射表）→ 确定性审计（同构测试 + Uzzi 常规骨架/非典型注入门）→ 两两锦标赛排名 → 可选落成 Idea 卡。用于「别的领域有没有现成解法 / 帮我从其他学科找思路 / 这个问题在物理/经济/生态里叫什么」。"
category: ideation
domain: A
triggers: [别的领域有没有现成解法, 从其他学科找思路, 跨领域, 这个问题在别的领域叫什么, 帮我找类比, 有没有同构的问题]
connectors: []
validation: [tests/unit/bridge.test.ts, tests/unit/skill_frontmatter.test.ts]
allowed-tools: [Bash, Read, Write]
---

# Cross-domain bridge（跨领域桥接）

## 何时用这个技能

- 用户的问题在本领域卡住了，想知道别的领域有没有已经解过的同构问题
- 用户想系统地拿到"多个学科各自会怎么看这个问题"，而不是一次随机联想
- 立项前想找一个"常规骨架 + 一处非典型注入"形状的切入点

**不适用**：已经有成形假设想挑毛病 → `idea-coexplore`；想知道新不新 → `novelty-check`
（本技能产出的 Idea 卡可以直接拿去查）；只想找论文 → `literature-search`。

## 为什么这样设计（先读这段，别把它当成普通 brainstorm）

模型在预训练里见过所有领域，但知识的检索被**上下文词汇**触发：用生物学术语提问，唤醒的就是生物学
文献的分布，物理学里的同构解法睡着。这条管线不是"让模型多想想"，而是把人类跨学科协作里有实证的
机制一条条做成结构：

| 阶段 | 做什么 | 对应的人类经验 | 谁说了算 |
|------|--------|---------------|---------|
| ① 结构签名 | 把问题重写成不含领域术语的对象/关系/动力学/约束/目标/可观测量 | Galison 的 trading zone：先造 pidgin 再谈合作；Heilmeier 第一问"不许用术语" | 模型产出，**确定性代码**核对签名里不含用户声明的术语 |
| ② 多语言唤醒 | 对着签名问"哪些领域研究过这个结构、叫什么、标准解法是什么" | 同一结构在不同领域有不同名字（spin glass / Hopfield / attention） | 模型 |
| ③ 盲写 | 每个领域一次**独立**调用，看不到其他提案，必须写显式映射表并标承重 | Janelia 小组独立工作；Wu/Wang/Evans：小团队挖老文献才颠覆 | 模型，结构上保证无共享历史 |
| ④ 结构审计 | 承重映射 ≥2、常规骨架 ≥2、只许一处非典型注入、伪证方案可排期 | Uzzi 2013：高影响 = 极常规骨架 + 一处非典型注入；SESYNC 的 facilitator | **确定性代码** |
| ⑤ 锦标赛 | 两两对决 Elo 排名，评委每次只看两份 | co-scientist 的 idea tournament；"Talk Isn't Always Cheap"：群聊让正确的 agent 从众翻车 | 模型裁决，代码计分 |

## 铁律

1. **签名不干净就不许往下走**。带着原领域术语的签名等于没翻译，别的领域读不懂，唤醒出来的全是
   同域近邻。校验器会把命中的术语原样打回去。
2. **没有映射表的类比只是修辞**。每份提案必须逐条写"我领域的 X 对应你问题的 Y、保持的是什么关系、
   是否承重"。承重对应不到两条 = 表面相似，硬杀。
3. **不按新奇度排序**。审计层杀掉"全新奇"（常规骨架 < 2 条）；评委 prompt 明令不按新奇度判。
   与直觉相反，但这是 1790 万篇论文的实证结论。
4. **一切都是 inferred**。本技能不查文献库，references 是自由文本；落成 Idea 卡时 supporting /
   contradicting 全部标 inferred，contradicting 至少一条（承重映射尚未在目标域验证）。
   拿到卡以后**先跑 `novelty-check` 再当真**。
5. **失败要看得见**。某个领域两次都写不出合格提案 → 列进报告的「未能产出合格提案的领域」，不静默丢。

## 用法

```bash
# 最小调用：只给问题陈述
spark-research idea bridge -m "我想用蛋白语言模型的注意力图直接预测别构位点"

# 完整调用：声明术语（签名里不许出现）、死路（提案撞上会被标出）、原领域、领域数、直接落卡
spark-research idea bridge -m "<问题>" \
  --terms "别构位点,注意力图,蛋白语言模型" \
  --dead-end "只用序列保守性" --dead-end "MD 模拟穷举" \
  --source-field "结构生物学" --fields 6 --save

# JSON 输出（给上游 agent 用）
spark-research idea bridge -m "<问题>" --json
```

程序化调用：

```ts
import { BridgeSession, bridgeToIdeaCard, renderBridgeReport } from "backend/src/ideation/bridge";
const session = new BridgeSession({ llm, model, projectContext });
const report = await session.run(
  { statement, domainTerms: ["…"], deadEnds: ["…"], sourceField: "…" },
  { fields: 6, note: console.log },
);
renderBridgeReport(report);                 // markdown
const card = bridgeToIdeaCard(report.ranked[0]);   // → IdeaStore.create(card)
```

chat 里说「从其他学科找思路」会由编排层直接执行（`skill_runners.ts`），参数：`problem`（必填）、
`domainTerms[]`、`deadEnds[]`、`sourceField`、`fields`、`save`。

## 产出物

**桥接报告**（markdown / JSON）：结构签名、唤醒的领域表、通过审计的桥（按 Elo 排名，每个带假设 / 机制 /
映射表 ◆承重◇装饰 / 常规骨架 / 非典型注入 / 廉价伪证 / 文献年代）、被否决的桥及原因、未能产出提案的领域。

**Idea 卡**（`--save` 时，取排名前 3）：hypothesis = 提案的可证伪陈述；critique = 机制 + 映射表；
supporting / contradicting 全 inferred；openQuestions = 廉价伪证方案。novelty 状态 `unchecked`。

## 怎么把它用好（给 agent 的操作要点）

- **术语表决定签名质量**。用户没给 `--terms` 时，先从问题里挑 3–8 个最领域化的名词替他填上，
  再跑。术语表空着跑出来的签名多半只是换了几个同义词。
- **死路是人的隐性知识**，模型没有。问一句"哪些方向你已经知道走不通"，填进 `--dead-end`。
- **领域数 6 左右**。少于 4 视角不够；多于 8 锦标赛调用数按 n² 涨（6 个 = 15 场）。
- 报告里 `literatureAge=old` 的桥值得优先看——那是被遗忘的想法，撞车概率最低。
- 排名只是锦标赛结果，**不是真伪**。下一步永远是：对前几名跑 `novelty-check`，或先做它自己写的廉价伪证。

## 反模式

- ❌ 把签名里的术语换成同义词就算"剥离"了（"别构位点"→"变构位点"）。签名要让物理学家读得懂
- ❌ 只换 persona 不换视角：六个提案全是同一领域的近亲。唤醒阶段要求领域互不相同且远离原领域
- ❌ 让提案互相看见、"讨论后收敛"——那是群聊，正确的会被带偏。盲写是结构约束，不要在上层绕开
- ❌ 把 Elo 第一名直接当结论写进报告——它没过 novelty-check，也没做伪证
- ❌ 把 references 里的自由文本当成真实引用塞进综述。要引就先 `lit search` 入库拿 `[@key]`
- ❌ 为了凑领域数让模型编冷门学科——去重后不够数会报错，报错就减 `--fields`

## 验证方式（AD-5）

- 单测：`tests/unit/bridge.test.ts`——jargon 门、提案 schema、审计四条硬规则 + 两条软规则、Elo 锦标赛
  的确定性与排序、盲写的结构性隔离（每次提案调用的 messages 里不含其他提案）、重试回灌、
  失败领域如实列出、Idea 卡转换满足共探的 contradicting ≥1、runner 分发与缺参数提示
- frontmatter：`tests/unit/skill_frontmatter.test.ts`
- 参考资料：`references/historical_bridges.md`（用作回测基准的历史跨领域突破清单）、
  `references/method_catalog.md`（可迁移方法目录）
