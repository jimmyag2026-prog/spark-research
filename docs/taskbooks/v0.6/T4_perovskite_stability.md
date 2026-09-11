# T4 · 钙钛矿太阳能电池稳定性（中文）

> B2 轮次任务书 · 语言：中文 · 预算：$2（LLM 实花，`maxCostUsd` 强制）
> 覆盖面：AMiner 中文 + 中英混合文献**去重**（同一工作的中英双发是本课题特有观测点）
> ⚠️ 排期约束：同 T3，AMiner key 到期前执行

## 研究问题（一句话）

钙钛矿太阳能电池的稳定性瓶颈（湿度/热/光致降解）与封装、组分工程对策的近三年进展是什么？

## 检索式

- AMiner 中文：`钙钛矿太阳能电池 稳定性`、`钙钛矿 封装 降解`
- 英文混检：`perovskite solar cell stability encapsulation`
- 主源：`--sources aminer` + 默认 6 源混合入库（刻意制造中英去重场景）

## 预列核心文献（召回率判据基准）

> ⚠️ 状态：**已冻结（2026-09-11）**——同 T1 纪律。基准含中英各若干，标注哪些是同一工作的双语版本。

| # | 标题 | 年份 | 来源标识 | 入选理由 |
|---|---|---|---|---|
| 1 | Research Progress in the Stability of Inorganic Perovskite Solar Cells（CN中文原版） | 2020 | AMiner 5f64918dd36f8db06e179c39 | 无机钙钛矿稳定性进展综述，中文权威发表；覆盖湿度热光致降解 |
| 2 | A Brief Survey on the Stability Study of Organometal Halide Perovskite Solar Cells（CN中文原版） | 2018 | AMiner 604b417d6f90b7f6cae2ad72 | 有机-无机杂化钙钛矿稳定性专题，中文发表基础文献 |
| 3 | Research Progress on the Stability of Perovskite Solar Cells（CN中文原版） | 2020 | AMiner 604b60b06f90b7f6cadb06de | 钙钛矿稳定性多角度综述，中文本地化研究汇总 |
| 4 | Halide Perovskite Photovoltaics: Background, Status, and Future Prospects | 2019 | https://doi.org/10.1021/acs.chemrev.8b00539 | 国际权威综述3091被引；稳定性机制与封装工程核心参考 |
| 5 | Consensus statement for stability assessment and reporting for perovskite photovoltaics based on ISOS procedures | 2020 | https://doi.org/10.1038/s41560-019-0529-5 | 稳定性测试标准与评价规范1788被引；近三年行业标准化工作 |
| 6 | Pseudo-halide anion engineering for α-FAPbI3 perovskite solar cells | 2021 | https://doi.org/10.1038/s41586-021-03406-5 | 组分工程稳定性提升3095被引；典型近三年封装+结构创新代表 |
| 7 | Efficient, stable and scalable perovskite solar cells using poly(3-hexylthiophene) | 2019 | https://doi.org/10.1038/s41586-019-1036-3 | 空穴传输层稳定性2319被引；封装与器件集成的实践案例 |
| 8 | Imperfections and their passivation in halide perovskite solar cells | 2019 | https://doi.org/10.1039/c8cs00853a | 缺陷钝化与稳定性1952被引；降解机制与对策的深层理论基础 |

**中英去重观测预期**：行#1-3为中文原版（AMiner）；行#4-8为英文（OpenAlex）。检索中未发现明确的同一工作双语版本对（中文发表可能集中在国内会议/期刊，AMiner覆盖较局限）。

## 执行脚本

按 §4 九步协议。**附加观测**：入库后检查 dedupe 行为——中英混检下同一工作是否被
正确合并或错误合并（W5-1 修过 `firstAuthorSurname` 错位，这是它的真实场景复验）。

## 成功判据

T1 的 5 条通用判据 + 第 6 条：中英去重行为有书面观测记录（正确/误合/漏合各计数）。
