import { describe, expect, test } from "bun:test";
// V95：approve/simulate 不再是 HTTP 审批旁路——两个端点现在都要求一次性令牌。
// `issue()` 是纯函数（node:fs/crypto/path），测试直接调用来铸一枚令牌，不经过
// CLI 的 TTY 门（那道门本身在 tests/unit/lab_cli.test.ts / approval_gate.test.ts
// 已经单独打过），这里只测 HTTP 层「拿到令牌之后怎么校验/消费」。
import { issue as issueApprovalToken } from "../../backend/src/lab/approval_token";
import type { ResearchRecord } from "../../backend/src/project/models";
import { makeServer } from "../helpers/server_scenario";

// P7 · 湿实验端点（AD-6 的 HTTP 落点）。
// 执行后端注入 mock：这里验的是 **HTTP 语义与 approve gate**，不是 opentrons 装没装（那是 wet_e2e）。

const PROTOCOL = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";
const PROTOCOL_B = "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次";
const UNSAFE = "加入10uL盐酸，加入10uL次氯酸钠";

// fx.project 与服务器进程共用同一个 ProjectManager/root（见 server_scenario.ts），
// 所以在这里签发的令牌与 HTTP 层 consume() 读到的是同一份 approval_tokens.json。
function mintToken(fx: ReturnType<typeof makeServer>, experimentId: string): string {
  return issueApprovalToken(fx.project.paths.root, experimentId).token;
}

interface WetView {
  id: string;
  state: string;
  protocolHash: string | null;
  approval: { actor: string; protocolHash: string; decisionRecordId: string } | null;
  rejection: { actor: string; reason: string } | null;
  observationId: string | null;
  runLogEntryCount: number | null;
  summary: Record<string, unknown> | null;
  compiledSteps: Array<{ stepId: string }>;
  safetyChecks: Array<{ check: string; passed: boolean }>;
  unconsumedWarnings: string[];
  record?: unknown;
}

async function compile(fx: ReturnType<typeof makeServer>, protocol = PROTOCOL) {
  const res = await fx.post<{ experiment: WetView; safetyReport: { passed: boolean }; next: string }>(
    "/api/lab/experiments",
    { naturalLanguage: protocol, title: "HTTP 协议" },
  );
  expect(res.status).toBe(201);
  return res.body;
}

