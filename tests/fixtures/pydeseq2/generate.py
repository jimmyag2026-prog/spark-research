#!/usr/bin/env python3
"""生成 pydeseq2 平台的离线小数据集（bulk RNA-seq 计数矩阵 + 样本表）。

设计意图同 scanpy 的 generate.py：**已知答案**。这里把 300 个基因里的
前 15 个人为上调 5 倍（UP*）、接下来 15 个下调 5 倍（DOWN*），其余是噪声。
于是 e2e 可以断言科学判据：**UP 组的 log2FoldChange 必须为正、DOWN 组必须为负，
且两组都在 padj < 0.05 里**；同时噪声基因的显著比例必须远低于 spike-in 组
（差异分析没把噪声当信号）。

负二项计数（gamma-poisson 混合），固定 seed，重跑逐字节一致。
"""

from __future__ import annotations

import csv
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20260911
N_PER_GROUP = 6
N_UP = 15
N_DOWN = 15
N_NOISE = 270
BASE_MEAN = 120.0
FOLD = 5.0
DISPERSION = 0.05


def negbin(rng: np.random.Generator, mean: float, dispersion: float) -> int:
    # gamma-poisson：真实 RNA-seq 计数的标准生成模型（方差 = mu + dispersion*mu^2）。
    shape = 1.0 / dispersion
    scale = mean * dispersion
    return int(rng.poisson(rng.gamma(shape, scale)))


def main() -> None:
    rng = np.random.default_rng(SEED)
    genes = (
        [f"UP{i:03d}" for i in range(N_UP)]
        + [f"DOWN{i:03d}" for i in range(N_DOWN)]
        + [f"NOISE{i:03d}" for i in range(N_NOISE)]
    )
    samples = [f"ctrl{i}" for i in range(N_PER_GROUP)] + [f"trt{i}" for i in range(N_PER_GROUP)]
    condition = ["control"] * N_PER_GROUP + ["treated"] * N_PER_GROUP
    # 每个样本一个测序深度因子——size factor 估计必须真的有事可做。
    depth = rng.uniform(0.75, 1.35, size=len(samples))

    matrix = []
    for gene in genes:
        row = []
        for idx, cond in enumerate(condition):
            mean = BASE_MEAN
            if gene.startswith("UP") and cond == "treated":
                mean *= FOLD
            elif gene.startswith("DOWN") and cond == "treated":
                mean /= FOLD
            row.append(negbin(rng, mean * depth[idx], DISPERSION))
        matrix.append(row)

    with open(os.path.join(HERE, "counts.csv"), "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["gene", *samples])
        for gene, row in zip(genes, matrix):
            writer.writerow([gene, *row])

    with open(os.path.join(HERE, "metadata.csv"), "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["sample", "condition"])
        writer.writerows(zip(samples, condition))

    print(f"genes={len(genes)} samples={len(samples)} up={N_UP} down={N_DOWN}")


if __name__ == "__main__":
    main()
