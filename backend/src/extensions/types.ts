// W2-c（v0.4 P17 X-a）· 扩展 manifest（extension.json）schema + 校验。
//
// 三种装载强度（方案 §4.5 补 + 任务书表格）：
//   ① kind === "connector"：旁边一个 connector.json，走 W1-c 的声明式 manifest 编译器
//      （backend/src/connectors/manifest.ts，本文件**只读复用**，不重造）。不执行任意代码。
//   ② kind ∈ {skill, platform, backend, rule}：旁边一个 index.ts，同 UID 代码执行——
//      装载需要显式 `--trust`（见 fingerprint.ts）。
//   ③ kind === "mcp_client"：旁边一个 mcp.json（数据：command/args/env 白名单/凭据映射），
//      装载器不执行任意 TS 代码，但会启动一个**外部进程**并用 stdio 跟它说 MCP 协议
//      （backend/src/extensions/mcp_client.ts，W4-d 交付）。风险面不比②低——"启动任意
//      command"本身就是本地任意命令执行——所以同样需要 `--trust`（指纹覆盖 mcp.json，
//      而不是某个 TS 入口文件）。
//
// extension.json 本身不执行代码、不发网络请求——只是数据，装载器读它来决定走哪条路。

export type ExtensionKind = "connector" | "skill" | "platform" | "backend" | "rule" | "mcp_client";

export const EXTENSION_KINDS: readonly ExtensionKind[] = ["connector", "skill", "platform", "backend", "rule", "mcp_client"];

// 扩展声明「它想访问什么」——**声明不等于拿到**，用户还要显式 `ext grant` 批准
// （见 grants.ts）。这是任务书安全边界的第一句话：「扩展默认拿不到任何凭据 /
// ToolBus grants」，manifest 只是「它想要什么」的申报单。
export interface ExtensionRequires {
  // 想访问的 connector 凭据（CredentialStore 的 connectorId），如 ["paidsource"]。
  credentials?: string[];
  // 想调用的 ToolBus 工具名（同 MCP_TOOLS 的 name 空间）。
  tools?: string[];
}

export interface ExtensionManifest {
  kind: ExtensionKind;
  // 扩展名，kebab-case，必须与目录名一致（同 SKILL.md 的纪律）。
  name: string;
  // semver 风格版本号（不强制真 semver 校验，只要求非空且看起来像版本号）。
  version: string;
  description: string;
  // kind !== "connector" 时使用：TS 入口文件，相对扩展目录，缺省 "index.ts"。
  entry?: string;
  requires?: ExtensionRequires;
}

export class ExtensionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionManifestError";
  }
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
// 宽松版本号：至少一段数字，允许 "0.1.0" / "1" / "0.1.0-alpha" 这类写法。
const VERSION_RE = /^\d+(\.\d+){0,2}(-[a-zA-Z0-9.]+)?$/;

export function validateExtensionManifest(raw: unknown): ExtensionManifest {
  if (!raw || typeof raw !== "object") {
    throw new ExtensionManifestError("extension.json 不是一个对象");
  }
  const m = raw as Partial<ExtensionManifest>;
  if (!m.kind || !EXTENSION_KINDS.includes(m.kind)) {
    throw new ExtensionManifestError(
      `extension.json 的 kind 非法："${String(m.kind)}"（只支持 ${EXTENSION_KINDS.join(" / ")}）`,
    );
  }
  if (!m.name || !NAME_RE.test(m.name)) {
    throw new ExtensionManifestError(`extension.json 的 name 非法（要求 /^[a-z][a-z0-9-]*$/）："${String(m.name)}"`);
  }
  if (!m.version || typeof m.version !== "string" || !VERSION_RE.test(m.version)) {
    throw new ExtensionManifestError(`extension.json 的 version 非法："${String(m.version)}"`);
  }
  if (!m.description || typeof m.description !== "string") {
    throw new ExtensionManifestError(`extension.json 缺少 description`);
  }
  if (m.kind !== "connector") {
    if (m.entry !== undefined && typeof m.entry !== "string") {
      throw new ExtensionManifestError(`extension.json 的 entry 必须是字符串`);
    }
  }
  const requires = m.requires ?? {};
  if (requires.credentials !== undefined) {
    if (!Array.isArray(requires.credentials) || requires.credentials.some((s) => typeof s !== "string")) {
      throw new ExtensionManifestError(`extension.json 的 requires.credentials 必须是字符串数组`);
    }
  }
  if (requires.tools !== undefined) {
    if (!Array.isArray(requires.tools) || requires.tools.some((s) => typeof s !== "string")) {
      throw new ExtensionManifestError(`extension.json 的 requires.tools 必须是字符串数组`);
    }
  }
  return {
    kind: m.kind,
    name: m.name,
    version: m.version,
    description: m.description,
    entry: m.entry,
    requires: {
      credentials: requires.credentials ? [...requires.credentials] : [],
      tools: requires.tools ? [...requires.tools] : [],
    },
  };
}

export function loadExtensionManifest(json: string): ExtensionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ExtensionManifestError(`extension.json 解析失败：${(error as Error).message}`);
  }
  return validateExtensionManifest(parsed);
}

// TS 代码执行强度（②）覆盖的 kind 集合——这些需要 --trust。
// mcp_client（③）同样需要 --trust：启动任意 command 的风险面不比同 UID 执行 TS
// 代码更小，见文件头注释。
export function requiresTrust(kind: ExtensionKind): boolean {
  return kind !== "connector";
}
