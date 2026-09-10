// W2-c · 扩展装载器——任务书的核心交付物。
//
// 三种装载强度落地：
//   kind="connector"                → 直接复用 W1-c 的 loadManifestFromJson，不执行代码。
//   kind∈{skill,platform,backend,rule} → 需要 --trust（fingerprint.ts），
//                                        通过后 dynamic import 扩展的 entry 文件。
//
// 安全边界（恶意矩阵的落点，逐条标注）：
//   ① manifest 声明 A 却调 B 工具        → context.ts 的 buildExtensionContext 结构性拒绝
//   ② 未 grant 却取凭据                 → 同上
//   ③ 声明式 connector 塞 file:// / 内网 → loadManifestFromJson 内部的 assertOutboundUrlAllowed 拒绝
//   ④ 扩展抛异常                       → 本文件的 try/catch，主进程不受影响，返回 status:"failed"
//   ⑤ 未过 ext verify 装载时警告         → verify_cache.ts 的缓存比对

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { loadExtensionManifest, ExtensionManifestError, type ExtensionKind, type ExtensionManifest } from "./types";
import { loadManifestFromJson, ManifestError } from "../connectors/manifest";
import type { HttpConnector, ConnectorOptions } from "../connectors/base";
import { checkTrust, sha256File } from "./fingerprint";
import { ExtensionGrantStore } from "./grants";
import { buildExtensionContext, type ExtensionContext, type ExtensionContextDeps } from "./context";
import { readVerifyCache, subjectPathFor } from "./verify_cache";
import type { ExtensionPathOptions } from "./paths";

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

  // ── 强度②：TS 扩展（skill / platform / backend / rule）── 同 UID 代码执行 ──
  const entryPath = join(extensionDir, manifest.entry ?? "index.ts");
  try {
    if (!existsSync(entryPath)) {
      return failure(manifest.name, manifest.kind, `找不到入口文件 ${entryPath}`, warnings);
    }

    const trust = checkTrust(manifest.name, entryPath, Boolean(options.trust), options.pathOptions);
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
