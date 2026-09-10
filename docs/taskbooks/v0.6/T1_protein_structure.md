# T1 · 蛋白结构预测与设计近三年进展（EN）

> B2 轮次任务书 · 语言：英文 · 预算：$2（LLM 实花，`maxCostUsd` 强制）
> 覆盖面：literature 全链路 + protein-analysis 技能；若产出结构数据 → 触发 A3（3D 视图）评估

## 研究问题（一句话）

2023–2026 年蛋白质结构预测与从头设计（AlphaFold 系及后继）的方法学进展与开放问题是什么？

## 检索式

- `protein structure prediction deep learning` （2023-2026）
- `de novo protein design diffusion model`
- `AlphaFold3 co-folding ligand`
- 源：默认 6 源集合（openalex/crossref/europepmc/semanticscholar/arxiv/pubmed）

## 预列核心文献（召回率判据基准）

> ⚠️ 状态：**待冻结**——R1 开跑前由独立子代理用免费源编制 5–8 篇、与轮次执行隔离，
> 冻结后填入下表并 commit；轮次执行者不得参与编制。

| # | 标题（预期） | 判据 |
|---|---|---|
| — | 待冻结 | — |

## 执行脚本

按 `DEVELOPMENT_PLAN_v0.6.md` §4 每轮协议九步执行，模型 `z-ai/glm-5.3-flash`。

## 成功判据

1. ≥10 篇入库、精读卡全生成、综述过引用核验（hard finding = 0）
2. 2 张 idea 卡 + novelty check 完成（模型原判与校正判双留痕）
3. report export 产出可读报告，评审门槛走到 approved 或有明确 veto 理由
4. 成本 ≤$2 且 unknownCostCalls = 0
5. 指标表（§5）填写完整
