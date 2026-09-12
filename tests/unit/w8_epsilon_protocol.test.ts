import { describe, expect, test } from "bun:test";
import { ProtocolCompiler } from "../../backend/src/lab/protocol";
import { runSafetyRules } from "../../backend/src/lab/safety";

// W8-1 ε · V55（BACKLOG）：湿实验自然语言解析双语化。
//
// 背景：验收实测「英文协议编译不出任何步骤」——`ACTION_RULES` 的关键词是纯中文的，
// 试剂词表（REAGENT_PATTERNS）早就是双语的，但上游步骤解析器不是，于是纯英文协议
// 一步都编不出来（不是拦截，是**静默产出零步骤协议**）。这里验证：
//   ① README 里那条中文协议的英文对照版，编出**相同步骤数**（试剂集合也一样——
//      这条协议本来就不含任何词表内试剂，空集合本身也是一种"相同"）；
//   ② 含真实试剂冲突的协议，中英文两个版本编出**相同的试剂 id 集合**，且安全门
//      对两个语言版本的判断一致（语言不能成为绕过安全门的手段）；
//   ③ 中英混排也能编。
//
// 纪律：**不测「造出一本英文实验动词词典」**——只测任务书点名的场景 + 明确会被
// 影响的相邻行为（大小写不敏感匹配、未识别试剂原文兜底）。

const compiler = new ProtocolCompiler();

describe("V55 · 协议解析器双语化", () => {
  test("README canonical 协议：中文 vs 英文对照版，步骤数与试剂集合相同", () => {
    const zh = compiler.compile("取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD", { name: "zh" });
    const en = compiler.compile(
      "Take 50µL of sample and add to a 96-well plate, incubate at 37°C for 1 hour, read OD at 600nm",
      { name: "en" },
    );

    expect(en.steps).toHaveLength(3);
    expect(en.steps.length).toBe(zh.steps.length);
    expect(en.steps.map((s) => s.action)).toEqual(zh.steps.map((s) => s.action));

    // 关键数值也要对得上：温度、时长、波长——不能只是「凑够了步骤数」。
    expect(en.steps[0]!.params.volume).toBe(50);
    expect(en.steps[0]!.params.unit).toBe("uL");
    expect(en.steps[1]!.params.temperature).toBe(37);
    expect(en.steps[1]!.params.durationSec).toBe(3600);
    expect(en.steps[2]!.params.wavelength).toBe(600);

    // 这条协议不含任何词表内试剂——中英文都应当是空集合（同一种"相同"）。
    const reagentIds = (steps: typeof en.steps) =>
      steps.flatMap((s) => ((s.params.reagents as Array<{ reagentId?: string }>) ?? []).map((r) => r.reagentId));
    expect(reagentIds(en.steps)).toEqual([]);
    expect(reagentIds(en.steps)).toEqual(reagentIds(zh.steps));

    // 英文协议是「干净协议」（README 对中文版的既有断言）：没有未消费告警、
    // 没有词表外试剂占位——双语解析不能引入新的误报。
    expect(en.warnings).toEqual([]);
    expect(en.steps.every((s) => s.unrecognizedReagentText === undefined)).toBe(true);
  });

  test("真实试剂冲突协议：中英文编出相同的试剂 id 集合，且安全门判定一致", () => {
    const zh = compiler.compile("加入10uL盐酸，加入10uL次氯酸钠", { name: "zh-unsafe" });
    const en = compiler.compile("Add 10uL hydrochloric acid, add 10uL sodium hypochlorite", { name: "en-unsafe" });

    expect(en.steps).toHaveLength(2);
    expect(en.steps.length).toBe(zh.steps.length);

    const reagentIdSet = (steps: typeof en.steps) =>
      new Set(
        steps.flatMap((s) => ((s.params.reagents as Array<{ reagentId?: string }>) ?? []).map((r) => r.reagentId)),
      );
    expect(reagentIdSet(en.steps)).toEqual(new Set(["strong_acid", "hypochlorite"]));
    expect(reagentIdSet(en.steps)).toEqual(reagentIdSet(zh.steps));

    // 安全门不能因为协议是英文写的就漏判——chemical_compatibility 两个语言版本都要拦。
    const zhReport = runSafetyRules({ protocol: zh });
    const enReport = runSafetyRules({ protocol: en });
    expect(enReport.passed).toBe(false);
    expect(enReport.passed).toBe(zhReport.passed);
    const enCheck = enReport.checks.find((c) => c.check === "chemical compatibility")!;
    expect(enCheck.passed).toBe(false);
    expect(enCheck.detail).toContain("下一步"); // V59④ 顺带验证：消息是中文完整句。
  });

  test("中英混排同一份协议也能编（不是「整段必须同语言」）", () => {
    const mixed = compiler.compile(
      "取样品50µL加入96孔板, incubate at 37°C for 1 hour，600nm读取OD",
      { name: "mixed" },
    );
    expect(mixed.steps).toHaveLength(3);
    expect(mixed.steps.map((s) => s.action)).toEqual(["addSample", "incubate", "read"]);
    expect(mixed.steps[1]!.params.temperature).toBe(37);
    expect(mixed.steps[1]!.params.durationSec).toBe(3600);
  });

  test("动词大小写不敏感：句首大写「Add」同样能识别成 addSample", () => {
    const capitalized = compiler.compile("Add 100uL sample to well A1", { name: "cap" });
    expect(capitalized.steps).toHaveLength(1);
    expect(capitalized.steps[0]!.action).toBe("addSample");
    expect(capitalized.steps[0]!.params.volume).toBe(100);
  });

  test("英文续句参数合并：「each step transfer 100uL and mix 3 times」并进上一步而非新起一步", () => {
    const protocol = compiler.compile(
      "Prepare 5000uL diluent, serial dilution 6 points for the sample, each step transfer 100uL and mix 3 times",
      { name: "en-serial" },
    );
    const dilute = protocol.steps.find((s) => s.action === "serialDilute");
    expect(dilute).toBeDefined();
    expect(dilute!.params.transferVolume).toBe(100);
    expect(dilute!.params.mixRepetitions).toBe(3);
  });
});

