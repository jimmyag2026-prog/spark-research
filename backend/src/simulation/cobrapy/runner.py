#!/usr/bin/env python3
"""cobrapy adapter 的 runner：基因组尺度代谢模型 → 通量平衡分析（FBA / pFBA / FVA）。

由 `SubprocessSimulationPlatform.submit()` 以
`python runner.py --params params.json --outdir <run 目录>` 启动。

**这个文件同时是可用性探测的落点**（`probe()`）——理由见 scanpy/runner.py 的模块 docstring：
探测与真跑必须指向同一条路径，否则会重演 V27（探测报可用、提交任务 ENOENT）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import cobra  # noqa: E402
from cobra.flux_analysis import flux_variability_analysis, pfba  # noqa: E402

from simulation.sim_runtime import RunContext, write_csv  # noqa: E402

# 氧气交换反应的常见 id（BiGG 口径）。找不到就报错而不是静默按有氧跑——
# 「以为把氧关了、其实没关」会让整个结论反过来。
OXYGEN_EXCHANGES = ("EX_o2_e", "EX_o2_LPAREN_e_RPAREN_", "EX_o2(e)")


def probe() -> dict:
    """探测入口：能 import cobra、且 LP 求解器真的在，才算可用。

    只 import cobra 是不够的：optlang 找不到任何求解器时，`import cobra` 照样成功，
    直到 `model.optimize()` 才炸。所以这里把求解器清单也一并查出来。
    """
    from importlib.metadata import version

    solvers = sorted(cobra.util.solver.solvers)
    if not solvers:
        raise RuntimeError("cobra 装上了但一个 LP 求解器都没有（optlang 找不到 glpk/cplex/gurobi）")
    return {
        "cobra": version("cobra"),
        "solvers": ",".join(solvers),
        "python": sys.version.split()[0],
    }


def load_model(path: str) -> "cobra.Model":
    suffix = "".join(Path(path).suffixes).lower()
    if suffix.endswith(".json"):
        return cobra.io.load_json_model(path)
    if suffix.endswith(".yml") or suffix.endswith(".yaml"):
        return cobra.io.load_yaml_model(path)
    if ".xml" in suffix or ".sbml" in suffix:
        return cobra.io.read_sbml_model(path)
    raise ValueError(f"不认识的模型格式 '{suffix}'（支持 .xml/.xml.gz/.sbml/.json/.yml）")


def apply_medium(model: "cobra.Model", medium: str) -> str:
    if medium == "model-default":
        return "模型自带的交换反应边界"
    exchange = next((r for r in OXYGEN_EXCHANGES if r in model.reactions), None)
    if exchange is None:
        raise ValueError(
            f"medium='{medium}' 需要氧气交换反应，但模型里找不到 {'/'.join(OXYGEN_EXCHANGES)}——"
            f"换个模型或用 medium=model-default"
        )
    reaction = model.reactions.get_by_id(exchange)
    if medium == "anaerobic":
        reaction.lower_bound = 0.0
        return f"{exchange}.lower_bound = 0（厌氧）"
    reaction.lower_bound = min(reaction.lower_bound, -20.0)
    return f"{exchange}.lower_bound = {reaction.lower_bound}（有氧）"


def main() -> None:
    with RunContext.from_argv() as ctx:
        p = ctx.params

        ctx.progress(0.1, "loading model")
        model = load_model(str(p["modelPath"]))
        n_reactions, n_metabolites, n_genes = len(model.reactions), len(model.metabolites), len(model.genes)

        medium_note = apply_medium(model, str(p["medium"]))

        objective = str(p["objective"])
        if objective:
            if objective not in model.reactions:
                raise ValueError(
                    f"objective='{objective}' 不是模型里的反应 id（模型有 {n_reactions} 个反应，"
                    f"例如 {', '.join(r.id for r in list(model.reactions)[:3])}）"
                )
            model.objective = objective

        knockouts = [k for k in str(p["knockouts"]).split(",") if k]
        for gene in knockouts:
            if gene not in model.genes:
                raise ValueError(
                    f"knockouts 里的 '{gene}' 不是模型里的基因 id（模型有 {n_genes} 个基因）"
                )
            model.genes.get_by_id(gene).knock_out()

        ctx.progress(0.4, "solving")
        solution = model.optimize()
        if solution.status != "optimal":
            raise RuntimeError(
                f"LP 求解状态为 '{solution.status}'（不是 optimal）——"
                f"模型在当前边界下不可行，检查 medium / knockouts"
            )
        objective_value = float(solution.objective_value)

        # pFBA：在保住最优目标值的前提下最小化总通量。FBA 的最优解常常不唯一
        # （alternate optima），不做这一步的话通量向量本身没有可复现性可言。
        if bool(p["parsimonious"]) and objective_value > 1e-9:
            ctx.progress(0.55, "parsimonious FBA")
            solution = pfba(model, fraction_of_optimum=1.0)

        fva = None
        if bool(p["fluxVariability"]):
            ctx.progress(0.7, "flux variability analysis")
            fva = flux_variability_analysis(model, fraction_of_optimum=float(p["fvaFraction"]))

        ctx.progress(0.85, "writing outputs")
        header = ["reaction", "name", "flux", "lowerBound", "upperBound"]
        if fva is not None:
            header += ["fvaMinimum", "fvaMaximum"]
        rows = []
        for reaction in model.reactions:
            row = [
                reaction.id,
                reaction.name,
                round(float(solution.fluxes[reaction.id]), 9),
                float(reaction.lower_bound),
                float(reaction.upper_bound),
            ]
            if fva is not None:
                row += [round(float(fva.minimum[reaction.id]), 9), round(float(fva.maximum[reaction.id]), 9)]
            rows.append(tuple(row))
        write_csv(ctx.declare("fluxes.csv", "flux_distribution"), header, rows)

        objective_expression = str(model.objective.expression)
        solution_path = ctx.declare("solution.json", "fba_solution")
        with open(solution_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "objectiveValue": objective_value,
                    "objectiveExpression": objective_expression,
                    "status": solution.status,
                    "medium": medium_note,
                    "knockouts": knockouts,
                    "parsimonious": bool(p["parsimonious"]),
                    "totalAbsoluteFlux": round(float(sum(abs(v) for v in solution.fluxes)), 9),
                    "activeReactions": int(sum(1 for v in solution.fluxes if abs(v) > 1e-9)),
                },
                handle,
                ensure_ascii=False,
                indent=2,
            )
            handle.write("\n")

        summary = {
            "reactions": n_reactions,
            "metabolites": n_metabolites,
            "genes": n_genes,
            "objectiveValue": round(objective_value, 9),
            "objectiveExpression": objective_expression,
            "status": solution.status,
            "medium": medium_note,
            "knockouts": ",".join(knockouts),
            "activeReactions": int(sum(1 for v in solution.fluxes if abs(v) > 1e-9)),
            "cobraVersion": probe()["cobra"],
        }
        print(
            f"[cobrapy] model={model.id} reactions={n_reactions} "
            f"objective={objective_value:.6f} status={solution.status}"
        )
        ctx.progress(1.0, "done")
        ctx.complete(summary)


if __name__ == "__main__":
    main()
