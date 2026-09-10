import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPLOAD_BYTES_LIMIT,
  UPLOAD_COUNT_LIMIT,
  UploadChangedError,
  UploadDeniedError,
  UploadLimitError,
  collectUploads,
  preflight,
} from "../../backend/src/compute/uploads";

// CB-3 · 上传面（设计 §1.1.7）。fail-closed：显式请求命中 deny-list **抛错**，不静默跳过。

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "compute-uploads-"));
  writeFileSync(join(root, "runner.py"), "print('hi')\n");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "a.csv"), "x,y\n1,2\n");
  return root;
}

describe("deny-list（fail-closed）", () => {
  test.each([
    [".env", ".env"],
    [".env.local", ".env.local"],
    ["id_ed25519", "id_ed25519"],
    ["server.pem", "server.pem"],
    ["credentials.json", "credentials.json"],
    [".netrc", ".netrc"],
    ["secrets.yaml", "secrets.yaml"],
  ])("显式请求密钥样文件 '%s' → 抛 UploadDeniedError", (_name, file) => {
    const root = workspace();
    writeFileSync(join(root, file), "TOP SECRET\n");
    expect(() => collectUploads(root, [file])).toThrow(UploadDeniedError);
  });

  test.each([[".git"], [".ssh"], [".aws"], ["node_modules"], [".venv"], ["__pycache__"], [".config"]])(
    "显式请求 deny-list 目录 '%s' → 抛",
    (dir) => {
      const root = workspace();
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "x"), "x");
      expect(() => collectUploads(root, [dir])).toThrow(UploadDeniedError);
      expect(() => collectUploads(root, [`${dir}/x`])).toThrow(UploadDeniedError);
    },
  );

  test("递归展开时命中 deny-list → 跳过但**记进 skipped**（可见，不静默）", () => {
    const root = workspace();
    mkdirSync(join(root, "proj", ".git"), { recursive: true });
    writeFileSync(join(root, "proj", ".git", "config"), "x");
    writeFileSync(join(root, "proj", ".env"), "SECRET=1");
    writeFileSync(join(root, "proj", "main.py"), "print(1)");
    const result = collectUploads(root, ["proj"]);
    expect(result.entries.map((e) => e.path)).toEqual(["proj/main.py"]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(["proj/.env", "proj/.git"]);
  });

  test("symlink 一律不跟（穿过即拒）", () => {
    const root = workspace();
    symlinkSync("/etc/passwd", join(root, "link-to-passwd"));
    expect(() => collectUploads(root, ["link-to-passwd"])).toThrow(/符号链接/);
  });

  test("路径逃出工作区 / 绝对路径 → 拒", () => {
    const root = workspace();
    expect(() => collectUploads(root, ["../outside"])).toThrow(/逃出/);
    expect(() => collectUploads(root, ["/etc/passwd"])).toThrow(/相对路径/);
  });

  test("不存在的文件 → 拒（不静默当作空清单）", () => {
    const root = workspace();
    expect(() => collectUploads(root, ["nope.py"])).toThrow(/不存在/);
  });
});

describe("gitignore 感知与限额", () => {
  test("递归展开时跳过 .gitignore 命中的文件，并记进 skipped", () => {
    const root = workspace();
    writeFileSync(join(root, ".gitignore"), "*.log\nbuild\n");
    mkdirSync(join(root, "proj", "build"), { recursive: true });
    writeFileSync(join(root, "proj", "keep.py"), "1");
    writeFileSync(join(root, "proj", "noise.log"), "1");
    writeFileSync(join(root, "proj", "build", "artifact.bin"), "1");
    const result = collectUploads(root, ["proj"]);
    expect(result.entries.map((e) => e.path)).toEqual(["proj/keep.py"]);
    expect(result.skipped.map((s) => s.reason)).toContain("gitignore");
  });

  test("显式点名的单个文件即便被 git 忽略也照传（数据文件常在 .gitignore 里，那不是密钥问题）", () => {
    const root = workspace();
    writeFileSync(join(root, ".gitignore"), "*.csv\n");
    const result = collectUploads(root, ["data/a.csv"]);
    expect(result.entries.map((e) => e.path)).toEqual(["data/a.csv"]);
  });

  test("双限额：文件数与总字节各自超限都抛 UploadLimitError", () => {
    const root = workspace();
    mkdirSync(join(root, "many"), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "many", `f${i}.txt`), "0123456789");
    expect(() => collectUploads(root, ["many"], { count: 3, bytes: 1 << 20 })).toThrow(UploadLimitError);
    expect(() => collectUploads(root, ["many"], { count: 100, bytes: 10 })).toThrow(UploadLimitError);
  });

  test("默认限额就是设计里那两个数字（审批面要显示它们）", () => {
    expect(UPLOAD_COUNT_LIMIT).toBe(200);
    expect(UPLOAD_BYTES_LIMIT).toBe(256 * 1024 * 1024);
  });

  test("条目按路径排序、带 size 与 sha256（digest 才稳定）", () => {
    const root = workspace();
    const a = collectUploads(root, ["data", "runner.py"]);
    const b = collectUploads(root, ["runner.py", "data"]);
    expect(a.entries).toEqual(b.entries);
    expect(a.entries[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.totalBytes).toBeGreaterThan(0);
  });
});

describe("preflight（派发前重验）", () => {
  test("没变 → 通过", () => {
    const root = workspace();
    const { entries } = collectUploads(root, ["runner.py"]);
    expect(() => preflight(root, entries)).not.toThrow();
  });

  test("内容改一个字节（大小不变）→ 抛 UploadChangedError（**这条靠 sha256，不靠 size**）", () => {
    const root = workspace();
    const { entries } = collectUploads(root, ["runner.py"]);
    writeFileSync(join(root, "runner.py"), "print('h1')\n");
    expect(() => preflight(root, entries)).toThrow(UploadChangedError);
    expect(() => preflight(root, entries)).toThrow(/sha256/);
  });

  test("大小变了 → 抛", () => {
    const root = workspace();
    const { entries } = collectUploads(root, ["runner.py"]);
    writeFileSync(join(root, "runner.py"), "print('hi there')\n");
    expect(() => preflight(root, entries)).toThrow(/size/);
  });

  test("文件被删 / 被换成符号链接 → 抛", () => {
    const root = workspace();
    const { entries } = collectUploads(root, ["runner.py"]);
    writeFileSync(join(root, "runner2.py"), "print('hi')\n");
    expect(() => preflight(root, [{ ...entries[0]!, path: "gone.py" }])).toThrow(/不存在/);

    const root2 = workspace();
    const e2 = collectUploads(root2, ["runner.py"]).entries;
    chmodSync(join(root2, "runner.py"), 0o644);
    symlinkSync(join(root2, "data", "a.csv"), join(root2, "sneaky.py"));
    expect(() => preflight(root2, [{ ...e2[0]!, path: "sneaky.py" }])).toThrow(/符号链接/);
  });
});
