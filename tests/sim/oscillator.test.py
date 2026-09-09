"""pyref 仿真核心的 Python 侧单测（P5）。

TS 侧的契约测试验的是**生命周期**（prepare/submit/poll/collect）；
这里验的是**物理与数值**——仿真跑完了不等于跑对了。
判据是解析解，不是「没报错」。
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

from simulation.pyref.oscillator import analytic_position, simulate
from simulation.sim_runtime import RunContext, _scalarize, write_csv

RUNNER = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "backend", "src", "simulation", "pyref", "runner.py",
)


# ── 数值正确性：与解析解对照 ────────────────────────────────────────────────

@pytest.mark.parametrize(
    "damping,expected_regime",
    [(0.2, "underdamped"), (4.0, "critical"), (10.0, "overdamped")],
)
def test_rk4_matches_analytic_in_all_three_regimes(damping, expected_regime):
    # stiffness=4, mass=1 → 临界阻尼 c = 2*sqrt(k*m) = 4
    result = simulate(mass=1.0, stiffness=4.0, damping=damping, dt=0.001, steps=4000, sample_interval=100)
    summary = result["summary"]
    assert summary["regime"] == expected_regime
    # RK4 在 dt=0.001 下应当把误差压到 1e-9 以下——这是「算对了」的判据。
    assert summary["maxAbsErrorVsAnalytic"] < 1e-9
    assert summary["finalPosition"] == pytest.approx(summary["analyticFinalPosition"], abs=1e-9)


def test_undamped_oscillator_conserves_energy():
    result = simulate(damping=0.0, dt=0.001, steps=6000, sample_interval=100)
    summary = result["summary"]
    # 无阻尼 = 保守系统；RK4 会有极小的能量漂移，但必须在 1e-8 相对量级内。
    assert summary["energyRetainedFraction"] == pytest.approx(1.0, abs=1e-8)
    assert summary["dampingRatio"] == 0.0


def test_damped_oscillator_loses_energy_monotonically_over_periods():
    result = simulate(damping=0.4, dt=0.001, steps=8000, sample_interval=1000)
    energies = [row[4] for row in result["rows"]]
    # 逐周期看必须是衰减的（振子在单个时刻会有动能↔势能交换，所以按采样点比较首尾与整体趋势）。
    assert energies[-1] < energies[0]
    assert result["summary"]["energyRetainedFraction"] < 0.05


def test_analytic_position_at_t0_returns_initial_conditions():
    for damping in (0.0, 0.2, 4.0, 10.0):
        assert analytic_position(0.0, 1.0, 4.0, damping, 0.7, -0.3) == pytest.approx(0.7)


def test_simulation_is_deterministic():
    a = simulate(steps=500)
    b = simulate(steps=500)
    assert a["rows"] == b["rows"]
    assert a["summary"] == b["summary"]


def test_sample_interval_controls_row_count():
    result = simulate(steps=1000, sample_interval=250)
    # 第 0 步 + 250/500/750/1000
    assert result["summary"]["samples"] == 5
    assert [row[0] for row in result["rows"]] == [0, 250, 500, 750, 1000]


# ── 失败模式：宁可当场报错，也不产出 NaN 轨迹 ────────────────────────────────

def test_diverging_timestep_raises_instead_of_writing_nan():
    with pytest.raises(ArithmeticError, match="发散"):
        simulate(dt=5.0, steps=200)


@pytest.mark.parametrize(
    "kwargs",
    [{"mass": 0.0}, {"mass": -1.0}, {"stiffness": 0.0}, {"dt": 0.0}, {"dt": -1.0}, {"steps": 0}],
)
def test_invalid_parameters_raise(kwargs):
    with pytest.raises(ValueError):
        simulate(**kwargs)


# ── sim_runtime：runner 与编排层之间的契约 ──────────────────────────────────

def test_run_context_writes_done_json_on_complete():
    with tempfile.TemporaryDirectory() as outdir:
        with RunContext({"a": 1}, outdir) as ctx:
            ctx.declare("x.csv", "trajectory")
            write_csv(ctx.path("x.csv"), ["a"], [(1,)])
            ctx.complete({"value": 1.5})
        envelope = json.load(open(os.path.join(outdir, "done.json")))
        assert envelope["status"] == "completed"
        assert envelope["summary"]["value"] == 1.5
        assert envelope["files"] == [{"filename": "x.csv", "role": "trajectory"}]
        assert envelope["wallSeconds"] >= 0
        # 原子写：临时文件不许留下（半写的 done.json 会被编排层当成可信终态）。
        assert not os.path.exists(os.path.join(outdir, "done.json.tmp"))


def test_run_context_turns_uncaught_exception_into_failed():
    with tempfile.TemporaryDirectory() as outdir:
        # __exit__ 吞掉异常并落 failed —— 绝不留「既没 done.json 又退出」的运行，
        # 所以下面这个 with 块是正常结束的（异常没有往外冒）。
        with RunContext({}, outdir) as ctx:
            assert ctx is not None
            raise RuntimeError("boom")
        envelope = json.load(open(os.path.join(outdir, "done.json")))
        assert envelope["status"] == "failed"
        assert "boom" in envelope["error"]
        assert envelope["files"] == []


def test_run_context_marks_failed_when_runner_forgets_to_report():
    with tempfile.TemporaryDirectory() as outdir:
        with RunContext({}, outdir):
            pass
        envelope = json.load(open(os.path.join(outdir, "done.json")))
        assert envelope["status"] == "failed"
        assert "没有给出结果" in envelope["error"]


def test_progress_is_clamped_to_unit_interval():
    with tempfile.TemporaryDirectory() as outdir:
        ctx = RunContext({}, outdir)
        ctx.progress(1.7, "over")
        assert json.load(open(os.path.join(outdir, "progress.json")))["fraction"] == 1.0
        ctx.progress(-3)
        assert json.load(open(os.path.join(outdir, "progress.json")))["fraction"] == 0.0


def test_scalarize_flattens_non_scalars():
    out = _scalarize({"i": 1, "f": 1.5, "s": "x", "b": True, "n": None, "list": [1, 2], "nan": float("nan")})
    assert out["list"] == "[1, 2]"
    assert out["nan"] is None
    assert out["i"] == 1 and out["b"] is True and out["n"] is None


# ── runner 端到端：编排层看到的就是这份 done.json ───────────────────────────

def test_runner_end_to_end_writes_declared_outputs():
    with tempfile.TemporaryDirectory() as outdir:
        params_path = os.path.join(outdir, "params.json")
        with open(params_path, "w") as handle:
            json.dump({"steps": 200, "sampleInterval": 50}, handle)
        proc = subprocess.run(
            [sys.executable, RUNNER, "--params", params_path, "--outdir", outdir],
            capture_output=True, text=True, timeout=120,
        )
        assert proc.returncode == 0, proc.stderr
        assert "[pyref]" in proc.stdout
        envelope = json.load(open(os.path.join(outdir, "done.json")))
        assert envelope["status"] == "completed"
        assert {f["filename"] for f in envelope["files"]} == {"trajectory.csv", "final_state.json"}
        for entry in envelope["files"]:
            assert os.path.getsize(os.path.join(outdir, entry["filename"])) > 0
        assert envelope["summary"]["maxAbsErrorVsAnalytic"] < 1e-6


def test_runner_reports_failure_without_crashing_the_contract():
    with tempfile.TemporaryDirectory() as outdir:
        params_path = os.path.join(outdir, "params.json")
        with open(params_path, "w") as handle:
            json.dump({"dt": 5, "steps": 200}, handle)
        proc = subprocess.run(
            [sys.executable, RUNNER, "--params", params_path, "--outdir", outdir],
            capture_output=True, text=True, timeout=120,
        )
        # 关键：算例失败了，但 runner 仍然**正常写出 done.json**（status=failed）。
        # 这样编排层才能区分「算例挂了」与「进程被杀了」。
        assert proc.returncode == 0
        envelope = json.load(open(os.path.join(outdir, "done.json")))
        assert envelope["status"] == "failed"
        assert "发散" in envelope["error"]
        assert envelope["files"] == []