describe("V59② · biosafety 识别 P-level 口语写法", () => {
  test("「P3 实验室」与 BSL-3 被识别成同一等级", () => {
    const viaP = compiler.compile("在P3实验室内加入50uL样品", { name: "p3" });
    const viaBsl = compiler.compile("在BSL-3环境下加入50uL样品", { name: "bsl3" });
    expect(viaP.steps[0]!.params.biosafetyLevel).toBe(3);
    expect(viaP.steps[0]!.params.biosafetyLevel).toBe(viaBsl.steps[0]!.params.biosafetyLevel);
    expect(viaP.warnings).toEqual([]);
  });

  test("裸「P2」（无「实验室」后缀）同样识别为 BSL-2", () => {
    const protocol = compiler.compile("P2 add 50uL sample", { name: "p2-bare" });
    expect(protocol.steps[0]!.params.biosafetyLevel).toBe(2);
  });

  test("英文「P3 lab」写法同样识别", () => {
    // 刻意不用逗号分句——生物安全信号要能挂到步骤上，必须和动作词同在一个子句里
    // （这是既有行为，不是本次新引入的限制：见 protocol.ts 里 V25 那段注释「一句
    // 独立的生物安全描述、前面没有步骤可挂时，只报未消费」）。
    const protocol = compiler.compile("In a P3 lab add 50uL sample", { name: "p3-lab" });
    expect(protocol.steps[0]!.params.biosafetyLevel).toBe(3);
  });

  test("识别结果不新增/不改阈值：MAX_BIOSAFETY_LEVEL 仍是 2，P3 仍会被 biosafety 规则拦", () => {
    const protocol = compiler.compile("在P3实验室内加入50uL样品", { name: "p3-blocked" });
    const report = runSafetyRules({ protocol });
    const biosafety = report.checks.find((c) => c.check === "biosafety")!;
    expect(biosafety.passed).toBe(false);
    expect(biosafety.detail).toContain("BSL-3");
  });
});
