import { describe, expect, test } from "bun:test";
import {
  RecoverFailure,
  SshHostValidationError,
  TARGET_KINDS,
  isTerminalRecoverFailure,
  validateSshHost,
} from "../../backend/src/compute/target";

// CB-1 · target 契约与 ssh 槽位（设计 §1.1.6：**明确不建** adapters/ssh.ts，只留 schema）。

function host(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cluster-a",
    host: "gpu.example.edu",
    port: 22,
    user: "researcher",
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    hostKey: "ssh-ed25519 AAAAC3Nza...",
    identityPath: "/Users/someone/.ssh/id_ed25519",
    proxyJump: ["bastion.example.edu"],
    concurrency: 4,
    scheduler: "slurm",
    ...over,
  };
}

describe("validateSshHost", () => {
  test("合法输入原样通过，port/concurrency/scheduler 有默认值", () => {
    const parsed = validateSshHost(host());
    expect(parsed.id).toBe("cluster-a");
    expect(parsed.scheduler).toBe("slurm");
    const minimal = validateSshHost(host({ port: undefined, concurrency: undefined, scheduler: undefined }));
    expect(minimal.port).toBe(22);
    expect(minimal.concurrency).toBe(1);
    expect(minimal.scheduler).toBe("none");
  });

  test("host key 指纹不钉死 → 拒（不钉死等于 StrictHostKeyChecking=no）", () => {
    expect(() => validateSshHost(host({ hostKeyFingerprint: "MD5:aa:bb" }))).toThrow(/不许省略主机指纹/);
    expect(() => validateSshHost(host({ hostKeyFingerprint: "" }))).toThrow(SshHostValidationError);
  });

  test("identityPath 里的 % 与 $ 一律拒（会在别处被再展开一次）", () => {
    expect(() => validateSshHost(host({ identityPath: "/keys/%u/id" }))).toThrow(/%/);
    expect(() => validateSshHost(host({ identityPath: "$HOME/.ssh/id" }))).toThrow(/\$/);
  });

  test("user 里的 @ 与空白一律拒", () => {
    expect(() => validateSshHost(host({ user: "me@elsewhere" }))).toThrow(/@/);
    expect(() => validateSshHost(host({ user: "me and you" }))).toThrow(SshHostValidationError);
  });

  test("port / concurrency 越界拒；proxyJump 必须是字符串数组", () => {
    expect(() => validateSshHost(host({ port: 0 }))).toThrow(/port/);
    expect(() => validateSshHost(host({ port: 70000 }))).toThrow(/port/);
    expect(() => validateSshHost(host({ concurrency: 0 }))).toThrow(/concurrency/);
    expect(() => validateSshHost(host({ concurrency: 101 }))).toThrow(/concurrency/);
    expect(() => validateSshHost(host({ proxyJump: [""] }))).toThrow(/proxyJump/);
    expect(() => validateSshHost(host({ proxyJump: "bastion" }))).toThrow(/proxyJump/);
  });

  test("scheduler 只认三种", () => {
    expect(() => validateSshHost(host({ scheduler: "lsf" }))).toThrow(/scheduler/);
  });

  test("非对象输入拒", () => {
    expect(() => validateSshHost(null)).toThrow(SshHostValidationError);
    expect(() => validateSshHost([1, 2])).toThrow(SshHostValidationError);
  });
});

describe("RecoverFailure 的分类", () => {
  test("只有 retryable 值得再试；其余都是终态", () => {
    expect(isTerminalRecoverFailure("retryable")).toBe(false);
    for (const kind of ["unauthorized", "quota", "ownership_mismatch", "invalid_request", "not_found"] as const) {
      expect(isTerminalRecoverFailure(kind)).toBe(true);
    }
    expect(new RecoverFailure("quota", "配额用尽").kind).toBe("quota");
  });
});

describe("TARGET_KINDS", () => {
  test("v0.5 只有三种执行地，ssh 只是槽位", () => {
    expect([...TARGET_KINDS]).toEqual(["local", "modal", "ssh"]);
  });
});
