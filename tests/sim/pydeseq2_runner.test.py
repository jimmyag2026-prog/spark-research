"""pydeseq2 runner 的 Python 侧单测（W5-3 β）。

验的是 runner 模块本身：probe() 报真版本、输入校验说人话、失败落成 failed 信封。
科学判据（spike-in 基因的方向）在 tests/unit/pydeseq2_e2e.test.ts 里。
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

from simulation.pydeseq2.runner import load_inputs, probe

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNNER = os.path.join(REPO, "backend", "src", "simulation", "pydeseq2", "runner.py")
FIXTURES = os.path.join(REPO, "tests", "fixtures", "pydeseq2")
COUNTS = os.path.join(FIXTURES, "counts.csv")
METADATA = os.path.join(FIXTURES, "metadata.csv")

BASE_PARAMS = {
    "countsPath": COUNTS,
    "metadataPath": METADATA,
    "designFactor": "condition",
    "testLevel": "treated",
    "referenceLevel": "control",
    "minTotalCount": 10,
    "alpha": 0.05,
    "fitType": "parametric",
    "refitCooks": True,
    "cooksFilter": True,
    "independentFilter": True,
}


def test_probe_reports_real_versions():
    detail = probe()
    for key in ("pydeseq2", "pandas", "numpy", "python"):
        assert key in detail
        assert detail[key] and detail[key][0].isdigit()


def test_probe_result_is_json_serialisable():
    assert json.loads(json.dumps(probe())) == probe()


# ── 输入校验 ────────────────────────────────────────────────────────────────

def test_load_inputs_transposes_genes_by_samples_into_samples_by_genes():
    counts, metadata = load_inputs(COUNTS, METADATA, "condition")
    # 计数矩阵按生信惯例是 genes × samples；PyDESeq2 要 samples × genes。
    assert counts.shape == (12, 300)
    assert list(counts.index[:2]) == ["ctrl0", "ctrl1"]
    # 样本表必须被重排成与计数矩阵同序，否则分组标签会整体错位。
    assert list(metadata.index) == list(counts.index)
    assert set(metadata["condition"]) == {"control", "treated"}


def test_load_inputs_rejects_a_design_factor_that_is_not_a_column():
    with pytest.raises(ValueError, match="designFactor"):
        load_inputs(COUNTS, METADATA, "treatment")


def test_load_inputs_rejects_samples_missing_from_the_metadata():
    with tempfile.TemporaryDirectory() as tmp:
        partial = os.path.join(tmp, "metadata.csv")
        with open(partial, "w", encoding="utf-8") as handle:
            handle.write("sample,condition\nctrl0,control\ntrt0,treated\n")
        with pytest.raises(ValueError, match="缺失"):
            load_inputs(COUNTS, partial, "condition")


# ── 真跑一遍 ────────────────────────────────────────────────────────────────

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


def test_filtering_every_gene_out_fails_instead_of_reporting_zero_differential_genes():
    # 「一个显著基因都没有」与「压根没有基因可测」是两件事，混起来会让人以为实验阴性。
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run({**BASE_PARAMS, "minTotalCount": 10**7}, tmp)
    assert envelope["status"] == "failed"
    assert "minTotalCount" in envelope["error"]
    assert envelope["files"] == []


def test_unknown_contrast_level_fails_with_the_available_levels_listed():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run({**BASE_PARAMS, "testLevel": "placebo"}, tmp)
    assert envelope["status"] == "failed"
    assert "placebo" in envelope["error"]
    assert "control" in envelope["error"]


def test_successful_run_declares_both_outputs_and_a_scalar_only_summary():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run(BASE_PARAMS, tmp)
        assert envelope["status"] == "completed", envelope.get("error")
        assert sorted(f["filename"] for f in envelope["files"]) == ["results.csv", "size_factors.csv"]
    assert envelope["summary"]["samples"] == 12
    assert envelope["summary"]["genesTested"] == 300
    for value in envelope["summary"].values():
        assert isinstance(value, (str, int, float, bool)) or value is None
