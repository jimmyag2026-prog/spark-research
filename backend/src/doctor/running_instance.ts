import { existsSync } from "node:fs";

// δ-2（USAGE_LOG U2）：`doctor` 探本机正在跑的 server 实例。
//
// 现场：4321 端口上一个 `v0.8.0-alpha.3` 的 server 从 09-12 一直活到 09-14，两天没人发现。
// 起它的终端早就关了（父进程被 launchd 收养），它的工作树 `spark-research-a7` 已经被删除，
// 进程靠已打开的 inode 继续跑。浏览器打开 4321 看到的是 alpha.3 的工作台，
// 而 CLI / package.json / 文档全是 0.8.0，界面上没有任何地方提示「你连的是个旧构建」。
// 更糟的是两边指向同一个 `~/.spark-research`，旧构建有没有已修复的写入 bug 无从保证。
//
// **方案甲（doctor 探端口），已裁定；不做 pid 文件。** 取舍如实记在这里：
//   探端口零新状态，不会留下需要维护的陈旧文件；代价是**只能探已知端口**——
//   `spark-research server 9000` 起的实例，doctor 看不见。这是这个方案已知的盲区，
//   不是实现缺陷，所以渲染层会把「探了哪几个端口」如实打出来，而不是笼统说一句「没有实例」。
//
// 判据分三层，每层拿不到就降级到上一层，绝不因为拿不到就整段不报：
//   ① HTTP：`GET /api/health` → `{status, service, version}`。service 不是 spark-research
//      就判 foreign（别人的服务占了这个端口，不该冒充成我们的实例去建议人家 kill）。
//   ② 版本：health 里的 version 与本 checkout 的 PACKAGE_VERSION 比对。
//   ③ 进程：lsof 取 pid → ps 取命令行/启动时间 → lsof -d cwd 取工作目录并检查目录是否还在。
//      macOS 与 Linux 的 lsof/ps 都支持这里用到的参数；任一步拿不到就降级为「只比版本」。

export type RunningInstanceVerdict =
  | "match" // 版本一致，工作目录还在
  | "version_mismatch" // 是我们的 server，但版本和本 checkout 对不上
  | "orphan_cwd" // 进程的工作目录已经不存在了（U2 现场）
  | "foreign"; // 端口被别的服务占着

export interface RunningInstance {
  port: number;
  /** health 报的 service 名；不是 spark-research 时 verdict=foreign。 */
  service: string | null;
  /** health 报的版本；拿不到为 null。 */
  version: string | null;
  /** 与本 checkout 的 PACKAGE_VERSION 是否一致。 */
  versionMatches: boolean;
  /**
   * δ-2（V162）：**这个实例**托管的前端产物在不在——由实例自己经 `/api/health` 报。
   * `null` = 实例没报这个字段（v0.10 之前的旧构建，或 foreign 服务）：那是「不知道」，
   * 不是「没构建」，渲染层要把这两者分开说。
   */
  frontendBuilt: boolean | null;
  pid: number | null;
  command: string | null;
  startedAt: string | null;
  cwd: string | null;
  /** cwd 目录现在还在不在；拿不到 cwd 时为 null。 */
  cwdExists: boolean | null;
  verdict: RunningInstanceVerdict;
  /** 该做什么。verdict=match 时为 null。 */
  nextStep: string | null;
  /** 进程信息为什么没拿到（lsof 不在 PATH、权限不足……）。拿到了就是 null。 */
  degraded: string | null;
}

export interface RunningInstanceScan {
  /** 实际探过的端口，按探测顺序。盲区是这个方案的已知代价，要如实打出来。 */
  scannedPorts: number[];
  instances: RunningInstance[];
}

export const DEFAULT_PROBE_PORT = 4321;

export interface HealthPayload {
  status?: unknown;
  service?: unknown;
  version?: unknown;
  /** δ-2（V162）：v0.10 起实例自己报；旧构建没有这个字段 → undefined。 */
  frontendBuilt?: unknown;
}

export interface RunningInstanceProbeOptions {
  /** 本 checkout 的版本，用来比对。 */
  currentVersion: string;
  /** 要探的端口；默认 [4321]，调用方把 config 里配的端口并进来。 */
  ports?: number[];
  /** 单个端口的 HTTP 超时（毫秒），默认 1000。 */
  timeoutMs?: number;
  /** 注入点：默认走裸 TCP 打 /api/health（见 localHttpGet 为什么不用 fetch）。返回 null = 这个端口上没东西应答。 */
  fetchHealth?: (port: number, timeoutMs: number) => Promise<HealthPayload | null>;
  /** 注入点：默认跑 lsof/ps。 */
  inspectProcess?: (port: number) => Promise<ProcessInfo>;
  /** 注入点：默认 existsSync。 */
  dirExists?: (path: string) => boolean;
}

