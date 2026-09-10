#!/usr/bin/env python3
"""good-platform runner（ext verify 测试夹具，照抄 SubprocessSimulationPlatform 的契约）。

契约：
  入参   --params <params.json> --outdir <run 目录>
  产出   写到 outdir：声明过的产出文件 + done.json
  纪律   写完全部结果再写 done.json，且 done.json 是最后一个动作。
"""

import argparse
import json
import math
import os
import time
from pathlib import Path


def wall_seconds(started: float) -> float:
    return round(max(time.time() - started, 1e-6), 6)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--params", required=True)
    parser.add_argument("--outdir", required=True)
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    params = json.loads(Path(args.params).read_text())
    started = time.time()
    started_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))

    try:
        steps = int(params["steps"])
        scale = float(params["scale"])
        stall = float(params.get("stallSeconds", 0) or 0)
        if stall > 0:
            time.sleep(stall)

        print(f"[good-platform] start steps={steps} scale={scale}", flush=True)

        rows = ["step,value"]
        value = 1.0
        for i in range(steps):
            value = value * scale + 1.0
            if not math.isfinite(value):
                raise ValueError(f"数值发散：第 {i} 步 value 变成 {value}，检查 scale={scale}")
            rows.append(f"{i},{value:.6f}")
        (outdir / "series.csv").write_text("\n".join(rows) + "\n")
        (outdir / "final_state.json").write_text(json.dumps({"steps": steps, "final": value}, indent=2) + "\n")
        print(f"[good-platform] done final={value:.6f}", flush=True)

        done = {
            "status": "completed",
            "startedAt": started_iso,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wallSeconds": wall_seconds(started),
            "summary": {"steps": steps, "final": round(value, 6)},
            "files": [
                {"filename": "series.csv", "role": "data"},
                {"filename": "final_state.json", "role": "state"},
            ],
        }
    except Exception as exc:  # noqa: BLE001 —— 失败也必须留下终态
        print(f"[good-platform] failed: {exc}", flush=True)
        done = {
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "startedAt": started_iso,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wallSeconds": wall_seconds(started),
        }

    tmp = outdir / "done.json.tmp"
    tmp.write_text(json.dumps(done, indent=2) + "\n")
    os.replace(tmp, outdir / "done.json")
    return 0 if done["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
