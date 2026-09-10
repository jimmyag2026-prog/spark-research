#!/usr/bin/env python3
"""scanpy adapter 的 runner：单细胞表达矩阵 → 聚类 → 每簇 marker 基因排名。

由 `SubprocessSimulationPlatform.submit()` 以
`python runner.py --params params.json --outdir <run 目录>` 启动。

**这个文件同时是可用性探测的落点**（`probe()`）。TS 侧的 `probeCode()` 不写内联的
`import scanpy`，而是用 importlib 把**这个文件本身**加载起来再调 `probe()`——
于是「探测说可用」与「真跑能起来」指向同一条路径：runner 没被解包出来、
包树缺件、或者 scanpy 装坏了，探测阶段就会红，而不是等到提交任务才 ENOENT（V27 那个形状）。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import scanpy as sc  # noqa: E402
import anndata  # noqa: E402

from simulation.sim_runtime import RunContext, write_csv  # noqa: E402


def probe() -> dict:
    """探测入口：能 import、能拿到版本号，就算这个平台可用。

    刻意放在 runner 里而不是 TS 的内联字符串里——见模块 docstring。
    leiden 的后端（igraph + leidenalg）不是 scanpy 的硬依赖，但**本 runner 一定会用**，
    所以它们缺失时必须在探测阶段就报出来。
    """
    import igraph
    import leidenalg

    from importlib.metadata import version

    return {
        "scanpy": version("scanpy"),
        "anndata": version("anndata"),
        "leidenalg": version("leidenalg"),
        "igraph": version("igraph"),
        "numpy": np.__version__,
        "python": sys.version.split()[0],
    }


def load_counts(path: str) -> "anndata.AnnData":
    """读 cells × genes 的计数 CSV（第一列是细胞 id，表头是基因名）。"""
    frame = pd.read_csv(path, index_col=0)
    if frame.shape[0] < 3 or frame.shape[1] < 3:
        raise ValueError(f"计数矩阵太小（{frame.shape[0]} 细胞 × {frame.shape[1]} 基因），无法聚类")
    adata = anndata.AnnData(
        X=frame.to_numpy(dtype=np.float32),
        obs=pd.DataFrame(index=frame.index.astype(str)),
        var=pd.DataFrame(index=frame.columns.astype(str)),
    )
    adata.var_names_make_unique()
    return adata


def main() -> None:
    with RunContext.from_argv() as ctx:
        p = ctx.params
        seed = int(p["randomSeed"])
        sc.settings.verbosity = 1
        sc.settings.n_jobs = 1  # 单线程：并行归约会让同一份数据两次跑出不同的浮点结果

        ctx.progress(0.05, "loading counts")
        adata = load_counts(p["countsPath"])
        raw_cells, raw_genes = adata.shape

        ctx.progress(0.2, "filtering + normalizing")
        sc.pp.filter_cells(adata, min_genes=int(p["minGenesPerCell"]))
        sc.pp.filter_genes(adata, min_cells=int(p["minCellsPerGene"]))
        if adata.n_obs < 3 or adata.n_vars < 3:
            raise ValueError(
                f"质控后只剩 {adata.n_obs} 细胞 × {adata.n_vars} 基因——"
                f"minGenesPerCell/minCellsPerGene 把数据过滤光了"
            )
        sc.pp.normalize_total(adata, target_sum=float(p["targetSum"]))
        sc.pp.log1p(adata)

        n_top = min(int(p["nTopGenes"]), adata.n_vars)
        sc.pp.highly_variable_genes(adata, n_top_genes=n_top)
        adata.raw = adata
        hvg_genes = int(adata.var["highly_variable"].sum())
        adata = adata[:, adata.var["highly_variable"]].copy()
        sc.pp.scale(adata, max_value=10)

        ctx.progress(0.45, "pca + neighbors")
        n_pcs = int(p["nPcs"])
        # scanpy 会把这条转成 ValueError；这里先说人话，免得用户只看到 ARPACK 的报错。
        if n_pcs >= min(adata.n_obs, adata.n_vars):
            raise ValueError(
                f"nPcs={n_pcs} 必须小于 min(细胞数={adata.n_obs}, HVG 数={adata.n_vars})——PCA 无解"
            )
        sc.tl.pca(adata, n_comps=n_pcs, svd_solver="arpack", random_state=seed)
        sc.pp.neighbors(adata, n_neighbors=int(p["nNeighbors"]), n_pcs=n_pcs, random_state=seed)

        ctx.progress(0.65, "leiden clustering")
        sc.tl.leiden(
            adata,
            resolution=float(p["resolution"]),
            random_state=seed,
            key_added="leiden",
            flavor="igraph",
            n_iterations=int(p["leidenIterations"]),
            directed=False,
        )
        clusters = adata.obs["leiden"].astype(str)
        n_clusters = int(clusters.nunique())

        embedding_key = "X_pca"
        if bool(p["computeUmap"]):
            ctx.progress(0.75, "umap embedding")
            sc.tl.umap(adata, random_state=seed)
            embedding_key = "X_umap"

        ctx.progress(0.85, "ranking marker genes")
        if n_clusters < 2:
            raise ValueError(
                f"只聚出 {n_clusters} 个 cluster——marker 排名需要至少两个组做对照，"
                f"把 resolution 调大或检查数据是否真的有结构"
            )
        sc.tl.rank_genes_groups(adata, "leiden", method=str(p["rankMethod"]), key_added="rank")

        cluster_path = ctx.declare("clusters.csv", "cluster_assignment")
        write_csv(
            cluster_path,
            ["cell", "cluster"],
            [(cell, cluster) for cell, cluster in zip(adata.obs_names, clusters)],
        )

        top_n = int(p["nMarkersPerCluster"])
        names = adata.uns["rank"]["names"]
        scores = adata.uns["rank"]["scores"]
        pvals = adata.uns["rank"]["pvals_adj"]
        logfc = adata.uns["rank"]["logfoldchanges"]
        marker_rows = []
        for group in names.dtype.names:
            for rank in range(min(top_n, len(names[group]))):
                marker_rows.append(
                    (
                        group,
                        rank + 1,
                        str(names[group][rank]),
                        round(float(scores[group][rank]), 6),
                        round(float(logfc[group][rank]), 6),
                        float(pvals[group][rank]),
                    )
                )
        marker_path = ctx.declare("markers.csv", "marker_ranking")
        write_csv(marker_path, ["cluster", "rank", "gene", "score", "log2fc", "padj"], marker_rows)

        # 降维坐标也是产出的一部分：下游（作图、与别的批次对齐）要用它，
        # 而且它是这条流水线里对「随机性有没有被真的钉住」最敏感的一份数据——
        # PCA 换成无种子的 randomized solver，clusters/markers 可能一个字不变，
        # 但这份坐标每次都不一样。deterministic 的声称由它兜底。
        embedding = adata.obsm[embedding_key]
        n_dims = min(int(p["nEmbeddingDims"]), embedding.shape[1])
        embedding_path = ctx.declare("embedding.csv", "embedding")
        write_csv(
            embedding_path,
            ["cell", "cluster", *[f"dim{i + 1}" for i in range(n_dims)]],
            [
                (cell, cluster, *[round(float(v), 6) for v in embedding[row, :n_dims]])
                for row, (cell, cluster) in enumerate(zip(adata.obs_names, clusters))
            ],
        )

        sizes = clusters.value_counts()
        summary = {
            "cells": int(adata.n_obs),
            "genes": int(raw_genes),
            "cellsFilteredOut": int(raw_cells - adata.n_obs),
            "hvgGenes": hvg_genes,
            "nPcs": n_pcs,
            "clusters": n_clusters,
            "largestClusterFraction": round(float(sizes.iloc[0] / adata.n_obs), 6),
            "smallestClusterSize": int(sizes.iloc[-1]),
            "resolution": float(p["resolution"]),
            "embedding": embedding_key,
            "scanpyVersion": probe()["scanpy"],
        }
        print(
            f"[scanpy] cells={summary['cells']} hvg={hvg_genes} clusters={n_clusters} "
            f"largest={summary['largestClusterFraction']:.3f}"
        )
        ctx.progress(1.0, "done")
        ctx.complete(summary)


if __name__ == "__main__":
    main()
