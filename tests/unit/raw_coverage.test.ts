import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpConnector, type HttpConnectorConfig } from "../../backend/src/connectors/base";
import { StubHttp } from "../../backend/src/http/client";
import { ApiCallStore, apiCallStorePath } from "../../backend/src/usage/api_ledger";
import { UsageStore, usageTrackingLlm } from "../../backend/src/usage/ledger";
import { JsonlRawSink, MemoryRawSink, globalRawSink, type RawEntry } from "../../backend/src/raw";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { ProjectManager } from "../../backend/src/project/manager";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

// v0.7 W7-D0 · 门禁 G1（覆盖率）· G2（脱敏）· G7 的运行期半边（rawLlm 真被读）。
//
// G1 的判据不是「我觉得埋了」，是两份既有台账对账：raw/connector 行数 == api_calls.jsonl
// 行数，raw/llm 行数 == usage.jsonl 行数。阴性对照（手工实跑，记在 devlog W7-D0）：删掉
// base.ts 的 appendRaw 调用 → 第一条红；删掉 usage/ledger.ts 的 rawOn 分支 → 第二条红。

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";

const CONFIG: HttpConnectorConfig = {
  baseUrl: "https://example.test/api/",
  description: "测试用 connector（非真实数据源）",
  tools: [{ name: "ping", description: "ping", endpoint: "ping" }],
};

const dirs: string[] = [];
let prevEnv: string | undefined;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.SPARK_RESEARCH_DATA_DIR;
  else process.env.SPARK_RESEARCH_DATA_DIR = prevEnv;
});
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "spark-raw-cov-"));
  dirs.push(root);
  prevEnv = process.env.SPARK_RESEARCH_DATA_DIR;
  process.env.SPARK_RESEARCH_DATA_DIR = root;
  return root;
}

function okResponse(content = "ok"): LlmResponse {
  return {
    ok: true,
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
  };
}

describe("G1 · connector：raw/connector 行数 == api_calls.jsonl 行数（含失败、含无项目兜底）", () => {
  test("注入项目 sink 时落项目目录；不注入落全局兜底；两处合计与台账相等", async () => {
    const root = dataDir();
    const project = new MemoryRawSink({ project: "p1" });
    const withProject = new HttpConnector("c-proj", CONFIG, { http: StubHttp.json({ a: 1 }), rawSink: project });
    const noProject = new HttpConnector("c-global", CONFIG, { http: StubHttp.json({ b: 2 }) });
    const failing = new HttpConnector("c-fail", CONFIG, { http: StubHttp.json({}, 500) });
    await withProject.call("ping", { q: "x" });
    await withProject.call("ping", { q: "y" });
    await noProject.call("ping", {});
    await expect(failing.call("ping", {})).rejects.toThrow(/HTTP 500/);

    const ledgerRows = new ApiCallStore(apiCallStorePath()).readAll().length;
    const projectRows = [...project.iterate({ kind: "connector" })];
    const globalRows = [...globalRawSink().iterate({ kind: "connector" })];
    expect(ledgerRows).toBe(4);
    expect(projectRows.length + globalRows.length).toBe(ledgerRows);
    expect(projectRows.every((e) => e.project === "p1" && e.provenanceClass === "upstream")).toBe(true);
    expect(existsSync(join(root, "raw", "connector", "c-global"))).toBe(true);
    // 失败调用也记（status 500，响应体照样留）。
    const failRow = globalRows.find((e) => (e.payload as { connector: string }).connector === "c-fail")!;
    expect((failRow.payload as { status: number }).status).toBe(500);
    // 参数与响应体真的在。
    const p = projectRows[0]!.payload as { params: Record<string, unknown>; response: { inline: string } };
    expect(p.params).toEqual({ q: "x" });
    expect(p.response.inline).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("G2 · 脱敏：带假 key 的调用之后，raw 目录里 grep 不到它", () => {
  test("connector params 里的 apiKey/token 被替换；LLM options 里的 env 被剥掉", async () => {
    const root = dataDir();
    const sink = new JsonlRawSink(join(root, "raw-p"), { project: "p" });
    const SECRET = "sk-THIS-MUST-NOT-LEAK-9f8e7d";
    const connector = new HttpConnector("c", CONFIG, { http: StubHttp.json({ ok: true }), rawSink: sink });
    await connector.call("ping", { q: "hi", apiKey: SECRET, nested: { token: SECRET, keep: "yes" } });

    const store = new UsageStore(join(root, "usage.jsonl"));
    const llm = usageTrackingLlm({
      llm: { call: async () => okResponse() },
      store,
      command: "lit-read",
      rawSink: sink,
      project: "p",
      configOptions: { env: {} },
    });
    await llm.call([{ role: "user", content: "q" }], { model: "m", env: { OPENROUTER_API_KEY: SECRET } } as never);

    const all = readdirSync(join(root, "raw-p"), { recursive: true }) as string[];
    const texts = all
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(root, "raw-p", f), "utf8"))
      .join("\n");
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.includes(SECRET)).toBe(false);
    expect(texts).toContain("<redacted>");
    expect(texts).toContain('"keep":"yes"');
  });
});

describe("G1 · LLM：raw/llm 行数 == usage.jsonl 行数；rawLlm=off 只关 raw 不关台账", () => {
  test("成功与失败各一次 → usage 2 行、raw 2 行；失败行 response=null 且带 failureKind", async () => {
    const root = dataDir();
    const sink = new MemoryRawSink({ project: "p" });
    const store = new UsageStore(join(root, "usage.jsonl"));
    let n = 0;
    const inner = {
      call: async (_m: ChatMessage[]): Promise<LlmResponse> =>
        n++ === 0
          ? okResponse("answer")
          : {
              ok: false,
              provider: "openrouter",
              model: "m",
              content: "",
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true },
              error: { kind: "rate_limit", message: "429", retryable: true },
            },
    };
    const llm = usageTrackingLlm({ llm: inner, store, command: "chat", rawSink: sink, project: "p", sessionId: "s1", configOptions: { env: {} } });
    await llm.call([{ role: "user", content: "a" }], "m");
    await llm.call([{ role: "user", content: "b" }], "m");
    const raw = [...sink.iterate({ kind: "llm" })];
    expect(store.readAll().length).toBe(2);
    expect(raw.length).toBe(2);
    expect(raw.every((e) => e.provenanceClass === "model_generated" && e.command === "chat" && e.sessionId === "s1")).toBe(true);
    const fail = raw[1]!.payload as { response: unknown; failureKind: string | null; ok: boolean };
    expect(fail.ok).toBe(false);
    expect(fail.response).toBeNull();
    expect(fail.failureKind).toBe("rate_limit");
    const okRow = raw[0]!.payload as { response: { inline: string }; messages: { inline: string } };
    expect(okRow.response.inline).toBe("answer");
    expect(JSON.parse(okRow.messages.inline)).toEqual([{ role: "user", content: "a" }]);
  });

  test("config rawLlm=off：台账照记、raw 不记（G7：这个配置项真有读者）", async () => {
    const root = dataDir();
    const sink = new MemoryRawSink({ project: "p" });
    const store = new UsageStore(join(root, "usage.jsonl"));
    const llm = usageTrackingLlm({
      llm: { call: async () => okResponse() },
      store,
      command: "lit-read",
      rawSink: sink,
      configOptions: { env: { SPARK_RESEARCH_RAW_LLM: "off" } },
    });
    await llm.call([{ role: "user", content: "a" }], "m");
    expect(store.readAll().length).toBe(1);
    expect([...sink.iterate({ kind: "llm" })].length).toBe(0);
  });
});

