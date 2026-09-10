import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpConnector, type HttpConnectorConfig } from "../../backend/src/connectors/base";
import { BufferedResponse, HttpTimeoutError, StubHttp } from "../../backend/src/http/client";
import { ApiCallStore, apiCallStorePath } from "../../backend/src/usage/api_ledger";
import { runUsageApiCommand } from "../../backend/src/cli/usage";
import { createApp } from "../../backend/src/server/app";
import { ProjectManager } from "../../backend/src/project/manager";

// W6-1 α（v0.6）：connector 调用台账。埋点在 connectors/base.ts 一处
// （HttpConnector.requestRaw），全体 connector 自动覆盖——这里用一个最小的
// 自定义 connector config（不是任何真实数据源）验证埋点本身，不依赖任何
// 真实网络（http 全部走注入的 StubHttp）。

const CONFIG: HttpConnectorConfig = {
  baseUrl: "https://example.test/api/",
  description: "测试用 connector（非真实数据源）",
  tools: [{ name: "ping", description: "ping", endpoint: "ping" }],
};

// 台账落在全局 dataDir()，用 SPARK_RESEARCH_DATA_DIR 隔离到每个测试自己的 mkdtemp
// 目录——与 tests/unit/extensions.test.ts 等既有测试同一套隔离手法。
const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function withDataDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "spark-api-ledger-"));
  cleanupDirs.push(root);
  const prev = process.env.SPARK_RESEARCH_DATA_DIR;
  process.env.SPARK_RESEARCH_DATA_DIR = root;
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) delete process.env.SPARK_RESEARCH_DATA_DIR;
    else process.env.SPARK_RESEARCH_DATA_DIR = prev;
  }
}

describe("W6-1 α · base.ts 埋点：三分支都落账", () => {
  test("成功（2xx）落一行，host 正确、rateLimitWaitMs=0", async () => {
    await withDataDir(async () => {
      const http = StubHttp.json({ hello: "world" });
      const connector = new HttpConnector("test-connector", CONFIG, { http });
      await connector.call("ping", {});

      const store = new ApiCallStore(apiCallStorePath());
      const entries = store.readAll();
      expect(entries.length).toBe(1);
      expect(entries[0]!.connector).toBe("test-connector");
      expect(entries[0]!.host).toBe("example.test");
      expect(entries[0]!.status).toBe(200);
      expect(typeof entries[0]!.latencyMs).toBe("number");
      expect(entries[0]!.latencyMs).toBeGreaterThanOrEqual(0);
      expect(entries[0]!.rateLimitWaitMs).toBe(0);
    });
  });

  test("429 落账、抛错但记录不受影响，计入 count429", async () => {
    await withDataDir(async () => {
      const http = new StubHttp(
        () => new BufferedResponse({ status: 429, body: new TextEncoder().encode("{}") }),
      );
      const connector = new HttpConnector("test-connector", CONFIG, { http });
      await expect(connector.call("ping", {})).rejects.toThrow(/HTTP 429/);

      const store = new ApiCallStore(apiCallStorePath());
      const entries = store.readAll();
      expect(entries.length).toBe(1);
      expect(entries[0]!.status).toBe(429);
      const totals = store.totals();
      expect(totals.count429).toBe(1);
      expect(totals.byConnector["test-connector"]!.count429).toBe(1);
    });
  });

  test("超时落账为 status='timeout'（与 4xx/5xx 结构上不同）", async () => {
    await withDataDir(async () => {
      const http = new StubHttp(() => {
        throw new HttpTimeoutError("https://example.test/api/ping", 5000);
      });
      const connector = new HttpConnector("test-connector", CONFIG, { http });
      await expect(connector.call("ping", {})).rejects.toBeInstanceOf(HttpTimeoutError);

      const store = new ApiCallStore(apiCallStorePath());
      const entries = store.readAll();
      expect(entries.length).toBe(1);
      expect(entries[0]!.status).toBe("timeout");
      expect(store.totals().otherNon2xx).toBe(1);
    });
  });

  test("非超时的网络异常落账为 error:<类名>", async () => {
    await withDataDir(async () => {
      class FakeSocketError extends Error {}
      const http = new StubHttp(() => {
        throw new FakeSocketError("connection reset");
      });
      const connector = new HttpConnector("test-connector", CONFIG, { http });
      await expect(connector.call("ping", {})).rejects.toThrow("connection reset");

      const store = new ApiCallStore(apiCallStorePath());
      const entries = store.readAll();
      expect(entries[0]!.status).toBe("error:FakeSocketError");
    });
  });

  test("URL 查询参数（可能含凭据）绝不落盘，台账只留 host", async () => {
    await withDataDir(async () => {
      const http = StubHttp.json({ ok: true });
      const connector = new HttpConnector("test-connector", CONFIG, { http });
      await connector.call("ping", { apiKey: "super-secret-token-do-not-leak" });

      // StubHttp 自己确实收到了带凭据的完整 url——验证测试构造本身有意义。
      expect(http.calls[0]!.url).toContain("super-secret-token-do-not-leak");

      const raw = readFileSync(apiCallStorePath(), "utf8");
      expect(raw).not.toContain("super-secret-token-do-not-leak");
      expect(raw).not.toContain("apiKey");
      expect(raw).not.toContain("https://");

      const store = new ApiCallStore(apiCallStorePath());
      expect(store.readAll()[0]!.host).toBe("example.test");
    });
  });
});

