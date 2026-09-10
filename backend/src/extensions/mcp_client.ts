// W4-d · 装载强度③：外部 MCP client（v0.4 P15 X-c，方案 §4.5 的第三档）。
//
// 相对 OpenScience 的净增益点（背景，任务书原话）：
//   OpenScience 有 MCP client，但外部工具调用不进 provenance。
//   spark 因为 W1-a 的 ToolBus 统一审计，外部工具的每次调用可以天然落进证据图。
// 这个文件把"天然"兑现成结构性保证：`ExternalMcpSession.call()` 是外部工具调用的
// **唯一**入口，每次调用——无论成功、失败、超时、还是工具名压根不存在——都会在
// 返回之前落一条执行记录（`appendMcpCallRecord`），调用方没有办法绕过这一步来
// "悄悄调用"一个外部工具而不留痕迹（除非绕过这个文件本身直接用 SDK，那属于
// "不通过 spark 提供的通道"，与 TS 扩展绕过 ExtensionContext 直接 import 是同一类
// 已知边界，见文件末尾"安全边界"注释）。
//
// 装载强度定位（对照 types.ts 的注释）：
//   ① connector.json   —— 数据，不执行代码
//   ② index.ts（TS 扩展）—— 同 UID 代码执行，--trust 覆盖单文件指纹
//   ③ 外部 MCP server（本文件）—— **另一个进程**：我们启动它、用 stdio 和它说 JSON-RPC。
//      比 ②更弱的一点：我们不 `import` 它的代码进当前进程（V8 堆/权限不共享）；
//      比 ②更强的一点：`command` 可以是任意可执行文件——启动一个受害者能装载的
//      "扩展"实际上等价于本地任意命令执行，所以信任模型不能比 TS 扩展更松。
//      `requiresTrust("mcp_client")` 同样为 true（types.ts 的默认规则：非
//      connector 一律需要 --trust），指纹覆盖的对象是 `mcp.json`（见 loader.ts）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { redactSecrets } from "../llm/types";
// **只做类型引用**（`import type`），不引入运行时依赖——`../mcp/server` 经
// `../server/app` 反过来会 import `../capabilities`，而 `../capabilities` 正是
// `capabilities.ts`（本文件的同目录邻居）的消费方，三者连起来是一个环：
//   capabilities/index.ts → extensions/capabilities.ts → mcp_client.ts
//   → mcp/server.ts → server/app.ts → capabilities/index.ts
// `import type` 在编译期整个擦除，不会在这个环里留下运行时边；下面
// `createExternalToolRunner()` 需要**运行时**拿到 `McpToolRunner`（继承一个类，
// 类型引用做不到）时，用 `await import("../mcp/server")` 做**动态**导入——动态
// import 在模块图初次同步求值阶段之后才会真正解析，不会参与上面那个环的
// TDZ 判定。实测复现（改成静态 `import { McpToolRunner }` 时）：
// `bun backend/src/index.ts --version` 直接抛
// `ReferenceError: Cannot access 'McpToolRunner' before initialization`——
// 不是假设性风险，是真的把 CLI 炸了一次，见 docs/devlog/W4-d.md。
import type { ToolOutcome, McpServerOptions, McpToolRunner } from "../mcp/server";
import type { ExtensionManifest } from "./types";
import type { ExtensionGrant } from "./grants";
import { buildExtensionContext, type ExtensionContextDeps } from "./context";
import { extensionDir, type ExtensionPathOptions } from "./paths";
// V31：外部工具调用除了 `.mcp_calls.jsonl` 之外，再落一条证据图 observation。
// `agents/contract.ts` 不会反过来（静态或动态）import 本文件——它只 import
// `project/models`/`project/records`（类型）与 `reviewer/rules`（值）——所以这里
// 静态 import 常量 + 类型不会重演文件头那段注释里的环，跟 `McpToolRunner` 那种
// 动态 import 是两个不同的情形，不需要同样的绕行。
import { EXTERNAL_TOOL_CALL_OBSERVATION_KIND, type ExternalToolCallObservationMetadata } from "../agents/contract";
import type { RecordInput } from "../project/models";
import type { RecordStore } from "../project/records";

