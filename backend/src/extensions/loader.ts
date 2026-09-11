// W2-c · 扩展装载器——任务书的核心交付物。
//
// 三种装载强度落地：
//   kind="connector"                → 直接复用 W1-c 的 loadManifestFromJson，不执行代码。
//   kind∈{skill,platform,backend,rule} → 需要 --trust（fingerprint.ts），
//                                        通过后 dynamic import 扩展的 entry 文件。
//   kind="mcp_client"                → 需要 --trust（指纹覆盖 mcp.json），通过后只解析
//                                        配置——**不**在装载时启动子进程（见 mcp_client.ts
//                                        头部注释：只读端点/装载动作不该顺手起进程）。
//
// 安全边界（恶意矩阵的落点，逐条标注）：
//   ① manifest 声明 A 却调 B 工具        → context.ts 的 buildExtensionContext 结构性拒绝
//   ② 未 grant 却取凭据                 → 同上（mcp_client 同样经这条路径，见 mcp_client.ts 的 resolveMcpChildEnv）
//   ③ 声明式 connector 塞 file:// / 内网 → loadManifestFromJson 内部的 assertOutboundUrlAllowed 拒绝
//   ④ 扩展抛异常                       → 本文件的 try/catch，主进程不受影响，返回 status:"failed"
//   ⑤ 未过 ext verify 装载时警告         → verify_cache.ts 的缓存比对

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { loadExtensionManifest, ExtensionManifestError, type ExtensionKind, type ExtensionManifest } from "./types";
import { loadManifestFromJson, ManifestError } from "../connectors/manifest";
import type { HttpConnector, ConnectorOptions } from "../connectors/base";
import { checkTrust, sha256File } from "./fingerprint";
import { ExtensionGrantStore, type ExtensionGrant } from "./grants";
import { buildExtensionContext, type ExtensionContext, type ExtensionContextDeps } from "./context";
import { readVerifyCache, subjectPathFor } from "./verify_cache";
import { extensionsRoot, type ExtensionPathOptions } from "./paths";
import {
  loadMcpClientConfig,
  McpClientConfigError,
  connectExternalMcp,
  ExternalToolRegistry,
  type McpClientConfig,
  type ConnectExternalMcpOptions,
  type ConnectResult,
  type ExternalMcpSession,
  type ExternalMcpAttachment,
  type ExternalMcpAttachFailure,
  type ExternalMcpAttachOptions,
  type ExternalMcpProvider,
} from "./mcp_client";

export interface LoadExtensionOptions {
  // 装载 TS 扩展（强度②）的显式确认；connector 不需要。
  trust?: boolean;
  // 真实凭据源 / ToolBus，由调用方（daemon）注入；缺省时 context 里任何访问都会拒绝。
  deps?: ExtensionContextDeps;
  // 测试用：覆盖数据根目录 / 让 connector 也能注入凭据与 http（不走真实网络）。
  pathOptions?: ExtensionPathOptions;
  connectorOptions?: ConnectorOptions;
}

export interface LoadedExtension {
  name: string;
  kind: ExtensionKind | null;
  status: "loaded" | "failed";
  reason: string | null;
  warnings: string[];
  connector?: HttpConnector;
  // kind="mcp_client"：解析后的 mcp.json（command/args/env 白名单/凭据映射）。
  // **不含**已建立的连接——连接是有状态的（子进程句柄），装载器不替调用方决定
  // "什么时候该连"，见 mcp_client.ts 的 connectExternalMcp()/discoverExternalMcpTools()。
  mcpConfig?: McpClientConfig;
  context?: ExtensionContext;
  // TS 扩展的原始模块导出。装载器不猜它长什么样（platform 该导出 createPlatform，
  // rule 该导出 rule/VERIFY_SAMPLE_INPUT，backend 该导出 backend）——那是 verify.ts
  // 各自 case 的职责，这里如实转交给调用方。
  module?: Record<string, unknown>;
}

function failure(name: string, kind: ExtensionKind | null, reason: string, warnings: string[] = []): LoadedExtension {
  return { name, kind, status: "failed", reason, warnings };
}

