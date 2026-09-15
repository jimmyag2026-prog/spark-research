import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PROBE_PORT,
  parseLsofCwd,
  parsePsArgsAndStart,
  probePorts,
  probeRunningInstances,
  type ProcessInfo,
} from "../../backend/src/doctor/running_instance";

// δ-2（USAGE_LOG U2）· doctor 探运行实例。
//
// 主干用例起一个**真的 Bun.serve**（不是假 fetch）：探测走的是裸 TCP + 手写 HTTP/1.1，
// 只有对着真服务端才谈得上验证——mock 掉 fetchHealth 只能验汇总逻辑，验不到「请求发得对不对、
// 响应解析得对不对」。进程信息那一层（lsof/ps）反过来必须注入：真跑 lsof 会把这条用例
// 绑死在 CI runner 的权限与工具链上，那不是这条用例要测的东西。

const stubProcess: ProcessInfo = {
  pid: 4242,
  command: "./dist/spark-research server 4321",
  startedAt: "Sat Sep 12 11:46:45 2026",
  cwd: "/Users/someone/Desktop/AI4S/spark-research-a7",
  degraded: null,
};

const servers: { stop: () => void }[] = [];

/** 起一个真的 health server，返回它实际拿到的端口（0 = 让内核挑，避免撞上开发机上真在跑的 4321）。 */
function startFakeHealth(payload: unknown, path = "/api/health"): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== path) return new Response("not found", { status: 404 });
      return Response.json(payload);
    },
  });
  servers.push({ stop: () => server.stop(true) });
  // Bun.serve 的 port 类型是 number | undefined；port:0 起成功后必然有值。
  return server.port!;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
});

describe("doctor 运行实例 · 探端口", () => {
  test("版本不一致 → verdict=version_mismatch，下一步给出 kill <pid>", async () => {
    const port = startFakeHealth({ status: "ok", service: "spark-research", version: "0.8.0-alpha.3" });
    const scan = await probeRunningInstances({
      currentVersion: "0.8.0",
      ports: [port],
      inspectProcess: async () => ({ ...stubProcess, cwd: null }),
      dirExists: () => true,
    });

    expect(scan.scannedPorts).toEqual([port]);
    expect(scan.instances.length).toBe(1);
    const inst = scan.instances[0]!;
    expect(inst.version).toBe("0.8.0-alpha.3");
    expect(inst.versionMatches).toBe(false);
    expect(inst.verdict).toBe("version_mismatch");
    expect(inst.nextStep).toContain("kill 4242");
  });

  test("版本一致且工作目录还在 → verdict=match，没有下一步", async () => {
    const port = startFakeHealth({ status: "ok", service: "spark-research", version: "0.8.0" });
    const scan = await probeRunningInstances({
      currentVersion: "0.8.0",
      ports: [port],
      inspectProcess: async () => stubProcess,
      dirExists: () => true,
    });
    const inst = scan.instances[0]!;
    expect(inst.verdict).toBe("match");
    expect(inst.versionMatches).toBe(true);
    expect(inst.nextStep).toBeNull();
  });

  test("U2 现场：工作目录已不存在 → verdict=orphan_cwd，即便版本也对不上也先报孤儿", async () => {
    const port = startFakeHealth({ status: "ok", service: "spark-research", version: "0.8.0-alpha.3" });
    const scan = await probeRunningInstances({
      currentVersion: "0.8.0",
      ports: [port],
      inspectProcess: async () => stubProcess,
      // 这就是 U2 的现场：spark-research-a7 已经被删掉了。
      dirExists: (path) => !path.endsWith("spark-research-a7"),
    });
    const inst = scan.instances[0]!;
    expect(inst.cwdExists).toBe(false);
    expect(inst.verdict).toBe("orphan_cwd");
    expect(inst.nextStep).toContain("spark-research-a7");
    expect(inst.nextStep).toContain("kill 4242");
  });

  test("端口被别的服务占着 → verdict=foreign，不去打探它的进程，也不建议 kill", async () => {
    const port = startFakeHealth({ status: "ok", service: "grafana", version: "11.0.0" });
    let inspected = false;
    const scan = await probeRunningInstances({
      currentVersion: "0.8.0",
      ports: [port],
      inspectProcess: async () => {
        inspected = true;
        return stubProcess;
      },
    });
    const inst = scan.instances[0]!;
    expect(inst.verdict).toBe("foreign");
    expect(inst.service).toBe("grafana");
    expect(inspected).toBe(false);
    expect(inst.nextStep).not.toContain("kill");
  });

  test("没有实例在跑 → instances 为空，但 scannedPorts 如实报出探过哪几个端口", async () => {
    // 先起再停，拿一个确定没人监听的端口，避免撞上开发机上真在跑的东西。
    const port = startFakeHealth({ status: "ok", service: "spark-research", version: "0.8.0" });
    servers.pop()!.stop();
    const scan = await probeRunningInstances({ currentVersion: "0.8.0", ports: [port], timeoutMs: 500 });
    expect(scan.instances).toEqual([]);
    expect(scan.scannedPorts).toEqual([port]);
  });

  test("拿不到进程信息时降级为「只比版本」，不整段不报", async () => {
    const port = startFakeHealth({ status: "ok", service: "spark-research", version: "0.7.0" });
    const scan = await probeRunningInstances({
      currentVersion: "0.8.0",
      ports: [port],
      // lsof 不在 PATH 的精简容器：pid 拿不到。
      inspectProcess: async () => ({ pid: null, command: null, startedAt: null, cwd: null, degraded: "拿不到 pid" }),
    });
    const inst = scan.instances[0]!;
    expect(inst.verdict).toBe("version_mismatch");
    expect(inst.pid).toBeNull();
    expect(inst.degraded).toBe("拿不到 pid");
    // 没有 pid 就不该编一个 kill 命令出来，得给可执行的替代办法。
    expect(inst.nextStep).toContain("lsof -nP");
  });

  test("端口上有东西应答但不是 JSON → 按 foreign 处理，不冒充成我们的实例", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("<html>nginx</html>", { headers: { "content-type": "text/html" } }),
    });
    servers.push({ stop: () => server.stop(true) });
    const scan = await probeRunningInstances({ currentVersion: "0.8.0", ports: [server.port!] });
    expect(scan.instances[0]!.verdict).toBe("foreign");
    expect(scan.instances[0]!.service).toBeNull();
  });
});

