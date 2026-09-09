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
