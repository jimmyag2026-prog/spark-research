---
name: pydeseq2
description: "批量 RNA-seq 差异表达分析：以 dry-experiment 的仿真平台形态接入 PyDESeq2（size factor → dispersion → Wald 检验 → FDR 校正）。给定计数矩阵与样本表，输出差异基因表与 size factor，走 exp 状态机（假设驱动、断点续跑）。用于「处理组和对照组哪些基因表达有显著差异」。"
category: experiment
domain: B
triggers: [处理组和对照组哪些基因有差异表达, 跑一下 DESeq2, 这批 RNA-seq 有哪些显著变化的基因, 差异表达分析]
connectors: []
platforms: [pydeseq2]
validation: [tests/unit/pydeseq2_contract.test.ts, tests/unit/pydeseq2_e2e.test.ts, tests/sim/pydeseq2_runner.test.py]
allowed-tools: [Bash, Read, Write]
---

# pydeseq2（批量 RNA-seq 差异表达）

## 何时用这个技能

- 有一份批量 RNA-seq 计数矩阵（genes × samples）和样本表（哪些样本是处理组/对照组），
  想知道哪些基因表达有统计显著差异
- 已经跑过一次比较，想换对比水平或过滤阈值重跑并保留对照

**不适用**：单细胞分辨率的比较 → `scanpy`（本技能没有细胞群概念，一个样本一个数）；
代谢通量 → `cobrapy`。

## 铁律（先读这段——本技能是 `dry-experiment` 的一个仿真平台形态）

1. **入口是 `spark-research exp new --platform pydeseq2`。** 与 `scanpy` 同一个理由：
   需要假设、需要保留「换参数重跑」的对照关系，状态机与证据图的规则直接复用。
2. **对比（contrast）是假设的一部分，不是实现细节。** `treated vs control` 与
   `control vs treated` 的 log2FC 差一个符号；`designFactor` / `testLevel` /
   `referenceLevel` 三个参数必须完整写进假设，落库时它们在 summary 的 `contrast` 里。
3. **显著（padj < 0.05）不等于生物学重要。** 报告必须同时给 log2FoldChange 与 padj。
   极小的 fold change 在样本量够大时也能显著——那是统计功效的问题，不是效应量。
4. **样本量过小时不要假装检验有效。** 每组 < 3 个重复时 DESeq2 的离散度估计不稳定；
   summary 里的 `samples` 必须进报告，好让域 E2 的 `stats-plausibility` 检查器接得上。
5. **`padj` 为空 ≠ 不显著。** 空值是「被独立过滤（independent filtering）剔除了」，
   多半是表达量太低根本没进检验。把它当成「不显著」会把「没测」说成「测了没有」。
6. **`deterministic: true` 是被测出来的。** runner 把 `DefaultInference` 的 `n_cpus`
   钉成 1（joblib 多进程会让浮点尾数漂），`tests/unit/pydeseq2_e2e.test.ts` 每次跑两遍比字节。
   保证的是同一台机器上重跑逐位一致，不保证跨机器。

## 用法

```bash
spark-research exp platforms
spark-research exp new "药物处理 vs 溶剂对照" --platform pydeseq2 \
    --param countsPath=/abs/path/counts.csv \
    --param metadataPath=/abs/path/metadata.csv \
    --param designFactor=condition \
    --param testLevel=treated --param referenceLevel=control \
    --param minTotalCount=10 --param alpha=0.05 \
    --hypothesis "≥50 个基因在 padj<0.05 且 |log2FC|>1 下显著差异表达"
spark-research exp run <id>
spark-research exp iterate <id> --param minTotalCount=50     # 换过滤阈值对照
```

## 任务种类 `bulk-de`

| 参数 | 默认 | 说明 |
|------|------|------|
| `countsPath` | 必填 | genes × samples 的整数计数 CSV（第一列基因 id，表头样本名）。**不要传 TPM/FPKM** |
| `metadataPath` | 必填 | samples × 因子 的样本表（第一列样本名，须与计数矩阵表头对得上） |
| `designFactor` | `condition` | 样本表里当分组用的列名 |
| `testLevel` / `referenceLevel` | 样本表里出现的头两个水平 | 对比的两端；`log2FC > 0` = 在 testLevel 里更高 |
| `minTotalCount` | 10 | 低表达过滤：跨样本计数和低于它的基因不进检验 |
| `alpha` | 0.05 | FDR 阈值，同时决定 independent filtering 的强度 |
| `fitType` | `parametric` | dispersion 趋势拟合；拟合不收敛时 PyDESeq2 会自己退回 `mean` 并在 stderr 里说 |
| `refitCooks` / `cooksFilter` / `independentFilter` | 全 true | DESeq2 的三道离群/功效处理，关掉要在假设里说明理由 |

产出：`results.csv`（gene / baseMean / log2FoldChange / lfcSE / stat / pvalue / padj）·
`size_factors.csv`（样本 → 分组 → size factor）。

**本平台目前的边界**：只支持**单因子两水平**对比（`~<designFactor>`）。
多因子设计（`~batch + condition`）、连续协变量、LFC shrinkage、火山图渲染**都没实现**——
需要就进 BACKLOG，别在报告里假装做了。

## 证据图

```
artifact record（results.csv / size_factors.csv）  --derives_from--> experiment
observation（显著基因数、上调/下调数、contrast）    --derives_from--> experiment 与 artifact
conclusion                                          --derives_from--> observation
```

- experiment 的 `evidence` 是 `inferred`，observation 是 `computed`
- 结论卡一律 `review: "pending"`

## 反模式

- ❌ 把 TPM / FPKM / 已归一化的矩阵喂进来（DESeq2 要的是**原始整数计数**）
- ❌ 只按 padj 排序报前 N 个基因，不给 log2FoldChange
- ❌ 把 padj 为空当成「不显著」
- ❌ 调 `minTotalCount` 直到显著基因数「好看」，再回头解释阈值
- ❌ 每组 2 个重复也照常宣布「显著差异表达」
- ❌ 反复重跑覆盖上一轮结果（要对照就 `iterate`）

## 验证方式（AD-5）

- 契约测试：`tests/unit/pydeseq2_contract.test.ts` —— 复用
  `tests/helpers/simulation_contract.ts` 的参数化契约用例，外加「探测与真跑同一条路径」
  与「依赖缺失报安装命令」两条
- e2e：`tests/unit/pydeseq2_e2e.test.ts` —— 离线合成数据集（15 个基因上调 5 倍、
  15 个下调 5 倍、270 个噪声），断言**全部 30 个 spike-in 基因方向正确且显著**，
  同时**噪声基因的假阳性率 < 5%**（只测灵敏度不测特异性等于没测），
  以及 deterministic 位与两次跑出来的字节一致性相符
- Python 侧：`tests/sim/pydeseq2_runner.test.py` —— 计数矩阵转置与样本表对齐、
  未知对比水平/过滤到空矩阵的失败信封