export interface ProcessInfo {
  pid: number | null;
  command: string | null;
  startedAt: string | null;
  cwd: string | null;
  /** 没拿全时的原因；全拿到了是 null。 */
  degraded: string | null;
}

function normalizePort(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * 探测端口清单：默认 4321 + config 的 `serverPort` + 命令行 `--port`，去重且保持顺序。
 *
 * δ-2（V160 / A8 U33）：`--port` 这一档是新的。A8 的现场是验收者用
 * `spark-research server --port 4399` 起了第二个实例，doctor 只探 4321，报「没有实例」——
 * 而用户刚刚**亲手**告诉过工具那个端口号。探端口方案的盲区（见文件头）是「探不到没人说过的
 * 端口」，不该连说过的那个也探不到。
 */
export function probePorts(configuredPort?: unknown, cliPorts: readonly unknown[] = []): number[] {
  const ports = [DEFAULT_PROBE_PORT];
  for (const raw of [configuredPort, ...cliPorts]) {
    const n = normalizePort(raw);
    if (n !== null && !ports.includes(n)) ports.push(n);
  }
  return ports;
}

/**
 * 走裸 TCP 手写一个 HTTP/1.1 GET，**刻意不用 `fetch`**。
 *
 * 原因是实测撞出来的：`fetch` 会读 `http_proxy` / `all_proxy` 环境变量，对
 * `127.0.0.1` 也照样走代理。在设了这两个变量的环境里（公司网络、VPN 客户端、
 * 各种带沙箱的开发环境——本轮的开发沙箱就是），探测会超时失败，doctor 于是报
 * 「这几个端口上没有在跑的实例」——**明明有**。诊断工具给假阴性，比不诊断更糟，
 * 而这恰恰就是 U2 那个实例能活两天没被发现的同一类失效。
 *
 * 实测对照（同一台机器、4321 上真有实例在跑）：
 *   fetch 默认            → The operation timed out.
 *   fetch + proxy:""      → The operation timed out.
 *   Bun.connect 裸 TCP    → {"status":"ok","service":"spark-research","version":"0.8.0"}
 *
 * 只对回环地址这么做，不是通用 HTTP 客户端：`Connection: close` + 读到对端关闭为止，
 * 不处理 chunked / keep-alive / 重定向——health 端点返回的是一小段 JSON，够用。
 */
async function localHttpGet(port: number, path: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let chunks = "";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, data) {
          chunks += new TextDecoder().decode(data);
        },
        close() {
          finish(chunks);
        },
        error() {
          finish(null);
        },
      },
    }).catch(() => finish(null)); // 端口上没人监听 → ECONNREFUSED，是常态不是错误
  });
}

async function defaultFetchHealth(port: number, timeoutMs: number): Promise<HealthPayload | null> {
  const raw = await localHttpGet(port, "/api/health", timeoutMs);
  if (!raw) return null;
  const statusLine = raw.split("\r\n", 1)[0] ?? "";
  if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) return null;
  const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as HealthPayload;
  } catch {
    // 端口上有东西在应答，但回的不是我们认得的 JSON —— 交给上层判 foreign。
    return {};
  }
}

async function run(cmd: string[], timeoutMs = 2000): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    clearTimeout(timer);
    if (code !== 0) return null;
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    // lsof / ps 不在 PATH（精简容器镜像里很常见）——降级，不是报错。
    return null;
  }
}

/** `lsof -Fn -a -p <pid> -d cwd` 的字段输出里，cwd 在以 `n` 开头的那一行。 */
export function parseLsofCwd(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("n")) return line.slice(1).trim() || null;
  }
  return null;
}

/** `ps -o args=,lstart= -p <pid>` 输出一行：命令行在前，启动时间是末尾固定 5 段的 lstart。 */
export function parsePsArgsAndStart(output: string): { command: string | null; startedAt: string | null } {
  const line = output.split("\n")[0]?.trim();
  if (!line) return { command: null, startedAt: null };
  // lstart 形如 `Sat Sep 12 11:46:45 2026`——5 个空白分隔段，长度固定，从末尾切。
  const parts = line.split(/\s+/);
  if (parts.length > 5) {
    const tail = parts.slice(-5);
    // 末段是四位年份、首段是三字母星期，两个都对上才认；否则宁可不报 startedAt。
    if (/^\d{4}$/.test(tail[4]!) && /^[A-Za-z]{3}$/.test(tail[0]!)) {
      return { command: parts.slice(0, -5).join(" "), startedAt: tail.join(" ") };
    }
  }
  return { command: line, startedAt: null };
}