describe("G1 · kernel：每次 KernelManager.execute 落一行 raw/kernel", () => {
  test("control_repl 执行：项目 sink 注入则落项目；不注入落全局", async () => {
    dataDir();
    const km = new SparkResearchDaemon().kernelManager;
    const sink = new MemoryRawSink({ project: "p" });
    const kid = km.createKernel("control_repl");
    try {
      await km.execute(kid, "1 + 1", { raw: { sink, project: "p", sessionId: "s", command: "chat" } });
      await km.execute(kid, "2 + 2");
    } finally {
      km.dispose(kid);
    }
    const rows = [...sink.iterate({ kind: "kernel" })];
    expect(rows.length).toBe(1);
    const p = rows[0]!.payload as { source: { inline: string }; kernelType: string; executionRecordId: null; contentHash: string };
    expect(p.source.inline).toBe("1 + 1");
    expect(p.kernelType).toBe("control_repl");
    expect(p.executionRecordId).toBeNull(); // V82：execution_records 无生产写入方，D0 如实置 null
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect([...globalRawSink().iterate({ kind: "kernel" })].length).toBe(1);
  });
});

describe("G1 · device：湿实验 analyze 时每个设备读数一行 raw/device", () => {
  test("mock 后端跑完一轮 → raw/device 行数 == readings 数，且 observation 带 provenanceClass=derived", async () => {
    const root = dataDir();
    const manager = new ProjectManager(join(root, "ws"));
    const project = manager.create("wet-raw");
    const loop = new WetLabLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      rawSink: project.raw(),
      root: join(project.paths.experimentsDir, "wet"),
      backend: new MockDeviceBackend(),
    });
    const view = loop.design({ title: "raw 试验", naturalLanguage: PROTOCOL_A });
    loop.compile(view.id);
    loop.safetyCheck(view.id);
    loop.approve(view.id, { actor: "tester" });
    await loop.execute(view.id);
    loop.analyze(view.id);
    const rows = [...project.raw().iterate({ kind: "device" })];
    // readings 在 observation record 的 metadata 里（analyze 返回的是实验视图，不是观察记录）。
    const obs = project.records().list({ type: "observation" })[0]!;
    const readings = (obs.metadata as { readings?: unknown[] }).readings ?? [];
    expect(rows.length).toBe(readings.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.project === "wet-raw" && e.provenanceClass === "derived")).toBe(true);
    expect(obs.provenanceClass).toBe("derived");
    expect(obs.quality).toContain("simulated");
    project.close();
  });
});
