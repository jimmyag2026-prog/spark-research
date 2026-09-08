import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, CREDENTIALS_FILE } from "../../backend/src/daemon/credentials";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { PermissionDeniedError, PermissionManager } from "../../backend/src/daemon/permissions";
import { KernelManager } from "../../backend/src/kernels/manager";

// 全部凭据值都是假值，仓库里不出现任何真实 key。
const FAKE_KEY = "fake-aminer-key-0000";

const dirs: string[] = [];
const managers: KernelManager[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "spark-creds-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const m of managers) m.dispose();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("CredentialStore", () => {
  test("写入后文件权限是 0600", () => {
    const root = tempRoot();
    const store = new CredentialStore({ root });
    store.set("aminer", { api_key: FAKE_KEY });

    const mode = statSync(store.path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.path).toBe(join(root, CREDENTIALS_FILE));
  });

  test("按 connector id 存取，覆盖写不丢其他 connector", () => {
    const root = tempRoot();
    const store = new CredentialStore({ root });
    store.set("aminer", { api_key: FAKE_KEY });
    store.set("cnki", { user: "u", password: "fake-pass" });
    store.set("aminer", { api_key: "fake-aminer-key-1111" });

    expect(store.get("aminer")).toEqual({ api_key: "fake-aminer-key-1111" });
    expect(store.get("cnki")).toEqual({ user: "u", password: "fake-pass" });
    expect(store.get("unknown")).toBeNull();
    expect(store.list().map((c) => c.connectorId)).toEqual(["aminer", "cnki"]);
  });

  test("describe/list 只给字段名不给值", () => {
    const root = tempRoot();
    const store = new CredentialStore({ root });
    store.set("aminer", { api_key: FAKE_KEY, secret: "fake-secret" });

    const meta = store.describe("aminer")!;
    expect(meta.keys).toEqual(["api_key", "secret"]);
    expect(JSON.stringify(meta)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(store.list())).not.toContain(FAKE_KEY);
    expect(JSON.stringify(store.toJSON())).not.toContain(FAKE_KEY);
  });

  test("权限过宽时读取告警（不含凭据值）", () => {
    const root = tempRoot();
    const warnings: string[] = [];
    const store = new CredentialStore({ root, warn: (m) => warnings.push(m) });
    store.set("aminer", { api_key: FAKE_KEY });

    chmodSync(store.path, 0o644);
    expect(store.checkPermissions().ok).toBe(false);

    expect(store.get("aminer")).toEqual({ api_key: FAKE_KEY });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("644");
    expect(warnings.join("\n")).not.toContain(FAKE_KEY);
  });

  test("remove 删除后不可再取", () => {
    const root = tempRoot();
    const store = new CredentialStore({ root });
    store.set("aminer", { api_key: FAKE_KEY });
    expect(store.remove("aminer")).toBe(true);
    expect(store.remove("aminer")).toBe(false);
    expect(store.has("aminer")).toBe(false);
    expect(readFileSync(store.path, "utf8")).not.toContain(FAKE_KEY);
  });

  test("重新打开同一路径能读到已存凭据（持久化）", () => {
    const root = tempRoot();
    new CredentialStore({ root }).set("aminer", { api_key: FAKE_KEY });
    expect(new CredentialStore({ root }).get("aminer")).toEqual({ api_key: FAKE_KEY });
  });
});

describe("daemon 凭据分层（AD-2）", () => {
  function createDaemon(root: string) {
    const credentials = new CredentialStore({ root });
    credentials.set("aminer", { api_key: FAKE_KEY });
    const kernelManager = new KernelManager();
    managers.push(kernelManager);
    const daemon = new SparkResearchDaemon({
      permissions: new PermissionManager(),
      kernelManager,
      credentials,
    });
    return daemon;
  }

  test("control_repl 无 credentials permit，调用被拦截", async () => {
    const daemon = createDaemon(tempRoot());
    const kid = daemon.kernelManager.createKernel("control_repl");
    let caught: unknown;
    try {
      await daemon.handleKernelCall(kid, "credentials", { connector: "aminer" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).method).toBe("credentials");
    expect(String(caught)).not.toContain(FAKE_KEY);
  });

  test("有 permit 的 python kernel 也只拿到元数据，拿不到凭据本体", async () => {
    const daemon = createDaemon(tempRoot());
    const kid = daemon.kernelManager.createKernel("python");
    const res = await daemon.handleKernelCall(kid, "credentials", { connector: "aminer" });

    expect(res.configured).toBe(true);
    expect(res.keys).toEqual(["api_key"]);
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
  });

  test("未配置的 connector 报未配置而不是报错", async () => {
    const daemon = createDaemon(tempRoot());
    const kid = daemon.kernelManager.createKernel("python");
    const res = await daemon.handleKernelCall(kid, "credentials", { connector: "cnki" });
    expect(res.ok).toBe(true);
    expect(res.configured).toBe(false);
    expect(res.keys).toEqual([]);
  });

  test("执行日志不落凭据值", async () => {
    const root = tempRoot();
    const daemon = createDaemon(root);
    const kid = daemon.kernelManager.createKernel("python");
    await daemon.handleKernelCall(kid, "credentials", { connector: "aminer" });
    const entries = (daemon.executionLog as unknown as { entries: unknown[] }).entries;
    expect(JSON.stringify(entries)).not.toContain(FAKE_KEY);
  });

  test("daemon 内部仍可取到凭据本体供 connector 使用", () => {
    const daemon = createDaemon(tempRoot());
    expect(daemon.credentials.get("aminer")).toEqual({ api_key: FAKE_KEY });
  });
});
