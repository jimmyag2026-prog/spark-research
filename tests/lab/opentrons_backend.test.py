"""P6 · Opentrons 模拟器执行后端的 Python 侧测试。

分两层：
  ① 纯函数层（classify / structure_runlog / summarize）—— 不需要装 opentrons，永远跑得到；
  ② 真模拟器层（simulate_script / main）—— 需要 opentrons，装不上就整段 skip 并打印原因。

第 ① 层刻意用**合成的 payload**：payload 的键与文案是 opentrons 的产物，
在这里固定成样本，opentrons 换版本改了措辞时能立刻看到是哪一条分类挂了。
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", "src"))

from lab.opentrons_backend import (  # noqa: E402
    ENTRY_TYPES,
    classify,
    simulate_script,
    structure_runlog,
    summarize,
)

BACKEND = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", "src", "lab", "opentrons_backend.py"
)

try:  # pragma: no cover - 环境相关
    import opentrons  # noqa: F401

    HAS_OPENTRONS = True
    SKIP_REASON = ""
except Exception as error:  # pragma: no cover - 环境相关
    HAS_OPENTRONS = False
    SKIP_REASON = f"opentrons 未安装：{error}"

needs_opentrons = pytest.mark.skipif(not HAS_OPENTRONS, reason=SKIP_REASON)


# ── ① 纯函数层 ────────────────────────────────────────────────────────────────

def test_classify_step_marker_carries_step_and_action():
    entry = classify({"text": "[spark-step] step-3 read"})
    assert entry["type"] == "step_marker"
    assert entry["stepId"] == "step-3"
    assert entry["action"] == "read"


def test_classify_read_result_parses_json_payload():
    entry = classify({"text": '[spark-read] {"stepId": "step-3", "wavelength": 600}'})
    assert entry["type"] == "read_result"
    assert entry["reading"]["wavelength"] == 600


def test_classify_read_result_survives_unparsable_payload():
    # 读不出来就给 None —— 绝不编一个数字出来。
    entry = classify({"text": "[spark-read] not-json"})
    assert entry["type"] == "read_result"
    assert entry["reading"] is None


def test_classify_note():
    entry = classify({"text": "[spark-note] step-2 离机离心 12000 × g / 300 s"})
    assert entry["type"] == "note"
    assert "离心" in entry["note"]


def test_classify_aspirate_and_dispense_take_structured_volume():
    aspirate = classify(
        {
            "text": "Aspirating 50.0 uL from A1 of NEST 12 Well Reservoir 15 mL on slot D2 at 716.0 uL/sec",
            "volume": 50.0,
            "location": "A1 of NEST 12 Well Reservoir 15 mL on slot D2",
            "instrument": "flex_1channel_1000",
            "rate": 716.0,
        }
    )
    assert aspirate["type"] == "aspirate"
    assert aspirate["volume"] == 50.0
    assert aspirate["location"].startswith("A1 of NEST")
    assert aspirate["rate"] == 716.0

    dispense = classify({"text": "Dispensing 30.0 uL into A1 of Corning", "volume": 30.0})
    assert dispense["type"] == "dispense"
    assert dispense["volume"] == 30.0


def test_classify_falls_back_to_text_when_payload_has_no_volume():
    entry = classify({"text": "Mixing 3 times with a volume of 80.0 ul"})
    assert entry["type"] == "mix"
    assert entry["repetitions"] == 3
    assert entry["volume"] == 80.0


def test_classify_delay_sums_minutes_and_seconds():
    entry = classify({"text": "Delaying for 60 minutes and 0.0 seconds.", "minutes": 60, "seconds": 0.0})
    assert entry["type"] == "delay"
    assert entry["seconds"] == 3600.0


def test_classify_temperature_and_shake():
    temp = classify({"text": "Setting Target Temperature of Heater-Shaker to 37 °C"})
    assert temp["type"] == "set_temperature"
    assert temp["temperature"] == 37.0
    shake = classify({"text": "Setting Target Shake Speed to 800 rpm"})
    assert shake["type"] == "shake"
    assert shake["rpm"] == 800.0


def test_classify_tip_and_module_commands():
    assert classify({"text": "Picking up tip from A1 of tiprack"})["type"] == "pick_up_tip"
    assert classify({"text": "Dropping tip into Trash Bin on slot A3"})["type"] == "drop_tip"
    assert classify({"text": "Latching labware on Heater-Shaker"})["type"] == "latch"
    assert classify({"text": "Unlatching labware on Heater-Shaker"})["type"] == "latch"
    assert classify({"text": "Deactivating Heater"})["type"] == "deactivate"
    assert classify({"text": "Moving plate to reader with gripper"})["type"] == "move_labware"
    assert classify({"text": "Transferring 50.0 from A1 to B1"})["type"] == "transfer"


def test_classify_unknown_text_is_comment_not_a_guess():
    entry = classify({"text": "某个我们没见过的命令"})
    assert entry["type"] == "comment"
    assert entry["type"] in ENTRY_TYPES


def test_structure_runlog_anchors_entries_to_steps():
    runlog = [
        {"level": 0, "payload": {"text": "[spark-note] reservoir A1 = sample"}},
        {"level": 0, "payload": {"text": "[spark-step] step-1 addSample"}},
        {"level": 0, "payload": {"text": "Transferring 50.0 from A1 to B1", "volume": 50.0}},
        {"level": 1, "payload": {"text": "Aspirating 50.0 uL from A1", "volume": 50.0}},
        {"level": 1, "payload": {"text": "Dispensing 50.0 uL into B1", "volume": 50.0}},
        {"level": 0, "payload": {"text": "[spark-step] step-2 incubate"}},
        {"level": 0, "payload": {"text": "Delaying for 1 minutes and 0.0 seconds", "minutes": 1, "seconds": 0}},
    ]
    entries = structure_runlog(runlog)
    # 标记之前的条目没有归属，绝不倒填给第一步。
    assert entries[0]["stepId"] is None
    assert [e["stepId"] for e in entries[2:5]] == ["step-1"] * 3
    assert [e["action"] for e in entries[2:5]] == ["addSample"] * 3
    assert entries[6]["stepId"] == "step-2"
    assert entries[6]["action"] == "incubate"


def test_structure_runlog_tracks_parent_commands():
    runlog = [
        {"level": 0, "payload": {"text": "Mixing 3 times with a volume of 80.0 ul"}},
        {"level": 1, "payload": {"text": "Aspirating 80.0 uL from A1", "volume": 80.0}},
        {"level": 1, "payload": {"text": "Dispensing 80.0 uL into A1", "volume": 80.0}},
        {"level": 0, "payload": {"text": "Dispensing 100.0 uL into A2", "volume": 100.0}},
    ]
    entries = structure_runlog(runlog)
    assert entries[1]["parentType"] == "mix"
    assert entries[2]["parentType"] == "mix"
    assert entries[3]["parentType"] is None
    assert entries[0]["parentIndex"] is None


def test_summarize_excludes_mix_from_dispensed_volume():
    # 混匀是在同一个孔里来回吹打：算进转移量会把数字吹成几倍。
    runlog = [
        {"level": 0, "payload": {"text": "[spark-step] step-1 serialDilute"}},
        {"level": 0, "payload": {"text": "Dispensing 100.0 uL into A2", "volume": 100.0}},
        {"level": 0, "payload": {"text": "Mixing 3 times with a volume of 80.0 ul"}},
        {"level": 1, "payload": {"text": "Aspirating 80.0 uL from A2", "volume": 80.0}},
        {"level": 1, "payload": {"text": "Dispensing 80.0 uL into A2", "volume": 80.0}},
    ]
    summary = summarize(structure_runlog(runlog))
    assert summary["dispensedUl"] == 100.0
    assert summary["mixes"] == 1
    assert summary["protocolSteps"] == 1


def test_summarize_counts_transfer_children_once():
    runlog = [
        {"level": 0, "payload": {"text": "Transferring 50.0 from A1 to B1", "volume": 50.0}},
        {"level": 1, "payload": {"text": "Aspirating 50.0 uL from A1", "volume": 50.0}},
        {"level": 1, "payload": {"text": "Dispensing 50.0 uL into B1", "volume": 50.0}},
    ]
    summary = summarize(structure_runlog(runlog))
    assert summary["dispensedUl"] == 50.0
    assert summary["transfers"] == 1


# ── ② 真模拟器层 ──────────────────────────────────────────────────────────────

PROTOCOL_A = '''
requirements = {"robotType": "Flex", "apiLevel": "2.21"}
metadata = {"protocolName": "pytest-A"}


def run(protocol):
    tips = protocol.load_labware("opentrons_flex_96_tiprack_200ul", "C1")
    reservoir = protocol.load_labware("nest_12_reservoir_15ml", "D2")
    heater_shaker = protocol.load_module("heaterShakerModuleV1", "D1")
    plate = heater_shaker.load_labware("corning_96_wellplate_360ul_flat")
    protocol.load_trash_bin("A3")
    pipette = protocol.load_instrument("flex_1channel_1000", "left", tip_racks=[tips])
    heater_shaker.close_labware_latch()

    protocol.comment("[spark-step] step-1 addSample")
    pipette.transfer(50.0, reservoir["A1"], plate["A1"], new_tip="once")

    protocol.comment("[spark-step] step-2 incubate")
    heater_shaker.set_and_wait_for_temperature(37.0)
    protocol.delay(seconds=60.0, msg="step-2 incubate 37C")
    heater_shaker.deactivate_heater()
'''

BROKEN_PROTOCOL = '''
requirements = {"robotType": "Flex", "apiLevel": "2.21"}
metadata = {"protocolName": "pytest-broken"}


def run(protocol):
    protocol.load_labware("totally_not_a_labware", "D1")
'''


def _write(tmpdir, name, source):
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source)
    return path


@needs_opentrons
def test_simulate_script_runs_a_real_protocol():
    with tempfile.TemporaryDirectory() as tmpdir:
        result = simulate_script(_write(tmpdir, "a.py", PROTOCOL_A))

    assert result["backend"] == "opentrons_simulate"
    assert result["opentronsVersion"][0].isdigit()
    types = [e["type"] for e in result["entries"] if e["stepId"] == "step-1" and e["type"] != "step_marker"]
    assert types == ["transfer", "pick_up_tip", "aspirate", "dispense", "drop_tip"]
    assert result["summary"]["protocolSteps"] == 2
    assert result["summary"]["dispensedUl"] == 50.0
    assert result["summary"]["delaySeconds"] == 60.0
    assert result["summary"]["maxTemperatureC"] == 37.0
    assert "Aspirating 50.0 uL" in result["text"]


@needs_opentrons
def test_simulate_script_raises_on_invalid_protocol():
    with tempfile.TemporaryDirectory() as tmpdir:
        with pytest.raises(Exception):
            simulate_script(_write(tmpdir, "bad.py", BROKEN_PROTOCOL))


@needs_opentrons
def test_cli_writes_runlog_and_done_envelope():
    with tempfile.TemporaryDirectory() as tmpdir:
        script = _write(tmpdir, "a.py", PROTOCOL_A)
        outdir = os.path.join(tmpdir, "run")
        code = subprocess.call([sys.executable, BACKEND, "--script", script, "--outdir", outdir])
        assert code == 0
        with open(os.path.join(outdir, "done.json"), encoding="utf-8") as handle:
            done = json.load(handle)
        assert done["status"] == "completed"
        assert {f["filename"] for f in done["files"]} == {"runlog.json", "runlog.txt"}
        assert done["wallSeconds"] >= 0
        with open(os.path.join(outdir, "runlog.json"), encoding="utf-8") as handle:
            runlog = json.load(handle)
        assert len(runlog["entries"]) == done["summary"]["runLogEntries"]
        assert os.path.exists(os.path.join(outdir, "runlog.txt"))
        # 原子写：不留 .tmp 残骸
        assert not os.path.exists(os.path.join(outdir, "done.json.tmp"))


@needs_opentrons
def test_cli_writes_failed_envelope_instead_of_dying_silently():
    with tempfile.TemporaryDirectory() as tmpdir:
        script = _write(tmpdir, "bad.py", BROKEN_PROTOCOL)
        outdir = os.path.join(tmpdir, "run")
        code = subprocess.call(
            [sys.executable, BACKEND, "--script", script, "--outdir", outdir],
            stderr=subprocess.DEVNULL,
        )
        assert code == 1
        with open(os.path.join(outdir, "done.json"), encoding="utf-8") as handle:
            done = json.load(handle)
        # 「既没 done.json 又退出」是禁止的：失败也必须留一份可读的终态。
        assert done["status"] == "failed"
        assert done["error"]
        assert done["traceback"]
        assert done["files"] == []


@needs_opentrons
def test_cli_probe_reports_versions():
    output = subprocess.check_output([sys.executable, BACKEND, "--probe"], text=True)
    payload = json.loads(output.strip().split("\n")[-1])
    assert payload["opentrons"][0].isdigit()
    assert payload["maxApiLevel"].startswith("2.")


def test_cli_requires_script_and_outdir_together():
    result = subprocess.run(
        [sys.executable, BACKEND, "--script", "x.py"], capture_output=True, text=True
    )
    assert result.returncode != 0
    assert "--outdir" in result.stderr
