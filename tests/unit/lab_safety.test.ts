import { describe, expect, test } from "bun:test";
import { compileToOpentrons } from "../../backend/src/lab/opentrons_protocol";
import { LabSafetyGate } from "../../backend/src/lab/orchestrator";
import { ProtocolCompiler, type Protocol } from "../../backend/src/lab/protocol";
import {
  SAFETY_RULES,
  biosafetyRule,
  chemicalCompatibilityRule,
  concentrationLimitRule,
  runSafetyRules,
  volumeCapacityRule,
} from "../../backend/src/lab/safety";

// P6 安全门对抗矩阵（DEVELOPMENT_PLAN P6 退出标准：「safety gate 对抗样例全部拦截」）。
//
// 纪律：**每条规则单独打**。混在一起测「协议被拦下了」，
// 通不过的可能是另一条规则，被测的那条其实一直在漏。

const compiler = new ProtocolCompiler();

function withReagents(
  text: string,
  reagents: Array<{ name: string; reagentId?: string; concentration?: number }>,
  stepIndex = 0,
): Protocol {
  const protocol = compiler.compile(text, { name: "adversarial", protocolId: "pid" });
  protocol.steps[stepIndex]!.params.reagents = reagents;
  return protocol;
}

describe("安全门 · 规则集结构", () => {
  test("四条规则，id 与显示名都唯一", () => {
    expect(SAFETY_RULES).toHaveLength(4);
    expect(new Set(SAFETY_RULES.map((r) => r.id)).size).toBe(4);
    expect(new Set(SAFETY_RULES.map((r) => r.check)).size).toBe(4);
    expect(SAFETY_RULES.map((r) => r.id)).toEqual([
      "chemical_compatibility",
      "concentration_limit",
      "biosafety",
      "volume_capacity",
    ]);
  });

  test("每条规则都是纯函数：同一输入调两次结果一致", () => {
    const protocol = compiler.compile("加入50uL样品", { name: "pure" });
    for (const rule of SAFETY_RULES) {
      expect(rule.evaluate({ protocol })).toEqual(rule.evaluate({ protocol }));
    }
  });

  test("干净协议：四条全过", () => {
    const protocol = compiler.compile("取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD", { name: "ok" });
    const report = runSafetyRules({ protocol, program: compileToOpentrons(protocol) });
    expect(report.passed).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });
});

describe("对抗 ① 不兼容试剂组合", () => {
  test("强酸 + 次氯酸盐 → 拦截，且指名是哪两样", () => {
    const protocol = compiler.compile("加入10uL盐酸，加入10uL次氯酸钠", { name: "boom" });
    const result = chemicalCompatibilityRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("盐酸 + 次氯酸钠");
  });

  test("强酸 + 强碱 → 拦截", () => {
    const protocol = withReagents("加入10uL试剂", [
      { name: "盐酸", reagentId: "strong_acid" },
      { name: "氢氧化钠", reagentId: "hydroxide" },
    ]);
    expect(chemicalCompatibilityRule.evaluate({ protocol }).passed).toBe(false);
  });

  test("阴性：乙醇 + 强酸不在冲突表里 → 放行（不做无差别拦截）", () => {
    const protocol = withReagents("加入10uL试剂", [
      { name: "乙醇", reagentId: "ethanol" },
      { name: "盐酸", reagentId: "strong_acid" },
    ]);
    expect(chemicalCompatibilityRule.evaluate({ protocol }).passed).toBe(true);
  });

  test("这条规则不受其他三条影响：单独评估只看试剂对", () => {
    const protocol = withReagents("加入10uL试剂", [
      { name: "次氯酸钠", reagentId: "hypochlorite", concentration: 5000 },
    ]);
    // 浓度爆表，但兼容性规则本身应当放行 —— 各管各的。
    expect(chemicalCompatibilityRule.evaluate({ protocol }).passed).toBe(true);
    expect(concentrationLimitRule.evaluate({ protocol }).passed).toBe(false);
  });

  // P10-d · D-8：评审实测「英文/分子式协议整体免疫」——试剂词表只有 6 个中文关键词时，
  // 下面这些输入压根提取不出 reagentId，chemical_compatibility 无从判断，静默放行。
  // 词表扩到英文名/分子式之后，同样的化学冲突要在**真实编译入口**（不是 withReagents
  // 手工注入）就能被拦下。
  test("英文名协议：HCl + NaClO 走真实编译入口也会被拦（不再靠手工注入）", () => {
    const protocol = compiler.compile("加入10uL HCl，加入10uL NaClO", { name: "english" });
    const result = chemicalCompatibilityRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
  });

  test("分子式协议：NaOH + HCl（强碱 × 强酸）同样被拦", () => {
    const protocol = compiler.compile("加入10uL NaOH，加入10uL HCl", { name: "formula" });
    expect(chemicalCompatibilityRule.evaluate({ protocol }).passed).toBe(false);
  });

  test("中英混写同一份协议：盐酸（中文）+ NaClO（分子式）照样识别成同一对冲突", () => {
    const protocol = compiler.compile("加入10uL盐酸，加入10uL NaClO", { name: "mixed" });
    const result = chemicalCompatibilityRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("盐酸");
  });

  test("阴性对照：ethanol（英文名）单独出现不误杀", () => {
    const protocol = compiler.compile("加入10uL ethanol", { name: "ethanol-alone" });
    expect(chemicalCompatibilityRule.evaluate({ protocol }).passed).toBe(true);
  });
});

