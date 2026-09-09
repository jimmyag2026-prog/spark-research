import type { Protocol, ProtocolStep, SafetyCheckResult } from "./protocol";
import {
  PIPETTE_MAX_VOLUME_UL,
  PIPETTE_MIN_VOLUME_UL,
  PLATE_WELL_CAPACITY_UL,
  type OpentronsProgram,
} from "./opentrons_protocol";

// 湿实验安全门（DESIGN 域 B2）。P6 把 v0.1 埋在 orchestrator 里的三段 if 拆成
// **一组彼此独立的纯函数规则**：每条规则一个 id、一个显示名、一个 evaluate。
//
// 为什么要拆：
//   1. 每条规则都要能**单独**被对抗样例打（DEVELOPMENT_PLAN P6 退出标准）。
//      混在一个方法里，测「超浓度被拦」时其实同时依赖了另外两条规则没误报。
//   2. 规则要能吃**编译产物**。「这一孔会被加到 600 µL」这件事只有编译成
//      Opentrons deck 布局之后才知道 —— 自然语言协议层面看不出来。
//
// 安全门是**必要非充分条件**：全过也只是允许进入 awaiting_approval，
// 绝不等于可以执行（AD-6）。这条纪律由状态机守，不由本模块守。

export const MAX_CONCENTRATION: Readonly<Record<string, number>> = {
  hypochlorite: 100,
  ethanol: 95,
  strong_acid: 200,
};

export const CHEMICAL_COMPATIBILITY: Readonly<Record<string, readonly string[]>> = {
  strong_acid: ["hypochlorite", "hydroxide"],
  hypochlorite: ["strong_acid"],
  hydroxide: ["strong_acid"],
};

export const MAX_BIOSAFETY_LEVEL = 2;

export interface SafetyReport {
  passed: boolean;
  checks: SafetyCheckResult[];
}

export interface SafetyRuleInput {
  protocol: Protocol;
  // 编译产物。给了就用真实 deck 体积核对；没给就退回到协议声明的体积。
  program?: OpentronsProgram | null;
}

export interface SafetyRule {
  // 稳定 id（机器读，进 record metadata）。
  id: string;
  // 显示名。v0.1 起就是这三个字符串，外部断言依赖它，不改。
  check: string;
  description: string;
  evaluate(input: SafetyRuleInput): SafetyCheckResult;
}

interface ReagentLike {
  name: string;
  reagentId?: string;
  concentration?: number;
  stepId?: string;
}

function reagentsOf(protocol: Protocol): ReagentLike[] {
  return protocol.steps.flatMap((step: ProtocolStep) => {
    const list = (step.params.reagents ?? []) as ReagentLike[];
    return list.map((r) => ({ ...r, stepId: step.id }));
  });
}

function toMicroliters(value: unknown, unit: unknown): number | null {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return null;
  const u = String(unit ?? "uL").toLowerCase();
  if (u === "ml") return raw * 1000;
  if (u === "l") return raw * 1_000_000;
  return raw;
}

// ── 规则 1：试剂兼容性 ────────────────────────────────────────────────────────
export const chemicalCompatibilityRule: SafetyRule = {
  id: "chemical_compatibility",
  check: "chemical compatibility",
  description: "同一协议内不得同时出现互不相容的试剂（强酸 × 次氯酸盐 / 强酸 × 强碱）",
  evaluate({ protocol }) {
    const reagents = reagentsOf(protocol);
    const incompatible: string[] = [];
    for (let i = 0; i < reagents.length; i++) {
      for (let j = i + 1; j < reagents.length; j++) {
        const a = reagents[i]!;
        const b = reagents[j]!;
        if (!a.reagentId || !b.reagentId) continue;
        const conflicts =
          (CHEMICAL_COMPATIBILITY[a.reagentId] ?? []).includes(b.reagentId) ||
          (CHEMICAL_COMPATIBILITY[b.reagentId] ?? []).includes(a.reagentId);
        if (conflicts) incompatible.push(`${a.name} + ${b.name}`);
      }
    }
    return {
      check: "chemical compatibility",
      passed: incompatible.length === 0,
      detail: incompatible.length ? `incompatible reagents: ${incompatible.join(", ")}` : undefined,
    };
  },
};

// ── 规则 2：浓度上限 ─────────────────────────────────────────────────────────
export const concentrationLimitRule: SafetyRule = {
  id: "concentration_limit",
  check: "concentration limit",
  description: "受管制试剂的浓度不得超过 MAX_CONCENTRATION 表中的上限",
  evaluate({ protocol }) {
    const overLimit = reagentsOf(protocol).filter(
      (r) =>
        r.reagentId != null &&
        r.concentration != null &&
        (MAX_CONCENTRATION[r.reagentId] ?? Infinity) < r.concentration,
    );
    return {
      check: "concentration limit",
      passed: overLimit.length === 0,
      detail: overLimit.length
        ? `over-limit reagents: ${overLimit.map((r) => `${r.name} (${r.concentration})`).join(", ")}`
        : undefined,
    };
  },
};

