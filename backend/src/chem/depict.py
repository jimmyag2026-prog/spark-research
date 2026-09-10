#!/usr/bin/env python3
"""SMILES -> 2D 结构图（SVG）。

唯一调用方是 `depict.ts` 的子进程封装（见 backend/src/chem/depict.ts::runDepictScript）：
契约是 stdin 一份 JSON、stdout 一份 JSON，不是给人直接敲命令行用的工具（同目录下
`lab/wet_backend.py` 的 `--probe`/`--script` 走的是参数式 CLI，这个更窄——没有任何
命令行参数，读 stdin 就够了）。

stdin:  {"smiles": "<SMILES>", "width"?: number, "height"?: number}
stdout（成功）: {"ok": true, "svg", "canonicalSmiles", "formula", "molWeight", "rdkitVersion"}
stdout（失败）: {"ok": false, "error": {"kind": "invalid_smiles"|"rdkit_unavailable"|"bad_output", "message": "..."}}

kind="timeout" 不在这里产生——那是 depict.ts 在子进程超时被 kill 时自己判定的。
"""
import json
import sys


def fail(kind: str, message: str) -> None:
    print(json.dumps({"ok": False, "error": {"kind": kind, "message": message}}))


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        fail("bad_output", f"stdin 不是合法 JSON：{exc}")
        return 0

    smiles = payload.get("smiles")
    if not isinstance(smiles, str) or not smiles.strip():
        fail("invalid_smiles", "缺少 smiles 字段，或 smiles 是空字符串")
        return 0
    smiles = smiles.strip()

    width = payload.get("width") or 400
    height = payload.get("height") or 300

    try:
        import rdkit
        from rdkit import Chem, RDLogger
        from rdkit.Chem import Descriptors, rdMolDescriptors
        from rdkit.Chem.Draw import rdMolDraw2D
    except ImportError as exc:
        fail(
            "rdkit_unavailable",
            f"rdkit 未安装（{exc}）。安装：VIRTUAL_ENV=.venv uv pip install rdkit",
        )
        return 0

    # 无效 SMILES 时 RDKit 会把一堆 C++ 层解析日志打到 stderr——我们自己给结构化错误，
    # 不需要这些噪音（depict.ts 只在 depict.py 没有任何 stdout 时才会把 stderr 拼进 message）。
    RDLogger.DisableLog("rdApp.*")

    try:
        mol = Chem.MolFromSmiles(smiles)
    except Exception as exc:  # 部分非法化合价 RDKit 会抛异常而不是返回 None
        fail(
            "invalid_smiles",
            f"无法解析 SMILES '{smiles}'：{exc}。下一步：检查化合价/环闭合编号/括号是否配对。",
        )
        return 0

    if mol is None:
        fail(
            "invalid_smiles",
            f"无法解析 SMILES '{smiles}'：不是合法分子。下一步：检查元素符号、化合价、"
            "环闭合编号与括号是否配对；也可以在本地用 `python -c \"from rdkit import Chem; "
            f"Chem.MolFromSmiles({smiles!r})\"` 自查。",
        )
        return 0

    try:
        canonical = Chem.MolToSmiles(mol)
        formula = rdMolDescriptors.CalcMolFormula(mol)
        mol_weight = round(Descriptors.MolWt(mol), 4)

        drawer = rdMolDraw2D.MolDraw2DSVG(int(width), int(height))
        drawer.DrawMolecule(mol)
        drawer.FinishDrawing()
        svg = drawer.GetDrawingText()

        # rdkit 输出带 `<?xml ...?>` 前缀；depict.ts 的 assertSafeSvg 要求正文以 "<svg" 开头
        # （AD-12 口径的显式校验，不是随口定的），这里在生成端统一去掉前缀，而不是放宽校验。
        idx = svg.find("<svg")
        if idx < 0:
            fail("bad_output", "rdkit 没有产出合法 SVG（找不到 <svg 标签）")
            return 0
        svg = svg[idx:]
    except Exception as exc:
        fail("bad_output", f"渲染 SVG 失败：{exc}")
        return 0

    print(
        json.dumps(
            {
                "ok": True,
                "svg": svg,
                "canonicalSmiles": canonical,
                "formula": formula,
                "molWeight": mol_weight,
                "rdkitVersion": rdkit.__version__,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
