"""仿真 runner 的公共运行时（P5 · DESIGN 域 B1）。

契约（与 TS 侧 `SubprocessSimulationPlatform` 对齐）：

* runner 由 `python runner.py --params <params.json> --outdir <run 目录>` 启动；
* 产出文件一律写进 `--outdir`；
* 任务终结时**必须**写 `done.json`（`status` = completed / failed）；
* `done.json` 用「临时文件 + os.replace」原子落盘——半写的结果文件比没有结果更糟，
  编排侧会把它当成一份可信的终态；
* 可选地写 `progress.json`，编排侧 poll 时读它作为进度。

TS 侧 poll **先看 done.json 再看 pid**，所以只要这里守住原子写，
「编排进程被杀」和「任务本身跑挂」就能被可靠地区分开。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from typing import Any, Dict, Iterable, List, Optional, Tuple


class RunContext:
    def __init__(self, params: Dict[str, Any], outdir: str) -> None:
        self.params = params
        self.outdir = outdir
        self.started_at = time.time()
        self._files: List[Dict[str, str]] = []
        self._done = False

    # ── 入口 ────────────────────────────────────────────────────────────────
    @classmethod
    def from_argv(cls, argv: Optional[Iterable[str]] = None) -> "RunContext":
        parser = argparse.ArgumentParser()
        parser.add_argument("--params", required=True)
        parser.add_argument("--outdir", required=True)
        args = parser.parse_args(list(argv) if argv is not None else None)
        with open(args.params, "r", encoding="utf-8") as handle:
            params = json.load(handle)
        os.makedirs(args.outdir, exist_ok=True)
        return cls(params, args.outdir)

    # ── 产出 ────────────────────────────────────────────────────────────────
    def path(self, filename: str) -> str:
        return os.path.join(self.outdir, filename)

    def declare(self, filename: str, role: str) -> str:
        self._files.append({"filename": filename, "role": role})
        return self.path(filename)

    def progress(self, fraction: float, message: str = "") -> None:
        self._atomic_write(
            "progress.json",
            {"fraction": max(0.0, min(1.0, float(fraction))), "message": message},
        )

    # ── 终态 ────────────────────────────────────────────────────────────────
    def complete(self, summary: Dict[str, Any]) -> None:
        self._finish("completed", summary=summary)

    def fail(self, error: str) -> None:
        self._finish("failed", error=error)

    def _finish(self, status: str, summary: Optional[Dict[str, Any]] = None, error: str = "") -> None:
        if self._done:
            return
        self._done = True
        finished = time.time()
        envelope: Dict[str, Any] = {
            "status": status,
            "files": self._files if status == "completed" else [],
            "startedAt": _iso(self.started_at),
            "finishedAt": _iso(finished),
            "wallSeconds": round(finished - self.started_at, 4),
        }
        if summary is not None:
            envelope["summary"] = _scalarize(summary)
        if error:
            envelope["error"] = error
        self._atomic_write("done.json", envelope)

    def _atomic_write(self, filename: str, payload: Dict[str, Any]) -> None:
        target = self.path(filename)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)

    # ── 上下文管理：未捕获异常 = failed，绝不留「既没 done.json 又退出」的运行 ──
    def __enter__(self) -> "RunContext":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            if not self._done:
                self.fail("runner 结束但没有给出结果（既没 complete 也没 fail）")
            return False
        traceback.print_exception(exc_type, exc, tb, file=sys.stderr)
        self.fail(f"{exc_type.__name__}: {exc}")
        return True


def _iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch)) + f".{int(epoch % 1 * 1000):03d}Z"


def _scalarize(summary: Dict[str, Any]) -> Dict[str, Any]:
    """摘要只允许标量：它会原样进 observation record，嵌套结构在证据图里没法读。"""
    out: Dict[str, Any] = {}
    for key, value in summary.items():
        if value is None or isinstance(value, (str, bool, int)):
            out[key] = value
        elif isinstance(value, float):
            out[key] = value if value == value and abs(value) != float("inf") else None
        else:
            out[key] = str(value)
    return out


def write_csv(path: str, header: Iterable[str], rows: Iterable[Tuple[Any, ...]]) -> None:
    import csv

    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(list(header))
        for row in rows:
            writer.writerow(list(row))
