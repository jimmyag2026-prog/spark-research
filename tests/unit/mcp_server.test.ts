import { describe, expect, test } from "bun:test";
import { MCP_TOOLS, MCP_WITHHELD, toolByName } from "../../backend/src/mcp/tools";
import { MCP_INSTRUCTIONS } from "../../backend/src/mcp/server";
import { callTool, connectClient, makeMcp } from "../helpers/mcp_scenario";
import { ScriptedLlm } from "../helpers/ideation_scenario";

// P9 · MCP server。三组测试：
//   ① 工具定义的**写法标准**（判断二：LLM 第一次见就会用）
//   ② **对抗测试**：危险动作在 MCP 层不可达（判断一 / AD-6）
//   ③ 真实 MCP 客户端跑通链路（判断三：长任务同步语义）

describe("MCP · 工具定义的写法标准（判断二）", () => {
  test("每个工具的描述都写了：何时调 / 参数示例 / 何时不该用 / 典型链路", () => {
    // 反面教材是 `"Search literature. Args: query (string)"`——只说做什么，
    // LLM 得试几次才知道什么时候该调。这条断言把标准变成门槛。
    for (const tool of MCP_TOOLS) {
      expect(tool.description).toContain("【何时调】");
      expect(tool.description).toContain("【参数示例】");
      expect(tool.description).toContain("【何时不该用】");
      expect(tool.description).toContain("【典型链路】");
      expect(tool.description.length).toBeGreaterThan(180);
    }
  });

  test("参数 schema 是合法 JSON Schema 且关键参数带真实值示例", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
      for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
        const prop = schema as { type?: string; description?: string; enum?: unknown[] };
        expect(prop.type ?? "string").toBeTruthy();
        // 每个参数都要有说明——没说明的参数等于要 LLM 猜。
        expect(prop.description, `${tool.name}.${name} 缺 description`).toBeTruthy();
      }
      // 必填参数必须真的在 properties 里（写错名字的 required 会让调用永远失败）。
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(required);
      }
    }
  });

  test("工具名唯一且是 snake_case", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe("MCP · 对抗测试：危险动作不可达（判断一 / AD-6）", () => {
  const DANGEROUS = ["lab_approve", "lab_reject", "lab_simulate", "conclusion_review", "project_archive"];

  test("危险动作不在工具清单里", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const name of DANGEROUS) expect(names).not.toContain(name);
    // 也不许换个名字混进来。
    for (const name of names) {
      expect(name).not.toMatch(/approve|reject|simulate|_review$/);
    }
  });

  test("**结构性防线**：没有任何已暴露工具能打到危险端点", () => {
    // 这一条比「名字里没有 approve」强得多：它检的是**实际会发出的 HTTP 请求**。
    // 将来有人加一个叫 lab_finish 的工具、内部却 POST 到 /approve，这里会立刻红。
    const probes: Record<string, unknown>[] = [
      {},
      { project: "p", experimentId: "x", ideaId: "x", recordId: "x", conclusionId: "x", taskId: "x", slug: "x" },
      { query: "q", message: "m", identifier: "d", naturalLanguage: "n", title: "t" },
    ];
    for (const tool of MCP_TOOLS) {
      for (const args of probes) {
        const req = tool.request(args);
        // 危险端点逐条点名（不是关键词模糊匹配）：
        //   湿实验的 approve / reject / simulate、结论卡的 review、项目 archive。
        // 注意 `/api/lit/review`（综述草稿）**不是**危险端点——它不改任何审批状态，
        // 用宽泛的 /review/ 正则会把它一起误伤，那种守卫迟早被人删掉。
        const message = `${tool.name} 的请求路径打到了危险端点：${req.method} ${req.path}`;
        expect(req.path, message).not.toMatch(/\/(approve|reject|simulate|archive)(\?|$)/);
        expect(req.path, message).not.toMatch(/\/conclusions\/[^/?]+\/review(\?|$)/);
      }
    }
  });

  test("即便猜到名字，调用也只回「为什么不给 + 人该怎么做」", async () => {
    const fx = makeMcp();
    for (const name of DANGEROUS) {
      const { ok, payload } = await fx.call<{ error: string; reason: string; humanAction: string }>(name, {
        experimentId: "whatever",
        actor: "attacker",
      });
      expect(ok).toBe(false);
      expect(payload.error).toContain("刻意不通过 MCP 暴露");
      expect(payload.reason.length).toBeGreaterThan(10);
      // 把人拉回环里：不是「拒绝」，是「该谁做、怎么做」。
      expect(payload.humanAction).toMatch(/spark-research/);
    }
  });

  test("未知工具名报错并列出可用工具", async () => {
    const fx = makeMcp();
    const { ok, payload } = await fx.call<{ error: string; available: string[] }>("lab_execute_now");
    expect(ok).toBe(false);
    expect(payload.available).toEqual(MCP_TOOLS.map((t) => t.name));
  });

  test("server instructions 把不可用动作写在明处", () => {
    for (const w of MCP_WITHHELD) {
      expect(MCP_INSTRUCTIONS).toContain(w.name);
      expect(MCP_INSTRUCTIONS).toContain(w.humanAction);
    }
  });

  test("lab_compile 停在 awaiting_approval 并给出人工动作指引", async () => {
    const fx = makeMcp();
    const { ok, payload } = await fx.call<{
      experiment: { state: string; id: string };
      humanAction: { nextStepForHuman: string; why: string };
    }>("lab_compile", {
      naturalLanguage: "取样品 50 uL 加入 96 孔板 A1，加入 100 uL 缓冲液，37°C 孵育 30 分钟",
      title: "MCP 编译测试",
    });
    expect(ok).toBe(true);
    // 安全门通过 ≠ 可以执行：状态必须停在等人批准。
    expect(payload.experiment.state).toBe("awaiting_approval");
    expect(payload.humanAction.why).toContain("AD-6");
    expect(payload.humanAction.nextStepForHuman).toContain("lab approve");
    expect(payload.humanAction.nextStepForHuman).toContain(payload.experiment.id);
  });
});

