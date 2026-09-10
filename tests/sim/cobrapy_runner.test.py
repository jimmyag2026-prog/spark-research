"""cobrapy runner 的 Python 侧单测（W5-3 β）。

验的是 runner 模块本身：probe() 连 LP 求解器一起查、培养基切换真的改到了边界、
失败落成 failed 信封。生长率的公开定值判据在 tests/unit/cobrapy_e2e.test.ts 里。
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

from simulation.cobrapy.runner import apply_medium, load_model, probe

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNNER = os.path.join(REPO, "backend", "src", "simulation", "cobrapy", "runner.py")
MODEL = os.path.join(REPO, "tests", "fixtures", "cobrapy", "e_coli_core.xml")

BASE_PARAMS = {
    "modelPath": MODEL,
    "objective": "",
    "medium": "model-default",
    "knockouts": "",
    "parsimonious": True,
    "fluxVariability": False,
    "fvaFraction": 0.9,
}


def test_probe_reports_version_and_at_least_one_lp_solver():
    detail = probe()
    assert detail["cobra"][0].isdigit()
    # `import cobra` 成功 ≠ 能解 LP。探测必须把求解器一并查出来，
    # 否则「探测说可用、optimize() 才炸」就是 V27 的同一个形状换了层皮。
    assert detail["solvers"], "一个 LP 求解器都没查到"
    assert "glpk" in detail["solvers"]


def test_probe_result_is_json_serialisable():
    assert json.loads(json.dumps(probe())) == probe()


# ── 模型加载与培养基 ────────────────────────────────────────────────────────

def test_load_model_reads_the_sbml_fixture():
    model = load_model(MODEL)
    assert model.id == "e_coli_core"
    assert len(model.reactions) == 95
    assert len(model.genes) == 137


def test_load_model_rejects_an_unknown_extension():
    with pytest.raises(ValueError, match="不认识的模型格式"):
        load_model("/tmp/model.parquet")


def test_anaerobic_medium_actually_closes_the_oxygen_uptake_bound():
    model = load_model(MODEL)
    assert model.reactions.EX_o2_e.lower_bound < 0
    note = apply_medium(model, "anaerobic")
    assert model.reactions.EX_o2_e.lower_bound == 0.0
    assert "EX_o2_e" in note


def test_model_default_medium_leaves_every_bound_untouched():
    model = load_model(MODEL)
    before = {r.id: (r.lower_bound, r.upper_bound) for r in model.reactions}
    apply_medium(model, "model-default")
    after = {r.id: (r.lower_bound, r.upper_bound) for r in model.reactions}
    assert before == after


def test_medium_switch_on_a_model_without_oxygen_exchange_fails_loudly():
    # 「以为把氧关了、其实没关」会让结论整个反过来——所以这里必须报错，不许静默跳过。
    model = load_model(MODEL)
    model.remove_reactions([model.reactions.EX_o2_e])
    with pytest.raises(ValueError, match="氧气交换反应"):
        apply_medium(model, "anaerobic")


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


def test_unknown_objective_reaction_fails_with_the_id_named():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run({**BASE_PARAMS, "objective": "NOT_A_REACTION"}, tmp)
    assert envelope["status"] == "failed"
    assert "NOT_A_REACTION" in envelope["error"]
    assert envelope["files"] == []


def test_unknown_knockout_gene_fails_instead_of_silently_doing_nothing():
    # 静默忽略一个敲不掉的基因 = 报告一个「敲除后照常生长」的假结论。
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run({**BASE_PARAMS, "knockouts": "b9999"}, tmp)
    assert envelope["status"] == "failed"
    assert "b9999" in envelope["error"]


def test_successful_run_declares_both_outputs_and_a_scalar_only_summary():
    with tempfile.TemporaryDirectory() as tmp:
        envelope = _run(BASE_PARAMS, tmp)
        assert envelope["status"] == "completed", envelope.get("error")
        assert sorted(f["filename"] for f in envelope["files"]) == ["fluxes.csv", "solution.json"]
    assert envelope["summary"]["status"] == "optimal"
    assert envelope["summary"]["objectiveValue"] == pytest.approx(0.8739215, abs=1e-6)
    for value in envelope["summary"].values():
        assert isinstance(value, (str, int, float, bool)) or value is None
