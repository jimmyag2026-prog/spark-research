import { describe, expect, test } from "bun:test";
import { makeServer } from "../helpers/server_scenario";

// P7 · 干实验端点。仿真走 pyref（零依赖、秒级），所以这些用例是真跑，不是打桩。

const FAST = { steps: 200, sampleInterval: 20 };

interface DryView {
  id: string;
  state: string;
  platform: string;
  simKind: string;
  params: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  observationId: string | null;
  conclusionId: string | null;
  record?: unknown;
}

async function design(fx: ReturnType<typeof makeServer>, title = "阻尼振子基线") {
  const res = await fx.post<{ experiment: DryView }>("/api/experiments", {
    title,
    params: FAST,
    hypothesis: "能量单调衰减",
  });
  expect(res.status).toBe(201);
  return res.body.experiment;
}

describe("HTTP · experiments 状态机与平台", () => {
  test("GET /api/experiments/machine 给出 7 状态与 7 条合法转移", async () => {
    const fx = makeServer();
    try {
      const { body } = await fx.get<{
        states: string[];
        transitions: Record<string, string[]>;
        terminal: string[];
        awaiting: null;
      }>("/api/experiments/machine");
      expect(body.states).toHaveLength(7);
      expect(Object.values(body.transitions).flat()).toHaveLength(7);
      expect(body.terminal).toEqual(["concluded", "iterated"]);
      // 干实验没有停留态——等待发生在 dry_run 内部。与湿实验刻意不同。
      expect(body.awaiting).toBeNull();
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/experiments/platforms 报可用性", async () => {
    const fx = makeServer();
    try {
      const { body } = await fx.get<{ platforms: Array<{ id: string; ok: boolean }>; default: string }>(
        "/api/experiments/platforms",
      );
      expect(body.default).toBe("pyref");
      expect(body.platforms.find((p) => p.id === "pyref")?.ok).toBe(true);
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · experiments 生命周期", () => {
  test("POST /api/experiments 建实验，默认平台/种类自动补齐", async () => {
    const fx = makeServer();
    try {
      const view = await design(fx);
      expect(view.state).toBe("design");
      expect(view.platform).toBe("pyref");
      expect(view.simKind).toBe("damped-oscillator");
      expect(view.params.steps).toBe(200);
      expect(view.record).toBeUndefined();
    } finally {
      await fx.stop();
    }
  });

  test("非法参数在 design 阶段就被拒（400，不建半成品）", async () => {
    const fx = makeServer();
    try {
      const res = await fx.post<{ error: string }>("/api/experiments", {
        title: "坏参数",
        params: { steps: -5 },
      });
      expect(res.status).toBe(400);
      const list = await fx.get<{ experiments: DryView[] }>("/api/experiments");
      expect(list.body.experiments).toHaveLength(0);
    } finally {
      await fx.stop();
    }
  });

  test("缺 title → 400；未知平台 → 400", async () => {
    const fx = makeServer();
    try {
      expect((await fx.post("/api/experiments", { params: FAST })).status).toBe(400);
      expect((await fx.post("/api/experiments", { title: "X", platform: "nope" })).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("POST /:id/run 跑完闭环：dry_run → collect → analyze，产出 observation", async () => {
    const fx = makeServer();
    try {
      const designed = await design(fx);
      const res = await fx.run(`/api/experiments/${designed.id}/run`, { pollIntervalMs: 50 });
      expect(res.status).toBe(200);
      expect(res.task.state).toBe("succeeded");
      const view = (res.task.result as { experiment: DryView }).experiment;
      expect(view.state).toBe("analyze");
      expect(view.observationId).toBeTruthy();
      expect(view.summary).toBeTruthy();

      const observation = await fx.get<{ record: { evidence: string } }>(`/api/records/${view.observationId}`);
      // 干实验的结果是算出来的（与湿实验的 observed 分开）。
      expect(observation.body.record.evidence).toBe("computed");
    } finally {
      await fx.stop();
    }
  });

  test("run --conclude 落结论卡，review 一律 pending", async () => {
    const fx = makeServer();
    try {
      const designed = await design(fx);
      const res = await fx.run(`/api/experiments/${designed.id}/run`, {
        pollIntervalMs: 50,
        conclude: "阻尼确实让能量单调衰减",
      });
      const view = (res.task.result as { experiment: DryView }).experiment;
      expect(view.state).toBe("concluded");
      const conclusion = await fx.get<{ record: { metadata: Record<string, unknown> } }>(
        `/api/records/${view.conclusionId}`,
      );
      expect(conclusion.body.record.metadata.review).toBe("pending");
    } finally {
      await fx.stop();
    }
  });

  test("GET /:id 带 runStatus；未知 id → 404", async () => {
    const fx = makeServer();
    try {
      const designed = await design(fx);
      const before = await fx.get<{ experiment: DryView; runStatus: unknown }>(
        `/api/experiments/${designed.id}`,
      );
      expect(before.status).toBe(200);
      expect(before.body.runStatus).toBeNull();
      await fx.run(`/api/experiments/${designed.id}/run`, { pollIntervalMs: 50 });
      const after = await fx.get<{ runStatus: { state: string } | null }>(`/api/experiments/${designed.id}`);
      expect(after.body.runStatus?.state).toBe("completed");
      expect((await fx.get("/api/experiments/missing")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("列表按 state / platform 过滤；未知 state → 400", async () => {
    const fx = makeServer();
    try {
      await design(fx, "A");
      await design(fx, "B");
      const all = await fx.get<{ experiments: DryView[] }>("/api/experiments");
      expect(all.body.experiments).toHaveLength(2);
      const byState = await fx.get<{ experiments: DryView[] }>("/api/experiments?state=design");
      expect(byState.body.experiments).toHaveLength(2);
      const byPlatform = await fx.get<{ experiments: DryView[] }>("/api/experiments?platform=openmm");
      expect(byPlatform.body.experiments).toHaveLength(0);
      expect((await fx.get("/api/experiments?state=nope")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("非法状态转移 → 409（conclude 一个还没跑的实验）", async () => {
    const fx = makeServer();
    try {
      const designed = await design(fx);
      const res = await fx.post(`/api/experiments/${designed.id}/conclude`, { claim: "太早了" });
      expect(res.status).toBe(409);
    } finally {
      await fx.stop();
    }
  });
});