describe("HTTP · lab 状态机与后端", () => {
  test("GET /api/lab/machine 暴露 11 状态 + approve gate 口径", async () => {
    const fx = makeServer();
    try {
      const { body } = await fx.get<{
        states: string[];
        transitions: Record<string, string[]>;
        awaiting: string;
        approvalGate: { from: string; to: string; requires: string[] };
        executionGate: { from: string; to: string; consumesApproval: boolean };
      }>("/api/lab/machine");
      // D-10 起 wet_run 拆成 approved / executing，状态数 11 → 12。
      expect(body.states).toHaveLength(12);
      expect(body.awaiting).toBe("awaiting_approval");
      // AD-6：approved 的唯一入边来自 awaiting_approval。这条断言就是「审批门」的机器可读形态。
      const intoApproved = Object.entries(body.transitions).filter(([, tos]) => tos.includes("approved"));
      expect(intoApproved.map(([from]) => from)).toEqual(["awaiting_approval"]);
      expect(body.approvalGate).toMatchObject({ from: "awaiting_approval", to: "approved", requires: ["actor"] });
      // D-10：executing 的唯一入边来自 approved，且这一步消费 approval（重跑要重批）。
      const intoExecuting = Object.entries(body.transitions).filter(([, tos]) => tos.includes("executing"));
      expect(intoExecuting.map(([from]) => from)).toEqual(["approved"]);
      expect(body.executionGate).toMatchObject({ from: "approved", to: "executing", consumesApproval: true });
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/lab/backends 列出后端与默认项", async () => {
    const fx = makeServer();
    try {
      const { body } = await fx.get<{ backends: Array<{ id: string; ok: boolean }>; default: string }>(
        "/api/lab/backends",
      );
      expect(body.backends.map((b) => b.id)).toContain("mock_devices");
      expect(body.default).toBe("opentrons_simulate");
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/lab/devices 仍是 v0.1 形态", async () => {
    const fx = makeServer();
    try {
      const { status, body } = await fx.get<{ devices: Array<{ id: string }> }>("/api/lab/devices");
      expect(status).toBe(200);
      expect(body.devices.length).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · lab compile", () => {
  test("POST /api/lab/experiments 一步走到 awaiting_approval 并明说需要人工确认", async () => {
    const fx = makeServer();
    try {
      const body = await compile(fx);
      expect(body.experiment.state).toBe("awaiting_approval");
      expect(body.experiment.protocolHash).toHaveLength(16);
      expect(body.safetyReport.passed).toBe(true);
      expect(body.next).toContain("安全门通过 ≠ 可以执行");
      // record 本体不塞进实验视图（时间线端点负责它）。
      expect(body.experiment.record).toBeUndefined();
    } finally {
      await fx.stop();
    }
  });

  test("缺 naturalLanguage → 400", async () => {
    const fx = makeServer();
    try {
      const res = await fx.post<{ error: string }>("/api/lab/experiments", { title: "空的" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("naturalLanguage");
    } finally {
      await fx.stop();
    }
  });

  test("安全门拦截 → 422 + 拦截清单（不是 500）", async () => {
    const fx = makeServer();
    try {
      const res = await fx.post<{ error: string; detail: { blocked: Array<{ check: string }> } }>(
        "/api/lab/experiments",
        { naturalLanguage: UNSAFE, title: "危险协议" },
      );
      expect(res.status).toBe(422);
      expect(res.body.detail.blocked.length).toBeGreaterThan(0);
      // 被拦的实验已标 failed，仍能在列表里看到（审计留痕，不是消失）。
      const list = await fx.get<{ experiments: WetView[] }>("/api/lab/experiments?state=failed");
      expect(list.body.experiments).toHaveLength(1);
    } finally {
      await fx.stop();
    }
  });

  // R-d-3（v0.4 P11 lane R-d / V23）：unconsumedWarnings 曾经只在 CLI 的编译与审批输出
  // 里强制显示，HTTP 响应没接——经 Web 批准的人看不到「你写了但安全门没看见」的部分。
  // viewJson() 把整个 WetExperimentView（除 record）原样转发，unconsumedWarnings 是
  // view 的字段之一，所以这里断言的是它**确实**出现在 compile 的 HTTP 响应体里，
  // 不是只存在于 CLI 的正文渲染里。
  // V25（W5-1 δ）：`配制10%次氯酸钠溶液` 这类「浓度 + 单一试剂同句」的写法现在会被
  // extractConcentration() 解析并消费，不再报未消费。换成同句两种试剂的归属歧义场景
  // 保持这条测试的原意（unconsumedWarnings 真的能非空且透传到 HTTP 响应体）。
  test("浓度描述归属歧义时：HTTP 响应体的 unconsumedWarnings 非空（不是只有 CLI 才看得到）", async () => {
    const fx = makeServer();
    try {
      const body = await compile(fx, "配制10%次氯酸钠和乙醇的混合液200uL");
      expect(body.safetyReport.passed).toBe(true); // 安全门四条全过——正是「看不见」的那种危险
      expect(body.experiment.unconsumedWarnings.length).toBeGreaterThan(0);
      expect(body.experiment.unconsumedWarnings.join(" ")).toContain("浓度");
    } finally {
      await fx.stop();
    }
  });

  test("干净协议：HTTP 响应体的 unconsumedWarnings 为空数组", async () => {
    const fx = makeServer();
    try {
      const body = await compile(fx, PROTOCOL);
      expect(body.experiment.unconsumedWarnings).toEqual([]);
    } finally {
      await fx.stop();
    }
  });

  test("重新编译作废先前的 approve", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      const recompiled = await fx.post<{ experiment: WetView; approvalCleared: boolean }>(
        `/api/lab/experiments/${experiment.id}/compile`,
        { naturalLanguage: PROTOCOL_B },
      );
      expect(recompiled.status).toBe(200);
      expect(recompiled.body.approvalCleared).toBe(true);
      expect(recompiled.body.experiment.approval).toBeNull();
      expect(recompiled.body.experiment.state).toBe("awaiting_approval");
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · approve gate（AD-6）", () => {
  test("approve 必须记名：缺 actor → 400，且 HTTP 层不从环境变量猜", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      // 缺 actor 时 400 必须在 actor 校验这一步就发生——即便 approvalToken 也没给，
      // 断言不能因为「先查哪个」的实现顺序而变得脆弱：这条测的是 actor 校验本身。
      const res = await fx.post<{ error: string }>(`/api/lab/experiments/${experiment.id}/approve`, {
        note: "看起来没问题",
        approvalToken: mintToken(fx, experiment.id),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("actor");
      expect(res.body.error).toContain("环境变量");
      // 门没过，状态原地不动。
      const after = await fx.get<{ experiment: WetView }>(`/api/lab/experiments/${experiment.id}`);
      expect(after.body.experiment.state).toBe("awaiting_approval");
    } finally {
      await fx.stop();
    }
  });

  test("approve 落 decision record：谁 / 何时 / 批的哪个 hash / actorSource=http", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      const res = await fx.post<{ experiment: WetView; decisionId: string; decision: ResearchRecord }>(
        `/api/lab/experiments/${experiment.id}/approve`,
        { actor: "李四", note: "复核过步骤表", approvalToken: mintToken(fx, experiment.id) },
      );
      expect(res.status).toBe(200);
      // D-10：approve 只把实验推到 approved，执行权要 execute() 另行原子声明。
      expect(res.body.experiment.state).toBe("approved");
      expect(res.body.experiment.approval?.actor).toBe("李四");
      expect(res.body.experiment.approval?.protocolHash).toBe(experiment.protocolHash!);
      const decision = res.body.decision;
      expect(decision.type).toBe("decision");
      expect(decision.evidence).toBe("inferred");
      expect(decision.metadata.actor).toBe("李四");
      // 审计能分清「网页批的」与「命令行批的」。
      expect(decision.metadata.actorSource).toBe("http:explicit");
      expect(decision.metadata.protocolHash).toBe(experiment.protocolHash);
      expect(decision.content).toContain("李四");
    } finally {
      await fx.stop();
    }
  });

  test("reject 必须给理由；落 decision record 并转 rejected", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      const missing = await fx.post(`/api/lab/experiments/${experiment.id}/reject`, { actor: "王五" });
      expect(missing.status).toBe(400);
      const res = await fx.post<{ experiment: WetView; decision: ResearchRecord }>(
        `/api/lab/experiments/${experiment.id}/reject`,
        { actor: "王五", reason: "试剂浓度需要复核" },
      );
      expect(res.status).toBe(200);
      expect(res.body.experiment.state).toBe("rejected");
      expect(res.body.experiment.rejection?.reason).toBe("试剂浓度需要复核");
      expect(res.body.decision.metadata.decision).toBe("reject");
    } finally {
      await fx.stop();
    }
  });

  test("未 approve 直接 simulate → 任务失败（gate 绕不过，即便带了合法令牌）", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      // V95：令牌门与状态机门是两道独立的门——令牌本身合法（correctly minted、没过期、
      // 没用过）只说明「这次调用有权限尝试」，不代表「这次调用一定成功」。这里故意给一枚
      // 合法令牌，证明真正拦下执行的是 execute() 内部的状态检查，不是令牌校验碰巧失败。
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      expect(res.status).toBe(500);
      expect(res.task.state).toBe("failed");
      expect(res.task.error?.message).toContain("未经 approve 不能执行");
      const after = await fx.get<{ experiment: WetView }>(`/api/lab/experiments/${experiment.id}`);
      expect(after.body.experiment.state).toBe("awaiting_approval");
    } finally {
      await fx.stop();
    }
  });

  test("非 awaiting_approval 状态 approve → 409（即便第二次也带了合法令牌）", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      // 第二次 approve 必须另外铸一枚令牌——上一枚已经被消费，这里不是在测令牌，
      // 是要证明令牌门通过之后，状态机门依然独立地把第二次 approve 拦下来。
      const again = await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      expect(again.status).toBe(409);
    } finally {
      await fx.stop();
    }
  });

  test("不存在的实验 → 404", async () => {
    const fx = makeServer();
    try {
      expect((await fx.get("/api/lab/experiments/missing")).status).toBe(404);
      // consume() 只认「令牌 hash 对得上 + 绑的 experimentId 一致」，不关心那个
      // experimentId 背后是否真有一份实验——这里特地铸一枚绑到 "missing" 的令牌，
      // 让它顺利通过令牌门，这样断言到的 404 确凿来自 wetLoop().approve() 的
      // not-found（状态机层），而不是被令牌校验先一步截胡成别的状态码。
      const missingId = "missing";
      const tokenBoundToMissing = mintToken(fx, missingId);
      const res = await fx.post(`/api/lab/experiments/${missingId}/approve`, {
        actor: "张三",
        approvalToken: tokenBoundToMissing,
      });
      expect(res.status).toBe(404);
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · lab simulate", () => {
  test("approve → simulate 走完 collect/analyze，产出 observation", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      // approve 已经把第一枚令牌用掉了——simulate 是另一条「触发执行的路由」，
      // 必须重新铸一枚，不能复用 approve 那枚（这正是任务书 e2e 场景要验的单次消费）。
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
        conclude: "OD 读数在预期区间",
      });
      expect(res.status).toBe(200);
      expect(res.task.state).toBe("succeeded");
      const view = (res.task.result as { experiment: WetView }).experiment;
      expect(view.state).toBe("concluded");
      expect(view.observationId).toBeTruthy();
      // 任务进度是真的：每一步都留了一条事件。
      expect(res.task.events.filter((e) => e.type === "progress").length).toBeGreaterThanOrEqual(3);

      const observation = await fx.get<{ record: ResearchRecord }>(`/api/records/${view.observationId}`);
      // 湿实验的执行产出是被观察到的，不是算出来的（P6 口径）。
      expect(observation.body.record.evidence).toBe("observed");
      expect(observation.body.record.metadata.simulated).toBe(true);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/lab/experiments?state=... 过滤；未知状态 → 400", async () => {
    const fx = makeServer();
    try {
      await compile(fx);
      const waiting = await fx.get<{ experiments: WetView[] }>("/api/lab/experiments?state=awaiting_approval");
      expect(waiting.body.experiments).toHaveLength(1);
      expect((await fx.get("/api/lab/experiments?state=nope")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });
});

// V95（BACKLOG）：`POST /approve` 与 `/simulate` 不再是 HTTP 审批旁路——一次性令牌
// 缺失/错误/过期/已用一律 403，且消息里指路径。「过期」单独在
// tests/unit/w8_epsilon_approval_token.test.ts 里用手工写脏 approval_tokens.json
// 的方式测（等真实 10 分钟太不现实，也不该在这里靠改系统时钟）。
describe("HTTP · V95 一次性审批令牌（approve/simulate 不再是 HTTP 旁路）", () => {
  test("approve 缺 approvalToken → 403，消息指路径", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      const res = await fx.post<{ error: string }>(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("approvalToken");
      expect(res.body.error).toContain("spark-research lab token");
      const after = await fx.get<{ experiment: WetView }>(`/api/lab/experiments/${experiment.id}`);
      expect(after.body.experiment.state).toBe("awaiting_approval");
    } finally {
      await fx.stop();
    }
  });

  test("approve 令牌错误（篡改/伪造）→ 403", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      mintToken(fx, experiment.id); // 签发一枚真的，但下面故意不用它——测的是伪造值。
      const res = await fx.post<{ error: string }>(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: "not-a-real-token-0123456789abcdef",
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("无效");
    } finally {
      await fx.stop();
    }
  });

  test("approve 令牌绑的是另一个实验 → 403（不能跨实验借用）", async () => {
    const fx = makeServer();
    try {
      const { experiment: a } = await compile(fx, PROTOCOL);
      const { experiment: b } = await compile(fx, PROTOCOL_B);
      const tokenForA = mintToken(fx, a.id);
      const res = await fx.post<{ error: string }>(`/api/lab/experiments/${b.id}/approve`, {
        actor: "张三",
        approvalToken: tokenForA,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("无效");
    } finally {
      await fx.stop();
    }
  });

  test("approve 令牌只能用一次：第一次 200，第二次同一枚 → 403", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      const token = mintToken(fx, experiment.id);
      const first = await fx.post(`/api/lab/experiments/${experiment.id}/approve`, { actor: "张三", approvalToken: token });
      expect(first.status).toBe(200);
      // 重新编译作废先前的 approve，好让第二次 approve 请求能再次走到「令牌校验」
      // 这一步而不是先被状态机拦成 409——这条测的是令牌单次消费，不是状态机。
      await fx.post(`/api/lab/experiments/${experiment.id}/compile`, { naturalLanguage: PROTOCOL });
      const second = await fx.post<{ error: string }>(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: token,
      });
      expect(second.status).toBe(403);
      expect(second.body.error).toContain("已被使用过");
    } finally {
      await fx.stop();
    }
  });

  test("simulate 缺 actor → 400（与 approve 同一条纪律：HTTP 层不从环境变量猜审批人）", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, {
        approvalToken: mintToken(fx, experiment.id),
      });
      expect(res.status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("simulate 缺 approvalToken → 403", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, { actor: "张三" });
      expect(res.status).toBe(403);
    } finally {
      await fx.stop();
    }
  });

  // 任务书 e2e 场景的核心断言：**同一枚令牌**只能兑现一次，approve 用掉之后不能
  // 拿去 simulate——这不是两条规则各自独立的单次消费，是**同一个令牌账本**的单次消费。
  test("同一枚令牌：approve 用掉之后，拿它去 simulate → 403（跨端点单次消费）", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      const token = mintToken(fx, experiment.id);
      const approveRes = await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: token,
      });
      expect(approveRes.status).toBe(200);
      const simulateRes = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, {
        actor: "张三",
        approvalToken: token,
      });
      expect(simulateRes.status).toBe(403);
      // 状态没有被这次被拒的 simulate 调用推进——approved 原地不动。
      const after = await fx.get<{ experiment: WetView }>(`/api/lab/experiments/${experiment.id}`);
      expect(after.body.experiment.state).toBe("approved");
    } finally {
      await fx.stop();
    }
  });

  // **阴性对照**（devlog 里要求「路由去掉令牌校验 → 红」的那一条，在这里用等价形式实跑）：
  // 如果 approve 路由不再校验/消费令牌，上面「用掉之后 simulate 会 403」这条断言就必须
  // 落空——因为这套测试就是靠 approve 端点本身完成消费的。用一枚从未在 approve 端点
  // 出现过的全新令牌去 simulate，等价地证明「没被消费过的合法令牌能让 simulate 通过
  // 令牌门」，从而反证上面那条测试测的确实是「消费」而不是别的东西碰巧失败。
  test("对照：从未被消费过的合法令牌可以让 simulate 通过令牌门（证明上面测的是『消费』本身）", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, {
        actor: "张三",
        approvalToken: mintToken(fx, experiment.id),
      });
      const freshToken = mintToken(fx, experiment.id);
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, {
        actor: "张三",
        approvalToken: freshToken,
      });
      // 令牌门必须放行（不是 403）——真正会不会跑完是 wet_loop 状态机的事，
      // 这里只断言没有被令牌校验挡在门外。
      expect(res.status).not.toBe(403);
    } finally {
      await fx.stop();
    }
  });
});
