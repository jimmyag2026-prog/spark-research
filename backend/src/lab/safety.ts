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
//
// ⚠️ P10-d · D-8 口径收敛（评审原话：「过度声明的安全门比没有安全门更危险」），
// V25 更新——这四条规则**仍不是**同等强度的四道防线，但 concentration_limit / biosafety
// 从「恒空转」变成了「部分消费」：
//   - `volume_capacity`：唯一全程接编译产物核对的规则，累计溢孔 / 移液器量程都查。
//   - `chemical_compatibility`：认识一个**有限**的试剂词表（中文常见名 + 英文名/分子式，
//     见 protocol.ts 的 REAGENT_PATTERNS）。词表之外的试剂（不管中英文）它完全看不见。
//   - `concentration_limit`：protocol.ts 的 `extractConcentration()` 现在会尝试解析，
//     但**只在同一子句里恰好点名一种试剂时才把浓度挂上去**——同句多种试剂、或浓度描述
//     和试剂名分处不同子句（例如「配制次氯酸钠，浓度为10%」两个逗号分开的分句），
//     这条规则仍然拿不到输入，仍是空转。真正会触发它的只有「浓度 + 单一试剂同句出现」
//     这一种写法。
//   - `biosafety`：protocol.ts 的 `extractBiosafetyLevel()` 现在会尝试解析，能挂到
//     「这句话最终归属的那个步骤」（本句新建的步骤，或它作为续句合并进的上一步）。
//     一句独立的生物安全描述、前面没有任何步骤可挂时，仍然只报未消费。
//   本文件里用 `withReagents()` 手工往编译产物里注入 concentration/biosafetyLevel 的
//   对抗测试，验证的始终是「规则本身接住了会不会正确判断」——这一半从 D-8 起就是对的，
//   没有变化。变化的是「真实编译入口现在也能喂出这种输入」，条件见上面两条。
// 漏检仍然要可见：protocol.ts 的 `Protocol.warnings`（unconsumed 信号）会把「这句话
// 有浓度/生物安全描述但没能确定性地解析/归属」列出来，且**必须**在 CLI / 正文里显示
// （backend/src/lab/cli.ts、wet_models.ts 的 renderWetExperiment）——安全门看不见的东西，
// 至少不能悄悄绿灯放行而不留痕迹。

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

// V59（BACKLOG）①：`lab compile` 那一屏与 `lab status` 现在共用同一段覆盖范围声明——
// 之前两处各写一份，`wet_models.ts` 的 `renderWetExperiment()` 里那份在 V55 落地后
// 变成了假话（还在说「英文协议编译不出步骤」），而 compile 那一屏（**绝大多数人
// 就是在这一屏看到四行 ✅ 的**）压根没有这段声明。抽成常量：cli.ts 的 `compile`
// 分支直接引用它打印；`wet_models.ts` 改成引用同一个常量还没做——那是 W8-1 ε
// 足迹外的文件（收口清单里有对应 diff），本文件先把「唯一真源」立好。
// **只改文案，不改任何阈值/规则语义**——四条规则的 evaluate() 逻辑一行未动。
export const SAFETY_COVERAGE_STATEMENT =
  "覆盖范围口径（**每次改安全门都要同步这段**——它出现在审批决策点上）：\n" +
  "· `volume_capacity`：唯一全程接编译产物核对的规则，累计溢孔与移液器量程都查。\n" +
  "· `chemical_compatibility`：认识一个**有限**的试剂词表（中文常见名 + 英文名/分子式）。" +
  "词表之外的试剂它完全看不见，不是「相容」；且**本规则不看孔位**——只要协议里同时出现过两种" +
  "不相容试剂就会拦，不检查它们是否真的会混进同一个孔。\n" +
  "· `concentration_limit`：只在**同句恰好点名一种试剂**时才拿得到浓度（跨句写法拿不到，会落" +
  "未消费告警）。解析到了但限值表里没有该试剂时**不放行**，理由写「没有规则可查」——" +
  "「查不到规则」不等于「检查通过」。另外百分比 > 100 一律拦（物理上不存在）。" +
  "限值表目前只覆盖 4 类试剂（盐酸/硫酸、次氯酸钠、乙醇），其中三类阈值就是 100——" +
  "与「物理上不可能」重合，**通过只表示「没超物理极限」，不表示「在安全限值内」**。\n" +
  "· `biosafety`：认识 `BSL-n`、`生物安全N级`、`biosafety level N`，以及口语化的" +
  "`PN 实验室`/裸 `PN`（P 分级与 BSL 分级是同一件事的两种命名）。能挂到「这句话最终归属的" +
  "那个步骤」；一句独立的生物安全描述、前面没有步骤可挂时，只报未消费。\n" +
  "· 自然语言步骤解析中英双语都能编（V55）：中文/英文协议均能编出步骤，混排也支持；" +
  "试剂词表、温度/时长/体积的量纲解析同样中英通用。\n" +
  "漏看了什么，看「未被安全门消费的信号」。";

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
  /** 浓度单位（发布前外部验收补）：规则不能在不知道单位的情况下比较数值。见 protocol.ts 的 ReagentSpec。 */
  concentrationUnit?: "percent" | "molar" | "other" | "unspecified";
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
  // V59（BACKLOG）③：口径必须在描述里就说清楚，不能只在拦截时才说——
  // 「不看孔位」是这条规则**始终成立**的性质，通过时也一样，不是失败才有的免责声明。
  description:
    "同一协议内不得同时出现互不相容的试剂（强酸 × 次氯酸盐 / 强酸 × 强碱）——" +
    "本规则不看孔位：只要协议里同时出现过这两种试剂就会拦，不检查它们是否真的会混进同一个孔",
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
    // V59（BACKLOG）④：旧消息是「incompatible reagents: A + B」——英文残句，
    // 不给下一步。统一成中文完整句：试剂对 + 本规则不看孔位的说明 + 下一步。
    return {
      check: "chemical compatibility",
      passed: incompatible.length === 0,
      detail: incompatible.length
        ? `试剂不相容：${incompatible.join("、")}。本规则不看孔位——只要协议里同时出现过这两种` +
          `试剂就会拦，不检查它们是否真的会混进同一个孔。下一步：分开配制/分批执行，或改用相容的试剂。`
        : undefined,
    };
  },
};

