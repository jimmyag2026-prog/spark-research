import { afterAll, describe, expect, test } from "bun:test";
import { KernelManager } from "../../backend/src/kernels/manager";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { OrchestratorAgent, type OrchestratorDeps } from "../../backend/src/agents/orchestrator";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";

// D-5（P10-b）：`agents/orchestrator.ts` 里 code task 的 finally 块此前调用的是
// `KernelManager.dispose()`（无参、全量销毁）——并发会话里先跑完 code task 的那个
// session 会把另一个还在执行中的 kernel 一起杀掉。修复是改成 `dispose(kernelId)`，
// 只销毁自己创建的那一个（`backend/src/kernels/manager.ts` 的 `dispose` 现在按 id
// 支持定向销毁，见同目录 tests/unit/kernels_manager.test.ts）。
// 这里从两个不同层面验证隔离：直接对 KernelManager 交错操作，以及经由
// OrchestratorAgent 两个并发 session 交错执行 code task。

const managers: KernelManager[] = [];
afterAll(() => {
  for (const m of managers) m.dispose();
});

describe("KernelManager：并发 kernel 互不干扰（D-5）", () => {
  test("两个 kernel 交错创建/执行/按 id 销毁，各自结果不串，早结束的不影响还在跑的", async () => {
    const km = new KernelManager();
    managers.push(km);

    const idA = km.createKernel("python");
    const idB = km.createKernel("python");

    // 交错：A 先设变量，B 再设不同的变量，两个 kernel 的 namespace 必须互不可见。
    await km.execute(idA, "value = 'session-a'", { timeoutMs: 5_000 });
    await km.execute(idB, "value = 'session-b'", { timeoutMs: 5_000 });

    // A 的长任务还在"执行中"（这里用一次真实 execute 模拟"仍然存活"），
    // 与此同时 B 已经结束并按 id 销毁——不能带走 A。
    const bDone = await km.execute(idB, "value", { timeoutMs: 5_000 });
    expect(bDone.status).toBe("ok");
    expect(bDone.result).toBe("session-b");
    km.dispose(idB);

    // A 必须继续存活，且 namespace 没有被 B 的销毁动作污染。
    const aStillAlive = await km.execute(idA, "value", { timeoutMs: 5_000 });
    expect(aStillAlive.status).toBe("ok");
    expect(aStillAlive.result).toBe("session-a");

    // B 已经真的被销毁了。
    expect(() => km.getKernelType(idB)).toThrow(/Unknown kernel/);

    km.dispose(idA);
  }, 20_000);
});

describe("OrchestratorAgent：并发 session 的 code task 不互相摧毁内核（D-5）", () => {
  // 一个总是产出「跑一段 python code」计划的假 LLM：把每个 session 的用户消息
  // 编码进 python 代码里，让两个 session 的 code task 在时间上交错执行。
  function codePlanLlm(): Pick<LLMRouter, "call" | "listModels"> {
    return {
      call: async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
        // plan() 发的 user 消息是把 userMessage 包在一段更长的规划提示词里
        // （"...Request: ${userMessage}"），不是原样传入，所以用 includes + 正则
        // 提取，而不是 startsWith。summarize() 的提示词里同样会带上原始
        // userMessage（execution log 里也会带一份），所以两次调用都会命中——
        // 这里不影响测试结果，因为只断言 execution[0]，不检查 summary 内容。
        const userMsg = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const match = userMsg.match(/RUN_CODE:([\s\S]*)/);
        if (match) {
          const code = match[1];
          const plan = JSON.stringify([{ id: "t1", kind: "code", description: "run", params: { code } }]);
          return { ok: true, provider: "kimi", model, content: plan, mock: false };
        }
        return { ok: true, provider: "kimi", model, content: "ok", mock: false };
      },
      listModels: () => new LLMRouter().listModels(),
    };
  }

  test("session A 的 code task 结束销毁自己的内核时，session B 仍在执行中的内核不受影响", async () => {
    const daemon = new SparkResearchDaemon();
    const deps: OrchestratorDeps = { llm: codePlanLlm() };
    const orch = new OrchestratorAgent(daemon, deps);

    // session A：先跑一小段很快结束的 code task。
    const resultA = await orch.processRequest("RUN_CODE:1 + 1", "sess_A");
    expect(resultA.execution[0]?.ok).toBe(true);
    expect(resultA.execution[0]?.output).toBe("2");

    // A 的 code task 已经走完 finally（dispose(kernelId) 只删自己），daemon 的
    // KernelManager 是共享的——如果修复前的 dispose() 无参版本仍在，这里不会立刻
        // 暴露问题（因为 B 还没创建），所以紧接着起 session B 并断言它能正常拿到
        // 独立的、干净的结果，证明 A 的收尾没有把共享 KernelManager 拖坏。
    const resultB = await orch.processRequest("RUN_CODE:21 * 2", "sess_B");
    expect(resultB.execution[0]?.ok).toBe(true);
    expect(resultB.execution[0]?.output).toBe("42");

    // 真正的交错场景：两个 session 并发跑，各自 kernel 独立创建/执行/销毁。
    // 用一个耗一点 CPU 时间但仍是**单一表达式**（能走 eval() 分支拿到返回值，
    // 不需要 import）的算式给 A 制造一点延迟，让两个 session 的
    // 创建/执行/dispose 在事件循环里真正交错，而不是纯粹顺序发生。
    const [interleavedA, interleavedB] = await Promise.all([
      orch.processRequest("RUN_CODE:(sum(range(3_000_000)) - sum(range(3_000_000))) + 11", "sess_C"),
      orch.processRequest("RUN_CODE:20 + 2", "sess_D"),
    ]);
    expect(interleavedA.execution[0]?.ok).toBe(true);
    expect(interleavedA.execution[0]?.output).toBe("11");
    expect(interleavedB.execution[0]?.ok).toBe(true);
    expect(interleavedB.execution[0]?.output).toBe("22");
  }, 20_000);
});