function verifyStalenessWarning(extensionDir: string, manifest: ExtensionManifest): string | null {
  const subjectPath = subjectPathFor(extensionDir, manifest);
  const cache = readVerifyCache(extensionDir);
  if (!cache) {
    return `⚠️ 扩展 "${manifest.name}" 从未跑过 \`ext verify\`——"能装上"不等于"过得了契约测试"（AD-11），请先跑 \`spark-research ext verify ${extensionDir}\`。`;
  }
  if (!existsSync(subjectPath)) {
    return `⚠️ 扩展 "${manifest.name}" 的校验对象 ${subjectPath} 已不存在，缓存的 ext verify 结果失效。`;
  }
  if (sha256File(subjectPath) !== cache.subjectSha256) {
    return `⚠️ 扩展 "${manifest.name}" 自上次 \`ext verify\` 后内容已变化，记录的验收结果已过期，请重新跑 \`ext verify\`。`;
  }
  if (!cache.ok) {
    return `⚠️ 扩展 "${manifest.name}" 上一次 \`ext verify\` 未通过（${cache.at}）——装载仍会继续（verify 是提醒不是硬闸，这不是沙箱），但不代表它符合契约。`;
  }
  return null;
}

export async function loadExtension(extensionDir: string, options: LoadExtensionOptions = {}): Promise<LoadedExtension> {
  const dirName = basename(extensionDir);
  const manifestPath = join(extensionDir, "extension.json");
  if (!existsSync(manifestPath)) {
    return failure(dirName, null, `找不到 ${manifestPath}`);
  }

  let manifest: ExtensionManifest;
  try {
    manifest = loadExtensionManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const reason = error instanceof ExtensionManifestError ? error.message : String(error);
    return failure(dirName, null, reason);
  }

  const warnings: string[] = [];
  // ⑤：探测本身绝不能让装载失败——探测失败就是没有这条警告，不是拒绝装载。
  try {
    const staleWarning = verifyStalenessWarning(extensionDir, manifest);
    if (staleWarning) warnings.push(staleWarning);
  } catch {
    /* 忽略：探测失败不影响装载 */
  }

  if (manifest.kind === "connector") {
    const connectorJsonPath = join(extensionDir, "connector.json");
    try {
      if (!existsSync(connectorJsonPath)) throw new Error(`找不到 ${connectorJsonPath}`);
      const raw = readFileSync(connectorJsonPath, "utf8");
      // 这一步是恶意矩阵③的真实落点：loadManifestFromJson 内部会跑
      // assertOutboundUrlAllowed（SSRF 白名单）与 validateManifest（schema/DSL）——
      // **装载路径本身**触发这些校验，不是测试单独调一遍编译器充数。
      const connector = loadManifestFromJson(raw, options.connectorOptions ?? {});
      return { name: manifest.name, kind: "connector", status: "loaded", reason: null, warnings, connector };
    } catch (error) {
      const reason = error instanceof ManifestError ? error.message : error instanceof Error ? error.message : String(error);
      return failure(manifest.name, "connector", reason, warnings);
    }
  }

  // ── 强度③：外部 MCP client ── 另一个进程，同样需要 --trust ──
  if (manifest.kind === "mcp_client") {
    const mcpJsonPath = join(extensionDir, "mcp.json");
    if (!existsSync(mcpJsonPath)) {
      return failure(manifest.name, "mcp_client", `找不到 ${mcpJsonPath}`, warnings);
    }
    let mcpConfig: McpClientConfig;
    try {
      mcpConfig = loadMcpClientConfig(readFileSync(mcpJsonPath, "utf8"));
    } catch (error) {
      const reason = error instanceof McpClientConfigError ? error.message : String(error);
      return failure(manifest.name, "mcp_client", reason, warnings);
    }

    // 指纹覆盖 mcp.json 本身（不是某个 TS 文件）——command/args/env/凭据映射
    // 任何一处变化都要求重新确认，理由与 TS 扩展的入口文件指纹完全一致。
    const trust = checkTrust(manifest.name, mcpJsonPath, Boolean(options.trust), options.pathOptions);
    if (!trust.trusted) {
      return failure(manifest.name, "mcp_client", trust.message, warnings);
    }
    warnings.push(trust.message);

    // 刻意不在这里 connectExternalMcp()：装载 ≠ 启动子进程。真正的连接由调用方
    // （daemon 接线 / `ext verify` / `ext add-mcp` 的发现步骤）显式发起。
    return { name: manifest.name, kind: "mcp_client", status: "loaded", reason: null, warnings, mcpConfig };
  }

  // ── 强度②：TS 扩展（skill / platform / backend / rule）── 同 UID 代码执行 ──
  const entryPath = join(extensionDir, manifest.entry ?? "index.ts");
  try {
    if (!existsSync(entryPath)) {
      return failure(manifest.name, manifest.kind, `找不到入口文件 ${entryPath}`, warnings);
    }

    // v0.8 G-2（V101）：TS 扩展的指纹覆盖**整个扩展目录**（清单哈希），不只是入口文件——
    // 改 helper 文件绕过 TOFU 的口子关掉。mcp_client 仍只盖 mcp.json（见上）。
    const trust = checkTrust(manifest.name, { kind: "dir", path: extensionDir }, Boolean(options.trust), options.pathOptions);
    if (!trust.trusted) {
      // 阴性对照②的落点：不传 --trust 时，无论 verify 状态如何，这里都拒绝装载。
      return failure(manifest.name, manifest.kind, trust.message, warnings);
    }
    warnings.push(trust.message);

    const grantStore = new ExtensionGrantStore(options.pathOptions);
    const grant = grantStore.get(manifest.name);
    const context = buildExtensionContext(manifest, grant, options.deps ?? {});

    // 任意代码执行发生在这一行。try/catch 是恶意矩阵④的落点——
    // 扩展在顶层抛异常（或导出的东西压根不是模块该有的形状，由调用方后续检查），
    // 这里只保证「装载器本身不会被炸穿，主进程活着」。
    const mod = (await import(entryPath)) as Record<string, unknown>;

    return { name: manifest.name, kind: manifest.kind, status: "loaded", reason: null, warnings, context, module: mod };
  } catch (error) {
    return failure(manifest.name, manifest.kind, error instanceof Error ? error.message : String(error), warnings);
  }
}

