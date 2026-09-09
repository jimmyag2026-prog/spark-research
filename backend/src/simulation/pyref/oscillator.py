"""阻尼谐振子（damped harmonic oscillator）—— 纯 Python 参考仿真核心。

    m·x'' + c·x' + k·x = 0

选它当第二个参考实现，是因为它同时满足三件事：

1. **零外部依赖**：只用标准库 `math`，任何 Python 3.9+ 都能跑，CI 里永远可用；
2. **确定性**：RK4 定步长积分，没有随机数，同样参数逐位复现；
3. **有解析解可对照**：欠阻尼情形的闭式解已知，所以「仿真跑对了没有」是可判定的，
   而不是「跑完了没报错就算过」。

第 3 点是刻意的：一个只会「跑完不报错」的参考实现，验证不了契约测试之外的任何东西。
"""

from __future__ import annotations

import math
from typing import Dict, List, Tuple


def analytic_position(t: float, mass: float, stiffness: float, damping: float, x0: float, v0: float) -> float:
    """闭式解。欠阻尼 / 临界阻尼 / 过阻尼三种情形分别处理。"""
    omega_n = math.sqrt(stiffness / mass)
    zeta = damping / (2.0 * math.sqrt(stiffness * mass))
    if zeta < 1.0 - 1e-12:  # 欠阻尼
        omega_d = omega_n * math.sqrt(1.0 - zeta * zeta)
        decay = math.exp(-zeta * omega_n * t)
        return decay * (x0 * math.cos(omega_d * t) + ((v0 + zeta * omega_n * x0) / omega_d) * math.sin(omega_d * t))
    if abs(zeta - 1.0) <= 1e-12:  # 临界阻尼
        return (x0 + (v0 + omega_n * x0) * t) * math.exp(-omega_n * t)
    # 过阻尼
    root = omega_n * math.sqrt(zeta * zeta - 1.0)
    r1 = -zeta * omega_n + root
    r2 = -zeta * omega_n - root
    c1 = (v0 - r2 * x0) / (r1 - r2)
    c2 = x0 - c1
    return c1 * math.exp(r1 * t) + c2 * math.exp(r2 * t)


def _derivatives(x: float, v: float, mass: float, stiffness: float, damping: float) -> Tuple[float, float]:
    return v, (-stiffness * x - damping * v) / mass


def simulate(
    mass: float = 1.0,
    stiffness: float = 4.0,
    damping: float = 0.2,
    x0: float = 1.0,
    v0: float = 0.0,
    dt: float = 0.01,
    steps: int = 2000,
    sample_interval: int = 10,
    diverge_threshold: float = 1.0e6,
) -> Dict[str, object]:
    """RK4 定步长积分。返回采样轨迹 + 与解析解的对照。

    发散保护：dt 取得过大时 RK4 会指数放大。这里当场判定失败而不是产出一堆 inf ——
    「跑出了 NaN 的轨迹」是最难排查的一类假成功。
    """
    if mass <= 0:
        raise ValueError("mass 必须为正")
    if stiffness <= 0:
        raise ValueError("stiffness 必须为正")
    if dt <= 0 or steps <= 0:
        raise ValueError("dt 与 steps 必须为正")

    x, v = float(x0), float(v0)
    rows: List[Tuple[int, float, float, float, float, float]] = []
    max_abs_error = 0.0
    initial_energy = 0.5 * mass * v * v + 0.5 * stiffness * x * x

    def energy(px: float, pv: float) -> float:
        return 0.5 * mass * pv * pv + 0.5 * stiffness * px * px

    def record(step: int) -> None:
        nonlocal max_abs_error
        t = step * dt
        exact = analytic_position(t, mass, stiffness, damping, x0, v0)
        err = abs(x - exact)
        max_abs_error = max(max_abs_error, err)
        rows.append((step, t, x, v, energy(x, v), exact))

    record(0)
    for step in range(1, steps + 1):
        k1x, k1v = _derivatives(x, v, mass, stiffness, damping)
        k2x, k2v = _derivatives(x + 0.5 * dt * k1x, v + 0.5 * dt * k1v, mass, stiffness, damping)
        k3x, k3v = _derivatives(x + 0.5 * dt * k2x, v + 0.5 * dt * k2v, mass, stiffness, damping)
        k4x, k4v = _derivatives(x + dt * k3x, v + dt * k3v, mass, stiffness, damping)
        x += (dt / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x)
        v += (dt / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v)
        if not (math.isfinite(x) and math.isfinite(v)) or abs(x) > diverge_threshold:
            raise ArithmeticError(
                f"积分在第 {step} 步发散（|x|={abs(x):.3e}，dt={dt}）——步长相对固有周期过大，请减小 dt"
            )
        if step % sample_interval == 0 or step == steps:
            record(step)

    final_energy = energy(x, v)
    omega_n = math.sqrt(stiffness / mass)
    zeta = damping / (2.0 * math.sqrt(stiffness * mass))
    return {
        "rows": rows,
        "summary": {
            "steps": steps,
            "dt": dt,
            "simulatedTime": steps * dt,
            "naturalFrequencyRadPerS": omega_n,
            "dampingRatio": zeta,
            "regime": "underdamped" if zeta < 1 else ("critical" if abs(zeta - 1) <= 1e-12 else "overdamped"),
            "initialEnergy": initial_energy,
            "finalEnergy": final_energy,
            "energyRetainedFraction": (final_energy / initial_energy) if initial_energy > 0 else None,
            "finalPosition": x,
            "finalVelocity": v,
            "analyticFinalPosition": analytic_position(steps * dt, mass, stiffness, damping, x0, v0),
            "maxAbsErrorVsAnalytic": max_abs_error,
            "samples": len(rows),
        },
    }
