import json
import os
import sys
import random

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend", "src"))

from lab.protocol_agent import LabProtocolAgent
from lab.mock_devices import (
    MockLiquidHandler,
    MockShaker,
    MockPlateReader,
    MockCentrifuge,
)


def test_generate_dna_assembly_protocol():
    agent = LabProtocolAgent()
    protocol = agent.generateProtocol("请设计一个DNA组装实验方案")
    assert len(protocol) == 3
    assert protocol[0]["action"] == "dispenseLiquid"
    assert protocol[-1]["action"] == "incubate"
    assert all("id" in step for step in protocol)
    json.dumps(protocol)
    print("[PASS] DNA assembly protocol generated, JSON-serializable")


def test_generate_protein_expression_protocol():
    agent = LabProtocolAgent()
    protocol = agent.generateProtocol("做一次蛋白质表达与诱导")
    assert len(protocol) == 3
    assert protocol[0]["action"] == "addSample"
    assert any(step["device"] == "centrifuge" for step in protocol)
    print("[PASS] protein expression protocol generated")


def test_default_template_for_unknown_goal():
    agent = LabProtocolAgent()
    protocol = agent.generateProtocol("随便做个实验")
    assert protocol == agent.TEMPLATES["DNA组装"]
    print("[PASS] unknown goal falls back to DNA assembly template")


def test_mock_liquid_handler():
    handler = MockLiquidHandler()
    result = handler.execute("addSample", {"volume": 50, "unit": "uL"})
    assert result["success"] is True
    assert result["action"] == "addSample"
    assert result["volume"] == 50
    try:
        handler.execute("nonsense")
        assert False, "expected ValueError"
    except ValueError:
        pass
    print("[PASS] MockLiquidHandler addSample + invalid action rejection")


def test_mock_plate_reader():
    reader = MockPlateReader()
    random.seed(42)
    result = reader.execute("read", {"wavelength": 600, "wells": 96})
    assert result["success"] is True
    assert result["wavelength"] == 600
    assert len(result["readings"]) == 96
    assert all(0.0 <= od <= 2.0 for od in result["readings"])
    assert result["od600"] == result["readings"][0]
    print("[PASS] MockPlateReader returns 96-well simulated OD values")


def test_mock_shaker_and_centrifuge():
    shaker = MockShaker()
    shake = shaker.execute("shake", {"rpm": 220, "temperature": 37})
    assert shake["rpm"] == 220
    assert shake["temperature"] == 37

    centrifuge = MockCentrifuge()
    spin = centrifuge.execute("centrifuge", {"rcf": 6000, "duration": 600})
    assert spin["rcf"] == 6000
    assert spin["durationSec"] == 600
    print("[PASS] MockShaker + MockCentrifuge execution")


def run_all():
    tests = [
        test_generate_dna_assembly_protocol,
        test_generate_protein_expression_protocol,
        test_default_template_for_unknown_goal,
        test_mock_liquid_handler,
        test_mock_plate_reader,
        test_mock_shaker_and_centrifuge,
    ]
    for test in tests:
        test()
    print("\nALL %d TESTS PASSED" % len(tests))


if __name__ == "__main__":
    run_all()
