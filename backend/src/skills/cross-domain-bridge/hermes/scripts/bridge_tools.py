#!/usr/bin/env python3
"""cross-domain-bridge 的确定性部件（Hermes 版）。零依赖，只用标准库。

与 spark-research 仓库里 backend/src/ideation/bridge.ts 是同一套判据的移植：
  signature   结构签名的 schema + jargon 门
  proposal    单份提案的 schema
  audit       一批提案的结构审计（承重映射 ≥2 / 常规骨架 ≥2 / 一处非典型注入 / 伪证可排期 / 死路 / 同域）
  pairs       给通过审计的提案生成两两对决清单
  tournament  用裁决结果算 Elo 排名
  render      把排名渲染成 markdown 表（供主模型组织最终回复）
  selftest    自检

所有子命令：退出码 0 = 通过 / 成功；1 = 校验失败（stdout 有 JSON，errors 字段列原因）；2 = 用法错。
模型看到 1 就按 errors 重写，不要绕过。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MIN_LOAD_BEARING = 2
MIN_SKELETON = 2
MIN_FALSIFICATION_CHARS = 20
ELO_INITIAL = 1000.0
ELO_K = 32.0
LITERATURE_AGES = ("old", "recent", "mixed")


# ── 工具 ────────────────────────────────────────────────────────────────────

def _out(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    sys.exit(code)


def _load(path: str):
    p = Path(path)
    if not p.exists():
        _out({"ok": False, "errors": [f"文件不存在: {path}"]}, 2)
    text = p.read_text(encoding="utf-8")
    # 允许 ```json 围栏
    if "```" in text:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            text = text[start : end + 1]
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        _out({"ok": False, "errors": [f"不是合法 JSON: {e}"]}, 1)


def _str_or_joined(v, field, errors):
    if isinstance(v, list):
        items = [s.strip() for s in v if isinstance(s, str) and s.strip()]
        if not items:
            errors.append(f"字段 '{field}' 缺失或为空")
            return ""
        return "；".join(items)
    if not isinstance(v, str) or not v.strip():
        errors.append(f"字段 '{field}' 缺失或为空")
        return ""
    return v.strip()


def _str_list(v, field, errors, minimum=0):
    if v is None:
        if minimum > 0:
            errors.append(f"字段 '{field}' 缺失")
        return []
    if not isinstance(v, list):
        errors.append(f"字段 '{field}' 必须是字符串数组")
        return []
    items = [s.strip() for s in v if isinstance(s, str) and s.strip()]
    if len(items) < minimum:
        errors.append(f"字段 '{field}' 至少要有 {minimum} 项（现在 {len(items)}）")
    return items


def jargon_hits(text: str, terms):
    hay = text.lower()
    return [t.strip() for t in terms if len(t.strip()) >= 3 and t.strip().lower() in hay]


# ── signature ───────────────────────────────────────────────────────────────

def validate_signature(raw, terms):
    errors = []
    if not isinstance(raw, dict):
        return {"ok": False, "errors": ["结构签名必须是 JSON 对象"]}
    sig = {
        "objects": _str_list(raw.get("objects"), "objects", errors, 2),
        "relations": _str_list(raw.get("relations"), "relations", errors, 1),
        "dynamics": _str_or_joined(raw.get("dynamics"), "dynamics", errors),
        "constraints": _str_list(raw.get("constraints"), "constraints", errors, 0),
        "objective": _str_or_joined(raw.get("objective"), "objective", errors),
        "observables": _str_list(raw.get("observables"), "observables", errors, 1),
    }
    flat = "\n".join([*sig["objects"], *sig["relations"], sig["dynamics"], *sig["constraints"], sig["objective"], *sig["observables"]])
    hits = jargon_hits(flat, terms)
    if hits:
        errors.append(f"结构签名仍含领域术语：{'、'.join(hits)}——改用不依赖该领域的结构性描述")
    return {"ok": not errors, "errors": errors, "signature": sig if not errors else None}


def render_signature(sig):
    return "\n".join([
        f"对象：{'；'.join(sig['objects'])}",
        f"关系：{'；'.join(sig['relations'])}",
        f"动力学：{sig['dynamics']}",
        f"约束：{'；'.join(sig['constraints']) or '（无）'}",
        f"目标：{sig['objective']}",
        f"可观测量：{'；'.join(sig['observables'])}",
    ])


# ── proposal ────────────────────────────────────────────────────────────────

def validate_proposal(raw):
    errors = []
    if not isinstance(raw, dict):
        return {"ok": False, "errors": ["提案必须是 JSON 对象"]}
    mapping = []
    m = raw.get("mapping")
    if not isinstance(m, list):
        errors.append("字段 'mapping' 必须是数组——没有映射表的类比只是修辞")
    else:
        for i, row in enumerate(m):
            if not isinstance(row, dict):
                errors.append(f"mapping[{i}] 不是对象")
                continue
            mapping.append({
                "source": str(row.get("source", "")).strip(),
                "target": str(row.get("target", "")).strip(),
                "relation": str(row.get("relation", "")).strip(),
                "loadBearing": row.get("loadBearing") is True,
            })
        if not mapping:
            errors.append("字段 'mapping' 不能为空")
    age = str(raw.get("literatureAge", "")).strip()
    if age not in LITERATURE_AGES:
        errors.append(f"字段 'literatureAge' 必须是 {' / '.join(LITERATURE_AGES)}")
    p = {
        "field": _str_or_joined(raw.get("field"), "field", errors),
        "mechanism": _str_or_joined(raw.get("mechanism"), "mechanism", errors),
        "statement": _str_or_joined(raw.get("statement"), "statement", errors),
        "mapping": mapping,
        "conventionalSkeleton": _str_list(raw.get("conventionalSkeleton"), "conventionalSkeleton", errors, 0),
        "atypicalInjection": _str_or_joined(raw.get("atypicalInjection"), "atypicalInjection", errors),
        "cheapFalsification": _str_or_joined(raw.get("cheapFalsification"), "cheapFalsification", errors),
        "literatureAge": age if age in LITERATURE_AGES else "mixed",
        "references": _str_list(raw.get("references"), "references", errors, 0),
    }
    return {"ok": not errors, "errors": errors, "proposal": p if not errors else None}


# ── audit ───────────────────────────────────────────────────────────────────

def audit_proposal(p, dead_ends, source_field):
    findings = []
    lb = [m for m in p["mapping"] if m["loadBearing"]]
    if len(lb) < MIN_LOAD_BEARING:
        findings.append({"code": "superficial_analogy", "severity": "hard",
                         "message": f"承重映射只有 {len(lb)} 条（至少 {MIN_LOAD_BEARING}）——这是表面类比，不是结构同构"})
    broken = [m for m in lb if not (m["source"] and m["target"] and m["relation"])]
    if broken:
        findings.append({"code": "broken_mapping", "severity": "hard",
                         "message": f"{len(broken)} 条承重映射缺 source/target/relation 之一"})
    if len(p["conventionalSkeleton"]) < MIN_SKELETON:
        findings.append({"code": "all_novel", "severity": "hard",
                         "message": f"常规骨架只有 {len(p['conventionalSkeleton'])} 条（至少 {MIN_SKELETON}）——全新奇的组合不是高影响的形状"})
    if len(p["cheapFalsification"]) < MIN_FALSIFICATION_CHARS:
        findings.append({"code": "unfalsifiable", "severity": "hard",
                         "message": "廉价伪证方案太短，不足以排期——写清做什么实验/计算、看到什么就算错"})
    text = "\n".join([p["statement"], p["mechanism"], p["atypicalInjection"]])
    dead = jargon_hits(text, dead_ends)
    if dead:
        findings.append({"code": "dead_end_overlap", "severity": "soft",
                         "message": f"提案触及用户声明的死路：{'、'.join(dead)}——需要说明为什么这次不同"})
    if source_field and p["field"].strip().lower() == source_field.strip().lower():
        findings.append({"code": "same_field", "severity": "soft",
                         "message": "来源领域与问题所属领域相同——这不是跨领域桥"})
    return {"pass": not any(f["severity"] == "hard" for f in findings), "findings": findings}


# ── tournament ──────────────────────────────────────────────────────────────

def expected(a, b):
    return 1.0 / (1.0 + 10 ** ((b - a) / 400.0))


def run_tournament(proposals, verdicts):
    """proposals: list（顺序即 id 0..n-1）；verdicts: [{"a":i,"b":j,"winner":"a"|"b"|"tie"}]"""
    entries = [{"id": i, "field": p["field"], "rating": ELO_INITIAL, "wins": 0, "losses": 0, "ties": 0} for i, p in enumerate(proposals)]
    seen = set()
    for v in verdicts:
        i, j, w = int(v["a"]), int(v["b"]), str(v["winner"]).strip().lower()
        key = (min(i, j), max(i, j))
        if key in seen:
            continue
        seen.add(key)
        a, b = entries[i], entries[j]
        score_a = 1.0 if w == "a" else 0.0 if w == "b" else 0.5
        ea = expected(a["rating"], b["rating"])
        a["rating"] += ELO_K * (score_a - ea)
        b["rating"] += ELO_K * ((1 - score_a) - (1 - ea))
        if w == "a":
            a["wins"] += 1; b["losses"] += 1
        elif w == "b":
            b["wins"] += 1; a["losses"] += 1
        else:
            a["ties"] += 1; b["ties"] += 1
    n = len(proposals)
    expected_pairs = n * (n - 1) // 2
    ranked = sorted(entries, key=lambda e: (-e["rating"], -e["wins"], e["id"]))
    for r, e in enumerate(ranked, 1):
        e["rank"] = r
        e["rating"] = round(e["rating"], 1)
    return {"ranked": ranked, "judgedPairs": len(seen), "expectedPairs": expected_pairs, "complete": len(seen) == expected_pairs}


# ── CLI ─────────────────────────────────────────────────────────────────────

def cmd_signature(args):
    terms = [t for t in (args.terms or "").split(",") if t.strip()]
    r = validate_signature(_load(args.file), terms)
    if r["ok"]:
        r["rendered"] = render_signature(r["signature"])
    _out(r, 0 if r["ok"] else 1)


def cmd_proposal(args):
    r = validate_proposal(_load(args.file))
    _out(r, 0 if r["ok"] else 1)


def cmd_audit(args):
    dead = [t for t in (args.dead_ends or "").split(",") if t.strip()]
    files = sorted(Path(args.dir).glob("*.json"))
    passed, rejected, invalid = [], [], []
    for f in files:
        v = validate_proposal(_load(str(f)))
        if not v["ok"]:
            invalid.append({"file": f.name, "errors": v["errors"]})
            continue
        p = v["proposal"]
        a = audit_proposal(p, dead, args.source_field)
        item = {"file": f.name, "field": p["field"], "statement": p["statement"], "audit": a, "proposal": p}
        (passed if a["pass"] else rejected).append(item)
    out_dir = Path(args.dir)
    (out_dir / "_passed.json").write_text(json.dumps([x["proposal"] for x in passed], ensure_ascii=False, indent=2), encoding="utf-8")
    _out({
        "ok": True,
        "passed": [{"id": i, "file": x["file"], "field": x["field"], "statement": x["statement"], "soft": [f["message"] for f in x["audit"]["findings"]]} for i, x in enumerate(passed)],
        "rejected": [{"file": x["file"], "field": x["field"], "hard": [f["message"] for f in x["audit"]["findings"] if f["severity"] == "hard"]} for x in rejected],
        "invalid": invalid,
        "passedFile": str(out_dir / "_passed.json"),
    })


def cmd_pairs(args):
    props = _load(args.passed)
    n = len(props)
    pairs = [{"a": i, "b": j, "aField": props[i]["field"], "bField": props[j]["field"]} for i in range(n) for j in range(i + 1, n)]
    _out({"ok": True, "count": len(pairs), "pairs": pairs})


def cmd_tournament(args):
    props = _load(args.passed)
    verdicts = _load(args.verdicts)
    if isinstance(verdicts, dict):
        verdicts = verdicts.get("verdicts", [])
    r = run_tournament(props, verdicts)
    r["ok"] = True
    _out(r)


def cmd_render(args):
    props = _load(args.passed)
    ranking = _load(args.ranking)
    lines = ["| # | 领域 | Elo | 胜-负-平 | 假设 |", "|---|------|-----|---------|------|"]
    for e in ranking["ranked"]:
        p = props[e["id"]]
        lines.append(f"| {e['rank']} | {p['field']} | {e['rating']} | {e['wins']}-{e['losses']}-{e['ties']} | {p['statement'][:80]} |")
    print("\n".join(lines))


def cmd_selftest(_args):
    sig = {"objects": ["a", "b"], "relations": ["r"], "dynamics": ["d1", "d2"], "constraints": [], "objective": "o", "observables": ["x"]}
    assert validate_signature(sig, ["别构"])["ok"]
    assert not validate_signature({**sig, "objective": "预测别构位点"}, ["别构位点"])["ok"]
    good = {"field": "F", "mechanism": "m", "statement": "s",
            "mapping": [{"source": "a", "target": "b", "relation": "r", "loadBearing": True}, {"source": "c", "target": "d", "relation": "r", "loadBearing": True}],
            "conventionalSkeleton": ["k1", "k2"], "atypicalInjection": "x", "cheapFalsification": "x" * 25, "literatureAge": "old", "references": []}
    p = validate_proposal(good)["proposal"]
    assert audit_proposal(p, [], None)["pass"]
    bad = dict(p); bad["conventionalSkeleton"] = ["k1"]
    assert not audit_proposal(bad, [], None)["pass"]
    r = run_tournament([p, {**p, "field": "G"}, {**p, "field": "H"}], [{"a": 0, "b": 1, "winner": "b"}, {"a": 0, "b": 2, "winner": "b"}, {"a": 1, "b": 2, "winner": "b"}])
    assert [e["field"] for e in r["ranked"]] == ["H", "G", "F"] and r["complete"]
    assert abs(sum(e["rating"] for e in r["ranked"]) - 3 * ELO_INITIAL) < 0.5
    _out({"ok": True, "message": "selftest passed"})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("signature"); s.add_argument("file"); s.add_argument("--terms", default=""); s.set_defaults(fn=cmd_signature)
    s = sub.add_parser("proposal"); s.add_argument("file"); s.set_defaults(fn=cmd_proposal)
    s = sub.add_parser("audit"); s.add_argument("dir"); s.add_argument("--dead-ends", default=""); s.add_argument("--source-field", default=None); s.set_defaults(fn=cmd_audit)
    s = sub.add_parser("pairs"); s.add_argument("passed"); s.set_defaults(fn=cmd_pairs)
    s = sub.add_parser("tournament"); s.add_argument("passed"); s.add_argument("verdicts"); s.set_defaults(fn=cmd_tournament)
    s = sub.add_parser("render"); s.add_argument("passed"); s.add_argument("ranking"); s.set_defaults(fn=cmd_render)
    s = sub.add_parser("selftest"); s.set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