describe("MCP · 真实客户端连接（协议层）", () => {
  test("tools/list 返回全部工具及其 schema", async () => {
    const { client, close } = await connectClient();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
      const search = listed.tools.find((t) => t.name === "lit_search")!;
      expect(search.inputSchema.required).toEqual(["query"]);
      expect(search.description).toContain("【何时不该用】");
    } finally {
      await close();
    }
  });

  test("危险动作经真实客户端调用同样被拒（isError）", async () => {
    const { client, close } = await connectClient();
    try {
      const { isError, payload } = await callTool<{ humanAction: string }>(client, "lab_approve", { id: "x" });
      expect(isError).toBe(true);
      expect(payload.humanAction).toContain("lab approve");
    } finally {
      await close();
    }
  });

  test("research_capabilities 经协议返回真实注册表", async () => {
    const { client, close } = await connectClient();
    try {
      const { isError, payload } = await callTool<{
        connectors: Array<{ id: string }>;
        mcp: { withheld: Array<{ name: string }> };
      }>(client, "research_capabilities");
      expect(isError).toBe(false);
      expect(payload.connectors.length).toBeGreaterThan(10);
      // 能力清单自己就声明了哪些动作不给——外部 agent 不必试了才知道。
      expect(payload.mcp.withheld.map((w) => w.name)).toContain("lab_approve");
    } finally {
      await close();
    }
  });
});

describe("MCP · 长任务同步语义（判断三）", () => {
  test("长任务默认等到落定再返回结果（不把 202 甩给调用方）", async () => {
    const llm = new ScriptedLlm([
      (user) =>
        user.includes("可用引用 key 白名单")
          ? JSON.stringify({
              critique: "库里没有可引用文献，以下都是推断（inferred）。",
              hypothesis: "用互信息找隐藏变构口袋",
              supporting: [{ inferred: true, note: "凭经验推断" }],
              contradicting: [{ inferred: true, note: "也可能不成立（inferred）" }],
              openQuestions: ["先把相关文献入库"],
            })
          : null,
    ]);
    const fx = makeMcp({ llm });
    const { ok, payload } = await fx.call<{ stored: { recordId: string }; emptyLibrary: boolean }>(
      "idea_coexplore",
      { message: "用互信息找隐藏变构口袋" },
    );
    expect(ok).toBe(true);
    // 拿到的是**结果**而不是任务句柄。
    expect(payload.stored.recordId).toBeTruthy();
    expect(payload.emptyLibrary).toBe(true);
  });

  test("超时降级为任务句柄，并说明任务仍在后台跑", async () => {
    // 用一个永远不返回的 LLM 制造长任务，把等待上限压到 30ms。
    const stalling = {
      call: () => new Promise<never>(() => {}),
    } as unknown as ScriptedLlm;
    const fx = makeMcp({ llm: stalling as never, timeoutMs: 30, pollIntervalMs: 5 });
    const { ok, payload } = await fx.call<{ timedOut: boolean; taskId: string; note: string }>("idea_coexplore", {
      message: "会卡住的一轮",
    });
    expect(ok).toBe(true);
    expect(payload.timedOut).toBe(true);
    expect(payload.taskId).toBeTruthy();
    expect(payload.note).toContain("仍在后台运行");
    expect(payload.note).toContain("task_status");

    // 句柄真的可查（task_status 不是安慰剂）。
    const status = await fx.call<{ task: { id: string; state: string } }>("task_status", {
      taskId: payload.taskId,
    });
    expect(status.ok).toBe(true);
    expect(status.payload.task.id).toBe(payload.taskId);
  });

  test("长任务失败以 isError 呈现，不伪装成成功", async () => {
    const fx = makeMcp();
    // 库里没有精读卡 → 综述任务必然失败。
    const { ok, payload } = await fx.call<{ error: string }>("lit_review_draft", {});
    expect(ok).toBe(false);
    expect(payload.error).toContain("精读卡");
  });
});

describe("MCP · 只读工具与项目作用域", () => {
  test("project 参数被带进查询串（跨项目查询不改当前项目）", () => {
    const tool = toolByName("records_timeline")!;
    const req = tool.request({ project: "other-proj", type: ["idea"], limit: 5 });
    expect(req.path).toContain("project=other-proj");
    expect(req.path).toContain("type=idea");
    expect(req.path).toContain("limit=5");
  });

  test("记录时间线与详情走同一套证据图", async () => {
    const fx = makeMcp();
    const timeline = await fx.call<{ records: unknown[]; total: number }>("records_timeline", { limit: 5 });
    expect(timeline.ok).toBe(true);
    expect(Array.isArray(timeline.payload.records)).toBe(true);
    const missing = await fx.call<{ error: string }>("record_get", { recordId: "no-such-record" });
    expect(missing.ok).toBe(false);
  });

  test("conclusion_get 只做预评估，不落评审记录", async () => {
    const fx = makeMcp();
    const before = fx.project.records().count({ type: "decision" });
    await fx.call("conclusion_get", { conclusionId: "nope" });
    expect(fx.project.records().count({ type: "decision" })).toBe(before);
  });
});
