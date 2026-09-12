import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// V109（v0.8.0-alpha.2 收口）：仓库根 pyproject.toml 版本长期停在 0.2.0——把 SDK 那条同款门禁扩到它。
const REPO = join(import.meta.dir, "../..");
function toPep440(npm: string): string {
  const m = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(npm);
  if (!m) throw new Error(`不是 semver：${npm}`);
  const suffix: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" };
  return m[2] ? `${m[1]}${suffix[m[2]]}${m[3]}` : m[1];
}

describe("版本单一真源 · 仓库根 pyproject.toml", () => {
  test("pyproject.toml 的 version == package.json 版本的 PEP440 转写", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string };
    const py = readFileSync(join(REPO, "pyproject.toml"), "utf8");
    const m = /^version = "([^"]+)"/m.exec(py);
    expect(m?.[1]).toBe(toPep440(pkg.version));
  });
});
