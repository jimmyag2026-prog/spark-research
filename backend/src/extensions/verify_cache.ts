// W2-c · `ext verify` 的结果缓存——恶意矩阵⑤（"未过 ext verify 的扩展装载时显式
// 警告"）靠它落地。
//
// 为什么是缓存而不是"装载时重新跑一遍 verify"：platform 的 verify 会 spawn 一次
// `bun test`（跑 13 条契约断言，秒级到十几秒），skill 的 verify 会跑它声明的全部
// e2e——每次 `ext load` 都重新跑一遍这些的代价太高，且与"装载"这个动作本身的
// 目的（把扩展接进当前进程）不匹配。缓存记录"上一次 `ext verify` 的结论 + 当时
// 校验的对象内容指纹"，装载时只做一次 O(1) 的指纹比对：
//   没有缓存           → 从未验证过，警告
//   缓存存在但指纹对不上  → 校验过的是旧版本代码，结论已经不可信，警告
//   缓存存在且指纹对得上、但 ok=false → 上次就没过，警告（但不阻断装载——见 loader.ts）
//   缓存存在且指纹对得上、且 ok=true  → 不警告

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionManifest } from "./types";

export interface VerifyCacheRecord {
  ok: boolean;
  at: string;
  // 被校验对象（connector.json 或 entry 文件）的 sha256，装载时用来判断缓存是否过期。
  subjectSha256: string;
}

export function verifyCachePath(extensionDir: string): string {
  return join(extensionDir, ".verify.json");
}

// connector kind 校验的是 connector.json；其余 kind 校验的是 entry 文件。
// 与 verify.ts 里 case 分支使用的对象保持一致。
export function subjectPathFor(extensionDir: string, manifest: Pick<ExtensionManifest, "kind" | "entry">): string {
  return manifest.kind === "connector" ? join(extensionDir, "connector.json") : join(extensionDir, manifest.entry ?? "index.ts");
}

export function readVerifyCache(extensionDir: string): VerifyCacheRecord | null {
  const path = verifyCachePath(extensionDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as VerifyCacheRecord;
  } catch {
    return null;
  }
}

export function writeVerifyCache(extensionDir: string, record: VerifyCacheRecord): void {
  const path = verifyCachePath(extensionDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
}