// ── mcp.json：装载强度③的 manifest 旁路文件（数据，不是代码）──────────────────

export interface McpCredentialMapping {
  // CredentialStore 的 connectorId——必须同时出现在 extension.json 的
  // requires.credentials 里，且被 `ext grant <name> --credential <id>` 批准，
  // 否则下面 resolveMcpChildEnv() 里的 buildExtensionContext 结构性拒绝（AD-2）。
  id: string;
  // 该凭据记录里要取哪个字段作为值（CredentialAccessor.get() 返回 Record<string,string>）。
  field: string;
  // 注入子进程的环境变量名。
  env: string;
}

export interface McpVerifySample {
  tool: string;
  args?: Record<string, unknown>;
}

export interface McpClientConfig {
  // 启动外部 MCP server 的可执行文件——**不经过 shell**（同 SDK 的 StdioClientTransport
  // 默认行为，shell:false），"a && b"这类 shell 拼接不会被解释，只会被当成一个不存在的
  // 可执行文件名而启动失败。
  command: string;
  args: string[];
  cwd?: string;
  // 显式白名单：允许从宿主进程透传给子进程的环境变量**名**（不是值的拷贝，只是"这个
  // 名字允许过去"）。默认空数组——子进程默认只拿到 SDK 自带的最小安全集合
  // （HOME/LOGNAME/PATH/SHELL/TERM/USER，见 getDefaultEnvironment()），不会继承
  // 宿主进程 process.env 里的其它任何东西，更不会继承任何凭据。
  env: string[];
  credentials: McpCredentialMapping[];
  startupTimeoutMs: number;
  callTimeoutMs: number;
  // ext verify 用：如果声明了，跑一次真实往返调用确认「工具可用 + 执行记录真的落盘」。
  // 不声明就跳过这一项检查（如实标注跳过，不算失败——见 mcp_client_verify.ts）。
  verifySample?: McpVerifySample;
}

export class McpClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClientConfigError";
  }
}

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export function validateMcpClientConfig(raw: unknown): McpClientConfig {
  if (!raw || typeof raw !== "object") {
    throw new McpClientConfigError("mcp.json 不是一个对象");
  }
  const m = raw as Partial<McpClientConfig> & { verifySample?: unknown };
  if (!m.command || typeof m.command !== "string" || m.command.trim() === "") {
    throw new McpClientConfigError("mcp.json 的 command 必须是非空字符串");
  }
  if (m.args !== undefined && (!Array.isArray(m.args) || m.args.some((a) => typeof a !== "string"))) {
    throw new McpClientConfigError("mcp.json 的 args 必须是字符串数组");
  }
  if (m.cwd !== undefined && typeof m.cwd !== "string") {
    throw new McpClientConfigError("mcp.json 的 cwd 必须是字符串");
  }
  if (m.env !== undefined && (!Array.isArray(m.env) || m.env.some((e) => typeof e !== "string"))) {
    throw new McpClientConfigError("mcp.json 的 env 必须是字符串数组（环境变量名白名单）");
  }
  const credentials: McpCredentialMapping[] = [];
  if (m.credentials !== undefined) {
    if (!Array.isArray(m.credentials)) throw new McpClientConfigError("mcp.json 的 credentials 必须是数组");
    for (const entry of m.credentials) {
      const c = entry as Partial<McpCredentialMapping>;
      if (!c || typeof c.id !== "string" || typeof c.field !== "string" || typeof c.env !== "string") {
        throw new McpClientConfigError('mcp.json 的 credentials 每一项必须是 {id, field, env} 三个字符串');
      }
      credentials.push({ id: c.id, field: c.field, env: c.env });
    }
  }
  if (m.startupTimeoutMs !== undefined && (typeof m.startupTimeoutMs !== "number" || m.startupTimeoutMs <= 0)) {
    throw new McpClientConfigError("mcp.json 的 startupTimeoutMs 必须是正数");
  }
  if (m.callTimeoutMs !== undefined && (typeof m.callTimeoutMs !== "number" || m.callTimeoutMs <= 0)) {
    throw new McpClientConfigError("mcp.json 的 callTimeoutMs 必须是正数");
  }
  let verifySample: McpVerifySample | undefined;
  if (m.verifySample !== undefined) {
    const v = m.verifySample as Partial<McpVerifySample>;
    if (!v || typeof v.tool !== "string") throw new McpClientConfigError("mcp.json 的 verifySample.tool 必须是字符串");
    verifySample = { tool: v.tool, args: (v.args as Record<string, unknown>) ?? {} };
  }
  return {
    command: m.command,
    args: m.args ? [...m.args] : [],
    cwd: m.cwd,
    env: m.env ? [...m.env] : [],
    credentials,
    startupTimeoutMs: m.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    callTimeoutMs: m.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    verifySample,
  };
}

