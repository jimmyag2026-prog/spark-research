// W2-c · TS 扩展（装载强度②：skill/platform/backend/rule）的信任指纹。
//
// 安全边界（如实记录，见任务书「不要重蹈评审 S-3」）：这**不是沙箱**。TS 扩展与
// 宿主进程同 UID、同权限跑同一个 V8 实例——`--trust` 挡不住"信任了之后代码干什么"，
// 它挡的是**未经确认的静默执行**：首次装载必须先看到 sha256 指纹再显式确认，
// 且指纹一旦变化（文件被换过内容）就要求重新确认，不能"信任过一次就永久免检"。
//
// 「manifest 记指纹」的实现选择：没有直接改写用户的 extension.json——那是用户手写/
// 版本控制的文件，装载器静默重写它风险面比价值大（格式被打乱、与用户的 git diff
// 撞车）。改成同目录下的旁路文件 `.trust.json`，语义等价（指纹与这个扩展的身份
// 绑定、随扩展目录一起存在），但不触碰用户自己维护的文件。

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trustFilePath, type ExtensionPathOptions } from "./paths";

export interface TrustRecord {
  sha256: string;
  trustedAt: string;
  /**
   * v0.8 G-2（V101）：指纹口径。`dir-manifest-v1` = 扩展目录清单哈希（每个文件的相对路径 + 内容
   * sha256，排序后再 sha256，跳过 node_modules/.git/隐藏文件）；`file` = 单文件（mcp_client 的
   * mcp.json 仍用它）。旧记录没有这个字段 = 入口单文件时代的指纹，一律视为「已变化」要求重新 --trust。
   */
  scheme?: "file" | "dir-manifest-v1";
}

export type FingerprintTarget = { kind: "file"; path: string } | { kind: "dir"; path: string };

export interface TrustCheck {
  trusted: boolean;
  sha256: string;
  // 首次信任（之前没有任何记录）。
  firstTime: boolean;
  // 指纹与上次记录的不同（文件内容变了，即使之前信任过也要重新确认）。
  changed: boolean;
  // 面向人类的消息：未信任时解释怎么做，已信任时说明记了什么。
  message: string;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** 目录清单：相对路径排序 + 每个文件的 sha256。改任何一个 helper 文件都会变（V101 的 TOFU 绕过点）。 */
export function dirManifest(dir: string): Array<{ path: string; sha256: string }> {
  const out: Array<{ path: string; sha256: string }> = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(abs, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue; // 不跟随符号链接：链接目标在目录外，不算这个扩展的一部分
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) out.push({ path: r, sha256: sha256File(full) });
    }
  };
  walk(dir, "");
  return out;
}

export function sha256Dir(dir: string): string {
  const lines = dirManifest(dir).map((f) => `${f.path}\t${f.sha256}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function fingerprintOf(target: FingerprintTarget): { sha256: string; scheme: TrustRecord["scheme"] } {
  return target.kind === "dir"
    ? { sha256: sha256Dir(target.path), scheme: "dir-manifest-v1" }
    : { sha256: sha256File(target.path), scheme: "file" };
}

function readTrustRecord(name: string, options: ExtensionPathOptions): TrustRecord | null {
  const path = trustFilePath(name, options);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TrustRecord;
  } catch {
    return null;
  }
}

function writeTrustRecord(name: string, record: TrustRecord, options: ExtensionPathOptions): void {
  const path = trustFilePath(name, options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

// entryPath：扩展的 TS 入口文件绝对路径。指纹只覆盖这一个文件（不是整个目录）——
// 与「首次打印 sha256 指纹」的措辞对应，多文件扩展的其余文件不在本轮指纹范围内，
// 这是一个已知的覆盖面限制（如实记录在 docs/devlog/W2-c.md）。
//
// 信任模型是 TOFU（trust-on-first-use，同 SSH known_hosts）：
//   没有记录 + 没给 --trust     → 拒绝，打印指纹，要求重跑并加 --trust
//   没有记录 + 给了 --trust     → 记指纹，放行（"首次...要求确认"落地）
//   有记录 + 指纹没变           → 放行，不需要每次都重复 --trust
//   有记录 + 指纹变了 + 没给 --trust → 拒绝（内容换过必须重新确认，不能"信任一次永久生效"）
//   有记录 + 指纹变了 + 给了 --trust  → 记新指纹，放行
// 这是「manifest 记指纹」这句话唯一讲得通的实现：如果指纹从不被用来跳过重复确认，
// 持久化它就没有意义，退化成一个从不被读的审计日志。
export function checkTrust(
  name: string,
  target: string | FingerprintTarget,
  requestTrust: boolean,
  options: ExtensionPathOptions = {},
): TrustCheck {
  const t: FingerprintTarget = typeof target === "string" ? { kind: "file", path: target } : target;
  const { sha256, scheme } = fingerprintOf(t);
  const prior = readTrustRecord(name, options);
  const firstTime = prior === null;
  // 口径不同（旧的入口单文件指纹 vs 目录清单）也算「已变化」——不能拿旧指纹给新口径背书。
  const changed = prior !== null && (prior.sha256 !== sha256 || (prior.scheme ?? "file") !== scheme);
  const needsConfirmation = firstTime || changed;

  if (needsConfirmation && !requestTrust) {
    return {
      trusted: false,
      sha256,
      firstTime,
      changed,
      message:
        `扩展 "${name}"（kind 需要代码执行）${changed ? "内容已变化，需要重新确认" : "尚未信任"}，拒绝装载。\n` +
        `${t.kind === "dir" ? "目录清单指纹" : "文件指纹"}：sha256:${sha256}\n` +
        `确认这段代码可信后，重新执行并加上 --trust。`,
    };
  }

  if (needsConfirmation) {
    writeTrustRecord(name, { sha256, trustedAt: new Date().toISOString(), scheme }, options);
    return {
      trusted: true,
      sha256,
      firstTime,
      changed,
      message: changed
        ? `扩展 "${name}" 内容已变化（旧指纹 ${prior!.sha256.slice(0, 12)}… → 新指纹 ${sha256.slice(0, 12)}…），已记录新的信任指纹。`
        : `扩展 "${name}" 信任指纹已记录：sha256:${sha256}`,
    };
  }

  // 已有记录且指纹未变：TOFU 生效，不需要重复 --trust。
  return {
    trusted: true,
    sha256,
    firstTime: false,
    changed: false,
    message: `扩展 "${name}" 沿用既有信任记录（sha256:${sha256.slice(0, 12)}…，未变化）。`,
  };
}
