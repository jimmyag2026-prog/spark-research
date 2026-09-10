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

> ⚠️ 状态：**待冻结**——同 T1 纪律：独立编制、开跑前冻结、执行者不参与。

| # | 标题（预期） | 判据 |
|---|---|---|
| — | 待冻结 | — |

## 执行脚本

按 §4 九步协议。**附加干实验步骤**：精读后用 scanpy 平台跑一次 `sc-cluster`
（内置示例数据集），产出 observation 进证据图，报告结论引用该 observation。

## 成功判据

T1 的 5 条通用判据 + 第 6 条：scanpy 干实验 observation 成功进证据图并被结论引用
（S2 修复路径的真实使用验证）。
