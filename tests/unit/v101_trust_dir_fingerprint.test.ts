import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTrust, dirManifest, sha256Dir } from "../../backend/src/extensions/fingerprint";
import { trustFilePath } from "../../backend/src/extensions/paths";

// v0.8 闸门 G-2（V101，外部 review P2-2）：`--trust` 指纹此前只盖入口单文件——改 helper 文件可绕过 TOFU。
// 现在 TS 扩展的指纹 = 目录清单哈希。阴性对照（devlog G-2）：loader 改回传 entryPath → 「改 helper 必须要求重新 trust」红。

function ext(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "v101-root-"));
  const dir = join(root, "extensions", "demo");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "extension.json"), JSON.stringify({ name: "demo", kind: "skill", entry: "index.ts" }));
  writeFileSync(join(dir, "index.ts"), 'export * from "./lib/helper";\n');
  writeFileSync(join(dir, "lib", "helper.ts"), "export const x = 1;\n");
  return { root, dir };
}

describe("目录清单指纹", () => {
  test("清单含全部文件、排序稳定；改 helper 文件 → 指纹变；改入口 → 也变；跳过 node_modules/.git/符号链接", () => {
    const { dir } = ext();
    const before = sha256Dir(dir);
    expect(dirManifest(dir).map((f) => f.path)).toEqual(["extension.json", "index.ts", "lib/helper.ts"]);
    writeFileSync(join(dir, "lib", "helper.ts"), "export const x = 2;\n");
    const afterHelper = sha256Dir(dir);
    expect(afterHelper).not.toBe(before);
    mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "junk", "a.js"), "1");
    symlinkSync("/etc", join(dir, "outside"));
    expect(sha256Dir(dir)).toBe(afterHelper); // node_modules 与符号链接不算扩展的一部分
  });

  test("checkTrust(dir)：首次要 --trust；改 helper 后再次要求确认；旧的入口单文件指纹一律视为已变化", () => {
    const { root, dir } = ext();
    const first = checkTrust("demo", { kind: "dir", path: dir }, false, { root });
    expect(first.trusted).toBe(false);
    expect(first.firstTime).toBe(true);
    expect(first.message).toContain("目录清单指纹");
    const trusted = checkTrust("demo", { kind: "dir", path: dir }, true, { root });
    expect(trusted.trusted).toBe(true);
    const rec = JSON.parse(readFileSync(trustFilePath("demo", { root }), "utf8")) as { scheme?: string; sha256: string };
    expect(rec.scheme).toBe("dir-manifest-v1");
    expect(checkTrust("demo", { kind: "dir", path: dir }, false, { root }).trusted).toBe(true);

    // 改 helper（不碰入口）→ 必须重新确认
    writeFileSync(join(dir, "lib", "helper.ts"), "export const x = 'pwned';\n");
    const afterHelper = checkTrust("demo", { kind: "dir", path: dir }, false, { root });
    expect(afterHelper.trusted).toBe(false);
    expect(afterHelper.changed).toBe(true);

    // 旧口径记录（入口单文件 sha256、无 scheme）→ 视为已变化
    writeFileSync(trustFilePath("demo", { root }), JSON.stringify({ sha256: "deadbeef".repeat(8), trustedAt: "2026-01-01T00:00:00.000Z" }));
    const legacy = checkTrust("demo", { kind: "dir", path: dir }, false, { root });
    expect(legacy.trusted).toBe(false);
    expect(legacy.changed).toBe(true);
  });

  test("file 口径仍可用（mcp_client 的 mcp.json）", () => {
    const { root, dir } = ext();
    writeFileSync(join(dir, "mcp.json"), "{}");
    const r = checkTrust("demo-mcp", join(dir, "mcp.json"), true, { root });
    expect(r.trusted).toBe(true);
    const rec = JSON.parse(readFileSync(trustFilePath("demo-mcp", { root }), "utf8")) as { scheme?: string };
    expect(rec.scheme).toBe("file");
  });
});

import { cpSync } from "node:fs";
import { loadExtension } from "../../backend/src/extensions/loader";

describe("装载层 · 改 helper 文件必须重新 --trust（阴性对照落点：loader 改回只传 entryPath → 红）", () => {
  test("good-skill：trust 装载 → 加/改一个非入口文件 → 不带 --trust 拒绝装载", async () => {
    const root = mkdtempSync(join(tmpdir(), "v101-load-"));
    const dir = join(root, "ext", "good-skill");
    cpSync(join(import.meta.dir, "../fixtures/extensions/good-skill"), dir, { recursive: true });
    const first = await loadExtension(dir, { trust: true, pathOptions: { root } });
    expect(first.status).toBe("loaded");
    const again = await loadExtension(dir, { pathOptions: { root } });
    expect(again.status).toBe("loaded"); // 未变，不需重复 --trust
    writeFileSync(join(dir, "helper.ts"), "export const injected = () => 'pwned';\n"); // 入口没动
    const afterHelper = await loadExtension(dir, { pathOptions: { root } });
    expect(afterHelper.status).not.toBe("loaded");
    expect(String(afterHelper.reason)).toContain("已变化");
    const retrusted = await loadExtension(dir, { trust: true, pathOptions: { root } });
    expect(retrusted.status).toBe("loaded");
  });
});