export function loadMcpClientConfig(json: string): McpClientConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new McpClientConfigError(`mcp.json 解析失败：${(error as Error).message}`);
  }
  return validateMcpClientConfig(parsed);
}

// ── 执行记录：差异化点的落点 ─────────────────────────────────────────────────
//
// 落盘位置与授权账本同级（extensions/<name>/.mcp_calls.jsonl），JSONL 便于追加不
// 用整读整写。**不**在这里尝试直接写主 project 的证据图（`backend/src/project/**`
// 不在本 lane 名下）——见文件头注释与 devlog「给收口的接线说明」：这条记录是
// "外部工具调用确实发生过"的自证结构，收口方决定要不要把它进一步转成一条
// project record（如 observation），本文件只保证记录本身永远存在、永远先于
// 结果返回给调用方。

export interface McpCallRecord {
  extension: string;
  tool: string;
  ok: boolean;
  // 参数摘要：复用 llm/types.ts 的 redactSecrets，不重写一遍脱敏规则。
  argsSummary: string;
  durationMs: number;
  timestamp: number;
  errorSummary?: string;
}

function mcpCallLogPath(name: string, options: ExtensionPathOptions = {}): string {
  return join(extensionDir(name, options), ".mcp_calls.jsonl");
}

export function appendMcpCallRecord(name: string, record: McpCallRecord, options: ExtensionPathOptions = {}): void {
  const path = mcpCallLogPath(name, options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export function readMcpCallRecords(name: string, options: ExtensionPathOptions = {}): McpCallRecord[] {
  const path = mcpCallLogPath(name, options);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as McpCallRecord);
}

function safeStringifyArgs(args: Record<string, unknown>): string {
  let raw: string;
  try {
    raw = JSON.stringify(args) ?? "{}";
  } catch {
    raw = "[unserializable args]";
  }
  return redactSecrets(raw);
}

// ── 凭据 → 子进程环境变量：AD-2 在"另一个进程"这个边界上的落点 ──────────────────
//
// 唯一合法通道是 buildExtensionContext()（W2-c 交付，本 lane 只读复用）：manifest
// 声明过 **且** 被 `ext grant --credential` 批准过的 id，才可能被解析出值。
// 拿不到时 `.get()` 抛 ExtensionGrantError——这里 catch 住，**不**把变量塞进 env，
// 而不是塞一个空字符串（空字符串仍然是"这个变量出现在子进程 env 里"，会被某些
// SDK 当作"已配置但为空"处理，语义不对；正确的"没有"是"这个 key 压根不存在"）。

export function resolveMcpChildEnv(
  manifest: ExtensionManifest,
  config: McpClientConfig,
  grant: ExtensionGrant,
  deps: ExtensionContextDeps = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const varName of config.env) {
    const value = process.env[varName];
    if (value !== undefined) env[varName] = value;
  }
  if (config.credentials.length === 0) return env;

  // buildExtensionContext 是恶意矩阵①②的同一个结构性拒绝点——mcp_client 扩展
  // 不能绕开它去拿凭据，因为这里压根没有"直接拿 CredentialStore"的第二条路径：
  // resolveMcpChildEnv 只知道 deps.credentials 这个 accessor，唯一的取值方式就是
  // 经过 ctx.credentials.get()。
  const ctx = buildExtensionContext(manifest, grant, deps);
  for (const mapping of config.credentials) {
    try {
      const record = ctx.credentials.get(mapping.id);
      const value = record?.[mapping.field];
      if (typeof value === "string" && value.length > 0) {
        env[mapping.env] = value;
      }
    } catch {
      // 未声明 / 未授权：什么都不做。变量不出现在最终 env 对象里——
      // 这正是阴性对照③要钉死的行为，见 tests/unit/mcp_client.test.ts。
    }
  }
  return env;
}

