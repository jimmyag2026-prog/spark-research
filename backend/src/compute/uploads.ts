// C1 · 上传面（CB-3，设计 §1.1.7）。
//
// 纯函数 + 只读 fs。这一层唯一的工作是回答「哪些文件会离开这台机器」，
// 并且在**派发前再回答一次**（preflight）——审批看到的那份清单，和真正上传的那份，
// 必须逐字节是同一份，否则就是 input_changed。
//
// fail-closed：显式请求命中 deny-list **抛错**，不静默跳过。
// 「静默跳过」是这类面最危险的失败模式：人以为 .env 被上传了所以没排查，
// 或者以为没被上传结果传了。两种误解都比一次显式失败贵。

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { UploadEntry } from "./plan";

export const UPLOAD_COUNT_LIMIT = 200;
export const UPLOAD_BYTES_LIMIT = 256 * 1024 * 1024; // 256 MiB

/** 目录名一律拒（无论出现在路径哪一段）。 */
export const DENY_DIRS: readonly string[] = [
  ".git",
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".docker",
  ".config",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".terraform",
  ".vagrant",
];

/** 相对路径整体匹配（POSIX 分隔符）。 */
export const DENY_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.config\/(gcloud|gh|op)(\/|$)/,
  /(^|\/)\.local\/share\/keyrings(\/|$)/,
];

/** 文件名匹配。 */
export const DENY_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\..*)/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^.*\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.htpasswd$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];

export class UploadDeniedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`拒绝上传 '${path}'：${reason}`);
    this.name = "UploadDeniedError";
  }
}

export class UploadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadLimitError";
  }
}

/** 派发前重验发现「审批的那份 ≠ 现在这份」。上游 adapter.ts 的 `input_changed` 同构。 */
export class UploadChangedError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`上传文件 '${path}' 在审批之后变了：${detail}——必须重新 plan → approve`);
    this.name = "UploadChangedError";
  }
}

export interface SkippedUpload {
  path: string;
  reason: "gitignore" | "deny_dir" | "empty_dir";
}

export interface UploadScanResult {
  entries: UploadEntry[];
  skipped: SkippedUpload[];
  totalBytes: number;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function denyReason(relPath: string): string | null {
  const segments = relPath.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (DENY_DIRS.includes(seg)) return `路径经过 deny-list 目录 '${seg}'`;
  }
  const last = segments[segments.length - 1]!;
  if (DENY_DIRS.includes(last)) return `deny-list 目录 '${last}'`;
  for (const pattern of DENY_PATH_PATTERNS) {
    if (pattern.test(relPath)) return `路径命中 deny-list 模式 ${pattern}`;
  }
  for (const pattern of DENY_FILE_PATTERNS) {
    if (pattern.test(last)) return `文件名命中密钥模式 ${pattern}`;
  }
  return null;
}

function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

// ── gitignore 感知 ──────────────────────────────────────────────────────
//
// 优先 `git check-ignore --no-index`（一次批量，权威口径）；仓库不是 git 或 git 不在
// 就回退到自解析 `.gitignore` + `.git/info/exclude` 的一个**保守子集**。
// 回退版故意只认「目录名 / 文件名 / *.ext」三种最常见形态——认不出的一律当作没忽略
// （宁可多传一个 build 产物，也不要因为一条没实现的否定规则漏掉真正要传的输入）。

export interface GitignoreFilter {
  ignores(relPath: string): boolean;
  source: "git" | "parsed" | "none";
}