describe("对抗 ② 超浓度", () => {
  test("次氯酸钠 500（上限 100）→ 拦截并报出实际值", () => {
    const protocol = withReagents("加入10uL次氯酸钠", [
      { name: "次氯酸钠", reagentId: "hypochlorite", concentration: 500 },
    ]);
    const result = concentrationLimitRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("次氯酸钠 (500)");
  });

  test("恰好等于上限 → 放行（边界不误杀）", () => {
    const protocol = withReagents("加入10uL乙醇", [
      { name: "乙醇", reagentId: "ethanol", concentration: 95 },
    ]);
    expect(concentrationLimitRule.evaluate({ protocol }).passed).toBe(true);
  });

  test("表外试剂不设上限 → 放行（不凭空造标准）", () => {
    const protocol = withReagents("加入10uL缓冲液", [
      { name: "buffer", reagentId: "buffer", concentration: 9999 },
    ]);
    expect(concentrationLimitRule.evaluate({ protocol }).passed).toBe(true);
  });

  // V25：上面三条全是 withReagents() 手工注入——测的是规则本身。这条走**真实编译入口**，
  // 验证 protocol.ts 现在真的会把浓度解析出来并挂到 ReagentSpec.concentration 上，
  // concentration_limit 不再永远空转。这是 V25 的关键断言（devlog 阴性对照①依赖它）。
  test("V25：浓度超限必须 fail——真实编译入口解析出浓度，不再靠 withReagents 手工注入", () => {
    const protocol = compiler.compile("配制浓度为500的次氯酸钠溶液", { name: "real-concentration" });
    const reagent = (protocol.steps[0]!.params.reagents as Array<{ reagentId?: string; concentration?: number }>)[0]!;
    expect(reagent.reagentId).toBe("hypochlorite");
    expect(reagent.concentration).toBe(500);
    const result = concentrationLimitRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("次氯酸钠 (500)");
    // 解析成功即消费：不再落 unconsumed 告警。
    expect(protocol.warnings).toEqual([]);
  });
});

describe("对抗 ③ 生物安全等级", () => {
  test("BSL-3 步骤 → 拦截并指名步骤", () => {
    const protocol = compiler.compile("加入50uL样品", { name: "bsl" });
    protocol.steps[0]!.params.biosafetyLevel = 3;
    const result = biosafetyRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("step-1");
    expect(result.detail).toContain("BSL-3");
  });

  test("BSL-2 → 放行（上限内）", () => {
    const protocol = compiler.compile("加入50uL样品", { name: "bsl2" });
    protocol.steps[0]!.params.biosafetyLevel = 2;
    expect(biosafetyRule.evaluate({ protocol }).passed).toBe(true);
  });

  // V25：真实编译入口——biosafetyLevel 现在会被 protocol.ts 解析并写进
  // ProtocolStep.params，不用手工赋值。
  test("V25：BSL-3 必须 fail——真实编译入口解析出 biosafetyLevel，不再手工赋值", () => {
    const protocol = compiler.compile("在BSL-3环境下加入50uL样品", { name: "real-biosafety" });
    expect(protocol.steps[0]!.params.biosafetyLevel).toBe(3);
    const result = biosafetyRule.evaluate({ protocol });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("BSL-3");
    expect(protocol.warnings).toEqual([]);
  });
});

