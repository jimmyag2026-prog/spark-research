import { describe, expect, test } from "bun:test";
import { ProtocolCompiler } from "../../backend/src/lab/protocol";
import {
  ABSORBANCE_WAVELENGTHS,
  OPENTRONS_API_LEVEL,
  OPENTRONS_ROBOT_TYPE,
  PIPETTE_MAX_VOLUME_UL,
  ProtocolCompileError,
  compileToOpentrons,
} from "../../backend/src/lab/opentrons_protocol";

// P6 编译器单测：`Protocol` → Opentrons Python Protocol API v2 脚本。
// 「脚本合不合法」由 opentrons 真模拟器判（见 wet_e2e.test.ts）；这里验的是
// **编译决策**：deck 排布、体积记账、hash 确定性、以及「没有的硬件不假装有」。

const compiler = new ProtocolCompiler();

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";
const PROTOCOL_B = "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次";

function compileA(name = "protoA") {
  return compileToOpentrons(compiler.compile(PROTOCOL_A, { name, protocolId: "pid-a" }));
}

function compileB(name = "protoB") {
  return compileToOpentrons(compiler.compile(PROTOCOL_B, { name, protocolId: "pid-b" }));
}

describe("ProtocolCompiler · P6 新增的自然语言能力", () => {
  test("协议 A：移液 + 孵育 + 读数三步，参数全部抽出来", () => {
    const protocol = compiler.compile(PROTOCOL_A, { name: "A" });
    expect(protocol.steps.map((s) => s.action)).toEqual(["addSample", "incubate", "read"]);
    expect(protocol.steps[0]!.params.volume).toBe(50);
    expect(protocol.steps[0]!.params.unit).toBe("uL");
    expect(protocol.steps[1]!.params.temperature).toBe(37);
    expect(protocol.steps[1]!.params.durationSec).toBe(3600);
    expect(protocol.steps[2]!.params.wavelength).toBe(600);
  });

  test("协议 B：梯度稀释被识别成一步 serialDilute，不是三步移液", () => {
    const protocol = compiler.compile(PROTOCOL_B, { name: "B" });
    expect(protocol.steps.map((s) => s.action)).toEqual(["prepareReagent", "serialDilute"]);
    const dilute = protocol.steps[1]!;
    expect(dilute.params.dilutionSteps).toBe(6);
    expect(dilute.params.transferVolume).toBe(100);
    expect(dilute.params.mixRepetitions).toBe(3);
  });

  test("「配制稀释液」不该被当成梯度稀释（关键词不收「稀释」单字）", () => {
    const protocol = compiler.compile("配制200uL稀释液", { name: "prep" });
    expect(protocol.steps.map((s) => s.action)).toEqual(["prepareReagent"]);
  });

  test("参数续句合并进上一步，而不是凭空多出一步移液", () => {
    const protocol = compiler.compile("对样品做4个梯度的连续稀释，每步转移80uL", { name: "cont" });
    expect(protocol.steps).toHaveLength(1);
    expect(protocol.steps[0]!.action).toBe("serialDilute");
    expect(protocol.steps[0]!.params.transferVolume).toBe(80);
    expect(protocol.steps[0]!.params.dilutionSteps).toBe(4);
  });

  test("续句不含任何参数时不影响上一步（不做无中生有的合并）", () => {
    const protocol = compiler.compile("加入50uL样品，随后静置", { name: "noop" });
    expect(protocol.steps).toHaveLength(1);
    expect(protocol.steps[0]!.params.volume).toBe(50);
  });
});