describe("doctor 运行实例 · 端口清单与命令输出解析", () => {
  test("probePorts：默认只探 4321；config 里配了端口就并进来", () => {
    expect(probePorts(undefined)).toEqual([DEFAULT_PROBE_PORT]);
    expect(probePorts(9000)).toEqual([DEFAULT_PROBE_PORT, 9000]);
    // config.json 里存成字符串也认。
    expect(probePorts("9000")).toEqual([DEFAULT_PROBE_PORT, 9000]);
    // 配成 4321 不该出现两次。
    expect(probePorts(4321)).toEqual([DEFAULT_PROBE_PORT]);
    // 垃圾值一律忽略，不能让 doctor 因为配置写错而崩。
    for (const bad of ["", "abc", -1, 0, 70000, 1.5, null, {}]) {
      expect(probePorts(bad)).toEqual([DEFAULT_PROBE_PORT]);
    }
  });

  test("parsePsArgsAndStart：命令行与 lstart 分得开（lstart 是末尾固定 5 段）", () => {
    // 照抄 USAGE_LOG U2 现场的 ps 输出形状。
    expect(parsePsArgsAndStart("./dist/spark-research server 4321    Sat Sep 12 11:46:45 2026")).toEqual({
      command: "./dist/spark-research server 4321",
      startedAt: "Sat Sep 12 11:46:45 2026",
    });
    // 尾部不是 lstart 形状时宁可不报启动时间，也不把命令行截断。
    expect(parsePsArgsAndStart("bun backend/src/index.ts server")).toEqual({
      command: "bun backend/src/index.ts server",
      startedAt: null,
    });
    expect(parsePsArgsAndStart("")).toEqual({ command: null, startedAt: null });
  });

  test("parseLsofCwd：从 -Fn 字段输出里取 n 开头那行", () => {
    expect(parseLsofCwd("p79165\nfcwd\nn/Users/jimmyclaw/Desktop/AI4S/spark-research-a7\n")).toBe(
      "/Users/jimmyclaw/Desktop/AI4S/spark-research-a7",
    );
    expect(parseLsofCwd("p79165\nfcwd\n")).toBeNull();
  });
});
