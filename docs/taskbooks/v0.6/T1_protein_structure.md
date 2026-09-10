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

> ⚠️ 状态：**已冻结（2026-09-11）**——8 篇 OpenAlex/arXiv 独立编制基准，覆盖
> AlphaFold/ESMFold/RFdiffusion/ProteinMPNN 等领域里程碑。

| # | 标题 | 年份 | 来源 | 入选理由 |
|---|---|---|---|---|
| 1 | Accurate structure prediction of biomolecular interactions with AlphaFold 3 | 2024 | 10.1038/s41586-024-07487-w | Nature 发表；15609 引用；扩展 AF2 至配体-蛋白协同折叠，域内权威里程碑 |
| 2 | Evolutionary-scale prediction of atomic-level protein structure with a language model | 2023 | 10.1126/science.ade2574 | Science；5485 引用；ESMFold 开源框架，蛋白语言模型方向公认标杆 |
| 3 | De novo design of protein structure and function with RFdiffusion | 2023 | 10.1038/s41586-023-06415-8 | Nature；2219 引用；扩散模型蛋白设计的标志性工作，被广泛复现应用 |
| 4 | Fast and accurate protein structure search with Foldseek | 2023 | 10.1038/s41587-023-01773-0 | Nature Biotech；2573 引用；3D 结构搜索基础设施，生信数据库必备工具 |
| 5 | De novo design of luciferases using deep learning | 2023 | 10.1038/s41586-023-05696-3 | Nature；464 引用；ProteinMPNN/RFdiffusion 组合设计验证，设计可行性实证 |
| 6 | Illuminating protein space with a programmable generative model | 2023 | 10.1038/s41586-023-06728-8 | Nature；452 引用；蛋白生成式模型能力评估，探索蛋白空间结构 |
| 7 | ProGen2: Exploring the boundaries of protein language models | 2023 | 10.1016/j.cels.2023.10.002 | Cell Systems；463 引用；预训练语言模型在序列生成中的泛化能力分析 |
| 8 | Improving de novo protein binder design with deep learning | 2023 | 10.1038/s41467-023-38328-5 | Nature Commun.；398 引用；结合力设计验证，可用性评估代表作 |

## 执行脚本

按 `DEVELOPMENT_PLAN_v0.6.md` §4 每轮协议九步执行，模型 `z-ai/glm-5.3-flash`。

## 成功判据

1. ≥10 篇入库、精读卡全生成、综述过引用核验（hard finding = 0）
2. 2 张 idea 卡 + novelty check 完成（模型原判与校正判双留痕）
3. report export 产出可读报告，评审门槛走到 approved 或有明确 veto 理由
4. 成本 ≤$2 且 unknownCostCalls = 0
5. 指标表（§5）填写完整
