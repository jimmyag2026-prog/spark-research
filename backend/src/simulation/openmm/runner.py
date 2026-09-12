#!/usr/bin/env python3
"""OpenMM adapter 的 runner：水盒子能量最小化 + 短时 NVT 平衡。

最小可信任务（DESIGN 域 B1「OpenMM 最小 MD 任务」）：
  显式溶剂水盒子（TIP3P-FB / amber14）→ 能量最小化 → Langevin 中点积分器平衡若干步。
秒级完成、纯 CPU、无需 GPU，但走的是**真实**的 PME + 约束 + 恒温器路径，
不是玩具积分器。

由 `SubprocessSimulationPlatform.submit()` 以
`python runner.py --params params.json --outdir <run 目录>` 启动。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from simulation.sim_runtime import RunContext, write_csv  # noqa: E402


def probe() -> dict:
    """探测入口（V118）：与 scanpy/pydeseq2/cobrapy 同源——TS 侧 `probeCodeFor` 把**这个文件**当模块
    加载后调它；能 import openmm、能列出 Platform，就算可用。探测代码与真提交代码同一份，
    不再在 TS 里维护一份内联探测串（V27 形状根治）。"""
    import openmm  # noqa: F401
    from openmm import Platform

    names = [Platform.getPlatform(i).getName() for i in range(Platform.getNumPlatforms())]
    return {
        "openmm": openmm.version.version,
        "platforms": ",".join(names),
        "python": sys.version.split()[0],
    }

FORCE_FIELDS = {
    "tip3p": "amber14/tip3p.xml",
    "tip3pfb": "amber14/tip3pfb.xml",
    "spce": "amber14/spce.xml",
}


def main() -> None:
    with RunContext.from_argv() as ctx:
        import openmm
        from openmm import LangevinMiddleIntegrator, Platform, Vec3, XmlSerializer
        from openmm.app import ForceField, Modeller, PME, HBonds, Simulation, Topology
        from openmm.unit import (
            kelvin,
            kilojoule_per_mole,
            nanometer,
            nanometers,
            picosecond,
            picoseconds,
        )

        p = ctx.params
        box = float(p.get("boxSizeNm", 2.0))
        steps = int(p.get("steps", 500))
        timestep = float(p.get("timestepPs", 0.002))
        temperature = float(p.get("temperatureK", 300.0))
        friction = float(p.get("frictionPerPs", 1.0))
        report_every = int(p.get("reportInterval", 50))
        seed = int(p.get("seed", 12345))
        cutoff = float(p.get("cutoffNm", 0.9))
        water = str(p.get("waterModel", "tip3pfb"))
        platform_name = str(p.get("computePlatform", "CPU"))
        minimize = bool(p.get("minimize", True))

        ctx.progress(0.05, "building solvated box")
        forcefield = ForceField(FORCE_FIELDS[water])
        modeller = Modeller(Topology(), [])
        modeller.addSolvent(forcefield, boxSize=Vec3(box, box, box) * nanometers)
        n_atoms = modeller.topology.getNumAtoms()
        n_waters = modeller.topology.getNumResidues()

        ctx.progress(0.2, f"system: {n_atoms} atoms")
        system = forcefield.createSystem(
            modeller.topology,
            nonbondedMethod=PME,
            nonbondedCutoff=cutoff * nanometer,
            constraints=HBonds,
        )
        integrator = LangevinMiddleIntegrator(
            temperature * kelvin, friction / picosecond, timestep * picoseconds
        )
        integrator.setRandomNumberSeed(seed)
        simulation = Simulation(
            modeller.topology, system, integrator, Platform.getPlatformByName(platform_name)
        )
        simulation.context.setPositions(modeller.positions)

        def potential() -> float:
            return simulation.context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(
                kilojoule_per_mole
            )

        initial_potential = potential()
        ctx.progress(0.3, "minimizing")
        if minimize:
            simulation.minimizeEnergy()
        minimized_potential = potential()

        ctx.progress(0.4, "equilibrating")
        simulation.context.setVelocitiesToTemperature(temperature * kelvin, seed)

        rows = []
        temps = []
        dof = 3 * n_atoms - system.getNumConstraints() - 3

        def sample(step: int) -> None:
            state = simulation.context.getState(getEnergy=True)
            pot = state.getPotentialEnergy().value_in_unit(kilojoule_per_mole)
            kin = state.getKineticEnergy().value_in_unit(kilojoule_per_mole)
            # T = 2·KE / (dof·R)，R = 0.0083144621 kJ/(mol·K)
            inst_temp = 2.0 * kin / (dof * 0.0083144621) if dof > 0 else 0.0
            temps.append(inst_temp)
            rows.append((step, step * timestep, pot, kin, pot + kin, inst_temp))

        sample(0)
        done = 0
        while done < steps:
            chunk = min(report_every, steps - done)
            simulation.step(chunk)
            done += chunk
            sample(done)
            ctx.progress(0.4 + 0.5 * done / steps, f"step {done}/{steps}")

        traj = ctx.declare("energy.csv", "trajectory")
        write_csv(
            traj,
            ["step", "time_ps", "potential_kJ_per_mol", "kinetic_kJ_per_mol", "total_kJ_per_mol", "temperature_K"],
            rows,
        )

        state_path = ctx.declare("final_state.xml", "final_state")
        final_state = simulation.context.getState(
            getPositions=True, getVelocities=True, enforcePeriodicBox=True
        )
        with open(state_path, "w", encoding="utf-8") as handle:
            handle.write(XmlSerializer.serialize(final_state))

        equilibrated = temps[len(temps) // 2 :] or temps
        summary = {
            "atoms": n_atoms,
            "waterMolecules": n_waters,
            "boxSizeNm": box,
            "waterModel": water,
            "steps": steps,
            "timestepPs": timestep,
            "simulatedTimePs": steps * timestep,
            "targetTemperatureK": temperature,
            "initialPotentialKJPerMol": initial_potential,
            "minimizedPotentialKJPerMol": minimized_potential,
            "minimizationDropKJPerMol": initial_potential - minimized_potential,
            "finalPotentialKJPerMol": rows[-1][2],
            "finalKineticKJPerMol": rows[-1][3],
            "finalTotalKJPerMol": rows[-1][4],
            "meanEquilibratedTemperatureK": sum(equilibrated) / len(equilibrated),
            "samples": len(rows),
            "openmmVersion": openmm.version.version,
            "computePlatform": simulation.context.getPlatform().getName(),
            "seed": seed,
        }
        print(
            f"[openmm] {n_atoms} atoms · E_init={initial_potential:.1f} → "
            f"E_min={minimized_potential:.1f} → E_final={rows[-1][2]:.1f} kJ/mol · "
            f"T_mean={summary['meanEquilibratedTemperatureK']:.1f} K"
        )
        ctx.progress(1.0, "done")
        ctx.complete(summary)


if __name__ == "__main__":
    main()
