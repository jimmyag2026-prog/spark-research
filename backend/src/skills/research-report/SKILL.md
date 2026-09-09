---
name: research-report
description: "研究报告导出：把一个项目的证据图（文献 / 思路 / 实验 / 观察 / 结论）渲染成带证据链接的 Markdown 报告，结论区受结论卡 review 门槛约束。用于「把这段时间做的事整理成一份能给人看的报告」「导出一份每条结论都能回溯到原始记录的材料」。也用于评审结论卡本身（review 门槛的操作入口）。"
category: report
domain: C/E
triggers: [整理成一份报告, 导出研究报告, 评审这张结论卡, 这个结论能不能写进论文]
connectors: []
validation: [tests/unit/report_export.test.ts, tests/unit/conclusion_review.test.ts, tests/unit/conclusion_rules.test.ts, tests/unit/demo_thread.test.ts]
allowed-tools: [Bash, Read, Write]
---

# Research report（证据图 → 研究报告）

## 何时用这个技能

- 一段研究做到一个节点，要把「问题 / 思路 / 实验 / 结论」整理成一份可交付的报告
- 需要一份**每条结论都能回溯到 record id** 的材料（给合作者、导师、审稿人看）
- 要评审结论卡：判断哪些结论可以对外说，哪些只能进「待验证」

**不适用**：写投稿用的综述 → `literature-review`（那是文献的组织，不是本项目产出的组织）；
想知道某条实验跑成什么样 → `spark-research exp status` / `lab status`。

## 铁律（先读这段）

1. **报告是证据图的投影，不是重新讲一遍故事。** 正文由代码渲染，**不经过模型**。
   不要「帮用户润色一下报告正文」再写回去——那等于给了模型一次改数据的机会。
   要改叙述就去改源头的 record（结论卡的 claim、实验的 hypothesis）。
2. **只有 `approved` 的结论进「结论」区。** 门槛看的是卡上**已经落下的** review 状态，
   不是「现在跑一遍检查器会通过」。没评审就是没评审，报告不替评审人按通过键。
3. **不许替用户 review。** `conclusion review` 会落一条记名的 decision record。
   你可以告诉用户「跑这条命令」，可以解释每条 finding 是什么意思，但不要用
   `--actor` 冒名顶替。评审是一个人对一条结论负责。
4. **hard finding 不可协商。** 三个检查器的 hard 全部是可核对的事实判断
   （证据不存在 / 类型不对 / 模拟数据没标注 / 在随机平台上声称逐位复现），
   不是审美问题。修的办法是补证据或改结论，不是找理由绕过去。
5. **模拟数据的标记不许在报告里消失。** 结论卡引用了 `simulated` 的 observation，
   报告里就带 `[模拟数据]` 标记与那句「模拟器不验证生物学」。
   把它删掉是把一份演练包装成实验结果。

## 用法

```bash
# 评审结论卡（门槛的操作入口）
spark-research conclusion list                       # 看有哪些结论卡、各自什么状态
spark-research conclusion show <id>                  # 看一张卡 + 「现在重新评审会是什么结果」
spark-research conclusion review <id> --actor 张三    # 跑检查器并落判定（记名）
spark-research conclusion review <id> --actor 张三 --veto "对照组不成立"   # 人工否决

# 导出报告
spark-research report stats                          # 先看统计：有多少结论还卡在 pending
spark-research report export                         # 打到 stdout
spark-research report export --out report.md         # 写文件
spark-research report export --verbose                # 把 record 正文整段嵌进去
```

HTTP：`GET /api/report?format=markdown`（工作台右上角「导出报告」按钮走的就是它）、
`GET /api/conclusions`、`POST /api/conclusions/:id/review`（**必须显式传 actor**，
HTTP 层没有环境变量兜底）。

退出码：`conclusion review` 被否决时返回 1。**不要把它当成命令失败**——
它是「这条结论没通过」，是一个有意义的结果。

## 三个检查器（结论卡评审跑的就是这三条）

