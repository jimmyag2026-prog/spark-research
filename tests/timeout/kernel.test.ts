import { afterAll, describe, expect, test } from "bun:test";
import { KernelManager, KernelTimeoutError } from "../../backend/src/kernels/manager";

// D-2（P10-b）验收 3/4：kernel execute 路径。
//
// 这里刻意**不**用一个纯 mock 假内核，而是用真实 PythonKernel 跑 `time.sleep(30)`
// 模拟一个「永不响应」的执行——D-2 对 kernel 的要求是「超时要杀掉/隔离该次执行」，
// 这件事只有对着真实子进程才验证得到：一个纯 JS mock 没有进程可杀，验证不出
// killAndReset 的行为。只依赖 Python 标准库（time 模块），不需要 venv/第三方包，
// 在没有 .venv 的环境（本 worktree 就是）里也能真实跑起来，不会被静默 skip。

const managers: KernelManager[] = [];
afterAll(() => {
  for (const m of managers) m.dispose();
});

describe("D-2 验收：kernel execute 路径不会挂死", () => {
  test("永不响应的 python 执行在短超时内返回可见的 KernelTimeoutError", async () => {
    const km = new KernelManager();
    managers.push(km);
    const kernelId = km.createKernel("python");

    const started = Date.now();
    let caught: unknown;
    try {
      await km.execute(kernelId, "import time\ntime.sleep(30)", { timeoutMs: 200 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(KernelTimeoutError);
    expect((caught as KernelTimeoutError).timeout).toBe(true);
    // 真的是被超时打断（远小于 30s 的 sleep），不是巧合地跑完了。
    expect(elapsed).toBeLessThan(5_000);

    // 隔离到位：kernel 没有被判永久死亡，同一个 id 后续还能正常用。
    const follow = await km.execute(kernelId, "1 + 1", { timeoutMs: 5_000 });
    expect(follow.status).toBe("ok");
    expect(follow.result).toBe(2);
  }, 15_000);
});
