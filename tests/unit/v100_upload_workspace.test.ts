import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadDeniedError, UploadLimitError, collectUploads, constrainWorkspaceRoot } from "../../backend/src/compute/uploads";

// v0.8 闸门 G-1（V100，外部 review P2-1）：
//   ① HTTP/MCP 面的 workspaceRoot 必须在项目目录之内（绝对路径 / `..` 逃出一律拒）
//   ② 上传限额检查先于读盘哈希（越界请求不能让本机对大目录全量读盘）
// 阴性对照（devlog G-1）：去掉 constrainWorkspaceRoot 的 rel 判断 → ①红；把哈希挪回限额前 → ②红。

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "v100-proj-"));
  mkdirSync(join(root, "work", "sub"), { recursive: true });
  writeFileSync(join(root, "work", "run.py"), "print(1)\n");
  return realpathSync(root);
}

describe("① constrainWorkspaceRoot", () => {
  test("省略 → 项目目录；相对路径按项目目录解析；项目内绝对路径放行", () => {
    const base = project();
    expect(constrainWorkspaceRoot(undefined, base)).toBe(base);
    expect(constrainWorkspaceRoot("work", base)).toBe(join(base, "work"));
    expect(constrainWorkspaceRoot(join(base, "work", "sub"), base)).toBe(join(base, "work", "sub"));
  });
  test("/etc、~、`..` 逃出、项目外绝对路径 → UploadDeniedError（消息点名项目目录）", () => {
    const base = project();
    for (const bad of ["/etc", "/", "../", "work/../..", mkdtempSync(join(tmpdir(), "v100-other-"))]) {
      expect(() => constrainWorkspaceRoot(bad, base)).toThrow(UploadDeniedError);
    }
    expect(() => constrainWorkspaceRoot("/etc", base)).toThrow(/项目目录之内/);
    expect(() => constrainWorkspaceRoot("nope-dir", base)).toThrow(/不存在/);
  });
});

describe("② 限额先于哈希", () => {
  test("超过文件数上限时抛 UploadLimitError，且不去读那些文件（含一个不可读文件也不会 EACCES）", () => {
    const base = project();
    const dir = join(base, "many");
    mkdirSync(dir);
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
    // 一个不可读文件：如果实现先哈希再检限额，这里会先撞 EACCES 而不是 UploadLimitError。
    writeFileSync(join(dir, "unreadable.txt"), "secret");
    chmodSync(join(dir, "unreadable.txt"), 0o000);
    try {
      expect(() => collectUploads(base, ["many"], { count: 2, bytes: 1_000_000 })).toThrow(UploadLimitError);
    } finally {
      chmodSync(join(dir, "unreadable.txt"), 0o600);
    }
  });
  test("字节上限同理", () => {
    const base = project();
    writeFileSync(join(base, "big.bin"), "y".repeat(2048));
    writeFileSync(join(base, "unreadable.bin"), "z".repeat(10));
    chmodSync(join(base, "unreadable.bin"), 0o000);
    try {
      expect(() => collectUploads(base, ["big.bin", "unreadable.bin"], { count: 10, bytes: 1024 })).toThrow(UploadLimitError);
    } finally {
      chmodSync(join(base, "unreadable.bin"), 0o600);
    }
  });
  test("限额内正常哈希（回归）", () => {
    const base = project();
    const r = collectUploads(base, ["work/run.py"]);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

import { makeServer } from "../helpers/server_scenario";

describe("HTTP 面 · POST /api/compute/jobs 的 workspaceRoot", () => {
  test("/etc → 400 且消息点名项目目录；项目内相对路径 → 通过校验层（即使后面因别的原因失败也不是 400 路径错）", async () => {
    const fx = makeServer({ slug: "v100-http" });
    try {
      const bad = await fx.post<{ error?: string; message?: string }>("/api/compute/jobs", { purpose: "p", command: ["echo", "hi"], workspaceRoot: "/etc", upload: [] });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain("项目目录之内");
      const escape = await fx.post("/api/compute/jobs", { purpose: "p", command: ["echo", "hi"], workspaceRoot: "../../", upload: [] });
      expect(escape.status).toBe(400);
      const ok = await fx.post<{ job?: unknown }>("/api/compute/jobs", { purpose: "p", command: ["echo", "hi"], upload: [] });
      expect(ok.status).toBeLessThan(400);
    } finally {
      await fx.close?.();
    }
  });
});