// ── V45：「agent 运行时连接外部 MCP 扩展」这条流程 ─────────────────────────────
//
// 背景（如实记录，见 docs/BACKLOG.md 的 V31/V32/V45）：W4-d 建了 `connectExternalMcp()`，
// W5-2 δ 建了 `recordSink`（每次外部调用落一条证据图 observation）与
// `OrchestratorDeps.externalTools`（注入了就走 `createExternalToolRunner()`）。
// 但收口追查发现 `connectExternalMcp()` 的调用方**只有 `ext verify` / `ext add-mcp`**——
// agent 运行路径上一个都没有。所以那两个可选参数不是"忘了传"，是**没有那条流程可传**。
// 这一段就是那条流程：
//
//   ① 发现  discoverInstalledMcpClients()  ── 纯文件系统，零子进程、零代码执行
//   ② 连接  ExternalMcpRuntime.attach()    ── 每个扩展一个子进程，逐个隔离
//   ③ 注册  ExternalToolRegistry.register() ── 交给 createExternalToolRunner()
//   ④ 绑定  recordSink = project.records()  ── V31 在生产里真的生效的那一刻
//   ⑤ 收尾  attachment.close()              ── agent 跑完把子进程收掉
//   ⑥ 隔离  一个坏扩展只产生一条 failed 记录，不抛异常上去
//
// **惰性策略（约束二）**，三层，逐层可测：
//   L0 构造 `ExternalMcpRuntime` 本身零 I/O——它只是记住几个选项，不 readdir、不 spawn。
//   L1 只有 **agent 运行路径**（`OrchestratorAgent.runResearchLoop()`）会调 `attach()`。
//      `lit search` / `ext list` / `report export` 这些 CLI 命令压根不构造 orchestrator，
//      更不会走到这里——它们的行为与 v0.4 逐字节一致。
//   L2 `attach()` 先做一次**纯文件系统**的发现；一个 `kind="mcp_client"` 扩展都没有时
//      直接返回空句柄——**一个子进程都不起，连 `ExternalToolRegistry` 都不建**
//      （`registry: undefined` 让 orchestrator 退回裸 `McpToolRunner`）。
//      没装扩展的用户为这条流程付出的全部代价 = 一次 `readdir()`。
//
// **凭据仍然只在 daemon 进程内（AD-2）**：`connectExternalMcp()` 内部走的仍是既有的
// `resolveMcpChildEnv()` → `buildExtensionContext()` 那条唯一通道，本段只是把
// `contextDeps.credentials`（生产上就是 daemon 持有的 `CredentialStore`）原样递下去，
// 没有另开第二条取值路径，也不把任何凭据值放进本段的任何数据结构里。

/** 一个"已安装、已 --trust、mcp.json 合法"的外部 MCP 扩展——可以直接拿去连接。 */
export interface InstalledMcpClient {
  name: string;
  dir: string;
  manifest: ExtensionManifest;
  config: McpClientConfig;
  grant: ExtensionGrant;
}

export interface McpClientDiscovery {
  ready: InstalledMcpClient[];
  /** 是 mcp_client 扩展但这一轮用不了的（manifest 坏了 / 没过 --trust / mcp.json 非法）。 */
  skipped: Array<{ extension: string; dir: string; reason: string }>;
}

