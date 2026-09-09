#!/usr/bin/env python3
"""pyref adapter 的 runner：阻尼谐振子（零外部依赖，确定性）。

由 `SubprocessSimulationPlatform.submit()` 以
`python runner.py --params params.json --outdir <run 目录>` 启动。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from simulation.pyref.oscillator import simulate  # noqa: E402
from simulation.sim_runtime import RunContext, write_csv  # noqa: E402


def main() -> None:
    with RunContext.from_argv() as ctx:
        p = ctx.params
        # 仅供生命周期测试：让任务可控地跑久一点，好在它「还在跑」的时候杀掉编排进程。
        stall = float(p.get("stallSeconds", 0) or 0)
        if stall > 0:
            ctx.progress(0.0, f"stalling {stall}s")
            deadline = time.time() + stall
            while time.time() < deadline:
                time.sleep(0.05)

        ctx.progress(0.1, "integrating")
        result = simulate(
            mass=float(p.get("mass", 1.0)),
            stiffness=float(p.get("stiffness", 4.0)),
            damping=float(p.get("damping", 0.2)),
            x0=float(p.get("x0", 1.0)),
            v0=float(p.get("v0", 0.0)),
            dt=float(p.get("dt", 0.01)),
            steps=int(p.get("steps", 2000)),
            sample_interval=int(p.get("sampleInterval", 10)),
        )
        ctx.progress(0.8, "writing outputs")

        traj = ctx.declare("trajectory.csv", "trajectory")
        write_csv(traj, ["step", "t", "x", "v", "energy", "analytic_x"], result["rows"])

        summary = result["summary"]
        state_path = ctx.declare("final_state.json", "final_state")
        with open(state_path, "w", encoding="utf-8") as handle:
            import json

            json.dump(
                {
                    "position": summary["finalPosition"],
                    "velocity": summary["finalVelocity"],
                    "time": summary["simulatedTime"],
                    "params": p,
                },
                handle,
                indent=2,
            )
            handle.write("\n")

        print(
            f"[pyref] steps={summary['steps']} regime={summary['regime']} "
            f"x_final={summary['finalPosition']:.6f} "
            f"analytic={summary['analyticFinalPosition']:.6f} "
            f"maxErr={summary['maxAbsErrorVsAnalytic']:.3e}"
        )
        ctx.progress(1.0, "done")
        ctx.complete(summary)


if __name__ == "__main__":
    main()
