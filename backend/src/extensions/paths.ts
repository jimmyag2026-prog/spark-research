// W2-c · 扩展相关的落盘路径。与 config/index.ts 的 dataDir() 同一口径
// （env SPARK_RESEARCH_DATA_DIR > 默认 ~/.spark-research），避免又长出第二套解析。

import { join } from "node:path";
import { dataDir } from "../config";

export interface ExtensionPathOptions {
  // 测试注入：直接指定数据根目录（等价于 config 的 options.root）。
  root?: string;
}

export function extensionsRoot(options: ExtensionPathOptions = {}): string {
  return join(dataDir({ root: options.root }), "extensions");
}

export function extensionDir(name: string, options: ExtensionPathOptions = {}): string {
  return join(extensionsRoot(options), name);
}

// 信任指纹记录：与扩展目录同放一处（"manifest 记指纹"的落地——见 fingerprint.ts
// 头部注释，为什么是旁路文件而不是直接改写用户的 extension.json）。
export function trustFilePath(name: string, options: ExtensionPathOptions = {}): string {
  return join(extensionDir(name, options), ".trust.json");
}

// 授权记录（凭据 + ToolBus 工具）集中存一份，而不是每个扩展目录一份——
// `ext grant` 需要一眼看到全局授权面，分散的话容易漏审计。
export function grantsFilePath(options: ExtensionPathOptions = {}): string {
  return join(extensionsRoot(options), ".grants.json");
}