describe("对抗 ④ 超体积 / 超孔板容量", () => {
  test("单次 500 µL 加进 360 µL 的孔 → 拦截（需要编译产物才看得出）", () => {
    const protocol = compiler.compile("加入500uL样品", { name: "overflow" });
    const program = compileToOpentrons(protocol);
    const result = volumeCapacityRule.evaluate({ protocol, program });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("超过孔板容量");
  });

  test("多次加液**累计**溢孔 → 拦截（单看每一次都合法）", () => {
    const protocol = compiler.compile("加入200uL样品，加入200uL缓冲液", { name: "cumulative" });
    // 每一次都远小于 360 µL，只有累加起来才越界。
    for (const step of protocol.steps) expect(Number(step.params.volume)).toBeLessThan(360);
    const program = compileToOpentrons(protocol);
    expect(program.finalWellVolumesUl.A1).toBe(400);
    expect(volumeCapacityRule.evaluate({ protocol, program }).passed).toBe(false);
  });

  test("2 µL 低于移液器最小量程 → 拦截（吸不准的液等于没吸）", () => {
    const protocol = compiler.compile("加入2uL样品", { name: "tiny" });
    const program = compileToOpentrons(protocol);
    const result = volumeCapacityRule.evaluate({ protocol, program });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("低于移液器最小量程");
  });

  test("没有编译产物时不静默放行：退回单次加液核对并说明查了什么", () => {
    const protocol = compiler.compile("加入500uL样品", { name: "nocompile" });
    const withoutProgram = volumeCapacityRule.evaluate({ protocol });
    expect(withoutProgram.passed).toBe(false);
    const clean = volumeCapacityRule.evaluate({
      protocol: compiler.compile("加入50uL样品", { name: "clean" }),
    });
    expect(clean.passed).toBe(true);
    expect(clean.detail).toContain("单孔累计体积待编译后复核");
  });

  test("协议 B 的梯度稀释整排都在容量内 → 放行", () => {
    const protocol = compiler.compile(
      "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次",
      { name: "dilution" },
    );
    const program = compileToOpentrons(protocol);
    expect(volumeCapacityRule.evaluate({ protocol, program }).passed).toBe(true);
  });
});

describe("LabSafetyGate 门面（v0.1 调用面保持不变）", () => {
  test("checkProtocol 汇总四条规则，任一不过则整体不过", () => {
    const gate = new LabSafetyGate();
    const protocol = compiler.compile("加入10uL盐酸，加入10uL次氯酸钠", { name: "gate" });
    const report = gate.checkProtocol(protocol);
    expect(report.passed).toBe(false);
    expect(report.checks).toHaveLength(4);
    expect(report.checks.find((c) => c.check === "chemical compatibility")?.passed).toBe(false);
    expect(report.checks.find((c) => c.check === "biosafety")?.passed).toBe(true);
  });

  test("传入编译产物时启用孔板容量核对", () => {
    const gate = new LabSafetyGate();
    const protocol = compiler.compile("加入200uL样品，加入200uL缓冲液", { name: "gate2" });
    expect(gate.checkProtocol(protocol).passed).toBe(true); // 未编译：看不出累计溢孔
    expect(gate.checkProtocol(protocol, compileToOpentrons(protocol)).passed).toBe(false);
  });

  test("三张静态表仍可从门面读到（v0.1 起的调用面）", () => {
    expect(LabSafetyGate.MAX_CONCENTRATION.ethanol).toBe(95);
    expect(LabSafetyGate.CHEMICAL_COMPATIBILITY.strong_acid).toContain("hypochlorite");
    expect(LabSafetyGate.MAX_BIOSAFETY_LEVEL).toBe(2);
    expect(LabSafetyGate.RULES).toHaveLength(4);
  });
});