// P10-d · D-8：安全门声明收敛。这里测的是**编译器**这一半——试剂词表扩到英文/分子式、
// 续句试剂不再被吞、以及新增的"未消费"信号。规则本身接不接得住这些输入，
// 由 lab_safety.test.ts 的对抗矩阵测；这里只管编译器产不产得出正确的输入。
describe("ProtocolCompiler · D-8 试剂词表扩到英文/分子式", () => {
  test("英文名与分子式都能被识别成试剂（评审原话：之前整体免疫）", () => {
    const cases: Array<{ text: string; reagentId: string }> = [
      { text: "加入10uL NaOH", reagentId: "hydroxide" },
      { text: "加入10uL HCl", reagentId: "strong_acid" },
      { text: "加入10uL ethanol", reagentId: "ethanol" },
      { text: "加入10uL NaClO", reagentId: "hypochlorite" },
      { text: "加入10uL H2O2", reagentId: "peroxide" },
    ];
    for (const { text, reagentId } of cases) {
      const protocol = compiler.compile(text, { name: "formula" });
      const reagents = protocol.steps[0]!.params.reagents as Array<{ reagentId?: string }>;
      expect(reagents?.map((r) => r.reagentId)).toContain(reagentId);
    }
  });

  test("分子式匹配大小写不敏感（naoh / NAOH 都认得出来）", () => {
    const lower = compiler.compile("加入10uL naoh", { name: "lower" });
    const upper = compiler.compile("加入10uL NAOH", { name: "upper" });
    for (const protocol of [lower, upper]) {
      const reagents = protocol.steps[0]!.params.reagents as Array<{ reagentId?: string }>;
      expect(reagents?.map((r) => r.reagentId)).toContain("hydroxide");
    }
  });

  test("中文关键词仍是 name（v0.1 起的对抗测试断言中文名，顺序不能倒）", () => {
    const protocol = compiler.compile("加入10uL盐酸", { name: "zh" });
    const reagents = protocol.steps[0]!.params.reagents as Array<{ name: string }>;
    expect(reagents?.[0]?.name).toBe("盐酸");
  });

  test("续句里的第二种试剂不再被吞掉（原 bug：加盐酸50µL，其中再补加次氯酸钠10µL）", () => {
    const protocol = compiler.compile("加入50uL盐酸，其中再补加10uL次氯酸钠", { name: "continuation-reagent" });
    // 两种试剂都要落在**同一步**上——安全门的 chemical_compatibility 是按 protocol 里
    // 出现过的所有试剂两两比对，不按 step 分组，但试剂要先进 params.reagents 才看得见。
    expect(protocol.steps).toHaveLength(1);
    const reagents = protocol.steps[0]!.params.reagents as Array<{ reagentId?: string }>;
    expect(reagents.map((r) => r.reagentId).sort()).toEqual(["hypochlorite", "strong_acid"]);
  });
});

// P10-d · D-8：「未消费」信号——编译器看到了量纲/试剂/浓度/生物安全等信号，
// 但没有任何一步/任何一条安全规则读取它。方针是「不做完美的 NL 解析，但漏检必须可见」。
describe("ProtocolCompiler · D-8 unconsumed 信号（漏检必须可见，不能静默绿灯）", () => {
  test("同一句里出现两处体积 → 报未消费（extractVolume 结构性地只取第一个）", () => {
    const protocol = compiler.compile("加入50uL样品并加30uL缓冲液", { name: "two-volumes" });
    expect(protocol.warnings.join(" ")).toContain("2 处体积数值");
  });

  test("单句一个动作假设丢语义：温度被识别成加样步骤时不静默消失，产出未消费告警", () => {
    // 评审原话的例子：「37°C 孵育 30 分钟后加入 500µL 样品」——句中没有切分标点，
    // 整句被"加入"关键词命中成 addSample，温度/时长信息在现有实现下没有落点。
    const protocol = compiler.compile("37°C孵育30分钟后加入500µL样品", { name: "single-action" });
    expect(protocol.steps.map((s) => s.action)).toEqual(["addSample"]);
    const joined = protocol.warnings.join(" ");
    expect(joined).toContain("温度");
    expect(joined).toContain("时长");
  });

  test("正常协议（A/B）不产出未消费告警——检测要保守，不能在干净协议上报警", () => {
    const a = compiler.compile("取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD", { name: "A" });
    const b = compiler.compile("配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次", {
      name: "B",
    });
    expect(a.warnings).toEqual([]);
    expect(b.warnings).toEqual([]);
  });

  // V25：浓度/生物安全等级从「恒空转」变成「解析成功即消费」——下面四个 test 覆盖
  // 成功消费（不再报）与解析失败（仍然报）两种分支，两边都要测，否则只测到一半。

  test("V25：同句恰好一种试剂时，浓度被真正解析并写进 ReagentSpec.concentration，不再报未消费", () => {
    const protocol = compiler.compile("配制10%次氯酸钠溶液", { name: "concentration" });
    const reagents = protocol.steps[0]!.params.reagents as Array<{ reagentId?: string; concentration?: number }>;
    expect(reagents?.find((r) => r.reagentId === "hypochlorite")?.concentration).toBe(10);
    expect(protocol.warnings).toEqual([]);
  });

  test("V25：同句出现两种试剂时，浓度归属歧义——不瞎猜，仍报未消费，且不挂到任何一种试剂上", () => {
    const protocol = compiler.compile("配制10%次氯酸钠和乙醇混合液", { name: "concentration-ambiguous" });
    const reagents = protocol.steps[0]!.params.reagents as Array<{ reagentId?: string; concentration?: number }>;
    expect(reagents?.every((r) => r.concentration === undefined)).toBe(true);
    expect(protocol.warnings.join(" ")).toContain("浓度");
  });

  test("V25：浓度描述所在子句里没有点名任何试剂——挂不上去，仍报未消费", () => {
    const protocol = compiler.compile("溶液浓度为70%", { name: "concentration-no-target" });
    expect(protocol.steps).toHaveLength(0);
    expect(protocol.warnings.join(" ")).toContain("浓度");
  });

  test("V25：生物安全等级被真正解析并写进 ProtocolStep.params.biosafetyLevel，不再报未消费", () => {
    const protocol = compiler.compile("在BSL-3环境下加入50uL样品", { name: "biosafety" });
    expect(protocol.steps[0]!.params.biosafetyLevel).toBe(3);
    expect(protocol.warnings).toEqual([]);
  });

  test("V25：生物安全等级作为续句挂到上一步（与温度/时长续句同一套逻辑）", () => {
    const protocol = compiler.compile("加入50uL样品，BSL-2实验室内操作", { name: "biosafety-continuation" });
    expect(protocol.steps).toHaveLength(1);
    expect(protocol.steps[0]!.params.biosafetyLevel).toBe(2);
    expect(protocol.warnings).toEqual([]);
  });

  test("V25：生物安全等级独立成句、前面没有任何步骤可挂——仍报未消费（结构性失败，不是漏解析）", () => {
    const protocol = compiler.compile("BSL-2实验室内操作", { name: "biosafety-no-target" });
    expect(protocol.steps).toHaveLength(0);
    expect(protocol.warnings.join(" ")).toContain("生物安全");
  });
});

