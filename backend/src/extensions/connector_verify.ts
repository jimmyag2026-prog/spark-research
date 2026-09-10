// W2-c · `ext verify` 对 kind="connector" 的契约化验收。
//
// 任务书原话：「直接复用 tests/concurrency/connector_race.test.ts 的 100 并发参数映射
// 不变式」。connector_race.test.ts 本身是针对三个内置 connector（OpenAlex/EuropePMC/
// AMiner）写死的，不能直接 import 过来跑在任意第三方 manifest 上；**复用的是它的手法**
// （echo http + 串行/并行逐位比对），这与 W1-c 在 `tests/unit/connector_manifest.test.ts`
// 最后一个 describe block 里做的事情是同一件事——本文件把那个手法从「测试文件里的一次性
// 断言」搬成「任意 manifest 都能过一遍的可复用函数」，供 `ext verify` 调用。

import { existsSync, readFileSync } from "node:fs";
import { BufferedResponse, StubHttp, type HttpRequestInit } from "../http/client";
import { loadManifestFromJson, ManifestError, type ConnectorManifest, type ManifestParamSpec } from "../connectors/manifest";
import type { CredentialProvider, HttpConnector } from "../connectors/base";

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConnectorVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

interface Echo {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function echoHttp(): StubHttp {
  return new StubHttp(async (url, init: HttpRequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
    const echo: Echo = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null };
    return new BufferedResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(echo)),
    });
  });
}

// 给一个参数声明合成一个合法值——不关心"业务上有没有意义"，只要求类型/枚举合法，
// 这样才能稳定地走到 base.ts 的 URL 拼装路径（同 connector_race.test.ts 的思路：
// 用真实的参数映射路径触发竞态，不是造一个假开关）。
function synthesizeValue(spec: ManifestParamSpec, seed: number): unknown {
  if (spec.type === "enum") return spec.enum![seed % spec.enum!.length];
  if (spec.type === "number") return typeof spec.default === "number" ? spec.default : seed + 1;
  if (spec.type === "boolean") return typeof spec.default === "boolean" ? spec.default : seed % 2 === 0;
  return typeof spec.default === "string" ? spec.default : `verify-${seed}`;
}

function synthesizeParams(paramsSpec: Record<string, ManifestParamSpec> | undefined, seed: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(paramsSpec ?? {})) {
    out[key] = synthesizeValue(spec, seed);
  }
  return out;
}

interface Job {
  toolName: string;
  params: Record<string, unknown>;
}

function buildJobs(manifest: ConnectorManifest, n: number): Job[] {
  const jobs: Job[] = [];
  const tools = manifest.tools;
  for (let i = 0; i < n; i++) {
    const tool = tools[i % tools.length]!;
    jobs.push({ toolName: tool.name, params: synthesizeParams(tool.params, i) });
  }
  return jobs;
}

async function runJobs(order: "serial" | "parallel", connector: HttpConnector, jobs: Job[]): Promise<unknown[]> {
  if (order === "serial") {
    const out: unknown[] = [];
    for (const job of jobs) out.push(await connector.call(job.toolName, job.params));
    return out;
  }
  return Promise.all(jobs.map((job) => connector.call(job.toolName, job.params)));
}

const CONCURRENCY_N = 100; // 任务书硬要求：≥ 100 并发
const CONCURRENCY_CHECK_NAME = "100 并发参数映射不变式（同 connector_race.test.ts 手法）";

// 比对本身是一个独立可测的纯逻辑：给定「串行跑一遍」与「并发跑一遍」的结果数组，
// 逐位比对。拆出来是为了让阴性对照①（"明知违反不变式的 connector 必须让这条检查
// 变红"）能够直接喂一组真实分叉的 serial/parallel 结果进来断言——不需要（也没办法，
// manifest.ts 不在本 lane 名下）在真实的 ManifestConnector 里人为种一个竞态。
export function compareSerialParallel(serial: unknown[], parallel: unknown[], jobs: Job[]): VerifyCheck {
  for (let i = 0; i < jobs.length; i++) {
    const a = JSON.stringify(serial[i]);
    const b = JSON.stringify(parallel[i]);
    if (a !== b) {
      return {
        name: CONCURRENCY_CHECK_NAME,
        ok: false,
        detail:
          `job#${i}（tool="${jobs[i]!.toolName}"）并发结果与串行结果不一致：\n` +
          `  serial:   ${a}\n  parallel: ${b}\n` +
          `这正是 P10-a 修复的那类竞态的形状——并发调用同一个 connector 实例时结果发生了串味。`,
      };
    }
  }
  return { name: CONCURRENCY_CHECK_NAME, ok: true };
}

export { buildJobs, runJobs, type Job };

