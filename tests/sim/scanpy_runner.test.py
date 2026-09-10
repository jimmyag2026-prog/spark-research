"""scanpy runner 的 Python 侧单测（W5-3 β）。

TS 侧的契约测试验的是生命周期，e2e 验的是科学判据；这里验的是**runner 这个模块本身**：
- `probe()` 是探测的落点（TS 的 probeCode 用 importlib 加载这个文件再调它），
  它必须报出真实版本号，而且把 leidenalg/igraph 这两个「scanpy 不硬依赖、但本 runner 一定用」
  的包一并查了——否则会出现「探测说可用、聚类那一步才炸」；
- 数据加载的错误信息必须说人话（用户拿到的第一手信息就是它）；
- 失败一律经 RunContext 落成 done.json 的 failed 信封，绝不留「既没结果又退出」的运行。
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

from simulation.scanpy.runner import load_counts, probe

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNNER = os.path.join(REPO, "backend", "src", "simulation", "scanpy", "runner.py")
FIXTURES = os.path.join(REPO, "tests", "fixtures", "scanpy")
COUNTS = os.path.join(FIXTURES, "counts.csv")


# ── probe()：探测的落点 ────────────────────────────────────────────────────

def test_probe_reports_real_versions_of_every_package_the_runner_uses():
    detail = probe()
    # 这四个包缺任何一个，聚类都跑不出来——所以四个都得在探测里露面。
    for key in ("scanpy", "anndata", "leidenalg", "igraph", "numpy", "python"):
        assert key in detail, f"probe() 少报了 {key}"
        assert detail[key] and detail[key][0].isdigit(), f"{key} 的版本号不像版本号: {detail[key]!r}"


def test_probe_result_is_json_serialisable():
    # TS 侧把 probe() 的返回值直接 json.dumps 出来当 PlatformAvailability.detail。
    assert json.loads(json.dumps(probe())) == probe()


# ── 数据加载：错误信息要说人话 ──────────────────────────────────────────────

def test_load_counts_reads_cells_by_genes_matrix():
    adata = load_counts(COUNTS)
    assert adata.shape == (240, 120)
    assert adata.obs_names[0] == "alpha_000"
    assert "MARKA0" in list(adata.var_names)


def test_load_counts_rejects_a_matrix_too_small_to_cluster():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tiny.csv")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("cell,g1,g2\nc1,1,2\n")
        with pytest.raises(ValueError, match="太小"):
            load_counts(path)


# ── 真跑一遍：失败必须落成 failed 信封 ──────────────────────────────────────

def _run(params, outdir):
    params_path = os.path.join(outdir, "params.json")
    with open(params_path, "w", encoding="utf-8") as handle:
        json.dump(params, handle)
    subprocess.run(
        [sys.executable, RUNNER, "--params", params_path, "--outdir", outdir],
        capture_output=True,
        text=True,
        check=False,
    )
    with open(os.path.join(outdir, "done.json"), "r", encoding="utf-8") as handle:
        return json.load(handle)


BASE_PARAMS = {
    "countsPath": COUNTS,
    "minGenesPerCell": 10,
    "minCellsPerGene": 3,
    "targetSum": 10000,
    "nTopGenes": 60,
    "nPcs": 15,
    "nNeighbors": 15,
    "resolution": 0.5,
    "leidenIterations": 2,
    "rankMethod": "wilcoxon",
    "nMarkersPerCluster": 5,
    "nEmbeddingDims": 5,
    "randomSeed": 0,
    "computeUmap": False,
}


def test_pca_component_count_too_high_fails_with_an_actionable_message():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run({**BASE_PARAMS, "nPcs": 80}, tmp)
    assert envelope["status"] == "failed"
    assert "nPcs" in envelope["error"]
    # 失败的 run 不许声明产出——半成品比没有结果更糟。
    assert envelope["files"] == []


def test_quality_control_filtering_everything_out_fails_instead_of_returning_empty_results():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run({**BASE_PARAMS, "minGenesPerCell": 100000}, tmp)
    assert envelope["status"] == "failed"
    assert "过滤" in envelope["error"]


def test_successful_run_declares_all_three_outputs_and_a_scalar_only_summary():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run(BASE_PARAMS, tmp)
        assert envelope["status"] == "completed", envelope.get("error")
        assert sorted(f["filename"] for f in envelope["files"]) == [
            "clusters.csv",
            "embedding.csv",
            "markers.csv",
        ]
        for entry in envelope["files"]:
            assert os.path.getsize(os.path.join(tmp, entry["filename"])) > 0
    # summary 会原样进 observation record，嵌套结构在证据图里没法读。
    for value in envelope["summary"].values():
        assert isinstance(value, (str, int, float, bool)) or value is None
