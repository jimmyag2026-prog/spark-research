---
name: scanpy
description: "单细胞 RNA-seq 标准分析闭环：以 dry-experiment 的仿真平台形态接入。质控 → 归一化 → 高变基因 → PCA → Leiden 聚类 → marker 基因排名，全程走 exp 状态机（假设驱动、断点续跑、iterate 对照）。用于「这个单细胞数据能分出几群细胞」「这个基因是不是某个细胞群的 marker」。"
category: experiment
domain: B
triggers: [这个单细胞数据能分出几群细胞, 跑一下单细胞聚类, 这个基因是不是这群细胞的 marker, 单细胞降维聚类]
connectors: []
platforms: [scanpy]
validation: [tests/unit/scanpy_contract.test.ts, tests/unit/scanpy_e2e.test.ts, tests/sim/scanpy_runner.test.py]
allowed-tools: [Bash, Read, Write]
---

# scanpy（单细胞 RNA-seq 标准分析）

## 何时用这个技能

- 有一个单细胞表达计数矩阵，想跑一遍标准流程看能分出几群细胞
- 想知道某个基因在哪个细胞群里富集表达，判断它是不是候选 marker
- 已经跑过一次，想换参数（分辨率、HVG 数量）重跑并保留两轮对照

**不适用**：批量 RNA-seq（没有单细胞分辨率）的差异表达 → `pydeseq2`；
代谢通量 → `cobrapy`；分子动力学 → `dry-experiment` 的 `openmm` 平台。

## 铁律（先读这段——本技能是 `dry-experiment` 的一个仿真平台形态）

1. **入口是 `spark-research exp new --platform scanpy`，不是新的 CLI 命令组。**
   单细胞流程的形状（QC 参数会导致完全不同的下游结果、聚类分辨率是一个需要试错的超参数、
   大数据集要跑几分钟）与 `dry-experiment` 现有平台完全吻合：需要假设、需要断点续跑、
   需要「换分辨率重跑」时用 `iterate` 而不是覆盖。复用状态机是唯一说得通的做法。
2. **先有可判定的假设，再跑聚类。** 「看看能分几群」不是假设。
   分辨率、HVG 数量这些超参数要写进假设的前提里——同一份数据换个分辨率能分出完全不同的
   群数，「分出了 8 群」这句话脱离参数是没有意义的。
3. **QC 阈值要写进假设的前提，不能事后调整凑出「好看」的结果。**
   `minGenesPerCell` / `minCellsPerGene` 决定了多少细胞与基因被保留——调阈值直到聚类
   「看起来对」是本技能的头号失效模式（与 `dry-experiment` 铁律 2「改小 steps 直到跑通」
   同一类问题）。summary 里的 `cellsFilteredOut` 必须进报告。
4. **marker 基因的统计显著不等于生物学意义。** `markers.csv` 同时给 `score` / `log2fc` /
   `padj`，报告里三者要一起给；只按 p 值排序前几名说事，在成千上万细胞的规模下毫无信息量。
5. **`deterministic: true` 是被测出来的，不是声称的。** runner 把 `sc.settings.n_jobs`
   钉成 1、PCA 用 arpack + 固定种子、leiden 传 `random_state`，`tests/unit/scanpy_e2e.test.ts`
   每次都跑两遍比字节。**它保证的是同一台机器上重跑逐位一致**，不保证跨机器/跨 BLAS 版本
   一致——跨机器复现请按数值区间对账。

## 用法

```bash
spark-research exp platforms                                  # 确认 scanpy 平台可用
spark-research exp new "PBMC 聚类" --platform scanpy \
    --param countsPath=/abs/path/counts.csv \
    --param minGenesPerCell=200 --param nTopGenes=2000 \
    --param nPcs=50 --param resolution=1.0 --param randomSeed=0 \
    --hypothesis "分辨率 1.0 下出现 ≥1 个 CD3D 高表达的独立细胞群"
spark-research exp run <id>
spark-research exp run <id> --resume                          # 进程被杀之后接上
spark-research exp iterate <id> --param resolution=0.5        # 换分辨率对照，新实验 supersedes 旧的
```