export function makeGitignoreFilter(workspaceRoot: string, candidates: string[]): GitignoreFilter {
  if (candidates.length === 0) return { ignores: () => false, source: "none" };
  if (existsSync(join(workspaceRoot, ".git"))) {
    try {
      const proc = Bun.spawnSync(["git", "check-ignore", "--no-index", "--stdin"], {
        cwd: workspaceRoot,
        stdin: Buffer.from(`${candidates.join("\n")}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      // exit 0 = 有命中，1 = 没有命中，其它 = git 出错（回退）。
      if (proc.exitCode === 0 || proc.exitCode === 1) {
        const ignored = new Set(
          new TextDecoder().decode(proc.stdout).split("\n").map((l) => l.trim()).filter(Boolean),
        );
        return { ignores: (p) => ignored.has(p), source: "git" };
      }
    } catch {
      /* git 不可用 → 回退 */
    }
  }
  const patterns: string[] = [];
  for (const file of [join(workspaceRoot, ".gitignore"), join(workspaceRoot, ".git/info/exclude")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      patterns.push(trimmed.replace(/\/+$/, "").replace(/^\/+/, ""));
    }
  }
  if (patterns.length === 0) return { ignores: () => false, source: "none" };
  return {
    source: "parsed",
    ignores(relPath: string): boolean {
      const segments = relPath.split("/");
      for (const pattern of patterns) {
        if (pattern.startsWith("*.")) {
          const ext = pattern.slice(1);
          if (segments[segments.length - 1]!.endsWith(ext)) return true;
          continue;
        }
        if (pattern.includes("/")) {
          if (relPath === pattern || relPath.startsWith(`${pattern}/`)) return true;
          continue;
        }
        if (segments.includes(pattern)) return true;
      }
      return false;
    },
  };
}

/**
 * v0.8 G-1（V100）：HTTP/MCP 调用方给的 `workspaceRoot` 必须落在 `base`（项目目录）之内——
 * 省略即项目目录；相对路径按项目目录解析；绝对路径只接受本来就在项目目录内的。
 * 此前 HTTP 面接受任意绝对路径：未鉴权的本机调用可以让 server 对 `/etc`、`~` 做全量读盘 + sha256
 * 兼目录枚举。CLI 不走这一层——用户在自己机器上显式点名路径是另一回事。
 */
export function constrainWorkspaceRoot(requested: string | undefined | null, base: string): string {
  const baseReal = realpathSync(base);
  if (requested === undefined || requested === null || requested.trim() === "") return baseReal;
  const abs = isAbsolute(requested) ? requested : resolve(baseReal, requested);
  if (!existsSync(abs)) throw new UploadDeniedError(requested, "workspaceRoot 不存在");
  const real = realpathSync(abs);
  const rel = toPosix(relative(baseReal, real));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UploadDeniedError(requested, `workspaceRoot 必须在项目目录之内（${baseReal}）——HTTP/MCP 面不接受项目外路径`);
  }
  return real;
}

function resolveInside(workspaceRoot: string, requested: string): { abs: string; rel: string } {
  if (isAbsolute(requested)) {
    throw new UploadDeniedError(requested, "只接受工作区内的相对路径");
  }
  const rootReal = realpathSync(workspaceRoot);
  const abs = resolve(rootReal, normalize(requested));
  const rel = toPosix(relative(rootReal, abs));
  if (rel === "" || rel.startsWith("..")) {
    throw new UploadDeniedError(requested, "路径逃出了工作区");
  }
  return { abs, rel };
}

function assertNoSymlink(abs: string, rel: string): void {
  // symlink 一律不跟（穿过即拒）：跟随符号链接是把 deny-list 绕过去的标准做法。
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink()) {
    throw new UploadDeniedError(rel, "是符号链接——上传面一律不跟随符号链接");
  }
}

/**
 * 把「用户点名的路径」变成「会离开这台机器的文件清单」。
 *
 * · 显式请求命中 deny-list → 抛 UploadDeniedError（fail-closed）
 * · 目录递归展开时命中 deny-list / gitignore → 跳过并记进 skipped（可见，不静默）
 * · 双限额超出 → 抛 UploadLimitError
 */
export function collectUploads(
  workspaceRoot: string,
  requested: string[],
  limits: { count: number; bytes: number } = { count: UPLOAD_COUNT_LIMIT, bytes: UPLOAD_BYTES_LIMIT },
): UploadScanResult {
  if (!existsSync(workspaceRoot)) {
    throw new UploadDeniedError(workspaceRoot, "工作区目录不存在");
  }
  const entries: UploadEntry[] = [];
  const skipped: SkippedUpload[] = [];
  const seen = new Set<string>();
  const filesToHash: Array<{ abs: string; rel: string }> = [];
  const walkedCandidates: string[] = [];

  const walk = (abs: string, rel: string, explicit: boolean): void => {
    assertNoSymlink(abs, rel);
    const reason = denyReason(rel);
    if (reason) {
      if (explicit) throw new UploadDeniedError(rel, reason);
      skipped.push({ path: rel, reason: "deny_dir" });
      return;
    }
    const stat = lstatSync(abs);
    if (stat.isDirectory()) {
      const children = readdirSync(abs).sort();
      if (children.length === 0 && explicit) skipped.push({ path: rel, reason: "empty_dir" });
      for (const child of children) walk(join(abs, child), `${rel}/${child}`, false);
      return;
    }
    if (!stat.isFile()) {
      if (explicit) throw new UploadDeniedError(rel, "既不是普通文件也不是目录");
      return;
    }
    if (seen.has(rel)) return;
    seen.add(rel);
    filesToHash.push({ abs, rel });
    walkedCandidates.push(rel);
  };

  for (const req of requested) {
    const { abs, rel } = resolveInside(workspaceRoot, req);
    if (!existsSync(abs)) throw new UploadDeniedError(rel, "文件不存在");
    walk(abs, rel, true);
  }

  // gitignore 只在**递归展开**出来的文件上生效：显式点名的单个文件即便被 git 忽略
  // 也照传（数据文件常在 .gitignore 里，那不是密钥问题；密钥由 deny-list 硬拦）。
  const explicitRels = new Set(
    requested.map((r) => resolveInside(workspaceRoot, r).rel),
  );
  const filter = makeGitignoreFilter(workspaceRoot, walkedCandidates);
  // v0.8 G-1（V100）：限额检查**先于读盘哈希**——此前先把整棵目录树读完算 sha256 再看限额，
  // 一个越界的上传请求等于让本机对任意大目录做全量读盘。先 lstat 拿 size，超限就停。
  const toHash: Array<{ abs: string; rel: string; size: number }> = [];
  for (const { abs, rel } of filesToHash) {
    if (!explicitRels.has(rel) && filter.ignores(rel)) {
      skipped.push({ path: rel, reason: "gitignore" });
      continue;
    }
    toHash.push({ abs, rel, size: lstatSync(abs).size });
  }
  const totalBytes = toHash.reduce((sum, e) => sum + e.size, 0);
  if (toHash.length > limits.count) {
    throw new UploadLimitError(
      `上传文件数 ${toHash.length} 超过上限 ${limits.count}——请缩小 --upload 范围（大目录别整个传）`,
    );
  }
  if (totalBytes > limits.bytes) {
    throw new UploadLimitError(
      `上传总字节 ${totalBytes} 超过上限 ${limits.bytes}（${(limits.bytes / 1024 / 1024).toFixed(0)} MiB）`,
    );
  }
  for (const { abs, rel, size } of toHash) entries.push({ path: rel, size, sha256: sha256File(abs) });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, skipped, totalBytes };
}

/**
 * 派发前逐文件重验：canonical 路径、size、sha256。任一不符 → UploadChangedError。
 *
 * **这是审批语义的一部分**，不是可选的性能优化：审批面上人看到的是这份清单的内容，
 * 内容变了就等于批的不是这件事。
 */
export function preflight(workspaceRoot: string, entries: readonly UploadEntry[]): void {
  for (const entry of entries) {
    const { abs, rel } = resolveInside(workspaceRoot, entry.path);
    if (rel !== entry.path) {
      throw new UploadChangedError(entry.path, `规范化后是 '${rel}'`);
    }
    if (!existsSync(abs)) {
      throw new UploadChangedError(entry.path, "文件已不存在");
    }
    assertNoSymlink(abs, rel);
    const stat = lstatSync(abs);
    if (!stat.isFile()) {
      throw new UploadChangedError(entry.path, "已不是普通文件");
    }
    if (stat.size !== entry.size) {
      throw new UploadChangedError(entry.path, `size ${entry.size} → ${stat.size}`);
    }
    const digest = sha256File(abs);
    if (digest !== entry.sha256) {
      throw new UploadChangedError(
        entry.path,
        `sha256 ${entry.sha256.slice(0, 12)} → ${digest.slice(0, 12)}（大小没变但内容变了）`,
      );
    }
  }
}
