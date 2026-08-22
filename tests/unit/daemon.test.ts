import { afterAll, describe, expect, test } from "bun:test";
import { KimiScienceDaemon } from "../../backend/src/daemon/daemon";
import { PERMIT_SETS, PermissionDeniedError, PermissionManager } from "../../backend/src/daemon/permissions";
import { KernelManager, type KernelType } from "../../backend/src/kernels/manager";

function createDaemon() {
  const permissions = new PermissionManager();
  const kernelManager = new KernelManager();
  const daemon = new KimiScienceDaemon({ permissions, kernelManager });
  return daemon;
}

const managers: KernelManager[] = [];

afterAll(() => {
  for (const m of managers) m.dispose();
});

describe("PermissionManager.getPermitSet", () => {
  test("control_repl 允许 mcp_call / create_agent 等控制方法", () => {
    const pm = new PermissionManager();
    expect(pm.getPermitSet("control_repl")).toEqual(PERMIT_SETS.control_repl);
    expect(pm.getPermitSet("control_repl")).toContain("mcp_call");
  });

  test("python_kernel 不允许 mcp_call", () => {
    const pm = new PermissionManager();
    expect(pm.getPermitSet("python_kernel")).toEqual(PERMIT_SETS.python_kernel);
    expect(pm.getPermitSet("python_kernel")).not.toContain("mcp_call");
  });

  test("r_kernel 与 python_kernel 同权限", () => {
    const pm = new PermissionManager();
    expect(pm.getPermitSet("r_kernel")).toEqual(pm.getPermitSet("python_kernel"));
  });

  test("kernel 类型 python/r 映射到对应 permit set", () => {
    const pm = new PermissionManager();
    expect(pm.getPermitSet("python")).toEqual(PERMIT_SETS.python_kernel);
    expect(pm.getPermitSet("r")).toEqual(PERMIT_SETS.r_kernel);
  });
});

describe("KernelManager", () => {
  test("创建 python kernel 返回唯一 kernelId", () => {
    const km = new KernelManager();
    managers.push(km);
    const id = km.createKernel("python");
    expect(id).toStartWith("kernel_");
    expect(km.getKernelType(id)).toBe("python");
  });

  test("创建 control_repl / r kernel", () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const cid = daemon.kernelManager.createKernel("control_repl");
    const rid = daemon.kernelManager.createKernel("r");
    expect(daemon.kernelManager.getKernelType(cid)).toBe("control_repl");
    expect(daemon.kernelManager.getKernelType(rid)).toBe("r");
  });

  test("未知 kernel 类型抛错", () => {
    const km = new KernelManager();
    expect(() => km.createKernel("brainfuck" as never)).toThrow(/unknown kernel/i);
  });
});

describe("KimiScienceDaemon.handleKernelCall", () => {
  test("python kernel 调用 mcp_call 被拒（PermissionDeniedError）", async () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const kid = daemon.kernelManager.createKernel("python");
    let caught: unknown;
    try {
      await daemon.handleKernelCall(kid, "mcp_call", { server: "math", tool: "add" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).method).toBe("mcp_call");
  });

  test("control_repl 可以调用 mcp", async () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const kid = daemon.kernelManager.createKernel("control_repl");
    const res = await daemon.kernelManager.execute(
      kid,
      `return await mcp.call("math", "add", { a: 1, b: 2 });`,
    );
    expect(res.status).toBe("ok");
    expect(res.result.ok).toBe(true);
    expect(res.result.result).toBe(3);
  });

  test("control_repl 可以创建 agent", async () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const kid = daemon.kernelManager.createKernel("control_repl");
    const res = await daemon.kernelManager.execute(kid, `return await createAgent({ name: "alice" });`);
    expect(res.status).toBe("ok");
    expect(res.result.name).toBe("alice");
  });

  test("control_repl 拒绝非白名单模块", async () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const kid = daemon.kernelManager.createKernel("control_repl");
    const res = await daemon.kernelManager.execute(kid, `require("fs")`);
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/not allowed/);
  });

  test("python kernel 持久化 namespace", async () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const kid = daemon.kernelManager.createKernel("python");
    const r1 = await daemon.kernelManager.execute(kid, "x = 41");
    expect(r1.status).toBe("ok");
    const r2 = await daemon.kernelManager.execute(kid, "x + 1");
    expect(r2.status).toBe("ok");
    expect(r2.result).toBe(42);
  });

  test("python kernel 捕获运行错误", async () => {
    const daemon = createDaemon();
    managers.push(daemon.kernelManager);
    const kid = daemon.kernelManager.createKernel("python");
    const res = await daemon.kernelManager.execute(kid, "1 / 0");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/ZeroDivisionError/);
  });
});
