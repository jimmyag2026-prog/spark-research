import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport, type DoctorReport } from "../../backend/src/doctor";
import { DOCTOR_HELP, renderDoctor, runDoctorCommand } from "../../backend/src/doctor/cli";
import { PROVIDER_API_KEY_ENV } from "../../backend/src/llm/providers/registry";

// `spark-research doctor` 的单测。
//
// 分两层：
//   ① 注入假探测器的快速单测——覆盖渲染/汇总逻辑，不 spawn 真子进程。
//   ② 用真实系统 python3（不是仓库 .venv，那个装了 openmm/opentrons）跑一次真探测——
//      系统自带的 CommandLineTools python3 没装 openmm/opentrons，是天然的「缺依赖」
//      环境，不用造假环境。见 docs/devlog/W1-d.md 的阴性对照①：把 science/lab 硬编码成
//      `available: true` 会让下面「真实缺依赖环境必须报 unavailable」这组测试变红。
const SYSTEM_PYTHON = "/usr/bin/python3";

function tmpRoot(prefix = "spark-doctor-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("doctor · buildDoctorReport（注入假探测器）", () => {
  test("三档都可用时全绿", async () => {
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "Python 3.12.0", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot(), // 空目录，没有 index.html
    });
    expect(report.tiers.find((t) => t.id === "core")!.available).toBe(true);
    expect(report.tiers.find((t) => t.id === "science")!.available).toBe(true);
    expect(report.tiers.find((t) => t.id === "lab")!.available).toBe(true);
    expect(report.python.ok).toBe(true);
  });

  test("science/lab 缺依赖时报 unavailable 并带 reason", async () => {
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "Python 3.9.0", error: null }),
      probeScience: async () => ({ ok: false, reason: "openmm 不可用：装一下 uv pip install openmm" }),
      probeLab: async () => ({ ok: false, reason: "opentrons 不可用：装一下 uv pip install opentrons" }),
      frontendDir: tmpRoot(),
    });
    const science = report.tiers.find((t) => t.id === "science")!;
    const lab = report.tiers.find((t) => t.id === "lab")!;
    expect(science.available).toBe(false);
    expect(science.reason).toContain("openmm");
    expect(lab.available).toBe(false);
    expect(lab.reason).toContain("opentrons");
    // core 永远零依赖，不受 science/lab 状态影响。
    expect(report.tiers.find((t) => t.id === "core")!.available).toBe(true);
  });

  test("Python 解释器本身不可用时报 ok:false 并带 error", async () => {
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "definitely-not-a-real-interpreter",
      probePython: async (py) => ({ path: py, ok: false, version: null, error: "command not found" }),
      probeScience: async () => ({ ok: false, reason: "跳过：python 都探测不到" }),
      probeLab: async () => ({ ok: false, reason: "跳过：python 都探测不到" }),
      frontendDir: tmpRoot(),
    });
    expect(report.python.ok).toBe(false);
    expect(report.python.error).toBe("command not found");
  });

  test("provider key：env 优先于 config.json，两边都没配就是 未配置", async () => {
    const root = tmpRoot();
    // 手写一份 config.json：只给 KIMI_API_KEY。
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.json"), JSON.stringify({ KIMI_API_KEY: "sk-from-config" }));
    const report = await buildDoctorReport({
      root,
      env: { OPENROUTER_API_KEY: "sk-from-env" },
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "Python 3.12.0", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot(),
    });
    const byId = Object.fromEntries(report.providers.map((p) => [p.id, p.configured]));
    expect(byId.openrouter).toBe(true); // 来自 env
    expect(byId.kimi).toBe(true); // 来自 config.json
    expect(byId.anthropic).toBe(false); // 两边都没有
    // 一致性：doctor 报的 provider 集合必须和 router 的真源一致（不能自己另起一份清单）。
    expect(Object.keys(byId).sort()).toEqual(Object.keys(PROVIDER_API_KEY_ENV).sort());
  });

  test("provider key 的值永不出现在报告里（AD-2 的延伸）", async () => {
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: { KIMI_API_KEY: "sk-super-secret-do-not-leak" },
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "Python 3.12.0", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot(),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sk-super-secret-do-not-leak");
  });

  test("前端产物存在/不存在都能正确识别", async () => {
    const builtDir = tmpRoot();
    writeFileSync(join(builtDir, "index.html"), "<html></html>");
    const reportBuilt = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "x", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: builtDir,
    });
    expect(reportBuilt.frontendBuilt).toBe(true);

    const emptyDir = tmpRoot();
    const reportMissing = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "x", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: emptyDir,
    });
    expect(reportMissing.frontendBuilt).toBe(false);
  });
});

