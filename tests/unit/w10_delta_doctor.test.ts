import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDoctorArgs, renderDoctor, runDoctorCommand } from "../../backend/src/doctor/cli";
import { probePorts, probeRunningInstances, type HealthPayload } from "../../backend/src/doctor/running_instance";
import { frontendBuiltAt, healthPayload } from "../../backend/src/server/health";
import type { DoctorReport } from "../../backend/src/doctor";

// δ-2（V160 + V162）门禁。
//
// 「收口 diff」那一行（app.ts 的 /api/health 改成 `c.json(healthPayload(frontendDir))`）
// 本 lane 不能自己动，所以这里钉的是两头：① 载荷构造函数 `healthPayload()` 本身；
// ② doctor 这一侧把 health 里的 `frontendBuilt` 真的读进 RunningInstance 并渲染出来
// （假 health 注入，不起真进程）。收口把那一行接上，两头就闭合。

function fakeHealth(byPort: Record<number, HealthPayload | null>) {
  return async (port: number): Promise<HealthPayload | null> => byPort[port] ?? null;
}

const noProcess = async () => ({ pid: null, command: null, startedAt: null, cwd: null, degraded: null });

describe("δ-2 V160 · 探端口清单 = 4321 + config + --port", () => {
  test("probePorts 合并三个来源，去重保序", () => {
    expect(probePorts(undefined, [])).toEqual([4321]);
    expect(probePorts(9000, [4399])).toEqual([4321, 9000, 4399]);
    expect(probePorts("9000", ["4399"])).toEqual([4321, 9000, 4399]);
    // 去重：config 和 --port 给了同一个端口只探一次；4321 不会被重复加进去。
    expect(probePorts(4399, [4399, 4321])).toEqual([4321, 4399]);
    // 非法值不进清单（-1 / 越界 / 非数字）。
    expect(probePorts("abc", [0, 70000])).toEqual([4321]);
  });

  test("parseDoctorArgs：--port 两种写法都认，可重复；非法值报错而不是静默忽略", () => {
    expect(parseDoctorArgs(["--port", "4399"]).ports).toEqual([4399]);
    expect(parseDoctorArgs(["--port=4399", "--port", "9000"]).ports).toEqual([4399, 9000]);
    expect(parseDoctorArgs(["--json"]).json).toBe(true);
    expect(parseDoctorArgs(["--port", "abc"]).error).toContain("--port");
    expect(parseDoctorArgs(["--port"]).error).toContain("--port");
    expect(parseDoctorArgs(["--wat"]).error).toContain("未知参数");
  });

  test("接线：CLI 的 --port 真的传到了探测清单里（两个实例都报出来）", async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(["--port", "4399"], {
      root: mkdtempSync(join(tmpdir(), "w10-delta-doc-")),
      // 探测本身用假件，但**端口清单由被测代码自己算**——这正是要钉的接线。
      probeRunningInstances: (version, ports) =>
        probeRunningInstances({
          currentVersion: version,
          ports,
          fetchHealth: fakeHealth({
            4321: { status: "ok", service: "spark-research", version, frontendBuilt: true },
            4399: { status: "ok", service: "spark-research", version, frontendBuilt: false },
          }),
          inspectProcess: noProcess,
        }),
      probePython: async (python) => ({ path: python, ok: true, version: "3.12.0", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      probeSegmenter: async () => ({ ok: true, reason: null }),
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("▎运行实例（探端口 4321 / 4399）");
    expect(text).toContain(":4321");
    expect(text).toContain(":4399");
  });

  test("阴性方向：不给 --port 时 4399 上的实例看不见（探端口方案的已知盲区）", async () => {
    const lines: string[] = [];
    await runDoctorCommand([], {
      root: mkdtempSync(join(tmpdir(), "w10-delta-doc2-")),
      probeRunningInstances: (version, ports) =>
        probeRunningInstances({
          currentVersion: version,
          ports,
          fetchHealth: fakeHealth({ 4399: { status: "ok", service: "spark-research", version } }),
          inspectProcess: noProcess,
        }),
      probePython: async (python) => ({ path: python, ok: true, version: "3.12.0", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({ ok: true, reason: null }),
      probeSegmenter: async () => ({ ok: true, reason: null }),
      out: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("这几个端口上没有在跑的实例");
  });
});

describe("δ-2 V162 · frontendBuilt 由实例自己报", () => {
  test("healthPayload 按目录里有没有 index.html 判定", () => {
    const empty = mkdtempSync(join(tmpdir(), "w10-delta-fe-empty-"));
    const built = mkdtempSync(join(tmpdir(), "w10-delta-fe-built-"));
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "index.html"), "<!doctype html>");
    expect(frontendBuiltAt(empty)).toBe(false);
    expect(frontendBuiltAt(built)).toBe(true);
    const payload = healthPayload(built);
    expect(payload.service).toBe("spark-research");
    expect(payload.frontendBuilt).toBe(true);
    expect(healthPayload(empty).frontendBuilt).toBe(false);
    // 无鉴权端点不吐绝对路径。
    expect(Object.keys(payload)).toEqual(["status", "service", "version", "frontendBuilt"]);
  });

  test("probeRunningInstances 把 health 的 frontendBuilt 读进实例；旧构建没这字段 → null", async () => {
    const scan = await probeRunningInstances({
      currentVersion: "0.9.0",
      ports: [4321, 4399, 5000],
      fetchHealth: fakeHealth({
        4321: { status: "ok", service: "spark-research", version: "0.9.0", frontendBuilt: false },
        4399: { status: "ok", service: "spark-research", version: "0.9.0", frontendBuilt: true },
        // 旧构建：没有这个字段。
        5000: { status: "ok", service: "spark-research", version: "0.9.0" },
      }),
      inspectProcess: noProcess,
    });
    expect(scan.instances.map((i) => [i.port, i.frontendBuilt])).toEqual([
      [4321, false],
      [4399, true],
      [5000, null],
    ]);
  });

  test("渲染：实例说没构建就按实例报；当前 checkout 没构建但实例有 → 说清楚这是两件事", () => {
    const base: DoctorReport = {
      version: "0.10.0",
      bunVersion: "1.3.14",
      platform: "darwin/arm64",
      python: { path: "python3", ok: true, version: "3.12.0", error: null },
      tiers: [],
      providers: [],
      computeTargets: [],
      runningInstances: {
        scannedPorts: [4321, 4399],
        instances: [
          {
            port: 4321, service: "spark-research", version: "0.10.0", versionMatches: true, frontendBuilt: true,
            pid: 81821, command: "bun", startedAt: null, cwd: null, cwdExists: null,
            verdict: "match", nextStep: null, degraded: null,
          },
          {
            port: 4399, service: "spark-research", version: "0.10.0", versionMatches: true, frontendBuilt: false,
            pid: 99999, command: "bun", startedAt: null, cwd: null, cwdExists: null,
            verdict: "match", nextStep: null, degraded: null,
          },
        ],
      },
      frontendBuilt: false,
      frontendDir: "/somewhere/dist",
      dataDir: "/tmp/data",
      timestamp: "2026-09-16T00:00:00.000Z",
    };
    const lines: string[] = [];
    renderDoctor(base, (l) => lines.push(l));
    const text = lines.join("\n");
    // 两个实例各报各的。
    expect(text).toContain("前端产物：已构建（浏览器打开 :4321 能看到工作台）");
    expect(text).toContain("前端产物：这个实例没有（浏览器打开 :4399 只会看到构建指引页）");
    // V162 的核心：cwd 那一档要标明口径，且不能让用户以为浏览器里也没有工作台。
    expect(text).toContain("▎前端（当前 checkout）");
    expect(text).toContain("这一行说的只是当前 checkout");
  });
});