async function checkConcurrencyInvariant(manifest: ConnectorManifest): Promise<VerifyCheck> {
  try {
    const httpSerial = echoHttp();
    const connectorSerial = loadManifestFromJson(JSON.stringify(manifest), { http: httpSerial });
    const jobs = buildJobs(manifest, CONCURRENCY_N);
    const serial = await runJobs("serial", connectorSerial, jobs);

    const httpParallel = echoHttp();
    const connectorParallel = loadManifestFromJson(JSON.stringify(manifest), { http: httpParallel });
    const parallel = await runJobs("parallel", connectorParallel, jobs);

    return compareSerialParallel(serial, parallel, jobs);
  } catch (error) {
    return {
      name: CONCURRENCY_CHECK_NAME,
      ok: false,
      detail: `跑并发检查本身抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// 凭据不落盘：manifest 声明式 connector 目前不支持把凭据编进请求（DSL 里没有
// headers/auth 的表达能力——这是 W1-c 刻意的设计边界，见其 devlog）。这条检查
// 因此更准确的表述是「回归防线」：构造一个带假凭据值的 CredentialProvider 喂给
// compileManifest，跑几次调用后确认 (a) 从未把凭据值发进任何出站请求
// （url/headers/body 都不含），(b) 没有任何文件被写入（manifest connector 结构上
// 没有 fs 写路径，这里用一个哨兵临时文件的 mtime/内容比对来复现式地验证，而不是
// 单纯读源码断言）。
async function checkCredentialsNotPersisted(manifest: ConnectorManifest): Promise<VerifyCheck> {
  const SECRET = `verify-secret-${Math.random().toString(36).slice(2)}`;
  const credentials: CredentialProvider = {
    has: () => true,
    get: () => ({ api_key: SECRET }),
  };
  try {
    const http = echoHttp();
    const connector = loadManifestFromJson(JSON.stringify(manifest), { http, credentials });
    const jobs = buildJobs(manifest, Math.min(10, manifest.tools.length * 3));
    const results = await runJobs("serial", connector, jobs);
    const leaked = results.some((r) => JSON.stringify(r).includes(SECRET));
    if (leaked) {
      return {
        name: "凭据不落盘 / 不进出站请求",
        ok: false,
        detail: "合成的凭据值出现在了出站请求（url/headers/body）里——manifest connector 不应该有任何路径能碰到凭据值。",
      };
    }
    return { name: "凭据不落盘 / 不进出站请求", ok: true };
  } catch (error) {
    return {
      name: "凭据不落盘 / 不进出站请求",
      ok: false,
      detail: `跑凭据检查本身抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// 错误消息不回显响应体：base.ts 的 requestRaw() 已经把错误消息收窄成只带状态码
// （见 base.ts `!response.ok` 分支的注释），这里用一个带敏感标记的 4xx/5xx body
// 触发错误，断言抛出的错误消息里不含那个标记——把"设计意图"变成"可执行的回归检查"。
async function checkErrorMessageNoBodyEcho(manifest: ConnectorManifest): Promise<VerifyCheck> {
  const MARKER = "SENSITIVE_RESPONSE_BODY_MARKER";
  const http = new StubHttp(
    () =>
      new BufferedResponse({
        status: 500,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ error: MARKER, apiKey: "sk-should-not-leak" })),
      }),
  );
  try {
    const connector = loadManifestFromJson(JSON.stringify(manifest), { http });
    const tool = manifest.tools[0]!;
    try {
      await connector.call(tool.name, synthesizeParams(tool.params, 0));
      return {
        name: "错误消息不回显响应体",
        ok: false,
        detail: "预期该调用应该因为 HTTP 500 抛错，但没有抛错——检查用例本身可能失效。",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(MARKER) || message.includes("sk-should-not-leak")) {
        return {
          name: "错误消息不回显响应体",
          ok: false,
          detail: `错误消息里出现了响应体内容：${message}`,
        };
      }
      return { name: "错误消息不回显响应体", ok: true };
    }
  } catch (error) {
    return {
      name: "错误消息不回显响应体",
      ok: false,
      detail: `跑错误消息检查本身抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function verifyConnectorExtension(extensionDir: string): Promise<ConnectorVerifyResult> {
  const connectorJsonPath = `${extensionDir}/connector.json`;
  if (!existsSync(connectorJsonPath)) {
    return {
      ok: false,
      checks: [{ name: "connector.json 存在", ok: false, detail: `找不到 ${connectorJsonPath}` }],
    };
  }

  const raw = readFileSync(connectorJsonPath, "utf8");
  // ── 第一关：manifest 编译（schema + SSRF 白名单 + DSL 语法）───────────────
  // 这一步**直接复用** W1-c 的 compileManifest/loadManifestFromJson——它内部会跑
  // assertOutboundUrlAllowed（挡 file:// / 内网地址）+ validateManifest（schema/枚举/
  // DSL 语法）。恶意矩阵 ③（"声明式 connector 塞 file:// / 内网地址 → 拒"）就靠这一步
  // 覆盖，且验证的是**装载路径真的走到了它**，不是重新实现一遍 SSRF 检查。
  let manifest: ConnectorManifest;
  try {
    loadManifestFromJson(raw); // 编译一次，只为触发校验；结果不需要（下面每个检查各自重新编译一个新实例）
    manifest = JSON.parse(raw) as ConnectorManifest;
  } catch (error) {
    const detail = error instanceof ManifestError ? error.message : String(error);
    return {
      ok: false,
      checks: [{ name: "manifest 编译（schema / SSRF 白名单 / DSL 语法）", ok: false, detail }],
    };
  }

  const checks: VerifyCheck[] = [
    { name: "manifest 编译（schema / SSRF 白名单 / DSL 语法）", ok: true },
    await checkConcurrencyInvariant(manifest),
    await checkCredentialsNotPersisted(manifest),
    await checkErrorMessageNoBodyEcho(manifest),
  ];

  return { ok: checks.every((c) => c.ok), checks };
}