async function defaultInspectProcess(port: number): Promise<ProcessInfo> {
  const pidText = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (!pidText) {
    return {
      pid: null,
      command: null,
      startedAt: null,
      cwd: null,
      degraded: "拿不到监听该端口的 pid（lsof 不在 PATH 或权限不足）——只比版本，不报进程信息。",
    };
  }
  // 端口上可能有多个 fd（IPv4/IPv6 各一行），取第一个 pid。
  const pid = Number(pidText.split("\n")[0]!.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid: null, command: null, startedAt: null, cwd: null, degraded: `lsof 返回的 pid 无法解析：${pidText}` };
  }

  const psText = await run(["ps", "-o", "args=,lstart=", "-p", String(pid)]);
  const { command, startedAt } = psText ? parsePsArgsAndStart(psText) : { command: null, startedAt: null };
  const cwdText = await run(["lsof", "-Fn", "-a", "-p", String(pid), "-d", "cwd"]);
  const cwd = cwdText ? parseLsofCwd(cwdText) : null;

  const missing: string[] = [];
  if (!command) missing.push("命令行");
  if (!cwd) missing.push("工作目录");
  return {
    pid,
    command,
    startedAt,
    cwd,
    degraded: missing.length > 0 ? `pid ${pid} 拿到了，但${missing.join("与")}没取到（ps/lsof 权限不足？）。` : null,
  };
}

function verdictFor(input: {
  service: string | null;
  versionMatches: boolean;
  cwd: string | null;
  cwdExists: boolean | null;
}): RunningInstanceVerdict {
  if (input.service !== "spark-research") return "foreign";
  // 工作目录没了是更硬的证据（进程靠已打开的 inode 在跑，任何重启都不可能恢复它），
  // 排在版本不一致前面——U2 现场两者同时成立，该先告诉人「这是个孤儿」。
  if (input.cwd !== null && input.cwdExists === false) return "orphan_cwd";
  if (!input.versionMatches) return "version_mismatch";
  return "match";
}

function nextStepFor(verdict: RunningInstanceVerdict, instance: { pid: number | null; port: number; cwd: string | null }): string | null {
  const kill = instance.pid === null ? `先找到监听 ${instance.port} 的进程（lsof -nP -iTCP:${instance.port} -sTCP:LISTEN）再停掉它` : `kill ${instance.pid}`;
  switch (verdict) {
    case "match":
      return null;
    case "foreign":
      return `端口 ${instance.port} 被别的服务占着，不是 spark-research。要在这个端口起 server 得先让出端口，或改用别的端口。`;
    case "orphan_cwd":
      return (
        `孤儿实例：它的工作目录 ${instance.cwd ?? "(未知)"} 已经不存在了，进程靠已打开的 inode 继续跑。` +
        `它和当前 checkout 共用同一个数据目录，两边都能写。${kill} 之后再从当前 checkout 起。`
      );
    case "version_mismatch":
      return `版本和当前 checkout 对不上：浏览器打开这个端口看到的是旧构建的工作台。${kill} 后重起。`;
  }
}

export async function probeRunningInstances(options: RunningInstanceProbeOptions): Promise<RunningInstanceScan> {
  const ports = options.ports ?? [DEFAULT_PROBE_PORT];
  const timeoutMs = options.timeoutMs ?? 1000;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const inspectProcess = options.inspectProcess ?? defaultInspectProcess;
  const dirExists = options.dirExists ?? existsSync;

  const instances: RunningInstance[] = [];
  // 端口并行探：都是 1s 超时，串行会让 doctor 平白多等一倍。
  const results = await Promise.all(
    ports.map(async (port) => ({ port, health: await fetchHealth(port, timeoutMs) })),
  );

  for (const { port, health } of results) {
    if (health === null) continue; // 这个端口上没东西在应答——不是异常，是常态。
    const service = typeof health.service === "string" ? health.service : null;
    const version = typeof health.version === "string" ? health.version : null;
    const versionMatches = version === options.currentVersion;
    const frontendBuilt = typeof health.frontendBuilt === "boolean" ? health.frontendBuilt : null;

    // 端口被别人占着时不去 lsof：既没必要，也不该对不属于我们的进程打探 cwd。
    const proc: ProcessInfo =
      service === "spark-research"
        ? await inspectProcess(port)
        : { pid: null, command: null, startedAt: null, cwd: null, degraded: null };
    const cwdExists = proc.cwd === null ? null : dirExists(proc.cwd);
    const verdict = verdictFor({ service, versionMatches, cwd: proc.cwd, cwdExists });

    instances.push({
      port,
      service,
      version,
      versionMatches,
      frontendBuilt,
      pid: proc.pid,
      command: proc.command,
      startedAt: proc.startedAt,
      cwd: proc.cwd,
      cwdExists,
      verdict,
      nextStep: nextStepFor(verdict, { pid: proc.pid, port, cwd: proc.cwd }),
      degraded: proc.degraded,
    });
  }

  return { scannedPorts: ports, instances };
}