/**
 * 扫描扩展根目录，找出可以连接的 `kind="mcp_client"` 扩展。**只读文件系统**：
 * 不启动任何子进程，也不执行任何扩展代码。
 *
 * 两条纪律，都是可被阴性对照钉红的：
 *
 * 1. **先看 manifest 的 kind，再决定要不要 `loadExtension()`**。`loadExtension()` 对
 *    `kind ∈ {skill, platform, backend, rule}` 会 `await import(entry)`——那是**同 UID
 *    的任意代码执行**。"发现有没有外部 MCP 扩展"这个动作绝不能顺手把用户装的别的
 *    扩展全跑一遍（与 `capabilities.ts` 头部"只读端点不该顺手执行代码"同一条纪律）。
 *    所以 kind 判定发生在 `loadExtension()` **之前**，用的是纯数据的 extension.json。
 *
 * 2. **不传 `trust: true`**。TOFU 的确认动作属于用户（`ext add-mcp` / `ext verify --trust`），
 *    agent 运行路径只沿用既有的信任记录。没确认过的 mcp_client 扩展在这里被 skip 并
 *    带上原因，**不会**被 agent 运行这个动作静默地"顺便信任了"——那等于把
 *    「启动任意本地命令」这件事从用户手里挪到模型手里。
 */
export async function discoverInstalledMcpClients(options: ExtensionPathOptions = {}): Promise<McpClientDiscovery> {
  const ready: InstalledMcpClient[] = [];
  const skipped: McpClientDiscovery["skipped"] = [];
  const root = extensionsRoot(options);
  if (!existsSync(root)) return { ready, skipped };

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // 根目录读不动（权限/竞态）不是"agent 跑不了"的理由——当作"没装扩展"。
    return { ready, skipped };
  }

  const grantStore = new ExtensionGrantStore(options);
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue; // .grants.json 之类的杂散文件
    } catch {
      continue;
    }
    const manifestPath = join(dir, "extension.json");
    if (!existsSync(manifestPath)) continue; // 不是一个扩展目录

    let manifest: ExtensionManifest;
    try {
      manifest = loadExtensionManifest(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      const reason = error instanceof ExtensionManifestError ? error.message : String(error);
      skipped.push({ extension: entry, dir, reason: `extension.json 无法解析：${reason}` });
      continue;
    }

    // ⚠️ 纪律 1 的落点：这一行必须在 loadExtension() 之前。
    if (manifest.kind !== "mcp_client") continue;

    // 纪律 2 的落点：没有 trust:true。
    const loaded = await loadExtension(dir, { pathOptions: options });
    if (loaded.status !== "loaded" || !loaded.mcpConfig) {
      skipped.push({ extension: manifest.name, dir, reason: loaded.reason ?? "装载失败（未给出原因）" });
      continue;
    }
    ready.push({ name: manifest.name, dir, manifest, config: loaded.mcpConfig, grant: grantStore.get(manifest.name) });
  }
  return { ready, skipped };
}

/** 生命周期事件——失败隔离要求"跳过它并留下**可见**记录"，这是那条记录的出口。 */
export type ExternalMcpLifecycleEvent =
  | { phase: "discovered"; ready: number; skipped: number }
  | { phase: "skipped"; extension: string; reason: string }
  | { phase: "connected"; extension: string; tools: number }
  | { phase: "failed"; extension: string; reason: string }
  | { phase: "closed"; extension: string };

export interface ExternalMcpRuntimeOptions {
  pathOptions?: ExtensionPathOptions;
  /**
   * 递给 `resolveMcpChildEnv()` 的凭据/工具源。生产上 `credentials` 就是 daemon 持有的
   * `CredentialStore`（AD-2：凭据本体只在 daemon 进程内，这里只是把那一个实例的
   * 引用传下去，没有拷贝任何值，也没有第二条取值路径）。
   */
  contextDeps?: ExtensionContextDeps;
  /** 测试注入：替换"发现"这一步。 */
  discover?: (options: ExtensionPathOptions) => Promise<McpClientDiscovery>;
  /** 测试注入：替换"连接"这一步（默认 `connectExternalMcp`，会真的 spawn 子进程）。 */
  connect?: (options: ConnectExternalMcpOptions) => Promise<ConnectResult>;
  onEvent?: (event: ExternalMcpLifecycleEvent) => void;
}

export class ExternalMcpRuntime implements ExternalMcpProvider {
  private readonly pathOptions: ExtensionPathOptions;
  private readonly contextDeps: ExtensionContextDeps;
  private readonly discover: (options: ExtensionPathOptions) => Promise<McpClientDiscovery>;
  private readonly connect: (options: ConnectExternalMcpOptions) => Promise<ConnectResult>;
  private readonly onEvent?: (event: ExternalMcpLifecycleEvent) => void;

