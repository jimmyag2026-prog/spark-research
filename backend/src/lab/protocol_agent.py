from typing import Any


class LabProtocolAgent:
    TEMPLATES: dict[str, list[dict[str, Any]]] = {
        "DNA组装": [
            {
                "id": "dna-1",
                "action": "dispenseLiquid",
                "device": "liquid_handler",
                "params": {
                    "volume": 500,
                    "unit": "uL",
                    "reagents": [{"name": "insert", "reagentId": "insert", "concentration": 20}],
                },
                "expectedOutput": "insert solution prepared",
            },
            {
                "id": "dna-2",
                "action": "addSample",
                "device": "liquid_handler",
                "params": {
                    "volume": 50,
                    "unit": "uL",
                    "reagents": [{"name": "vector", "reagentId": "vector", "concentration": 10}],
                },
                "expectedOutput": "vector and insert mixed",
            },
            {
                "id": "dna-3",
                "action": "incubate",
                "device": "incubator",
                "params": {"temperature": 37, "durationSec": 1800},
                "expectedOutput": "ligation completed",
            },
        ],
        "蛋白质表达": [
            {
                "id": "expr-1",
                "action": "addSample",
                "device": "liquid_handler",
                "params": {"volume": 100, "unit": "uL", "reagents": [{"name": "culture", "reagentId": "culture", "concentration": 1}]},
                "expectedOutput": "culture inoculated",
            },
            {
                "id": "expr-2",
                "action": "shake",
                "device": "shaker",
                "params": {"rpm": 220, "temperature": 37},
                "expectedOutput": "culture grown to target OD",
            },
            {
                "id": "expr-3",
                "action": "centrifuge",
                "device": "centrifuge",
                "params": {"rcf": 6000, "duration": 600},
                "expectedOutput": "cells pelleted",
            },
        ],
        "酶活性测定": [
            {
                "id": "assay-1",
                "action": "dispenseLiquid",
                "device": "liquid_handler",
                "params": {"volume": 200, "unit": "uL", "reagents": [{"name": "buffer", "reagentId": "buffer", "concentration": 50}]},
                "expectedOutput": "assay buffer dispensed",
            },
            {
                "id": "assay-2",
                "action": "addSample",
                "device": "liquid_handler",
                "params": {"volume": 10, "unit": "uL", "reagents": [{"name": "enzyme", "reagentId": "enzyme", "concentration": 0.1}]},
                "expectedOutput": "enzyme added",
            },
            {
                "id": "assay-3",
                "action": "incubate",
                "device": "incubator",
                "params": {"temperature": 30, "durationSec": 900},
                "expectedOutput": "reaction progressed",
            },
            {
                "id": "assay-4",
                "action": "read",
                "device": "plate_reader",
                "params": {"wavelength": 340},
                "expectedOutput": "absorbance time course recorded",
            },
        ],
        "热稳定性筛选": [
            {
                "id": "thermal-1",
                "action": "addSample",
                "device": "liquid_handler",
                "params": {"volume": 40, "unit": "uL", "reagents": [{"name": "protein", "reagentId": "protein", "concentration": 5}]},
                "expectedOutput": "protein aliquots prepared",
            },
            {
                "id": "thermal-2",
                "action": "shake",
                "device": "shaker",
                "params": {"rpm": 300, "temperature": 60},
                "expectedOutput": "gradient heating applied",
            },
            {
                "id": "thermal-3",
                "action": "centrifuge",
                "device": "centrifuge",
                "params": {"rcf": 20000, "duration": 600},
                "expectedOutput": "aggregates separated",
            },
            {
                "id": "thermal-4",
                "action": "read",
                "device": "plate_reader",
                "params": {"wavelength": 280},
                "expectedOutput": "protein stability profile collected",
            },
        ],
    }

    TEMPLATE_KEYWORDS: dict[str, list[str]] = {
        "DNA组装": ["dna", "组装", "克隆", "连接", "ligation"],
        "蛋白质表达": ["蛋白质", "蛋白", "表达", "诱导", "expression"],
        "酶活性测定": ["酶", "活性", "酶活", "kinase", "activity"],
        "热稳定性筛选": ["热稳定", "筛选", "t50", "退火", "thermal"],
    }

    def generateProtocol(self, goal: str) -> list[dict[str, Any]]:
        goal_lower = goal.lower()
        for name, keywords in self.TEMPLATE_KEYWORDS.items():
            if any(keyword.lower() in goal_lower for keyword in keywords):
                return list(self.TEMPLATES[name])
        return list(self.TEMPLATES["DNA组装"])

    def listTemplates(self) -> list[str]:
        return list(self.TEMPLATES.keys())