// ── 规则 2：浓度上限 ─────────────────────────────────────────────────────────
export const concentrationLimitRule: SafetyRule = {
  id: "concentration_limit",
  check: "concentration limit",
  description: "受管制试剂的浓度不得超过 MAX_CONCENTRATION 表中的上限",
  evaluate({ protocol }) {
    // **发布前外部验收（BLOCKER-2）**：这里原来是 `MAX_CONCENTRATION[r.reagentId] ?? Infinity`
    // ——限值表里没有条目的试剂，阈值当成无穷大，于是**一律 ✅ 通过**。
    //
    // 验收者的原话点破了性质：「『我查了，没有针对这个试剂的规则』和『我查了，通过了』
    // 在输出里是**同一个符号**」——这正是本项目红线「没查到 ≠ 查了没有」的镜像违反，
    // 而且落在湿实验安全门上，是 README 自己说的「过度声明的安全门比没有安全门更危险」。
    //
    // 修法：**解析出了浓度、却查不到限值** = 这条规则**没有覆盖**它，不是「安全」。
    // 判定为不通过，理由里说清楚是「没有规则可查」而不是「超标」——两者该做的事不同。
    // 湿实验本来就要过人工审批（AD-6），门在这里拦一下只是把人的注意力引到该看的地方。
    const withConcentration = reagentsOf(protocol).filter(
      (r) => r.reagentId != null && r.concentration != null,
    );
    // 「物理上不可能」与「超标」**不重复报**：150% 次氯酸钠既 >100% 又超过表里的 100，
    // 两条都列会让用户以为是两个独立问题（窄范围验收指出消息拼接略糙）。
    // 物理不可能是更根本的那条，命中它就不再报超标。
    const impossibleSet = new Set(
      withConcentration.filter((r) => r.concentrationUnit === "percent" && r.concentration! > 100),
    );
    const overLimit = withConcentration.filter(
      (r) =>
        !impossibleSet.has(r) &&
        MAX_CONCENTRATION[r.reagentId!] != null &&
        MAX_CONCENTRATION[r.reagentId!]! < r.concentration!,
    );
    const uncovered = withConcentration.filter((r) => MAX_CONCENTRATION[r.reagentId!] == null);
    // **物理上不可能的浓度**：百分比 > 100。这一条与限值表无关，也**不需要编造任何阈值**——
    // 验收发现 `101% 硫酸` 能通过，因为 strong_acid 的阈值写的是 200（那个数在百分比语境下
    // 没有意义）。单位口径本身是既有未决问题（解析器原来把单位丢了，规则在比较自己不知道
    // 单位的数），这里只做无歧义的那一半：**浓度超过 100% 的东西不存在**。
    const impossible = [...impossibleSet];

    const details: string[] = [];
    if (impossible.length) {
      details.push(
        `浓度在物理上不可能（百分比 > 100%）：` +
          `${impossible.map((r) => `${r.name} (${r.concentration}%)`).join(", ")}。` +
          `下一步：确认是不是把 mol/L 写成了 %，或者少写了小数点。`,
      );
    }
    // V59（BACKLOG）④：旧消息是「over-limit reagents: 乙醇 (200)」——英文残句、
    // 不说限值是多少、不说单位、不给下一步（同一条规则里 impossible/uncovered 两个
    // 分支已经是中文完整句，这一条明显落后一个数量级）。统一成：数值 + 单位 +
    // 限值 + 下一步。`unspecified` 口径本来就是「没写单位、按限值表的百分比口径
    // 理解」（见 protocol.ts extractConcentration），如实标注不是真的写了 %。
    if (overLimit.length) {
      details.push(
        `浓度超过限值：${overLimit
          .map((r) => {
            const value =
              r.concentrationUnit === "percent" ? `${r.concentration}%` : `${r.concentration}（未标注单位，按百分比口径比较）`;
            return `${r.name}（${value}，上限 ${MAX_CONCENTRATION[r.reagentId!]}%）`;
          })
          .join("、")}。下一步：把浓度降到上限以内再重新编译协议；如确有必要使用更高浓度，` +
          `需要人工复核并调整 MAX_CONCENTRATION（并说明理由）。`,
      );
    }
    if (uncovered.length) {
      details.push(
        `限值表里没有这些试剂的条目，本规则**未覆盖**它们（这不是「安全」，是「没有规则可查」）：` +
          `${uncovered.map((r) => `${r.name} (${r.concentration})`).join(", ")}。` +
          `下一步：人工核对这些浓度是否安全；若该试剂应当受管，把阈值加进 MAX_CONCENTRATION 再重新编译。`,
      );
    }
    return {
      check: "concentration limit",
      passed: overLimit.length === 0 && uncovered.length === 0 && impossible.length === 0,
      detail: details.length ? details.join("；") : undefined,
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

    // V59（BACKLOG）④：四条 violation 消息统一补上「下一步」——限值与单位本来就有，
    // 缺的是「知道超标之后该做什么」，与 chemical_compatibility / concentration_limit
    // 两条同一次改齐。
    if (program) {
      for (const [well, volume] of Object.entries(program.finalWellVolumesUl)) {
        if (volume > PLATE_WELL_CAPACITY_UL) {
          violations.push(
            `孔 ${well} 累计 ${volume} µL 超过孔板容量 ${PLATE_WELL_CAPACITY_UL} µL。` +
              `下一步：减少这个孔的总加液量，或把样品分装到多个孔。`,
          );
        }
        if (volume < -1e-6) {
          violations.push(
            `孔 ${well} 累计体积为负（${volume} µL）——协议里取走的比加进去的多。` +
              `下一步：核对协议里这个孔的加液/取液顺序与数量。`,
          );
        }
      }
      for (const transfer of program.transfers) {
        if (transfer.volumeUl > PIPETTE_MAX_VOLUME_UL) {
          violations.push(
            `${transfer.stepId}: 单次转移 ${transfer.volumeUl} µL 超过移液器量程 ${PIPETTE_MAX_VOLUME_UL} µL。` +
              `下一步：把这一步拆成多次转移，每次不超过量程。`,
          );
        }
        if (transfer.volumeUl > 0 && transfer.volumeUl < PIPETTE_MIN_VOLUME_UL) {
          violations.push(
            `${transfer.stepId}: 单次转移 ${transfer.volumeUl} µL 低于移液器最小量程 ${PIPETTE_MIN_VOLUME_UL} µL。` +
              `下一步：把体积提高到最小量程以上，或换用更小量程的移液器。`,
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
            `${step.id}: 单次加液 ${volume} µL 超过孔板容量 ${PLATE_WELL_CAPACITY_UL} µL。` +
              `下一步：减少这一步的加液量，或改用更大容量的孔板。`,
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
