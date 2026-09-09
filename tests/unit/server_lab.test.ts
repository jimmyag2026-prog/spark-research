import { describe, expect, test } from "bun:test";
import type { ResearchRecord } from "../../backend/src/project/models";
import { makeServer } from "../helpers/server_scenario";

// P7 · 湿实验端点（AD-6 的 HTTP 落点）。
// 执行后端注入 mock：这里验的是 **HTTP 语义与 approve gate**，不是 opentrons 装没装（那是 wet_e2e）。

const PROTOCOL = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";
const PROTOCOL_B = "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次";
const UNSAFE = "加入10uL盐酸，加入10uL次氯酸钠";

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
      }>("/api/lab/machine");
      expect(body.states).toHaveLength(11);
      expect(body.awaiting).toBe("awaiting_approval");
      // AD-6：wet_run 的唯一入边来自 awaiting_approval。这条断言就是「门」的机器可读形态。
      const intoWetRun = Object.entries(body.transitions).filter(([, tos]) => tos.includes("wet_run"));
      expect(intoWetRun.map(([from]) => from)).toEqual(["awaiting_approval"]);
      expect(body.approvalGate).toMatchObject({ from: "awaiting_approval", to: "wet_run", requires: ["actor"] });
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

  test("重新编译作废先前的 approve", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, { actor: "张三" });
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
      const res = await fx.post<{ error: string }>(`/api/lab/experiments/${experiment.id}/approve`, {
        note: "看起来没问题",
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
        { actor: "李四", note: "复核过步骤表" },
      );
      expect(res.status).toBe(200);
      expect(res.body.experiment.state).toBe("wet_run");
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

  test("未 approve 直接 simulate → 任务失败（gate 绕不过）", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`);
      expect(res.status).toBe(500);
      expect(res.task.state).toBe("failed");
      expect(res.task.error?.message).toContain("未经 approve 不能执行");
      const after = await fx.get<{ experiment: WetView }>(`/api/lab/experiments/${experiment.id}`);
      expect(after.body.experiment.state).toBe("awaiting_approval");
    } finally {
      await fx.stop();
    }
  });

  test("非 awaiting_approval 状态 approve → 409", async () => {
    const fx = makeServer();
    try {
      const { experiment } = await compile(fx);
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, { actor: "张三" });
      const again = await fx.post(`/api/lab/experiments/${experiment.id}/approve`, { actor: "张三" });
      expect(again.status).toBe(409);
    } finally {
      await fx.stop();
    }
  });

  test("不存在的实验 → 404", async () => {
    const fx = makeServer();
    try {
      expect((await fx.get("/api/lab/experiments/missing")).status).toBe(404);
      expect((await fx.post("/api/lab/experiments/missing/approve", { actor: "张三" })).status).toBe(404);
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
      await fx.post(`/api/lab/experiments/${experiment.id}/approve`, { actor: "张三" });
      const res = await fx.run(`/api/lab/experiments/${experiment.id}/simulate`, {
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
