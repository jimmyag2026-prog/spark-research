"""Opentrons 官方模拟器执行后端（P6 · DESIGN 域 B2）。

替换 `mock_devices.py` 成为**默认**湿实验后端；mock 保留给单测（不需要装 opentrons 就能跑）。

契约（与 TS 侧 `OpentronsSimulatorBackend` 对齐，风格沿用 P5 的 `sim_runtime.py`）：

* 由 `python opentrons_backend.py --script <protocol.py> --outdir <run 目录>` 启动；
* 产出一律写进 `--outdir`：`runlog.json`（结构化）/ `runlog.txt`（人读）/ `done.json`（终态信封）；
* `done.json` 用「临时文件 + os.replace」原子落盘 —— 半写的结果比没有结果更糟，
  编排层会把它当成一份可信的终态（P5 决策 D1 的同一条纪律）；
* 任何异常都转成 `status=failed` 的 done.json，**绝不留「既没 done.json 又退出」的运行**；
* `--probe` 打印一行 JSON 用于可用性探测。

关于「结构化 run log」：`opentrons.simulate.simulate()` 返回的 runlog 条目形如
`{"level": int, "payload": {...}, "logs": [...]}`，payload 的键**随命令而变**，
而且官方文档明确说 `payload["text"]` 只是人读串、不保证格式稳定。所以这里做两件事：

1. 用 (payload 键签名 + text 前缀) 做确定性分类（`classify`），得到 `aspirate / dispense /
   mix / pick_up_tip / drop_tip / transfer / delay / comment / ...` 这些**我们自己**的类型名；
2. 更重要的：编译器在每个协议步骤前注入 `[spark-step] <stepId> <action>` 注释标记，
   于是每条 run log 都能被**锚定回编译产物里的某一步**，不依赖 opentrons 的文案。
   opentrons 换个版本改了措辞，锚定关系也不会断。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from typing import Any, Dict, Iterable, List, Optional, Tuple

STEP_MARKER = "[spark-step] "
READ_MARKER = "[spark-read] "
NOTE_MARKER = "[spark-note] "

# 我们自己的 run log 类型名。TS 侧断言只认这些，不认 opentrons 的文案。
ENTRY_TYPES = (
    "step_marker",
    "read_result",
    "note",
    "transfer",
    "aspirate",
    "dispense",
    "mix",
    "pick_up_tip",
    "drop_tip",
    "delay",
    "set_temperature",
    "wait_temperature",
    "deactivate",
    "shake",
    "latch",
    "move_labware",
    "pause",
    "comment",
)

# text 前缀 → 类型。顺序即优先级（先匹配到的赢）。
_TEXT_RULES: Tuple[Tuple[str, str], ...] = (
    ("Transferring", "transfer"),
    ("Distributing", "transfer"),
    ("Consolidating", "transfer"),
    ("Aspirating", "aspirate"),
    ("Dispensing", "dispense"),
    ("Mixing", "mix"),
    ("Picking up tip", "pick_up_tip"),
    ("Dropping tip", "drop_tip"),
    ("Returning tip", "drop_tip"),
    ("Delaying", "delay"),
    ("Setting Target Temperature", "set_temperature"),
    ("Setting Temperature", "set_temperature"),
    ("Waiting for", "wait_temperature"),
    ("Deactivating", "deactivate"),
    ("Setting Target Shake Speed", "shake"),
    ("Setting Heater-Shaker", "shake"),
    ("Latching", "latch"),
    ("Unlatching", "latch"),
    ("Moving", "move_labware"),
    ("Pausing", "pause"),
)

_NUM = r"(-?\d+(?:\.\d+)?)"


def _to_float(value: Any) -> Optional[float]:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def _location_text(payload: Dict[str, Any], key: str) -> Optional[str]:
    value = payload.get(key)
    if value is None:
        return None
    return str(value)


def classify(payload: Dict[str, Any]) -> Dict[str, Any]:
    """一条 runlog payload → 结构化条目（不含 index/depth/锚点，那些由调用方补）。

    刻意是**纯函数**：给一个 dict 出一个 dict，没有 IO，可以单独测。
    """
    text = str(payload.get("text", ""))
    entry: Dict[str, Any] = {"type": "comment", "text": text}

    if text.startswith(STEP_MARKER):
        rest = text[len(STEP_MARKER) :].strip().split(" ", 1)
        entry["type"] = "step_marker"
        entry["stepId"] = rest[0] if rest else ""
        entry["action"] = rest[1].strip() if len(rest) > 1 else ""
        return entry
    if text.startswith(READ_MARKER):
        entry["type"] = "read_result"
        payload_text = text[len(READ_MARKER) :].strip()
        entry["raw"] = payload_text
        try:
            entry["reading"] = json.loads(payload_text)
        except (ValueError, TypeError):
            entry["reading"] = None
        return entry
    if text.startswith(NOTE_MARKER):
        entry["type"] = "note"
        entry["note"] = text[len(NOTE_MARKER) :].strip()
        return entry

    for prefix, kind in _TEXT_RULES:
        if text.startswith(prefix):
            entry["type"] = kind
            break

    # 结构化字段优先取 payload 里的真值，取不到才回退到从 text 里抠。
    volume = _to_float(payload.get("volume"))
    if volume is None and entry["type"] in ("aspirate", "dispense", "mix", "transfer"):
        match = re.search(_NUM + r"\s*u[lL]", text) or re.search(_NUM, text)
        volume = _to_float(match.group(1)) if match else None
    if volume is not None:
        entry["volume"] = volume

    if payload.get("repetitions") is not None:
        entry["repetitions"] = int(payload["repetitions"])
    elif entry["type"] == "mix":
        match = re.search(r"Mixing\s+(\d+)\s+times", text)
        if match:
            entry["repetitions"] = int(match.group(1))

    for key, out_key in (("location", "location"), ("source", "source"), ("dest", "dest")):
        located = _location_text(payload, key)
        if located is not None:
            entry[out_key] = located

    if payload.get("instrument") is not None:
        entry["instrument"] = str(payload["instrument"])
    if payload.get("rate") is not None:
        rate = _to_float(payload["rate"])
        if rate is not None:
            entry["rate"] = rate

    if entry["type"] == "delay":
        seconds = _to_float(payload.get("seconds")) or 0.0
        minutes = _to_float(payload.get("minutes")) or 0.0
        entry["seconds"] = round(seconds + minutes * 60.0, 3)
    if entry["type"] == "set_temperature":
        match = re.search(_NUM + r"\s*°?\s*C", text)
        if match:
            entry["temperature"] = _to_float(match.group(1))
    if entry["type"] == "shake":
        match = re.search(_NUM + r"\s*rpm", text, re.IGNORECASE)
        if match:
            entry["rpm"] = _to_float(match.group(1))

    return entry


def structure_runlog(runlog: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """整条 run log → 结构化条目列表，并把每条锚定回编译产物里的步骤。

    锚点来自协议里注入的 `[spark-step]` 注释；标记本身也留在列表里（type=step_marker），
    这样「第几步开始」在结构化日志里是显式的，不用靠 index 推。
    """
    entries: List[Dict[str, Any]] = []
    current_step: Optional[str] = None
    current_action: Optional[str] = None
    # depth → 该层最近一条条目的下标。用来给每条命令找父命令：
    # `transfer` / `mix` 这类复合命令会把 aspirate/dispense 展开成 depth+1 的子命令，
    # 不区分父子就会把 mix 的来回吹打也算成「转移了多少液体」。
    open_by_depth: Dict[int, int] = {}
    for index, raw in enumerate(runlog):
        payload = dict(raw.get("payload") or {})
        entry = classify(payload)
        entry["index"] = index
        depth = int(raw.get("level") or 0)
        entry["depth"] = depth
        parent_index = open_by_depth.get(depth - 1) if depth > 0 else None
        entry["parentIndex"] = parent_index
        entry["parentType"] = entries[parent_index]["type"] if parent_index is not None else None
        open_by_depth[depth] = index
        for deeper in [d for d in open_by_depth if d > depth]:
            del open_by_depth[deeper]
        if entry["type"] == "step_marker":
            current_step = entry.get("stepId") or None
            current_action = entry.get("action") or None
        entry["stepId"] = entry.get("stepId") if entry["type"] == "step_marker" else current_step
        if entry["type"] != "step_marker":
            entry["action"] = current_action
        entries.append(entry)
    return entries


def summarize(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """标量摘要。只放**可判定**的量——不编造「实验成功」这种评价。"""
    counts: Dict[str, int] = {}
    for entry in entries:
        counts[entry["type"]] = counts.get(entry["type"], 0) + 1

    # 「实际转移了多少液体」：每条 dispense 都算一次，但**排除 mix 展开出来的**——
    # 混匀是在同一个孔里来回吹打，把它算进转移量会把数字吹成好几倍。
    # 不能简单用 depth==0 过滤：`transfer()` 会把真正的 dispense 放在 depth=1。
    dispensed = sum(
        float(e.get("volume") or 0.0)
        for e in entries
        if e["type"] == "dispense" and e.get("parentType") != "mix"
    )
    delay_seconds = sum(float(e.get("seconds") or 0.0) for e in entries if e["type"] == "delay")
    steps = [e["stepId"] for e in entries if e["type"] == "step_marker" and e.get("stepId")]
    temperatures = [e["temperature"] for e in entries if e.get("temperature") is not None]
    readings = [e.get("reading") for e in entries if e["type"] == "read_result"]

    summary: Dict[str, Any] = {
        "runLogEntries": len(entries),
        "protocolSteps": len(steps),
        "tipPickups": counts.get("pick_up_tip", 0),
        "aspirates": counts.get("aspirate", 0),
        "dispenses": counts.get("dispense", 0),
        "mixes": counts.get("mix", 0),
        "transfers": counts.get("transfer", 0),
        "moveLabware": counts.get("move_labware", 0),
        "dispensedUl": round(dispensed, 3),
        "delaySeconds": round(delay_seconds, 3),
        "readings": len([r for r in readings if r is not None]),
    }
    if temperatures:
        summary["maxTemperatureC"] = max(temperatures)
    return summary


def simulate_script(script_path: str) -> Dict[str, Any]:
    """跑一次 `opentrons.simulate.simulate()`，回结构化结果。

    import 放在函数体里：mock 后端（单测路径）不该因为没装 opentrons 就 import 失败。
    """
    from opentrons.simulate import format_runlog, simulate  # noqa: WPS433（见上）
    import opentrons

    with open(script_path, "r", encoding="utf-8") as handle:
        runlog, _bundle = simulate(handle, os.path.basename(script_path))

    entries = structure_runlog(runlog)
    return {
        "backend": "opentrons_simulate",
        "opentronsVersion": getattr(opentrons, "__version__", "unknown"),
        "entries": entries,
        "text": format_runlog(runlog),
        "summary": summarize(entries),
    }


def _atomic_write(path: str, payload: Dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def _probe() -> int:
    try:
        import opentrons
        from opentrons.protocols.api_support.definitions import (
            MAX_SUPPORTED_VERSION,
            MIN_SUPPORTED_VERSION,
        )

        print(
            json.dumps(
                {
                    "opentrons": getattr(opentrons, "__version__", "unknown"),
                    "minApiLevel": str(MIN_SUPPORTED_VERSION),
                    "maxApiLevel": str(MAX_SUPPORTED_VERSION),
                    "python": sys.version.split(" ")[0],
                }
            )
        )
        return 0
    except Exception as error:  # noqa: BLE001 —— 探测失败要给出可操作的原因，不是栈
        print(f"opentrons 不可用：{error}", file=sys.stderr)
        return 1


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Opentrons 模拟器执行后端")
    parser.add_argument("--script", help="Opentrons Python Protocol API v2 脚本路径")
    parser.add_argument("--outdir", help="产出目录（runlog.json / runlog.txt / done.json）")
    parser.add_argument("--probe", action="store_true", help="只做可用性探测")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.probe:
        return _probe()
    if not args.script or not args.outdir:
        parser.error("--script 与 --outdir 必须同时给出（或用 --probe）")

    os.makedirs(args.outdir, exist_ok=True)
    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(started)) + "Z"
    done_path = os.path.join(args.outdir, "done.json")

    try:
        result = simulate_script(args.script)
    except BaseException as error:  # noqa: BLE001 —— 任何失败都必须落成 done.json
        _atomic_write(
            done_path,
            {
                "status": "failed",
                "backend": "opentrons_simulate",
                "error": f"{type(error).__name__}: {error}",
                "traceback": traceback.format_exc()[-4000:],
                "startedAt": started_at,
                "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "wallSeconds": round(time.time() - started, 3),
                "files": [],
            },
        )
        print(f"opentrons 模拟执行失败：{error}", file=sys.stderr)
        return 1

    _atomic_write(
        os.path.join(args.outdir, "runlog.json"),
        {"entries": result["entries"], "summary": result["summary"]},
    )
    with open(os.path.join(args.outdir, "runlog.txt"), "w", encoding="utf-8") as handle:
        handle.write(result["text"] + "\n")

    _atomic_write(
        done_path,
        {
            "status": "completed",
            "backend": "opentrons_simulate",
            "opentronsVersion": result["opentronsVersion"],
            "summary": result["summary"],
            "files": [
                {"filename": "runlog.json", "role": "runlog"},
                {"filename": "runlog.txt", "role": "log"},
            ],
            "startedAt": started_at,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wallSeconds": round(time.time() - started, 3),
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
