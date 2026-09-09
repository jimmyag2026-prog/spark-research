import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLAMMABLE_FLASH_POINT_C,
  HEAT_THRESHOLD_C,
  flammableOverHeatRule,
} from "../../examples/extending/flammable_over_heat_rule";
import { ProtocolCompiler, type Protocol } from "../../backend/src/lab/protocol";
import { SAFETY_RULES, runSafetyRules } from "../../backend/src/lab/safety";

// docs/EXTENDING.md 里的最小示例必须**真的能跑**（P9 验证项）。
//
// 这个文件是那句话的执行面：文档第五节展示的安全门规则就是
// examples/extending/flammable_over_heat_rule.ts 本体，这里把它按真规则的
// 标准打一遍（对抗样例 + 阴性对照 + 与现有规则集共存）。
//
// skill / connector / platform 三类示例的可运行性由 tests/unit/scaffold.test.ts
// 保证——那三类的「示例」就是脚手架产物本身，CI 会生成后真的 bun test 跑一遍。
// 示例代码与文档不同步是文档腐烂最快的一条路，所以这里还额外断言
// EXTENDING.md 引用的路径都真实存在。

const compiler = new ProtocolCompiler();
const REPO_ROOT = join(import.meta.dir, "../..");

function protocolWith(
  reagents: Array<{ name: string; reagentId?: string }>,
  temperature: number | null,
): Protocol {
  const protocol = compiler.compile("取样品50µL加入96孔板，孵育30分钟", { name: "example", protocolId: "pid" });
  const step = protocol.steps[0]!;
  step.params.reagents = reagents;
  if (temperature !== null) step.params.temperature = temperature;
  return protocol;
}