describe("W6-1 α · ApiCallStore.totals() 聚合", () => {
  test("分 connector / host 聚合次数、429/401/其他非2xx、平均与最大延迟", async () => {
    await withDataDir(async () => {
      const store = new ApiCallStore(apiCallStorePath());
      store.append({ ts: "t1", connector: "aminer", host: "aminer.example", status: 200, latencyMs: 100, rateLimitWaitMs: 0 });
      store.append({ ts: "t2", connector: "aminer", host: "aminer.example", status: 429, latencyMs: 300, rateLimitWaitMs: 0 });
      store.append({ ts: "t3", connector: "pubmed", host: "eutils.ncbi.nlm.nih.gov", status: 401, latencyMs: 50, rateLimitWaitMs: 0 });
      store.append({ ts: "t4", connector: "pubmed", host: "eutils.ncbi.nlm.nih.gov", status: "timeout", latencyMs: 5000, rateLimitWaitMs: 0 });

      const totals = store.totals();
      expect(totals.calls).toBe(4);
      expect(totals.count429).toBe(1);
      expect(totals.count401).toBe(1);
      expect(totals.otherNon2xx).toBe(1); // 只有 timeout；429/401 单独计
      expect(totals.maxLatencyMs).toBe(5000);
      expect(totals.avgLatencyMs).toBeCloseTo((100 + 300 + 50 + 5000) / 4);

      expect(totals.byConnector["aminer"]!.calls).toBe(2);
      expect(totals.byConnector["aminer"]!.count429).toBe(1);
      expect(totals.byConnector["aminer"]!.avgLatencyMs).toBeCloseTo((100 + 300) / 2);
      expect(totals.byConnector["pubmed"]!.count401).toBe(1);
      expect(totals.byConnector["pubmed"]!.otherNon2xx).toBe(1);

      expect(totals.byHost["aminer.example"]!.calls).toBe(2);
      expect(totals.byHost["eutils.ncbi.nlm.nih.gov"]!.calls).toBe(2);
    });
  });

  test("corruptLines：坏行计数但不让 totals() 崩", async () => {
    await withDataDir(async () => {
      const store = new ApiCallStore(apiCallStorePath());
      store.append({ ts: "t1", connector: "x", host: "h", status: 200, latencyMs: 1, rateLimitWaitMs: 0 });
      const { appendFileSync } = await import("node:fs");
      appendFileSync(apiCallStorePath(), "not-json\n");
      appendFileSync(apiCallStorePath(), `${JSON.stringify({ missing: "fields" })}\n`);

      const totals = store.totals();
      expect(totals.calls).toBe(1);
      expect(store.corruptLines()).toBe(2);
    });
  });

  test("写盘失败不打断调用方：append 到一个不可写路径不抛异常", async () => {
    // 台账是观测，不是业务——见 api_ledger.ts ApiCallStore.append 的注释。
    // 用一个目录路径当"文件"制造一个必然失败的写入（mkdirSync 会在已存在的
    // 同名普通文件路径下再建目录，触发 ENOTDIR/EEXIST 类错误）。
    await withDataDir(async (root) => {
      const impossiblePath = join(root, "not-a-dir", "..", "..", "\0invalid");
      const store = new ApiCallStore(impossiblePath);
      expect(() =>
        store.append({ ts: "t1", connector: "x", host: "h", status: 200, latencyMs: 1, rateLimitWaitMs: 0 }),
      ).not.toThrow();
    });
  });
});

