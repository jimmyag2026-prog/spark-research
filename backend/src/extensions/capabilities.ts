// W2-c · 扩展的能力自描述。
//
// **这个文件不在 `backend/src/capabilities/**` 目录下**——任务书明确写了
// "backend/src/capabilities/** 不在你的所有权内（多个 lane 争用，收口统一接线）"。
// 这里导出的 `listExtensionCapabilities()` 是一个可被那个文件调用的纯函数，
// 接线方式写在 docs/devlog/W2-c.md 的"给主会话的 capabilities 接线说明"一节，
// 不在本文件里擅自 import/改 capabilities/index.ts。
//
// 刻意**不**在这里执行任何扩展代码：TS 扩展需要 --trust 才能装载（同 UID 代码
// 执行），而 `capabilities --json` 是一个会被外部 agent 频繁、无副作用地调用的
// 只读端点——如果它顺手把每个扩展的 index.ts 都 import 一遍，"查看能力清单"
// 这个动作本身就变成了一个隐蔽的代码执行入口，直接违反 --trust 的设计意图。
// 所以这里只读 manifest（数据），不读 connector.json 之外的任何代码文件，
// 状态判定只用"静态可推导的信息"（manifest 内容 + 授权记录 + 上次 ext verify
// 的缓存结论），对应主 capabilities/index.ts 里"静态可用性 vs 探测可用性"的同一
// 纪律（见该文件头部注释）。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionManifest, type ExtensionKind } from "./types";
import { ExtensionGrantStore } from "./grants";
import { readVerifyCache, subjectPathFor } from "./verify_cache";
import { sha256File } from "./fingerprint";
import { extensionsRoot, type ExtensionPathOptions } from "./paths";

export type ExtensionCapabilityStatus = "available" | "needs_grant" | "unverified" | "stale_verify" | "failed";

export interface ExtensionCapability {
  name: string;
  kind: ExtensionKind | null;
  version: string | null;
  description: string | null;
  status: ExtensionCapabilityStatus;
  reason: string | null;
  requires: { credentials: string[]; tools: string[] };
  granted: { credentials: string[]; tools: string[] };
}

export async function listExtensionCapabilities(options: ExtensionPathOptions = {}): Promise<ExtensionCapability[]> {
  const root = extensionsRoot(options);
  if (!existsSync(root)) return [];

  const grantStore = new ExtensionGrantStore(options);
  const out: ExtensionCapability[] = [];

  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue; // 跳过 .grants.json 之类的杂散文件
    const manifestPath = join(dir, "extension.json");
    if (!existsSync(manifestPath)) continue; // 不是一个扩展目录

    try {
      const manifest = loadExtensionManifest(readFileSync(manifestPath, "utf8"));
      const grant = grantStore.get(manifest.name);
      const requiresCredentials = manifest.requires?.credentials ?? [];
      const requiresTools = manifest.requires?.tools ?? [];
      const needsGrant =
        requiresCredentials.some((id) => !grant.credentials.includes(id)) ||
        requiresTools.some((t) => !grant.tools.includes(t));

      let status: ExtensionCapabilityStatus;
      let reason: string | null = null;
      const cache = readVerifyCache(dir);
      const subjectPath = subjectPathFor(dir, manifest);
      if (needsGrant) {
        status = "needs_grant";
        reason = "manifest 声明了 requires.credentials/tools，但尚未被 `ext grant` 全部授权——扩展装载后这部分访问会被拒绝";
      } else if (!cache) {
        status = "unverified";
        reason = "从未跑过 `ext verify`";
      } else if (!existsSync(subjectPath) || sha256File(subjectPath) !== cache.subjectSha256) {
        status = "stale_verify";
        reason = "内容自上次 `ext verify` 后已变化，结论已过期";
      } else if (!cache.ok) {
        status = "failed";
        reason = "上一次 `ext verify` 未通过";
      } else {
        status = "available";
      }

      out.push({
        name: manifest.name,
        kind: manifest.kind,
        version: manifest.version,
        description: manifest.description,
        status,
        reason,
        requires: { credentials: requiresCredentials, tools: requiresTools },
        granted: { credentials: grant.credentials, tools: grant.tools },
      });
    } catch (error) {
      // manifest 本身就坏了（恶意/损坏的 extension.json）——照样要出现在清单里，
      // 标 failed + 原因，而不是让一个坏扩展的解析异常打断整个 capabilities 请求
      // （对称于主 capabilities/index.ts 的纪律：一个坏 connector 不该拖垮整份清单）。
      out.push({
        name: entry,
        kind: null,
        version: null,
        description: null,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        requires: { credentials: [], tools: [] },
        granted: { credentials: [], tools: [] },
      });
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
