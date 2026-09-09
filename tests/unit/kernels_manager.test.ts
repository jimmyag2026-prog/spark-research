import { afterAll, describe, expect, test } from "bun:test";
import { KernelManager, KernelTimeoutError, PythonKernel } from "../../backend/src/kernels/manager";

const managers: KernelManager[] = [];
const kernels: PythonKernel[] = [];

afterAll(() => {
  for (const m of managers) m.dispose();
  for (const k of kernels) k.dispose();
});

describe("PythonKernel stderr 排空（D-3）", () => {
  test("向 OS 级 stderr 打 >=1MB 后 kernel 仍能正常 execute（此前会因管道缓冲区写满而死锁）", async () => {
    const kernel = new PythonKernel();
    kernels.push(kernel);

    // os.write(2, ...) 绕过 python_kernel.py 对 sys.stderr 的 StringIO 重定向，
    // 直接写 OS 级 fd 2——这正是 manager.ts 此前从不读取 proc.stderr 时会撞上
    // 管道缓冲区上限（常见 64KB）而永久阻塞在 write(2) 上的路径。
    // 多行代码走的是 exec() 分支（不是 eval() 单表达式），所以这次调用本身不产生
    // `result`——这里只断言它没有挂死；下面单独一次表达式调用验证 kernel 仍然存活。
    const floodCode = ["import os", "os.write(2, b'x' * (2 * 1024 * 1024))"].join("\n");

    const started = Date.now();
    const floodResult = await kernel.execute(floodCode, { timeoutMs: 15_000 });
    expect(floodResult.status).toBe("ok");
    // 不是靠踩到 15s 超时兜底才勉强完成——真排空的话应该在远低于超时上限的时间内返回。
    expect(Date.now() - started).toBeLessThan(10_000);

    // 关键验收点：flood 之后这个 kernel 还活着，能继续正常 execute。
    const follow = await kernel.execute("1 + 1", { timeoutMs: 5_000 });
    expect(follow.status).toBe("ok");
    expect(follow.result).toBe(2);
  }, 20_000);
});

describe("PythonKernel 超时隔离（D-2）", () => {
  test("挂起的 execute 在 timeoutMs 内抛出 KernelTimeoutError，而不是永久挂起调用方", async () => {
    const kernel = new PythonKernel();
    kernels.push(kernel);

    const started = Date.now();
    let caught: unknown;
    try {
      await kernel.execute("import time\ntime.sleep(30)", { timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(KernelTimeoutError);
    expect((caught as KernelTimeoutError).timeout).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  test("超时杀掉子进程后，同一个 kernel 对象后续 execute 会透明重新拉起干净进程", async () => {
    const kernel = new PythonKernel();
    kernels.push(kernel);

    let caught: unknown;
    try {
      await kernel.execute("import time\ntime.sleep(30)", { timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KernelTimeoutError);

    // 隔离到位：挂起的那次执行被杀掉，但 kernel 本身没有被判「永久关闭」——
    // 下一次 execute() 应该正常工作（新进程，namespace 是干净的）。
    const res = await kernel.execute("21 * 2", { timeoutMs: 5_000 });
    expect(res.status).toBe("ok");
    expect(res.result).toBe(42);
  }, 15_000);
});

describe("KernelManager.dispose(kernelId)（D-5）", () => {
  test("按 id 销毁只影响那一个内核，其它内核继续存活", async () => {
    const km = new KernelManager();
    managers.push(km);

    const idA = km.createKernel("python");
    const idB = km.createKernel("python");

    const before = await km.execute(idB, "1 + 1", { timeoutMs: 5_000 });
    expect(before.status).toBe("ok");
    expect(before.result).toBe(2);

    km.dispose(idA);

    // A 被摘除：类型查询应该报「未知内核」。
    expect(() => km.getKernelType(idA)).toThrow(/Unknown kernel/);

    // B 完全不受影响，还能继续执行。
    const after = await km.execute(idB, "2 + 2", { timeoutMs: 5_000 });
    expect(after.status).toBe("ok");
    expect(after.result).toBe(4);
  }, 15_000);

  test("不传 id 的 dispose() 仍然全量销毁（保留给进程退出用）", () => {
    const km = new KernelManager();
    const idA = km.createKernel("python");
    const idB = km.createKernel("python");
    km.dispose();
    expect(() => km.getKernelType(idA)).toThrow(/Unknown kernel/);
    expect(() => km.getKernelType(idB)).toThrow(/Unknown kernel/);
  });

  test("对不存在的 id 调用 dispose(id) 是安全的空操作", () => {
    const km = new KernelManager();
    managers.push(km);
    expect(() => km.dispose("kernel_does_not_exist")).not.toThrow();
  });
});
