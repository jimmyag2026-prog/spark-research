#!/usr/bin/env python3
"""pydeseq2 adapter 的 runner：bulk RNA-seq 计数矩阵 → 差异表达（DESeq2 口径）。

由 `SubprocessSimulationPlatform.submit()` 以
`python runner.py --params params.json --outdir <run 目录>` 启动。

**这个文件同时是可用性探测的落点**（`probe()`）——理由见 scanpy/runner.py 的模块 docstring：
探测与真跑必须指向同一条路径，否则会重演 V27（探测报可用、提交任务 ENOENT）。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from pydeseq2.dds import DeseqDataSet  # noqa: E402
from pydeseq2.default_inference import DefaultInference  # noqa: E402
from pydeseq2.ds import DeseqStats  # noqa: E402

from simulation.sim_runtime import RunContext, write_csv  # noqa: E402


def probe() -> dict:
    """探测入口：能 import 且能拿到版本号就算可用。放在 runner 里的理由见模块 docstring。"""
    from importlib.metadata import version

    return {
        "pydeseq2": version("pydeseq2"),
        "pandas": pd.__version__,
        "numpy": np.__version__,
        "python": sys.version.split()[0],
    }


def load_inputs(counts_path: str, metadata_path: str, factor: str):
    """计数矩阵是 genes × samples（生信惯例），PyDESeq2 要的是 samples × genes，这里转置。"""
    counts = pd.read_csv(counts_path, index_col=0)
    metadata = pd.read_csv(metadata_path, index_col=0)
    counts = counts.T
    counts.index = counts.index.astype(str)
    metadata.index = metadata.index.astype(str)
    if factor not in metadata.columns:
        raise ValueError(
            f"样本表里没有列 '{factor}'（现有列：{', '.join(metadata.columns)}）——designFactor 写错了"
        )
    missing = [s for s in counts.index if s not in metadata.index]
    if missing:
        raise ValueError(f"计数矩阵里的样本在样本表里缺失: {', '.join(missing[:5])}")
    metadata = metadata.loc[counts.index]
    return counts, metadata


def main() -> None:
    with RunContext.from_argv() as ctx:
        p = ctx.params
        factor = str(p["designFactor"])

        ctx.progress(0.05, "loading counts")
        counts, metadata = load_inputs(str(p["countsPath"]), str(p["metadataPath"]), factor)
        raw_genes = counts.shape[1]

        # 低表达基因过滤：DESeq2 的标准前处理。阈值太高会把矩阵滤空——
        # 那是这个平台最真实的失败模式（TS 侧对高阈值会给警告）。
        keep = counts.sum(axis=0) >= int(p["minTotalCount"])
        counts = counts.loc[:, keep]
        if counts.shape[1] < 2:
            raise ValueError(
                f"minTotalCount={int(p['minTotalCount'])} 过滤后只剩 {counts.shape[1]} 个基因——"
                f"没有可做差异分析的矩阵（原始 {raw_genes} 个基因）"
            )

        levels = list(dict.fromkeys(metadata[factor].astype(str)))
        test_level = str(p["testLevel"]) or (levels[1] if len(levels) > 1 else levels[0])
        ref_level = str(p["referenceLevel"]) or levels[0]
        for name, value in (("testLevel", test_level), ("referenceLevel", ref_level)):
            if value not in levels:
                raise ValueError(f"{name}='{value}' 不在 '{factor}' 的取值里（{', '.join(levels)}）")
        if test_level == ref_level:
            raise ValueError(f"testLevel 与 referenceLevel 都是 '{test_level}'——没有可比的两组")

        ctx.progress(0.2, "fitting dispersions")
        # n_cpus=1：joblib 多进程会让同一份数据两次跑出不同的浮点尾数，
        # 而这个平台声称 deterministic=true（见 index.ts），单线程是那个声称的兑现方式。
        inference = DefaultInference(n_cpus=1)
        dds = DeseqDataSet(
            counts=counts.astype(int),
            metadata=metadata,
            design=f"~{factor}",
            refit_cooks=bool(p["refitCooks"]),
            fit_type=str(p["fitType"]),
            inference=inference,
            quiet=True,
        )
        dds.deseq2()

        ctx.progress(0.7, "wald test")
        stats = DeseqStats(
            dds,
            contrast=[factor, test_level, ref_level],
            alpha=float(p["alpha"]),
            cooks_filter=bool(p["cooksFilter"]),
            independent_filter=bool(p["independentFilter"]),
            inference=inference,
            quiet=True,
        )
        stats.summary()
        results = stats.results_df.copy()
        results.index.name = "gene"
        results = results.sort_values("padj", kind="stable")

        ctx.progress(0.9, "writing outputs")
        results_path = ctx.declare("results.csv", "differential_expression")
        write_csv(
            results_path,
            ["gene", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj"],
            [
                (
                    gene,
                    _num(row["baseMean"]),
                    _num(row["log2FoldChange"]),
                    _num(row["lfcSE"]),
                    _num(row["stat"]),
                    _num(row["pvalue"]),
                    _num(row["padj"]),
                )
                for gene, row in results.iterrows()
            ],
        )

        size_factors = pd.Series(dds.obs["size_factors"], index=dds.obs_names)
        sf_path = ctx.declare("size_factors.csv", "size_factors")
        write_csv(
            sf_path,
            ["sample", factor, "sizeFactor"],
            [(s, str(metadata.loc[s, factor]), _num(v)) for s, v in size_factors.items()],
        )

        alpha = float(p["alpha"])
        significant = results[results["padj"].notna() & (results["padj"] < alpha)]
        summary = {
            "samples": int(counts.shape[0]),
            "genesInput": int(raw_genes),
            "genesTested": int(counts.shape[1]),
            "genesFilteredOut": int(raw_genes - counts.shape[1]),
            "significantGenes": int(significant.shape[0]),
            "upRegulated": int((significant["log2FoldChange"] > 0).sum()),
            "downRegulated": int((significant["log2FoldChange"] < 0).sum()),
            "maxAbsLog2FoldChange": _num(float(results["log2FoldChange"].abs().max())),
            "contrast": f"{factor}: {test_level} vs {ref_level}",
            "alpha": alpha,
            "pydeseq2Version": probe()["pydeseq2"],
        }
        print(
            f"[pydeseq2] samples={summary['samples']} tested={summary['genesTested']} "
            f"significant={summary['significantGenes']} "
            f"(up={summary['upRegulated']} down={summary['downRegulated']})"
        )
        ctx.progress(1.0, "done")
        ctx.complete(summary)


def _num(value) -> float | str:
    """NaN 在 CSV 里写成空串比写成 'nan' 好读；padj 的 NaN 是「被独立过滤掉了」，不是错误。"""
    number = float(value)
    if number != number:
        return ""
    return round(number, 10)


if __name__ == "__main__":
    main()