// ── 规则 3：生物安全等级 ──────────────────────────────────────────────────────
export const biosafetyRule: SafetyRule = {
  id: "biosafety",
  check: "biosafety",
  description: `协议中任何步骤的生物安全等级不得超过 BSL-${MAX_BIOSAFETY_LEVEL}`,
  evaluate({ protocol }) {
    const offending = protocol.steps.filter(
      (s) => Number(s.params.biosafetyLevel ?? 1) > MAX_BIOSAFETY_LEVEL,
    );
    return {
      check: "biosafety",
      passed: offending.length === 0,
      detail: offending.length
        ? `biosafety level exceeds allowed maximum: ${offending
            .map((s) => `${s.id} (BSL-${s.params.biosafetyLevel})`)
            .join(", ")}`
        : undefined,
    };
  },
};

// ── 规则 4：体积 / 孔板容量（P6 新增） ─────────────────────────────────────────
//
// 这条规则是「安全门必须吃编译产物」的理由：一句「加 500 µL 样品到 A1」在自然语言层面
// 完全正常，只有排完 deck、把同一孔的多次加液累加起来，才知道 360 µL 的孔会溢。
// 溢孔在真机上就是把样品洒到 deck 上 —— 交叉污染 + 生物安全事故。
export const volumeCapacityRule: SafetyRule = {
  id: "volume_capacity",
  check: "volume capacity",
  description: "单孔累计体积不得超过孔板容量；单次转移体积必须在移液器量程内",
  evaluate({ protocol, program }) {
    const violations: string[] = [];

    if (program) {
      for (const [well, volume] of Object.entries(program.finalWellVolumesUl)) {
        if (volume > PLATE_WELL_CAPACITY_UL) {
          violations.push(
            `孔 ${well} 累计 ${volume} µL 超过孔板容量 ${PLATE_WELL_CAPACITY_UL} µL`,
          );
        }
        if (volume < -1e-6) {
          violations.push(`孔 ${well} 累计体积为负（${volume} µL）——协议里取走的比加进去的多`);
        }
      }
      for (const transfer of program.transfers) {
        if (transfer.volumeUl > PIPETTE_MAX_VOLUME_UL) {
          violations.push(
            `${transfer.stepId}: 单次转移 ${transfer.volumeUl} µL 超过移液器量程 ${PIPETTE_MAX_VOLUME_UL} µL`,
          );
        }
        if (transfer.volumeUl > 0 && transfer.volumeUl < PIPETTE_MIN_VOLUME_UL) {
          violations.push(
            `${transfer.stepId}: 单次转移 ${transfer.volumeUl} µL 低于移液器最小量程 ${PIPETTE_MIN_VOLUME_UL} µL`,
          );
        }
      }
    } else {
      // 没有编译产物时**不静默放行**：退回到协议声明的体积逐条核对单次加液。
      // 累计溢孔查不出来，detail 里说清楚查了什么、没查什么。
      for (const step of protocol.steps) {
        const volume = toMicroliters(step.params.volume, step.params.unit);
        if (volume === null) continue;
        if (volume > PLATE_WELL_CAPACITY_UL) {
          violations.push(
            `${step.id}: 单次加液 ${volume} µL 超过孔板容量 ${PLATE_WELL_CAPACITY_UL} µL`,
          );
        }
      }
    }

    return {
      check: "volume capacity",
      passed: violations.length === 0,
      detail: violations.length
        ? `volume violations: ${violations.join("; ")}`
        : program
          ? undefined
          : "未提供编译产物：只核对了单次加液体积，单孔累计体积待编译后复核",
    };
  },
};

export const SAFETY_RULES: readonly SafetyRule[] = [
  chemicalCompatibilityRule,
  concentrationLimitRule,
  biosafetyRule,
  volumeCapacityRule,
];

export function runSafetyRules(input: SafetyRuleInput): SafetyReport {
  const checks = SAFETY_RULES.map((rule) => rule.evaluate(input));
  return { passed: checks.every((c) => c.passed), checks };
}

// 规则 id ↔ 显示名 的映射（record metadata 里存 id，CLI 打显示名）。
export function ruleIdFor(check: string): string {
  return SAFETY_RULES.find((r) => r.check === check)?.id ?? check;
}
