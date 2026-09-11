# T2 · 单细胞转录组聚类方法比较（EN）

> B2 轮次任务书 · 语言：英文 · 预算：$2（LLM 实花，`maxCostUsd` 强制）
> 覆盖面：literature 全链路 + scanpy 平台干实验闭环（`sc-cluster`）

## 研究问题（一句话）

单细胞 RNA-seq 聚类方法（Leiden/Louvain 系与深度学习系）的基准比较结论是什么，
分辨率选择与批次效应如何影响聚类稳定性？

## 检索式

- `single-cell RNA-seq clustering benchmark`
- `scRNA-seq Leiden Louvain comparison`
- `clustering stability batch effect single cell`
- 源：默认 6 源集合

## 预列核心文献（召回率判据基准）

> ⚠️ 状态：**已冻结（2026-09-11）**——同 T1 纪律：独立编制、开跑前冻结、执行者不参与。

| # | 标题 | 年份 | 来源标识 | 入选理由 |
|---|---|---|---|---|
| 1 | SCANPY: large-scale single-cell gene expression data analysis | 2018 | https://doi.org/10.1186/s13059-017-1382-0 | 主流单细胞分析平台，9816被引；内置Leiden聚类作基准 |
| 2 | From Louvain to Leiden: guaranteeing well-connected communities | 2019 | https://doi.org/10.1038/s41598-019-41695-z | Leiden算法原始论文，5552被引；直接解决任务关键的Leiden vs Louvain对标 |
| 3 | Fast unfolding of communities in large networks | 2008 | https://doi.org/10.1088/1742-5468/2008/10/p10008 | Louvain算法基础方法，21717被引；community detection领域标志性工作 |
| 4 | Current best practices in single‐cell RNA‐seq analysis: a tutorial | 2019 | https://doi.org/10.15252/msb.20188746 | 单细胞分析best practice综述，2471被引；涵盖聚类稳定性与参数选择 |
| 5 | Batch effects in single-cell RNA-sequencing data are corrected by matching mutual nearest neighbors | 2018 | https://doi.org/10.1038/nbt.4091 | 批次效应纠正方法，2792被引；直接支撑"批次效应如何影响稳定性"子问题 |
| 6 | Normalization and variance stabilization of single-cell RNA-seq data using regularized negative binomial regression | 2019 | https://doi.org/10.1186/s13059-019-1874-1 | 标准化与方差稳定，5096被引；前置处理对聚类稳定性的影响 |
| 7 | A benchmark of batch-effect correction methods for single-cell RNA sequencing data | 2020 | https://doi.org/10.1186/s13059-019-1850-9 | 批次校正benchmark比较，1247被引；系统性评估批次方法的聚类效果差异 |
| 8 | Clustering trees: a visualization for evaluating clusterings at multiple resolutions | 2018 | https://doi.org/10.1093/gigascience/giy083 | 分辨率多层级可视化与评估，1211被引；直接支撑"分辨率选择"的判据 |

## 执行脚本

按 §4 九步协议。**附加干实验步骤**：精读后用 scanpy 平台跑一次 `sc-cluster`
（数据集自备：合成一个小型 counts CSV 即可——R2 实测澄清：平台不带内置示例数据集，任务书早先的说法有误），产出 observation 进证据图，报告结论引用该 observation。

## 成功判据

T1 的 5 条通用判据 + 第 6 条：scanpy 干实验 observation 成功进证据图并被结论引用
（S2 修复路径的真实使用验证）。