// ── 连接一个外部 MCP server ─────────────────────────────────────────────────

export interface ExternalMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ExternalMcpSession {
  extensionName: string;
  tools: ExternalMcpTool[];
  call(toolName: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
}

// V31：只要「写一条 observation record」这一个方法——不给整个 RecordStore 的写权限
// （尤其不给 update/link，call() 从头到尾只创建、不修改任何既有 record）。测试可以
// 传一个只实现了 `.create()` 的假对象，不需要真的起一个 sqlite RecordStore。
export type EvidenceRecordSink = Pick<RecordStore, "create">;

export interface ConnectExternalMcpOptions {
  manifest: ExtensionManifest;
  config: McpClientConfig;
  grant: ExtensionGrant;
  deps?: ExtensionContextDeps;
  pathOptions?: ExtensionPathOptions;
  clientName?: string;
  /**
   * V31：给了就在 `.mcp_calls.jsonl` 之外，每次外部工具调用**再**落一条证据图
   * observation record（`metadata.kind = EXTERNAL_TOOL_CALL_OBSERVATION_KIND`，
   * `evidence: "sourced"`）——成功/失败/超时/未知工具四个分支全都落，与 jsonl
   * 审计记录同步（见 `session.call()` 内的 `record()`）。
   *
   * 可选、默认不落：本文件的调用方不是只有"研究循环里真有 project 的场景"——
   * `mcp_client_verify.ts` 的 `ext verify`、`discoverExternalMcpTools()` 的发现
   * 探测都没有（也不该有）project 上下文，那些调用方不传这个字段，行为与 W4-d
   * 落地时完全一致（只写 jsonl）。真正接上 project 证据图是收口（orchestrator 持有
   * 已连接的 project）的职责，见 `docs/devlog/W5-2-d.md`「给收口的接线说明」。
   */
  recordSink?: EvidenceRecordSink;
}

export interface ConnectResult {
  ok: boolean;
  reason?: string;
  session?: ExternalMcpSession;
}

// 启动 + 握手的硬超时：不完全信任 SDK 内部的 RequestOptions.timeout 覆盖了所有
// "进程起来了但从不说话"的情形（它覆盖的是 JSON-RPC 请求本身的超时，子进程
// spawn 成功但 stdin/stdout 一个字节都不吐的场景需要一道额外的保险丝）。
function raceWithHardTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * 启动外部 MCP server（子进程）、握手、`listTools()` 一次。
 *
 * **安全边界（如实写在这里，EXTENDING.md/devlog 原样转载）**：
 * - 它是**另一个进程**，同 UID，但不与宿主进程共享 V8 堆——宿主不 `import` 它的代码。
 * - 它能拿到的环境变量：SDK 默认安全集合（HOME/LOGNAME/PATH/SHELL/TERM/USER）
 *   + `mcp.json` 显式声明且存在于宿主 env 里的白名单变量 + manifest 声明且被
 *   grant 过的凭据派生变量。**不会**继承宿主进程完整的 `process.env`。
 * - 它挂了 / 超时 / 返回垃圾：本函数一律吞掉异常，返回结构化的 `{ok:false, reason}`，
 *   绝不向上抛出未捕获异常、绝不让调用方的进程被拖垮（阴性对照②的落点）。
 * - **不挡什么**：子进程一旦启动，它能做任何该 UID 能做的事（读写文件、发网络
 *   请求、`fork` 更多进程）——`stdio` transport 本身不是沙箱，只是一条通信管道。
 *   这与 TS 扩展"--trust 挡的是未经确认的静默执行，不是代码行为本身"是同一类边界。
 */
export async function connectExternalMcp(options: ConnectExternalMcpOptions): Promise<ConnectResult> {
  const { manifest, config, grant, deps, pathOptions, clientName, recordSink } = options;
  const env = resolveMcpChildEnv(manifest, config, grant, deps ?? {});

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: clientName ?? `spark-research-ext-${manifest.name}`, version: "0.1.0" }, { capabilities: {} });

  try {
    await raceWithHardTimeout(
      client.connect(transport, { timeout: config.startupTimeoutMs }),
      config.startupTimeoutMs + 1_000,
      `外部 MCP server "${manifest.name}" 启动超时（>${config.startupTimeoutMs}ms），进程可能挂起未响应`,
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {
      /* 忽略：反正要报告失败了 */
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  let tools: ExternalMcpTool[];
  try {
    const listed = await raceWithHardTimeout(
      client.listTools(undefined, { timeout: config.callTimeoutMs }),
      config.callTimeoutMs + 1_000,
      `外部 MCP server "${manifest.name}" 的 listTools 超时`,
    );
    tools = (listed.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* 忽略 */
    }
    return { ok: false, reason: `listTools 失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const callTimeoutMs = config.callTimeoutMs;
  const session: ExternalMcpSession = {
    extensionName: manifest.name,
    tools,
    async call(toolName, args = {}) {
      const startedAt = Date.now();
      const argsSummary = safeStringifyArgs(args);
      const record = (partial: Omit<McpCallRecord, "extension" | "tool" | "argsSummary" | "durationMs" | "timestamp">) => {
        // 唯一的记账口：无论走哪条分支，都在这里落一条记录——这是差异化点的
        // 结构性保证（阴性对照①要钉死的就是"这一行永远会跑"）。
        const durationMs = Date.now() - startedAt;
        appendMcpCallRecord(
          manifest.name,
          { extension: manifest.name, tool: toolName, argsSummary, durationMs, timestamp: startedAt, ...partial },
          pathOptions,
        );
        // V31：jsonl 之外，再落一条证据图 observation——同一个 record() 分发点，
        // 四个分支（成功/失败/超时/未知工具）走的都是这一处，不会有第二条路径
        // "只写 jsonl 不写 observation"（阴性对照②钉死的就是这一点）。recordSink
        // 缺省时保持 W4-d 原样行为（只有 jsonl），见 ConnectExternalMcpOptions 的注释。
        if (recordSink) {
          // RecordInput.metadata 是 Record<string, unknown>（schema 不区分 record 类型）；
          // 先按 ExternalToolCallObservationMetadata 用 `satisfies` 做一次结构校验
          // （字段漏了/类型错了在这里就编译不过），再降级成落库用的宽类型——与
          // literature/cli.ts 落 CITATION_INTEGRITY_REVIEW_KIND 观察记录同一手法，
          // 不重新发明一遍。
          const metadata = ({
            kind: EXTERNAL_TOOL_CALL_OBSERVATION_KIND,
            extension: manifest.name,
            tool: toolName,
            ok: partial.ok,
            durationMs,
            argsSummary,
            ...(partial.errorSummary !== undefined ? { errorSummary: partial.errorSummary } : {}),
          } satisfies ExternalToolCallObservationMetadata) as unknown as Record<string, unknown>;
          const input: RecordInput = {
            type: "observation",
            title: `外部工具调用：${manifest.name}/${toolName}`,
            content: partial.ok
              ? `外部 MCP 工具 "${toolName}"（扩展 "${manifest.name}"）调用成功，耗时 ${durationMs}ms`
              : `外部 MCP 工具 "${toolName}"（扩展 "${manifest.name}"）调用失败：${partial.errorSummary ?? "未知原因"}`,
            evidence: "sourced",
            metadata,
          };
          try {
            recordSink.create(input);
          } catch {
            // 落 observation 失败不该拖垮外部工具调用本身的返回——jsonl 那条审计
            // 记录已经先落盘了（见上面那一行），这里只是"锦上添花"的第二份记录，
            // 与本函数"绝不向上抛出未捕获异常"的整体纪律一致（见文件头安全边界注释）。
          }
        }
      };

      if (!tools.some((t) => t.name === toolName)) {
        record({ ok: false, errorSummary: "unknown_tool" });
        return { ok: false, payload: { error: `外部工具 "${toolName}" 不在扩展 "${manifest.name}" 已发现的工具列表里`, available: tools.map((t) => t.name) } };
      }

      try {
        const result = (await raceWithHardTimeout(
          client.callTool({ name: toolName, arguments: args }, undefined, { timeout: callTimeoutMs }),
          callTimeoutMs + 1_000,
          `外部工具 "${toolName}" 调用超时（>${callTimeoutMs}ms）`,
        )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        const isError = Boolean(result.isError);
        const text = (result.content ?? []).map((c) => c.text ?? "").join("");
        let payload: unknown;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = text;
        }
        record({ ok: !isError });
        return { ok: !isError, payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record({ ok: false, errorSummary: message });
        // 超时 / 进程中途挂掉都落在这里——绝不抛给调用方一个未处理异常。
        return { ok: false, payload: { error: `外部工具调用失败：${message}` } };
      }
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* 忽略 */
      }
    },
  };

  return { ok: true, session };
}

// ── 发现结果缓存：capabilities.ts 读它来判定 mcp_client 扩展的状态 ────────────
//
// 与 verify_cache.ts 的 `.verify.json`是姊妹文件、不是同一个东西：`.verify.json`
// 记的是"契约测试通不通过"，`.mcp_discovery.json` 记的是"上一次尝试连接时,外部
// server 到底活不活、有哪些工具"——两者独立过期。capabilities --json 只读这个
// 文件（数据），不会为了回答"这个扩展有哪些工具"而重新 spawn 一次子进程
// （与 capabilities.ts 头部注释的纪律一致：只读端点不该顺手执行代码/起进程）。

export interface McpDiscoveryCache {
  ok: boolean;
  at: string;
  reason?: string;
  tools: Array<{ name: string; description?: string }>;
}

function discoveryCachePath(dir: string): string {
  return join(dir, ".mcp_discovery.json");
}

export function readMcpDiscoveryCache(dir: string): McpDiscoveryCache | null {
  const path = discoveryCachePath(dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as McpDiscoveryCache;
  } catch {
    return null;
  }
}

export function writeMcpDiscoveryCache(dir: string, record: McpDiscoveryCache): void {
  const path = discoveryCachePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
}

/**
 * `spark-research ext add-mcp` 与 `ext verify`（kind=mcp_client）共用的发现步骤：
 * 连接一次、记住结果、断开。**不保持常驻连接**——常驻连接的生命周期管理是收口
 * （daemon/orchestrator）的职责，本函数只负责"探一次、留下痕迹"。
 */
export async function discoverExternalMcpTools(
  extensionDir: string,
  manifest: ExtensionManifest,
  config: McpClientConfig,
  grant: ExtensionGrant,
  deps: ExtensionContextDeps = {},
  pathOptions: ExtensionPathOptions = {},
): Promise<McpDiscoveryCache> {
  const result = await connectExternalMcp({ manifest, config, grant, deps, pathOptions });
  let record: McpDiscoveryCache;
  if (!result.ok || !result.session) {
    record = { ok: false, at: new Date().toISOString(), reason: result.reason ?? "未知原因", tools: [] };
  } else {
    record = { ok: true, at: new Date().toISOString(), tools: result.session.tools.map((t) => ({ name: t.name, description: t.description })) };
    await result.session.close();
  }
  writeMcpDiscoveryCache(extensionDir, record);
  return record;
}

// ── 子代理调用面：把外部工具接进 ToolBus ────────────────────────────────────
//
// `backend/src/agents/toolbus.ts` 不在本 lane 名下（W1-a 交付，只读）。它的
// `ToolBusOptions.runner` 类型是具体的 `McpToolRunner`（不是接口——该类有私有
// 字段，TS 在这种情况下按名义类型检查，普通"形状匹配"的对象不能赋值给这个位置）。
// 不改 toolbus.ts 也能接进去的办法：**子类化** `McpToolRunner`，子类实例在 TS
// 的名义类型系统里就是 `McpToolRunner`的实例，可以直接塞进 `ToolBusOptions.runner`。
// 这样 AgentToolBus 已有的三层（授权 grants 白名单 / 预算 BudgetLedger / 审计
// audit 回调）不用改一行代码，就会对外部工具名同样生效——见 devlog「给收口的
// 接线说明」。

const QUALIFIED_PREFIX = "mcp:";

export function qualifyExternalToolName(extensionName: string, toolName: string): string {
  return `${QUALIFIED_PREFIX}${extensionName}:${toolName}`;
}

export function parseQualifiedToolName(name: string): { extension: string; tool: string } | null {
  if (!name.startsWith(QUALIFIED_PREFIX)) return null;
  const rest = name.slice(QUALIFIED_PREFIX.length);
  const idx = rest.indexOf(":");
  if (idx === -1) return null;
  const extension = rest.slice(0, idx);
  const tool = rest.slice(idx + 1);
  if (!extension || !tool) return null;
  return { extension, tool };
}

/** 多个已连接外部 MCP 扩展的登记表——AgentToolBus 需要的"工具名 → 谁来执行"路由。 */
export class ExternalToolRegistry {
  private readonly sessions = new Map<string, ExternalMcpSession>();

  register(session: ExternalMcpSession): void {
    this.sessions.set(session.extensionName, session);
  }

  unregister(extensionName: string): void {
    this.sessions.delete(extensionName);
  }

  get(extensionName: string): ExternalMcpSession | undefined {
    return this.sessions.get(extensionName);
  }

  /** 与 AgentToolBus.specs() 同形状（name/description/inputSchema），供收口拼进喂给模型的 tools 列表。 */
  specs(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const [extensionName, session] of this.sessions) {
      for (const tool of session.tools) {
        out.push({
          name: qualifyExternalToolName(extensionName, tool.name),
          description: `[外部 MCP · ${extensionName}] ${tool.description ?? tool.name}`,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        });
      }
    }
    return out;
  }

  has(qualifiedName: string): boolean {
    const parsed = parseQualifiedToolName(qualifiedName);
    return parsed !== null && this.sessions.has(parsed.extension);
  }

  async call(qualifiedName: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const parsed = parseQualifiedToolName(qualifiedName);
    if (!parsed) return { ok: false, payload: { error: `不是一个合法的外部 MCP 工具名："${qualifiedName}"（期望 mcp:<extension>:<tool>）` } };
    const session = this.sessions.get(parsed.extension);
    if (!session) return { ok: false, payload: { error: `外部 MCP 扩展 "${parsed.extension}" 未连接/未注册` } };
    return session.call(parsed.tool, args);
  }
}

/**
 * 构造一个"`McpToolRunner`，但工具名带 `mcp:` 前缀时路由给外部 MCP server"的实例——
 * 收口把它塞进 `AgentToolBus.options.runner` 之后，`AgentToolBus` 已有的三层
 * （授权 grants 白名单 / 预算 BudgetLedger / 审计 audit 回调）不用改一行代码，
 * 就会对外部工具名同样生效（`backend/src/agents/toolbus.ts` 的
 * `ToolBusOptions.runner` 类型是具体的 `McpToolRunner`——该类有私有字段，TS 按
 * 名义类型检查，子类实例天然可以赋值给这个位置，不需要把那个类型放宽成接口）。
 *
 * 是 `async` 工厂函数而不是一个可以 `new` 的具名导出类：见文件头注释——避免在
 * 模块顶层静态 `import { McpToolRunner }`，改用运行时才解析的动态 `import()`，
 * 从根上切断 capabilities.ts → mcp_client.ts → mcp/server.ts → server/app.ts →
 * capabilities/index.ts 这个环。
 *
 * 收口方式：daemon 构造 `AgentToolBus` 时，把
 * `new McpToolRunner(sameOptions)` 换成
 * `await createExternalToolRunner(sameOptions, registry)`。
 */
export async function createExternalToolRunner(baseOptions: McpServerOptions, registry: ExternalToolRegistry): Promise<McpToolRunner> {
  const { McpToolRunner: RealMcpToolRunner } = await import("../mcp/server");
  class McpToolRunnerWithExternal extends RealMcpToolRunner {
    override async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
      if (registry.has(name)) return registry.call(name, args);
      return super.call(name, args);
    }
  }
  return new McpToolRunnerWithExternal(baseOptions);
}
