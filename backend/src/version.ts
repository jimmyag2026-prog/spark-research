import { readFileSync } from "node:fs";
import { join } from "node:path";

// 版本号的单一真源是仓库根的 package.json。
//
// 为什么不 `import pkg from "../../package.json"`：那样 `bun build --compile` 会把
// package.json 整个打进产物，而这里只要一个字段。同步读一次文件、失败时退回 "0.0.0"
// —— 版本号读不出来不该让服务起不来，但也不该假装成某个具体版本。
function readVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dir, "../../package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PACKAGE_VERSION = readVersion();