describe("EXTENDING 示例 · 安全门规则（对抗）", () => {
  test("易燃试剂在高温步骤中被拦下，detail 指名到步骤与温度", () => {
    const result = flammableOverHeatRule.evaluate({
      protocol: protocolWith([{ name: "无水乙醇", reagentId: "ethanol" }], 80),
    });
    expect(result.passed).toBe(false);
    // 拿到一句「不安全」而不知道哪一步的用户只能全协议重读。
    expect(result.detail).toContain("ethanol" in FLAMMABLE_FLASH_POINT_C ? "无水乙醇" : "");
    expect(result.detail).toContain("80");
  });

  test("多个易燃试剂全部列出，不是只报第一个", () => {
    const result = flammableOverHeatRule.evaluate({
      protocol: protocolWith(
        [
          { name: "乙醇", reagentId: "ethanol" },
          { name: "丙酮", reagentId: "acetone" },
        ],
        90,
      ),
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("乙醇");
    expect(result.detail).toContain("丙酮");
  });

  test("阈值边界：恰好等于阈值放行，超过一度拦下", () => {
    const at = flammableOverHeatRule.evaluate({
      protocol: protocolWith([{ name: "乙醇", reagentId: "ethanol" }], HEAT_THRESHOLD_C),
    });
    const over = flammableOverHeatRule.evaluate({
      protocol: protocolWith([{ name: "乙醇", reagentId: "ethanol" }], HEAT_THRESHOLD_C + 1),
    });
    expect(at.passed).toBe(true);
    expect(over.passed).toBe(false);
  });
});

describe("EXTENDING 示例 · 安全门规则（阴性对照，防误杀）", () => {
  // 一条只会说「不」的规则会在两周内被人注释掉。阴性对照和对抗样例一样重要。
  test("37 °C 孵育里的乙醇不拦（低温孵育不是明火环境）", () => {
    expect(
      flammableOverHeatRule.evaluate({ protocol: protocolWith([{ name: "乙醇", reagentId: "ethanol" }], 37) }).passed,
    ).toBe(true);
  });

  test("高温但试剂不易燃 → 放行", () => {
    expect(
      flammableOverHeatRule.evaluate({ protocol: protocolWith([{ name: "缓冲液", reagentId: "buffer" }], 95) }).passed,
    ).toBe(true);
  });

  test("没有温度参数的步骤 → 放行（不猜温度）", () => {
    expect(
      flammableOverHeatRule.evaluate({ protocol: protocolWith([{ name: "乙醇", reagentId: "ethanol" }], null) }).passed,
    ).toBe(true);
  });

  test("试剂没有 reagentId → 放行（name 是自然语言抄来的，靠它匹配必漏也必误）", () => {
    expect(flammableOverHeatRule.evaluate({ protocol: protocolWith([{ name: "某种溶剂" }], 90) }).passed).toBe(true);
  });
});

describe("EXTENDING 示例 · 规则的形态契约", () => {
  test("规则是纯函数：同一输入反复求值结果相同，且不改动入参", () => {
    const protocol = protocolWith([{ name: "乙醇", reagentId: "ethanol" }], 80);
    const snapshot = JSON.stringify(protocol);
    const first = flammableOverHeatRule.evaluate({ protocol });
    const second = flammableOverHeatRule.evaluate({ protocol });
    expect(first).toEqual(second);
    expect(JSON.stringify(protocol)).toBe(snapshot);
  });

  test("id / check / description 齐备，且 id 不与现有规则冲突", () => {
    expect(flammableOverHeatRule.id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(flammableOverHeatRule.check.length).toBeGreaterThan(0);
    expect(flammableOverHeatRule.description.length).toBeGreaterThan(10);
    expect(SAFETY_RULES.map((r) => r.id)).not.toContain(flammableOverHeatRule.id);
  });

  test("加进规则集后与现有四条共存：安全协议照样全过", () => {
    // 「装上新规则」在实现上就是往 SAFETY_RULES 里加一项。这里模拟那一步，
    // 确认它不会把本来合法的协议误杀（新规则最常见的事故）。
    const safe = compiler.compile("取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD", { name: "ok" });
    const builtin = runSafetyRules({ protocol: safe });
    const withExample = [...SAFETY_RULES, flammableOverHeatRule].map((rule) => rule.evaluate({ protocol: safe }));
    expect(builtin.passed).toBe(true);
    expect(withExample.every((c) => c.passed)).toBe(true);
    expect(withExample).toHaveLength(SAFETY_RULES.length + 1);
  });
});

describe("EXTENDING 文档与示例不许脱节", () => {
  const doc = readFileSync(join(REPO_ROOT, "docs/EXTENDING.md"), "utf8");

  test("六节都在", () => {
    for (const heading of [
      "## 1. Skill",
      "## 2. Connector",
      "## 3. SimulationPlatform",
      "## 4. WetLabBackend",
      "## 5. 安全门规则",
      "## 6. Prompt 与模型路由",
    ]) {
      expect(doc).toContain(heading);
    }
  });

  test("文档引用的仓库内路径真实存在", () => {
    // 文档里写的每一个 `backend/src/...` / `tests/...` / `examples/...` 路径
    // 都去磁盘上核一遍。文档腐烂最常见的形态是路径改了文档没改。
    const paths = [...doc.matchAll(/`((?:backend\/src|tests|examples|scripts|docs)\/[A-Za-z0-9_./-]+)`/g)].map(
      (m) => m[1]!,
    );
    expect(paths.length).toBeGreaterThan(15);
    const missing = [...new Set(paths)].filter((rel) => !Bun.file(join(REPO_ROOT, rel)).size && !dirExists(rel));
    expect(missing).toEqual([]);
  });

  test("每节都写了「测试方法」与「放哪里」", () => {
    // P9 对 EXTENDING 的要求是每节 = 契约 + 最小可运行示例 + 测试方法 + 文件位置。
    expect((doc.match(/^### 怎么测$/gm) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((doc.match(/^### 放哪里$/gm) ?? []).length).toBeGreaterThanOrEqual(6);
    // 「最小可运行示例」也是每节的必备件（除了 WetLabBackend——它的第二设备族
    // 还没有真实实现，给一个跑不通的示例比不给更糟，所以那一节给的是施工说明）。
    expect((doc.match(/^### 最小可运行示例/gm) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

function dirExists(rel: string): boolean {
  try {
    return Bun.spawnSync(["test", "-e", join(REPO_ROOT, rel)]).exitCode === 0;
  } catch {
    return false;
  }
}