退出码 1 = 算例失败或参数非法。**不要**把它当成「跑完了」。

## 任务种类 `sc-cluster`

| 阶段 | 关键参数 | 备注 |
|------|---------|------|
| 输入 | `countsPath`（必填） | cells × genes 的计数 CSV，第一列是细胞 id，表头是基因名 |
| QC | `minGenesPerCell` / `minCellsPerGene` | 默认 200 / 3；过滤后不足 3×3 直接报错，不返回空结果 |
| 归一化 | `targetSum` + log1p | 默认 1e4，与上游标准流程一致 |
| 高变基因 | `nTopGenes` | 默认 2000 |
| PCA + 邻居图 | `nPcs` / `nNeighbors` | 默认 50 / 15。`nPcs ≥ nTopGenes` 时 prepare 会警告：PCA 无解 |
| Leiden 聚类 | `resolution` / `leidenIterations` / `randomSeed` | 默认 1.0 / 2 / 0，flavor=igraph |
| Marker 排名 | `rankMethod` / `nMarkersPerCluster` | 默认 wilcoxon / 10 |
| 降维坐标 | `computeUmap` / `nEmbeddingDims` | 默认 false / 5；false 时导出 PCA 坐标 |

产出：`clusters.csv`（细胞 → 簇）· `markers.csv`（簇 → top 基因 + score/log2fc/padj）·
`embedding.csv`（细胞 → 簇 + 降维坐标）。

**本平台目前的边界**（不是缺陷，是没做的事，别在报告里假装做了）：
只吃 CSV 计数矩阵，**不读 h5ad / 10X mtx**；**没有线粒体比例 QC**（`maxPctMt` 没实现）；
没有批次校正、没有细胞类型自动注释。需要这些请在 BACKLOG 里提，不要在 SKILL 里想象。

## 证据图

```
artifact record（clusters.csv / markers.csv / embedding.csv）  --derives_from--> experiment
observation（聚类数、marker 表、QC 前后细胞数）                 --derives_from--> experiment 与 artifact
conclusion                                                      --derives_from--> observation
新 experiment                                                   --supersedes-->   旧 experiment（iterate）
```

- experiment 的 `evidence` 是 `inferred`（参数与假设是设计出来的）
- observation 的 `evidence` 是 `computed`（结果是算出来的）
- 结论卡一律 `review: "pending"` —— 干实验不给自己发通过证

## 反模式

- ❌ 调 QC 阈值或分辨率直到聚类结果「看起来对」，再回头解释参数选择
- ❌ 只报 marker 基因的 p 值排序，不给 log2 fold change
- ❌ 把「分出了 N 群」当结论，不说明这是哪个分辨率、哪个 HVG 数下的结果
- ❌ 同一份数据反复重跑覆盖上一轮聚类结果（要对照就 `iterate`）
- ❌ 把 UMAP 坐标图上的视觉聚集当成统计显著性的证据
- ❌ 因为 `deterministic: true` 就以为跨机器也能逐位复现（它只保证同机重跑）

## 验证方式（AD-5）

- 契约测试：`tests/unit/scanpy_contract.test.ts` —— 复用 `tests/helpers/simulation_contract.ts`
  的参数化契约用例（与 pyref / openmm 逐字节相同的断言），外加两条本平台特有的：
  探测与真跑必须是同一条路径（V27）、依赖缺失必须报出安装命令
- e2e：`tests/unit/scanpy_e2e.test.ts` —— 离线合成数据集（三种细胞类型各 5 个专属 marker），
  断言**每组 marker 整组落在各自那一个 cluster 的 top-5 里**、聚类纯度 ≥ 95%，
  以及 deterministic 位与两次跑出来的字节一致性相符
- Python 侧：`tests/sim/scanpy_runner.test.py` —— probe() 的版本报告、输入校验的错误信息、
  失败一律落成 `done.json` 的 failed 信封