describe("doctor · 真实探测（阴性对照①的正样本）", () => {
  test("系统 python3（没装 openmm/opentrons）必须被真实判定为 unavailable，不是随便一个假值", async () => {
    if (!existsSync(SYSTEM_PYTHON)) {
      // 不同机器上系统 python3 的路径可能不一样；跑不到就跳过而不是假装通过。
      console.warn(`跳过：本机没有 ${SYSTEM_PYTHON}`);
      return;
    }
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: SYSTEM_PYTHON,
      // 不注入 probeScience/probeLab —— 用真实实现，真去 spawn 系统 python3。
      frontendDir: tmpRoot(),
    });
    const science = report.tiers.find((t) => t.id === "science")!;
    const lab = report.tiers.find((t) => t.id === "lab")!;
    expect(science.available).toBe(false);
    expect(science.reason).toBeTruthy();
    expect(science.reason).toContain("openmm");
    expect(lab.available).toBe(false);
    expect(lab.reason).toBeTruthy();
    expect(report.python.ok).toBe(true); // 解释器本身是好的，只是没装这两个包
  }, 20_000);
});

describe("doctor · CLI 渲染与调度", () => {
  function fakeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
    return {
      version: "0.4.0-test",
      bunVersion: "1.3.14",
      platform: "darwin/arm64",
      python: { path: "/fake/python", ok: true, version: "Python 3.12.0", error: null },
      tiers: [
        { id: "core", label: "core", summary: "核心域", available: true, reason: null },
        { id: "science", label: "science", summary: "openmm", available: false, reason: "装一下 uv pip install openmm" },
        { id: "lab", label: "lab", summary: "opentrons", available: true, reason: null },
      ],
      providers: [
        { id: "kimi", envVar: "KIMI_API_KEY", configured: true },
        { id: "openrouter", envVar: "OPENROUTER_API_KEY", configured: false },
      ],
      frontendBuilt: false,
      frontendDir: "/fake/frontend/dist",
      dataDir: "/fake/.spark-research",
      timestamp: "2026-09-10T00:00:00.000Z",
      ...overrides,
    };
  }

  test("renderDoctor：不可用的档位打印 reason，前端未构建给修复命令", () => {
    const lines: string[] = [];
    renderDoctor(fakeReport(), (l) => lines.push(l));
    const text = lines.join("\n");
    expect(text).toContain("uv pip install openmm");
    expect(text).toContain("bun run build:web");
    expect(text).toContain("science");
  });

  test("runDoctorCommand --json 输出可解析且字段齐全", async () => {
    const out: string[] = [];
    const code = await runDoctorCommand(["--json"], {
      out: (l) => out.push(l),
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "x", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.tiers).toBeInstanceOf(Array);
    expect(parsed.providers).toBeInstanceOf(Array);
    expect(typeof parsed.bunVersion).toBe("string");
  });

  test("runDoctorCommand 无参数走文本渲染", async () => {
    const out: string[] = [];
    const code = await runDoctorCommand([], {
      out: (l) => out.push(l),
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "x", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot(),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("doctor");
  });

  test("runDoctorCommand --help 打印帮助且不探测环境", async () => {
    const out: string[] = [];
    const code = await runDoctorCommand(["--help"], { out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("\n")).toBe(DOCTOR_HELP);
  });

  test("runDoctorCommand 未知参数返回非零退出码", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDoctorCommand(["--bogus"], { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--bogus");
  });
});