| rule | 严重度 | 检查什么 |
|------|--------|---------|
| `data-consistency` | hard / soft | 结论引用的 observation 是否真实存在于执行记录：断链、跨项目、类型不对 = hard；没有执行锚点、图上没连边 = soft |
| `capability-labeling` | hard | 模拟读数没标注 = hard；在非确定性平台上声称逐位复现 = hard |
| `stats-plausibility` | **只有 soft** | 启发式：样本量过小、多重比较未校正、p 值边缘（0.04–0.05）、结论强度超过数据支撑 |

**`stats-plausibility` 是启发式，误报与漏报都在预期内。** 它不是统计审稿人，
是一个「这里值得再看一眼」的提示。看到它的 finding 不要直接改数字去迎合它。

判定规则只有一条：**任一 hard → vetoed，零 hard → approved**。没有「人工推翻 hard」的路；
反方向可以——`--veto` 让人挡下一条本来会自动通过的结论。

## 能力位在报告里的措辞（G4）

| 能力位 | 来源 | 报告里怎么说 |
|--------|------|-------------|
| `deterministic: true`（pyref） | 仿真平台 | 「逐位重算对账」——同参数重跑应逐位一致 |
| `deterministic: false`（OpenMM） | 仿真平台 | 「区间/趋势对账」——只保证落在同一区间，**不**声称逐位可复现 |
| `simulated: true`（opentrons_simulate / mock） | 湿实验后端 | 结论标题挂 `[模拟数据]`，并写明模拟器不验证生物学 |

混合证据取最保守的一条：只要有一条来自非确定性平台，整条结论就按区间对账写。

## 报告结构

```
一、问题      项目描述 + 思路卡里的 openQuestions + 文献基础统计
二、思路      每张 idea 卡：假设 / novelty 状态 / 支持与反对文献（走 supports / contradicts 边）
三、实验      干湿实验：状态、平台或后端、假设、结果摘要、观察（带能力位注记）
四、结论      **只有 approved**：主张 / 评审记录 / 可复现性口径 / 逐条证据 / 局限 / soft 提示
五、待验证    pending 与 vetoed：为什么没进结论区（逐条 hard finding）
附录 A        证据索引：报告里出现过的全部 record id → 类型 / 证据标签 / 标题
附录 B        参考文献（库内论文，key 与 `lit export --format bibtex` 一致）
```

## 反模式

- ❌ 用模型重写报告正文再存回去（数据会在润色中变形）
- ❌ 替用户 `conclusion review --actor <某人>`
- ❌ 把 `report export` 的退出码 0 说成「结论都通过了」——结论区可能是空的
- ❌ 为了让报告好看，把 `[模拟数据]` 标记或「模拟器不验证生物学」那句删掉
- ❌ 看到 `stats-plausibility` 的 soft finding 就去调整样本量描述来消掉告警
- ❌ 把「检查器现在会通过」当成「已经通过」写进对外材料

## 证据图

```
decision(conclusion_review) --derives_from--> conclusion   （谁 / 何时 / 判了什么 / 依据哪些 finding）
conclusion                 --derives_from--> observation   （证据）
conclusion                 --derives_from--> experiment
observation                --derives_from--> experiment / artifact record
paper                      --supports/contradicts--> idea
```

报告里每条 `record ...` 都是这张图上的一个节点 id，可用
`spark-research conclusion show <id>` 或 `GET /api/records/<id>/graph` 展开。

## 验证方式（AD-5）

- 检查器单测：`tests/unit/conclusion_rules.test.ts` —— G2 断链 / 已删除 / 跨项目 / 类型不对
  四种对抗 + G4 模拟未标注与逐位声明 + G3 四类启发式（含阴性对照「干净结论零 finding」）
- review 门槛：`tests/unit/conclusion_review.test.ts` —— approved/vetoed 判定、人工否决、
  重新评审会翻面、`assess` 不写库、CLI 退出码
- 报告导出：`tests/unit/report_export.test.ts` —— 分区归属（approved vs pending/vetoed）、
  证据链接可回溯、能力位措辞、空项目不崩
- 全链路：`tests/unit/demo_thread.test.ts`（`scripts/demo-research-thread.ts` 的可重放脚本）
  —— 文献 → idea → novelty → 干实验 → 结论 → review → 报告
