#!/usr/bin/env python3
"""生成 scanpy 平台的离线小数据集（VALIDATION_PLAN 禁止测试期下载）。

设计意图：数据集必须自带**已知答案**，否则 e2e 只能断言「跑完没报错」。
这里造三种细胞类型，每种各有 5 个专属 marker 基因（在本类型里表达率高一个量级），
于是 e2e 可以断言一条科学判据：**每个 marker 组必须落在某一个 cluster 的 top 表里，
且三组落在三个不同的 cluster**——聚类真的把三种细胞分开了才可能成立。

重跑本脚本得到逐字节相同的 CSV（numpy 固定 seed + 整数计数 + 固定列序）。
"""

from __future__ import annotations

import csv
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20260910
N_PER_TYPE = 80
N_BACKGROUND_GENES = 105
N_MARKERS_PER_TYPE = 5
TYPES = ["alpha", "beta", "gamma"]
BASE_RATE = 3.0
MARKER_RATE = 45.0


def main() -> None:
    rng = np.random.default_rng(SEED)
    genes = [f"BG{i:03d}" for i in range(N_BACKGROUND_GENES)]
    marker_blocks = {t: [f"MARK{t[0].upper()}{i}" for i in range(N_MARKERS_PER_TYPE)] for t in TYPES}
    for t in TYPES:
        genes.extend(marker_blocks[t])

    rows = []
    labels = []
    for t in TYPES:
        for i in range(N_PER_TYPE):
            rate = np.full(len(genes), BASE_RATE)
            # 每个细胞自带一个文库大小因子——真实数据里没有两个细胞测到一样深。
            depth = rng.uniform(0.7, 1.4)
            for other in TYPES:
                for gene in marker_blocks[other]:
                    idx = genes.index(gene)
                    rate[idx] = MARKER_RATE if other == t else 0.4
            counts = rng.poisson(rate * depth)
            rows.append((f"{t}_{i:03d}", counts))
            labels.append((f"{t}_{i:03d}", t))

    with open(os.path.join(HERE, "counts.csv"), "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["cell", *genes])
        for cell, counts in rows:
            writer.writerow([cell, *counts.tolist()])

    with open(os.path.join(HERE, "cell_labels.csv"), "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["cell", "cell_type"])
        writer.writerows(labels)

    print(f"cells={len(rows)} genes={len(genes)} markers={ {t: marker_blocks[t] for t in TYPES} }")


if __name__ == "__main__":
    main()