  /** 构造函数**不做任何 I/O**——惰性策略的 L0（见本段顶部注释）。 */
  constructor(options: ExternalMcpRuntimeOptions = {}) {
    this.pathOptions = options.pathOptions ?? {};
    this.contextDeps = options.contextDeps ?? {};
    this.discover = options.discover ?? discoverInstalledMcpClients;
    this.connect = options.connect ?? connectExternalMcp;
    this.onEvent = options.onEvent;
  }

  async attach(options: ExternalMcpAttachOptions = {}): Promise<ExternalMcpAttachment> {
    const discovery = await this.discover(this.pathOptions);
    this.onEvent?.({ phase: "discovered", ready: discovery.ready.length, skipped: discovery.skipped.length });

    const skipped: ExternalMcpAttachFailure[] = discovery.skipped.map((s) => ({ extension: s.extension, reason: s.reason }));
    for (const s of skipped) this.onEvent?.({ phase: "skipped", extension: s.extension, reason: s.reason });

    // 惰性策略 L2：一个 mcp_client 扩展都没有 → 一个子进程都不起，registry 都不建。
    if (discovery.ready.length === 0) {
      return { connected: [], failed: [], skipped, async close() {} };
    }

    const connected: string[] = [];
    const failed: ExternalMcpAttachFailure[] = [];
    const opened: ExternalMcpSession[] = [];

    for (const item of discovery.ready) {
      let result: ConnectResult;
      try {
        result = await this.connect({
          manifest: item.manifest,
          config: item.config,
          grant: item.grant,
          deps: this.contextDeps,
          pathOptions: this.pathOptions,
          // ④ 绑定：V31 在生产里真的生效的那一刻。
          recordSink: options.recordSink,
        });
      } catch (error) {
        // `connectExternalMcp()` 契约上"绝不向上抛"，但"契约上不抛"不等于"永远不抛"
        // （SDK 换版本、`StdioClientTransport` 构造函数自己抛、注入的假件抛…）。
        // 失败隔离是硬要求：这里兜住，记一条，继续下一个扩展——**绝不**让一个坏扩展
        // 把整轮 agent 运行带走。
        failed.push({ extension: item.name, reason: error instanceof Error ? error.message : String(error) });
        this.onEvent?.({ phase: "failed", extension: item.name, reason: failed[failed.length - 1]!.reason });
        continue;
      }
      if (!result.ok || !result.session) {
        failed.push({ extension: item.name, reason: result.reason ?? "连接失败（未给出原因）" });
        this.onEvent?.({ phase: "failed", extension: item.name, reason: failed[failed.length - 1]!.reason });
        continue;
      }
      opened.push(result.session);
      connected.push(item.name);
      this.onEvent?.({ phase: "connected", extension: item.name, tools: result.session.tools.length });
    }

    // 全都连不上：同样退回"没有外部工具"的形态（registry undefined），而不是给一张空表。
    if (opened.length === 0) {
      return { connected, failed, skipped, async close() {} };
    }

    // **每次 attach 一张新表**，不是全局共用一张。这不是风格选择，是正确性：
    // `ExternalToolRegistry` 按扩展名索引 session，而一个 `OrchestratorAgent` 实例在
    // HTTP 服务下会被多个 session（分属不同 project）并发使用。共用一张表的话，
    // 后一轮 register 同名扩展会顶掉前一轮的 session，前一轮收尾时又会把后一轮的
    // 条目摘掉；更糟的是 `recordSink` 是**连接时**绑定的，共用 session 等于把 B 项目
    // 的外部工具调用记进 A 项目的证据图。一轮一张表 + 一轮一组子进程，没有共享可变
    // 状态，代价是"真装了外部扩展的用户，每轮 agent 运行多起一次子进程"——
    // 这个代价只有装了扩展的人付，没装的人连这段都走不到（上面的 L2 早就返回了）。
    const registry = new ExternalToolRegistry();
    for (const session of opened) registry.register(session);

    let closed = false;
    const onEvent = this.onEvent;
    return {
      registry,
      connected,
      failed,
      skipped,
      async close() {
        if (closed) return; // 幂等：finally 里关一次、调用方再关一次都不会重复 close 子进程
        closed = true;
        for (const session of opened) {
          registry.unregister(session.extensionName);
          try {
            await session.close();
          } catch {
            // 关不掉也不能让收尾抛异常——那会把一个已经跑完的 agent run 变成失败。
          }
          onEvent?.({ phase: "closed", extension: session.extensionName });
        }
      },
    };
  }
}