describe("W6-1 α · usage api CLI", () => {
  test("--json 输出与 ApiCallStore.totals() 同形状", async () => {
    await withDataDir(async () => {
      const store = new ApiCallStore(apiCallStorePath());
      store.append({ ts: "t1", connector: "aminer", host: "aminer.example", status: 200, latencyMs: 10, rateLimitWaitMs: 0 });

      const lines: string[] = [];
      const code = runUsageApiCommand(true, { out: (l) => lines.push(l) });
      expect(code).toBe(0);
      const parsed = JSON.parse(lines.join("\n"));
      expect(parsed.calls).toBe(1);
      expect(parsed.byConnector.aminer.calls).toBe(1);
      expect(parsed.corruptLines).toBe(0);
    });
  });

  test("人类可读输出把 429/401 单独成列", async () => {
    await withDataDir(async () => {
      const store = new ApiCallStore(apiCallStorePath());
      store.append({ ts: "t1", connector: "aminer", host: "h", status: 429, latencyMs: 10, rateLimitWaitMs: 0 });

      const lines: string[] = [];
      runUsageApiCommand(false, { out: (l) => lines.push(l) });
      const joined = lines.join("\n");
      expect(joined).toContain("429");
      expect(joined).toContain("aminer");
    });
  });

  test("没有记录时给出可读的空态提示，不是裸的 0", async () => {
    await withDataDir(async () => {
      const lines: string[] = [];
      runUsageApiCommand(false, { out: (l) => lines.push(l) });
      expect(lines.join("\n")).toContain("还没有 API 调用记录");
    });
  });
});

describe("W6-1 α · HTTP 端点契约", () => {
  test("GET /api/usage/api 返回 ApiCallStore.totals() 形状（全局，不需要 ?project）", async () => {
    await withDataDir(async (root) => {
      const manager = new ProjectManager(root);
      manager.create("demo", { name: "demo", description: "" }).close();
      const store = new ApiCallStore(apiCallStorePath({ root }));
      store.append({ ts: "t1", connector: "aminer", host: "aminer.example", status: 200, latencyMs: 10, rateLimitWaitMs: 0 });

      const app = createApp({ root, projects: manager });
      const res = await app.fetch(new Request("http://spark.local/api/usage/api"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { calls: number; byConnector: Record<string, unknown> };
      expect(body.calls).toBe(1);
      expect(body.byConnector["aminer"]).toBeDefined();
    });
  });

  test("GET /api/usage?project=<slug> 返回 UsageStore.totals() + project 字段", async () => {
    await withDataDir(async (root) => {
      const manager = new ProjectManager(root);
      const created = manager.create("demo2", { name: "demo2", description: "" });
      const slug = created.slug;
      created.close();

      const app = createApp({ root, projects: manager });
      const res = await app.fetch(new Request(`http://spark.local/api/usage?project=${slug}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { project: string; calls: number };
      expect(body.project).toBe(slug);
      expect(body.calls).toBe(0);
    });
  });
});

describe("W6-1 α · 门禁：URL 绝不进入台账落盘字段构造（凭据红线）", () => {
  // 读源码文本、而不是跑一次真实请求再断言输出里没有 url——运行时断言只能证明
  // 「这一次巧合没漏」，读源码能证明「构造这一行的代码里压根没有引用 url 变量」，
  // 后者才是真正堵死「以后有人手滑加回 url:」这条路的门禁。
  function extractCall(src: string, marker: string): string {
    const start = src.indexOf(marker);
    if (start === -1) throw new Error(`marker not found in source: ${marker}`);
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced parens while extracting: ${marker}`);
    return src.slice(start, end + 1);
  }

  test("connectors/base.ts 里 recordApiCall(...) 调用点不引用 url，只传 host", () => {
    const src = readFileSync(join(import.meta.dir, "../../backend/src/connectors/base.ts"), "utf8");
    const call = extractCall(src, "recordApiCall(");
    expect(call).toMatch(/\bhost\b/);
    expect(call).not.toMatch(/\burl\b/);
  });

  test("usage/api_ledger.ts 里 store.append(...) 的落盘对象构造不引用 url", () => {
    const src = readFileSync(join(import.meta.dir, "../../backend/src/usage/api_ledger.ts"), "utf8");
    const call = extractCall(src, "store.append({");
    expect(call).not.toMatch(/\burl\b/i);
  });

  test("ApiCallEntry 类型声明本身没有 url 字段", () => {
    const src = readFileSync(join(import.meta.dir, "../../backend/src/usage/api_ledger.ts"), "utf8");
    const start = src.indexOf("export interface ApiCallEntry");
    const end = src.indexOf("\n}", start);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/\burl\s*:/);
  });
});
