import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CobraPyPlatform } from "../../backend/src/simulation/cobrapy";
import type { SimulationOutputs, SimulationSpec } from "../../backend/src/simulation/models";

// W5-3 β · cobrapy 的科学判据 e2e（§1.4.3 checklist 第 5 条）。
//
// 模型是 e_coli_core（cobrapy 自带的教科书模型，离线拷进 tests/fixtures/cobrapy/）。
// 它的四个数字在文献与 cobrapy 文档里是公开的定值，正好当判据：
//   ① 有氧最大生长率 0.873922 h⁻¹
//   ② 厌氧（关掉 EX_o2_e 的摄入）0.211663 h⁻¹
//   ③ 敲掉烯醇化酶 b2779（eno，糖酵解必需）→ 生长归零
//   ④ 敲掉 NADH 脱氢酶亚基 b2280（nuoA）→ 生长掉到**厌氧那个值**：呼吸链没了，只能发酵
// 第 ④ 条尤其值钱：它不是「跑完没报错」，是两条独立路径必须给出同一个数。

const FIXTURES = resolve(import.meta.dir, "../fixtures/cobrapy");
const MODEL = join(FIXTURES, "e_coli_core.xml");

const AEROBIC_GROWTH = 0.8739215;
const ANAEROBIC_GROWTH = 0.2116629;

function spec(params: Record<string, unknown>): SimulationSpec {
  return { platform: "cobrapy", kind: "fba", params: { modelPath: MODEL, ...params } };
}

const probe = await new CobraPyPlatform({ root: mkdtempSync(join(tmpdir(), "cobrapy-e2e-probe-")) }).available();
if (!probe.ok) console.warn(`[W5-3 β e2e] cobrapy 整套 skip：${probe.reason}`);
const suite = probe.ok ? describe : describe.skip;

async function runToCompletion(platform: CobraPyPlatform, target: SimulationSpec): Promise<SimulationOutputs> {
  const runId = await platform.submit(await platform.prepare(target));
  const deadline = Date.now() + 180_000;
  for (;;) {
    const status = await platform.poll(runId);
    if (status.state === "completed") break;
    if (status.state === "failed") throw new Error(`run 失败：${status.message}`);
    if (Date.now() > deadline) throw new Error("等待超时");
    await Bun.sleep(200);
  }
  return platform.collect(runId);
}

suite("cobrapy e2e · 科学判据（e_coli_core 的公开定值）", () => {
  const platform = new CobraPyPlatform({ root: mkdtempSync(join(tmpdir(), "cobrapy-e2e-")) });
  let aerobic: SimulationOutputs;

  test(
    "有氧野生型最大生长率 = 0.873922 h⁻¹",
    async () => {
      aerobic = await runToCompletion(platform, spec({}));
      expect(aerobic.summary.reactions).toBe(95);
      expect(aerobic.summary.metabolites).toBe(72);
      expect(aerobic.summary.genes).toBe(137);
      expect(aerobic.summary.status).toBe("optimal");
      expect(Number(aerobic.summary.objectiveValue)).toBeCloseTo(AEROBIC_GROWTH, 5);
    },
    240_000,
  );

  test("通量表自洽：95 条反应各一行，且生物量反应的通量 = 目标值", () => {
    const rows = readFileSync(aerobic.files.find((f) => f.filename === "fluxes.csv")!.path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/\r$/, "").split(","));
    expect(rows.length).toBe(95);
    const biomass = rows.find((cells) => cells[0]!.startsWith("Biomass"))!;
    expect(Number(biomass[2])).toBeCloseTo(AEROBIC_GROWTH, 5);

    const solution = JSON.parse(
      readFileSync(aerobic.files.find((f) => f.filename === "solution.json")!.path, "utf8"),
    ) as { objectiveValue: number; status: string; activeReactions: number };
    expect(solution.objectiveValue).toBeCloseTo(AEROBIC_GROWTH, 5);
    expect(solution.status).toBe("optimal");
    expect(solution.activeReactions).toBeLessThan(95);
  });

  test(
    "厌氧（关掉 O2 摄入）生长率掉到 0.211663 h⁻¹",
    async () => {
      const anaerobic = await runToCompletion(platform, spec({ medium: "anaerobic" }));
      expect(Number(anaerobic.summary.objectiveValue)).toBeCloseTo(ANAEROBIC_GROWTH, 5);
      expect(String(anaerobic.summary.medium)).toContain("EX_o2_e");
    },
    240_000,
  );

  test(
    "敲掉必需基因 eno（b2779，烯醇化酶）→ 生长归零",
    async () => {
      const knockout = await runToCompletion(platform, spec({ knockouts: "b2779" }));
      expect(Math.abs(Number(knockout.summary.objectiveValue))).toBeLessThan(1e-6);
      expect(knockout.summary.knockouts).toBe("b2779");
    },
    240_000,
  );

  test(
    "敲掉呼吸链的 nuoA（b2280）→ 生长掉到厌氧那个值（两条独立路径给出同一个数）",
    async () => {
      const knockout = await runToCompletion(platform, spec({ knockouts: "b2280" }));
      expect(Number(knockout.summary.objectiveValue)).toBeCloseTo(ANAEROBIC_GROWTH, 5);
    },
    240_000,
  );
});

// deterministic 位是实测出来的，不是声明的——理由见 scanpy_e2e.test.ts 同名 describe。
suite("cobrapy · deterministic 声称与实测一致", () => {
  test(
    "同一 spec 跑两遍，产出逐字节一致 ⇔ deterministic 为真",
    async () => {
      const platform = new CobraPyPlatform({ root: mkdtempSync(join(tmpdir(), "cobrapy-det-")) });
      const first = await runToCompletion(platform, spec({}));
      const second = await runToCompletion(platform, spec({}));
      const differing = first.files
        .filter((file) => {
          const other = second.files.find((f) => f.filename === file.filename)!;
          return readFileSync(file.path, "utf8") !== readFileSync(other.path, "utf8");
        })
        .map((f) => f.filename);
      expect(
        differing.length === 0,
        differing.length === 0
          ? "两次产出一致，但平台声称 deterministic=false"
          : `平台声称 deterministic=${platform.deterministic}，但两次跑出的 ${differing.join(", ")} 不一致` +
              `（FBA 的 alternate optima 是最常见的那处：pFBA 关掉之后通量向量就不唯一了）`,
      ).toBe(platform.deterministic);
    },
    300_000,
  );
});