describe("compileToOpentrons · 脚本骨架", () => {
  test("生成 Flex 协议头：requirements / metadata / def run", () => {
    const program = compileA();
    expect(program.robotType).toBe(OPENTRONS_ROBOT_TYPE);
    expect(program.apiLevel).toBe(OPENTRONS_API_LEVEL);
    expect(program.source).toContain(`"robotType": "Flex"`);
    expect(program.source).toContain(`"apiLevel": "${OPENTRONS_API_LEVEL}"`);
    expect(program.source).toContain("def run(protocol):");
    expect(program.source).toContain("protocol.load_instrument");
  });

  test("每个步骤前有 [spark-step] 锚点，run log 才能绑回编译产物", () => {
    const program = compileA();
    for (const step of program.steps) {
      expect(program.source).toContain(`protocol.comment("[spark-step] ${step.stepId} ${step.action}")`);
    }
  });

  test("protocolHash 确定性：同一份协议编译两次得到同一个 hash", () => {
    expect(compileA().protocolHash).toBe(compileA().protocolHash);
  });

  test("协议不同则 hash 不同（approve 才能锁住「批的是哪一版」）", () => {
    expect(compileA().protocolHash).not.toBe(compileB().protocolHash);
  });

  test("源码里不含编译时间戳（否则每次编译都换 hash，approve 永远失效）", () => {
    const program = compileA();
    expect(program.source).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  test("空协议直接拒绝编译，不产出一个「什么都不做」的脚本", () => {
    const empty = compiler.compile("今天天气不错", { name: "empty" });
    expect(empty.steps).toHaveLength(0);
    expect(() => compileToOpentrons(empty)).toThrow(ProtocolCompileError);
  });

  test("不认识的动作直接抛错，不静默跳过", () => {
    const protocol = compiler.compile("加入50uL样品", { name: "bad" });
    protocol.steps[0]!.action = "teleport";
    expect(() => compileToOpentrons(protocol)).toThrow(/不支持的动作/);
  });
});

describe("compileToOpentrons · deck 布局按需加载", () => {
  test("有孵育步骤 → 板装在 Heater-Shaker 上", () => {
    const program = compileA();
    expect(program.modules.heaterShaker).toBe(true);
    expect(program.deck.find((d) => d.role === "plate")?.onModule).toBe("heaterShakerModuleV1");
    expect(program.source).toContain("heater_shaker.load_labware");
  });

  test("没有孵育/震荡 → 不加载 Heater-Shaker（不摆用不到的模块）", () => {
    const program = compileB();
    expect(program.modules.heaterShaker).toBe(false);
    expect(program.deck.find((d) => d.role === "plate")?.onModule).toBeNull();
    expect(program.source).not.toContain("heaterShakerModuleV1");
  });

  test("600 nm 读数 → 加载吸光度读板模块并按官方次序开合盖", () => {
    const program = compileA();
    expect(program.modules.absorbanceReader).toBe(true);
    expect(ABSORBANCE_WAVELENGTHS).toContain(600);
    const source = program.source;
    // initialize 必须在关盖状态；之后才开盖搬板。次序错了模拟器直接报错。
    expect(source.indexOf("reader.close_lid()")).toBeLessThan(source.indexOf("reader.initialize"));
    expect(source.indexOf("reader.initialize")).toBeLessThan(source.indexOf("protocol.move_labware"));
    expect(source).toContain("_reading = reader.read()");
  });

  test("340 nm 读数不在模块支持的四档内 → 编译成离机步骤 + 警告，不假装读得到", () => {
    const protocol = compiler.compile("加入50uL样品，340nm读取吸光度", { name: "od340" });
    const program = compileToOpentrons(protocol);
    expect(program.modules.absorbanceReader).toBe(false);
    const readStep = program.steps.find((s) => s.action === "read")!;
    expect(readStep.execution).toBe("manual");
    expect(program.warnings.join(" ")).toContain("340");
  });

  test("离心没有对应硬件 → 编译成离机人工步骤，run log 里是 note 不是执行记录", () => {
    const protocol = compiler.compile("加入50uL样品，12000g离心5分钟", { name: "spin" });
    const program = compileToOpentrons(protocol);
    const spin = program.steps.find((s) => s.action === "centrifuge")!;
    expect(spin.execution).toBe("manual");
    expect(program.source).toContain("[spark-note]");
    expect(program.source).not.toContain("centrifuge(");
    expect(program.warnings.join(" ")).toContain("离心");
  });

  test("「配制缓冲液」是离机配液：装载进 reservoir，不往 360 µL 的孔里倒 50 mL", () => {
    const protocol = compiler.compile("配制50mL LB培养基", { name: "prep" });
    const program = compileToOpentrons(protocol);
    expect(program.steps[0]!.execution).toBe("manual");
    expect(program.finalWellVolumesUl).toEqual({});
    expect(program.source).toContain("50000 µL → reservoir");
  });
});

describe("compileToOpentrons · 体积记账", () => {
  test("协议 A：单孔 50 µL", () => {
    expect(compileA().finalWellVolumesUl).toEqual({ A1: 50 });
  });

  test("协议 B：整排孔体积一致，最后一孔多一份转移量", () => {
    const program = compileB();
    const wells = program.finalWellVolumesUl;
    // 第 1 孔进 200（稀释液+转移量），转走 100 后留 100 —— 与 A2..A5 齐平。
    expect(wells.A1).toBe(100);
    expect(wells.A2).toBe(100);
    expect(wells.A5).toBe(100);
    expect(wells.A6).toBe(200);
    expect(Object.keys(wells)).toHaveLength(6);
  });

  test("连续稀释每一级都换新 tip（复用会把上一级浓度带下去）", () => {
    const program = compileB();
    const pickUps = program.source.match(/pipette\.pick_up_tip\(\)/g) ?? [];
    expect(pickUps.length).toBe(5); // 6 个梯度 → 5 次级间转移
  });

  test("单次体积超过移液器量程 → 自动拆成多次，每次都不超量程", () => {
    const protocol = compiler.compile("加入2500uL样品", { name: "big" });
    const program = compileToOpentrons(protocol);
    expect(program.transfers).toHaveLength(3);
    for (const transfer of program.transfers) {
      expect(transfer.volumeUl).toBeLessThanOrEqual(PIPETTE_MAX_VOLUME_UL);
    }
    expect(program.finalWellVolumesUl.A1).toBeCloseTo(2500, 2);
    expect(program.steps[0]!.notes.join(" ")).toContain("拆成 3 次");
  });

  test("梯度数超过一行孔数 → 拒绝编译", () => {
    const protocol = compiler.compile("对样品做20个梯度的连续稀释", { name: "toomany" });
    expect(() => compileToOpentrons(protocol)).toThrow(/超过 96 孔板一行/);
  });

  test("孵育温度超过 Heater-Shaker 上限 → 拒绝编译", () => {
    const protocol = compiler.compile("加入50uL样品，在120度孵育10分钟", { name: "hot" });
    expect(() => compileToOpentrons(protocol)).toThrow(/超过 Heater-Shaker 上限/);
  });

  test("孵育温度低于加热下限 → 降级为计时等待并注明，不假装能控温", () => {
    const protocol = compiler.compile("加入50uL样品，在4度孵育10分钟", { name: "cold" });
    const program = compileToOpentrons(protocol);
    const incubate = program.steps.find((s) => s.action === "incubate")!;
    expect(incubate.execution).toBe("manual");
    expect(incubate.notes.join(" ")).toContain("低于 Heater-Shaker 加热下限");
    expect(program.source).not.toContain("set_and_wait_for_temperature");
  });
});

// V60（BACKLOG）：词表外试剂的原文进编译产物。v0.5 只止住了「两种未知试剂塌缩到
// 同一 reservoir 孔」，用户写的原文本身还是没进产物——人在 lab approve 时看不到
// 自己写的是「硝酸」。这里测编译器这一半：原文抠不抠得出来、进不进 ProtocolStep。
describe("ProtocolCompiler · V60 词表外试剂原文进编译产物", () => {
  test("三种表外试剂各自原文可见，互不干扰", () => {
    const protocol = compiler.compile("加入100uL硝酸，加入100uL柠檬酸，加入100uL高锰酸钾", { name: "oov" });
    expect(protocol.steps).toHaveLength(3);
    expect(protocol.steps.map((s) => s.unrecognizedReagentText)).toEqual(["硝酸", "柠檬酸", "高锰酸钾"]);
    // 词表外试剂**不**进 params.reagents——那个数组是 safety.ts 四条规则的输入源，
    // 不能塞一条没有 reagentId 的假条目进去喂它看不懂的东西（见 protocol.ts 里
    // ProtocolStep.unrecognizedReagentText 字段顶部注释）。
    for (const step of protocol.steps) {
      expect(step.params.reagents).toBeUndefined();
    }
  });

  test("prepareReagent 同样适用：「配制50mL柠檬酸溶液」抠出「柠檬酸」（去掉体积/动作词/通用后缀「溶液」）", () => {
    const protocol = compiler.compile("配制50mL柠檬酸溶液", { name: "prep-oov" });
    expect(protocol.steps).toHaveLength(1);
    expect(protocol.steps[0]!.action).toBe("prepareReagent");
    expect(protocol.steps[0]!.unrecognizedReagentText).toBe("柠檬酸");
  });

  test("词表内试剂行为不变：不设 unrecognizedReagentText，reagents 里正常认得出它", () => {
    const protocol = compiler.compile("加入100uL盐酸", { name: "vocab" });
    expect(protocol.steps[0]!.unrecognizedReagentText).toBeUndefined();
    const reagents = protocol.steps[0]!.params.reagents as Array<{ name: string; reagentId?: string }>;
    expect(reagents.map((r) => r.name)).toContain("盐酸");
  });

  test("抠不出非空残留（整句只剩通用液体「样品」）时不瞎猜——不设 unrecognizedReagentText", () => {
    const protocol = compiler.compile("加入100uL样品", { name: "generic" });
    expect(protocol.steps[0]!.unrecognizedReagentText).toBeUndefined();
  });
});

describe("compileToOpentrons · V60 词表外试剂原文与占位符唯一化", () => {
  test("原文进编译产物，格式与 BACKLOG 原句一致：未识别试剂#step-1（原文：硝酸）", () => {
    const protocol = compiler.compile("加入100uL硝酸", { name: "raw" });
    const program = compileToOpentrons(protocol);
    expect(program.steps[0]!.summary).toContain("未识别试剂#step-1（原文：硝酸）");
    expect(program.steps[0]!.summary).toContain("词表外，安全规则未覆盖");
    expect(program.steps[0]!.unrecognizedReagent).toEqual({ rawText: "硝酸" });
  });

  test("三种不同的词表外试剂分到三个不同的 reservoir 孔——既有的按步骤唯一化断言必须继续绿（不塌缩）", () => {
    const protocol = compiler.compile("加入100uL硝酸，加入100uL柠檬酸，加入100uL高锰酸钾", { name: "no-collapse" });
    const program = compileToOpentrons(protocol);
    const sourceWells = program.transfers.map((t) => t.from);
    expect(sourceWells).toHaveLength(3);
    expect(new Set(sourceWells).size).toBe(3);
    const reservoirLines = program.source.match(/\[spark-note\] reservoir \S+ = .+/g) ?? [];
    expect(reservoirLines).toHaveLength(3);
    expect(new Set(reservoirLines).size).toBe(3);
  });

  test("词表内试剂编译产物不变：直接显示试剂名，不带「未识别试剂」「词表外」字样", () => {
    const protocol = compiler.compile("加入100uL盐酸", { name: "vocab-compile" });
    const program = compileToOpentrons(protocol);
    expect(program.steps[0]!.summary).toContain("盐酸");
    expect(program.steps[0]!.summary).not.toContain("未识别试剂");
    expect(program.steps[0]!.summary).not.toContain("词表外");
    expect(program.steps[0]!.unrecognizedReagent).toBeUndefined();
  });
});
