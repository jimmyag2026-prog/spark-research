import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 凭据分层原则（DESIGN §2.3 / AD-2）：
// 凭据只在 daemon 进程内，落盘 ~/.spark-research/credentials.json（0600）。
// 凭据本体永不进 env / prompt / 日志 / 错误消息；kernel 只能通过 permit set
// 授权的 daemon 方法拿到「是否已配置」这类元数据，拿不到值本身。

export const CREDENTIALS_FILE = "credentials.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface CredentialMeta {
  connectorId: string;
  // 只有字段名，永远不含字段值。
  keys: string[];
  updatedAt: string;
}

export interface CredentialFilePermission {
  ok: boolean;
  mode: string;
  path: string;
  warning?: string;
}

interface CredentialEntry {
  values: Record<string, string>;
  updatedAt: string;
}

interface CredentialFile {
  version: number;
  connectors: Record<string, CredentialEntry>;
}

export interface CredentialStoreOptions {
  // 根目录（测试注入 mkdtemp 目录），默认 ~/.spark-research
  root?: string;
  // 直接指定文件路径时优先于 root
  path?: string;
  // 权限告警出口，默认 console.warn；注入便于单测断言。
  warn?: (message: string) => void;
}

function emptyFile(): CredentialFile {
  return { version: 1, connectors: {} };
}

export class CredentialStore {
  readonly path: string;
  private warn: (message: string) => void;

  constructor(options: CredentialStoreOptions = {}) {
    const root = options.root ?? process.env.SPARK_RESEARCH_DATA_DIR ?? join(homedir(), ".spark-research");
    this.path = options.path ?? join(root, CREDENTIALS_FILE);
    this.warn = options.warn ?? ((msg) => console.warn(msg));
  }

  // 文件权限体检：宽于 0600 时告警（不阻断，避免把用户锁在门外）。
  checkPermissions(): CredentialFilePermission {
    if (!existsSync(this.path)) {
      return { ok: true, mode: "-", path: this.path };
    }
    const mode = statSync(this.path).mode & 0o777;
    const modeStr = mode.toString(8).padStart(3, "0");
    if ((mode & 0o077) === 0) return { ok: true, mode: modeStr, path: this.path };
    return {
      ok: false,
      mode: modeStr,
      path: this.path,
      warning: `凭据文件权限过宽（${modeStr}）：${this.path}，请执行 chmod 600 收紧`,
    };
  }

  has(connectorId: string): boolean {
    return this.read().connectors[connectorId] !== undefined;
  }

  // 返回凭据本体，仅供 daemon 进程内的 connector 使用，绝不外发。
  get(connectorId: string): Record<string, string> | null {
    const entry = this.read().connectors[connectorId];
    return entry ? { ...entry.values } : null;
  }

  // 元数据视图：只有 connector id、字段名与时间戳，可以安全地返回给 kernel / CLI。
  describe(connectorId: string): CredentialMeta | null {
    const entry = this.read().connectors[connectorId];
    if (!entry) return null;
    return { connectorId, keys: Object.keys(entry.values).sort(), updatedAt: entry.updatedAt };
  }

  list(): CredentialMeta[] {
    const file = this.read();
    return Object.keys(file.connectors)
      .sort()
      .map((id) => ({
        connectorId: id,
        keys: Object.keys(file.connectors[id]!.values).sort(),
        updatedAt: file.connectors[id]!.updatedAt,
      }));
  }

  set(connectorId: string, values: Record<string, string>): CredentialMeta {
    if (!connectorId.trim()) throw new Error("CredentialStore: connectorId 不能为空");
    const file = this.read();
    file.connectors[connectorId] = { values: { ...values }, updatedAt: new Date().toISOString() };
    this.write(file);
    return this.describe(connectorId)!;
  }

  remove(connectorId: string): boolean {
    const file = this.read();
    if (!file.connectors[connectorId]) return false;
    delete file.connectors[connectorId];
    this.write(file);
    return true;
  }

  // 序列化时只暴露路径与 connector id，防止 console.log(store) 泄密。
  toJSON(): { path: string; connectors: string[] } {
    return { path: this.path, connectors: this.list().map((c) => c.connectorId) };
  }

  private read(): CredentialFile {
    if (!existsSync(this.path)) return emptyFile();
    const perm = this.checkPermissions();
    if (!perm.ok && perm.warning) this.warn(perm.warning);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CredentialFile>;
      return { version: parsed.version ?? 1, connectors: parsed.connectors ?? {} };
    } catch {
      // 解析失败时不要把文件内容带进错误消息（里面就是凭据）。
      throw new Error(`CredentialStore: 凭据文件解析失败（${this.path}），请检查 JSON 格式`);
    }
  }

  private write(file: CredentialFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // writeFileSync 的 mode 只在创建时生效，已存在的文件要显式 chmod。
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n", { mode: FILE_MODE });
    chmodSync(this.path, FILE_MODE);
  }
}

// daemon 暴露给 kernel 的 `credentials` 方法的返回体：只有元数据，没有值。
export interface CredentialStatus {
  ok: boolean;
  connector: string | null;
  configured: boolean;
  keys: string[];
  connectors?: string[];
  scopes?: unknown;
  note: string;
}

export const CREDENTIALS_NOTE =
  "credential values never leave the daemon; use mcp_call to have the daemon access the source on your behalf";

export function credentialStatus(store: CredentialStore, args: any): CredentialStatus {
  const connector = typeof args?.connector === "string" ? args.connector : null;
  if (!connector) {
    return {
      ok: true,
      connector: null,
      configured: false,
      keys: [],
      connectors: store.list().map((c) => c.connectorId),
      scopes: args?.scopes ?? [],
      note: CREDENTIALS_NOTE,
    };
  }
  const meta = store.describe(connector);
  return {
    ok: true,
    connector,
    configured: meta !== null,
    keys: meta?.keys ?? [],
    scopes: args?.scopes ?? [],
    note: CREDENTIALS_NOTE,
  };
}
