import math
import random
from typing import Any, Optional


class MockLiquidHandler:
    def __init__(self, device_id: str = "mock-liquid-handler"):
        self.id = device_id
        self.name = "Mock Liquid Handler"

    def execute(self, action: str, params: Optional[dict] = None) -> dict:
        params = params or {}
        if action not in ("dispenseLiquid", "addSample", "mix"):
            raise ValueError("unsupported action: %s" % action)
        return {
            "success": True,
            "device": self.id,
            "action": action,
            "volume": params.get("volume", 0),
            "unit": params.get("unit", "uL"),
        }


class MockShaker:
    def __init__(self, device_id: str = "mock-shaker"):
        self.id = device_id
        self.name = "Mock Thermal Shaker"

    def execute(self, action: str, params: Optional[dict] = None) -> dict:
        params = params or {}
        if action not in ("shake", "heat"):
            raise ValueError("unsupported action: %s" % action)
        return {
            "success": True,
            "device": self.id,
            "action": action,
            "rpm": params.get("rpm", 800),
            "temperature": params.get("temperature", 37),
        }


class MockPlateReader:
    def __init__(self, device_id: str = "mock-plate-reader"):
        self.id = device_id
        self.name = "Mock Plate Reader"

    def execute(self, action: str, params: Optional[dict] = None) -> dict:
        params = params or {}
        if action != "read":
            raise ValueError("unsupported action: %s" % action)
        n_wells = params.get("wells", 96)
        readings = [round(random.uniform(0.05, 1.8), 3) for _ in range(n_wells)]
        return {
            "success": True,
            "device": self.id,
            "action": action,
            "wavelength": params.get("wavelength", 600),
            "od600": readings[0],
            "readings": readings,
        }


class MockCentrifuge:
    def __init__(self, device_id: str = "mock-centrifuge"):
        self.id = device_id
        self.name = "Mock Centrifuge"

    def execute(self, action: str, params: Optional[dict] = None) -> dict:
        params = params or {}
        if action != "centrifuge":
            raise ValueError("unsupported action: %s" % action)
        return {
            "success": True,
            "device": self.id,
            "action": action,
            "rcf": params.get("rcf", 12000),
            "durationSec": params.get("duration", 60),
        }
