import { describe, expect, test } from "bun:test";
import { BufferedResponse, HttpTimeoutError, StubHttp, type HttpClient, type HttpRequestInit } from "../../backend/src/http/client";
import {
  SEMANTIC_THRESHOLDS,
  embeddingCassette,
  isCalibrated,
  semanticHighAffinity,
} from "../../backend/src/llm/embeddings/calibration";
import {
  DEFAULT_EMBED_BATCH_LIMIT,
  OpenAiCompatEmbeddingAdapter,
} from "../../backend/src/llm/embeddings/openai_compat";
import {
  EMBED_BATCH_CHARS,
  EmbeddingRouter,
  chunkByCharBudget,
  parseEmbeddingModelId,
  supportedEmbeddingProviders,
} from "../../backend/src/llm/embeddings/router";
import { cosine, embedFailure, embedOk } from "../../backend/src/llm/embeddings/types";

// v0.5 C4 · embedding 抽象层单测。
//
// 重点在**失败面**：AD-13 要求「失败无内容可用」，这一层的具体形态是
// `ok:false ⇒ vectors === null`。下面每一条失败路径都要能被调用方看见，
// 而不是变成一批看起来算过了的零向量。

function jsonHttp(payload: unknown, status = 200): StubHttp {
  return new StubHttp(
    () =>
      new BufferedResponse({
        status,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify(payload)),
      }),
  );
}

function wire(vectors: number[][], usage?: { prompt_tokens: number; total_tokens: number }) {
  return {
    object: "list",
    data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
    model: "test-model",
    ...(usage ? { usage } : {}),
  };
}

const baseRequest = {
  model: "test-model",
  apiKey: null,
  baseUrl: "http://localhost:11434/v1",
  timeoutMs: 1000,
};

describe("cosine", () => {
  test("正交 / 同向 / 反向的数值钉死", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
    expect(cosine([3, 4], [4, 3])).toBeCloseTo(24 / 25, 10);
    // 长度不影响：余弦只看方向
    expect(cosine([1, 1], [5, 5])).toBeCloseTo(1, 10);
  });

  test("维度不一致抛异常，不静默算出一个数", () => {
    expect(() => cosine([1, 2, 3], [1, 2])).toThrow(/维度不一致/);
  });

  test("零向量返回 0 而不是 1/NaN——「方向未定义」绝不能被解释成「完全相似」", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosine([0, 0], [0, 0])).toBe(0);
    expect(Number.isNaN(cosine([0, 0], [0, 0]))).toBe(false);
  });
});

describe("EmbedResponse 的 AD-13 不变式", () => {
  test("失败响应的 vectors 恒为 null、error 必填、usage 恒为不可用", () => {
    const failed = embedFailure({ provider: "local", model: "m", kind: "upstream", message: "炸了" });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.vectors).toBeNull();
    expect(failed.dims).toBeNull();
    expect(failed.usage).toEqual({ tokens: 0, costUsd: null, usageUnavailable: true });
    expect(failed.error.kind).toBe("upstream");
  });

  test("错误消息过一遍脱敏：凭据不进任何输出", () => {
    const failed = embedFailure({
      provider: "openai",
      model: "m",
      kind: "auth",
      message: 'HTTP 401: {"api_key": "sk-abcdefghijklmnop"}',
    });
    if (failed.ok) return;
    expect(failed.error.message).not.toContain("sk-abcdefghijklmnop");
    expect(failed.error.message).toContain("[redacted]");
  });

  test("成功响应的 dims 从向量派生，不必手写", () => {
    const ok = embedOk({ provider: "local", model: "m", vectors: [[1, 2, 3]] });
    expect(ok.ok).toBe(true);
    expect(ok.dims).toBe(3);
    expect(ok.usage.costUsd).toBeNull();
  });
});

describe("OpenAiCompatEmbeddingAdapter", () => {
  test("正常路径：POST {baseUrl}/embeddings，按 index 排序，usage 如实透传", async () => {
    const http = jsonHttp({
      object: "list",
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 7, total_tokens: 9 },
    });
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    const response = await adapter.embed({ ...baseRequest, input: ["a", "b"], http });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    // 上游乱序返回也要按 index 归位——错位会让第 k 条 claim 拿到第 k+1 条的向量。
    expect(response.vectors).toEqual([[1, 0], [0, 1]]);
    expect(response.usage.tokens).toBe(9);
    expect(response.usage.usageUnavailable).toBe(false);
    expect(http.calls[0]!.url).toBe("http://localhost:11434/v1/embeddings");
    expect(http.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(http.calls[0]!.init.body!)).toEqual({ model: "test-model", input: ["a", "b"] });
  });

  test("空 key 不发 Authorization 头；有 key 才发", async () => {
    const http = jsonHttp(wire([[1, 0]]));
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    await adapter.embed({ ...baseRequest, input: ["a"], http });
    expect(http.calls[0]!.init.headers).not.toHaveProperty("Authorization");
    await adapter.embed({ ...baseRequest, apiKey: "k", input: ["a"], http });
    expect(http.calls[1]!.init.headers!.Authorization).toBe("Bearer k");
  });

  test("上游没报 usage → usageUnavailable:true，不填 0 冒充免费", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    const response = await adapter.embed({ ...baseRequest, input: ["a"], http: jsonHttp(wire([[1, 0]])) });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.usage.usageUnavailable).toBe(true);
    expect(response.usage.tokens).toBe(0);
  });

  test("HTTP 状态码分档：401→auth、429→rate_limit（可重试）、500→upstream（可重试）", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    for (const [status, kind, retryable] of [
      [401, "auth", false],
      [429, "rate_limit", true],
      [503, "upstream", true],
    ] as const) {
      const response = await adapter.embed({ ...baseRequest, input: ["a"], http: jsonHttp({ error: "x" }, status) });
      expect(response.ok).toBe(false);
      if (response.ok) continue;
      expect(response.error.kind).toBe(kind);
      expect(response.error.retryable).toBe(retryable);
      expect(response.vectors).toBeNull();
    }
  });

  test("超时被识别成 timeout 而不是泛泛的网络失败", async () => {
    const http: HttpClient = {
      async request(url: string, _init?: HttpRequestInit) {
        throw new HttpTimeoutError(url, 1000);
      },
    };
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    const response = await adapter.embed({ ...baseRequest, input: ["a"], http });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("timeout");
    expect(response.error.retryable).toBe(true);
  });

  test("返回条数与请求条数不符 → parse 失败（绝不补零/错位）", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    const response = await adapter.embed({ ...baseRequest, input: ["a", "b"], http: jsonHttp(wire([[1, 0]])) });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("parse");
    expect(response.error.message).toContain("与请求的 2 条不符");
  });

  test("向量里混进非数值 / 维度不齐 → parse 失败", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    const bad = await adapter.embed({
      ...baseRequest,
      input: ["a"],
      http: jsonHttp({ data: [{ index: 0, embedding: [1, "x"] }] }),
    });
    expect(bad.ok).toBe(false);
    const ragged = await adapter.embed({
      ...baseRequest,
      input: ["a", "b"],
      http: jsonHttp(wire([[1, 0], [1, 0, 0]])),
    });
    expect(ragged.ok).toBe(false);
    if (ragged.ok) return;
    expect(ragged.error.message).toContain("维度不一致");
  });

  test("空字符串输入当场拒绝：空文本没有可用语义向量，不让它变成一批零向量", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local" });
    const response = await adapter.embed({ ...baseRequest, input: ["a", "   "], http: jsonHttp(wire([[1, 0], [0, 1]])) });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toContain("空字符串");
  });

  test("超过 batchLimit 的输入由调用方分批，adapter 不默默截断", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ id: "local", batchLimit: 2 });
    expect(adapter.batchLimit()).toBe(2);
    const response = await adapter.embed({ ...baseRequest, input: ["a", "b", "c"], http: jsonHttp(wire([[1]])) });
    expect(response.ok).toBe(false);
  });

  test("默认 batchLimit 有个确定的值（改了它 fixture 的分批就变了）", () => {
    expect(DEFAULT_EMBED_BATCH_LIMIT).toBe(64);
  });
});

describe("分批：条数上限 + 字符预算双约束", () => {
  test("单条超预算时自己成一批，绝不截断文本", () => {
    const long = "x".repeat(EMBED_BATCH_CHARS + 100);
    const chunks = chunkByCharBudget([long, "a", "b"], 64, EMBED_BATCH_CHARS);
    expect(chunks[0]).toEqual([long]);
    expect(chunks[1]).toEqual(["a", "b"]);
    expect(chunks.flat().join("")).toBe([long, "a", "b"].join(""));
  });

  test("条数上限与字符预算谁先到算谁", () => {
    expect(chunkByCharBudget(["a", "b", "c", "d"], 2, 1000)).toEqual([["a", "b"], ["c", "d"]]);
    expect(chunkByCharBudget(["aaa", "bbb", "ccc"], 64, 6)).toEqual([["aaa", "bbb"], ["ccc"]]);
  });

  test("确定性：同一个输入永远切成同一批（fixture key 稳定的前提）", () => {
    const texts = Array.from({ length: 40 }, (_, i) => "t".repeat(i * 7 + 1));
    expect(chunkByCharBudget(texts, 64, 3000)).toEqual(chunkByCharBudget(texts, 64, 3000));
  });
});

describe("EmbeddingRouter", () => {
  test("modelId 解析：<provider>/<model>；不合形状不猜 provider", () => {
    expect(parseEmbeddingModelId("local/bge-m3")).toEqual({ provider: "local", wireModel: "bge-m3" });
    expect(parseEmbeddingModelId("openai/text-embedding-3-small")).toEqual({
      provider: "openai",
      wireModel: "text-embedding-3-small",
    });
    // 带命名空间的模型名：只按**第一个** / 切
    expect(parseEmbeddingModelId("local/library/nomic")).toEqual({ provider: "local", wireModel: "library/nomic" });
    expect(parseEmbeddingModelId("bge-m3")).toBeNull();
    expect(parseEmbeddingModelId("/bge-m3")).toBeNull();
    expect(parseEmbeddingModelId("local/")).toBeNull();
  });

  test("未配置 embeddingModel → configured()=false，且 embed 返回可见的 unsupported 失败", async () => {
    const router = new EmbeddingRouter({ modelId: null, env: {} });
    expect(router.modelId()).toBeNull();
    expect(router.configured()).toBe(false);
    const response = await router.embed(["a"]);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("unsupported");
    expect(response.error.message).toContain("未配置 embeddingModel");
  });

  test("没有 embedding 端点的 provider（anthropic/deepseek/openrouter）→ unsupported，并说明支持哪几个", async () => {
    for (const provider of ["anthropic", "deepseek", "openrouter"]) {
      const router = new EmbeddingRouter({ modelId: `${provider}/whatever`, env: {} });
      const response = await router.embed(["a"]);
      expect(response.ok).toBe(false);
      if (response.ok) continue;
      expect(response.error.kind).toBe("unsupported");
      expect(response.error.message).toContain("local");
    }
    expect(supportedEmbeddingProviders()).toEqual(["local", "openai", "qwen"]);
  });

  test("local/ 但没设 baseUrl → auth 失败，不悄悄打到别的 provider", async () => {
    const router = new EmbeddingRouter({ modelId: "local/bge-m3", env: {} });
    const response = await router.embed(["a"]);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("auth");
    expect(response.error.message).toContain("SPARK_LOCAL_LLM_BASE_URL");
  });

  test("云端 provider 缺 key → auth 失败，且 env 变量名从 chat router 的真源派生", async () => {
    expect(EmbeddingRouter.apiKeyEnvFor("openai")).toBe("OPENAI_API_KEY");
    expect(EmbeddingRouter.apiKeyEnvFor("qwen")).toBe("QWEN_API_KEY");
    expect(EmbeddingRouter.apiKeyEnvFor("local")).toBe("SPARK_LOCAL_LLM_API_KEY");
    const router = new EmbeddingRouter({ modelId: "openai/text-embedding-3-small", env: {} });
    const response = await router.embed(["a"]);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("auth");
    expect(response.error.message).toContain("OPENAI_API_KEY");
  });

  test("回报的 model 是带 provider 前缀的完整 id（阈值表用的就是这个 id）", async () => {
    const router = new EmbeddingRouter({
      modelId: "local/bge-m3",
      env: { SPARK_LOCAL_LLM_BASE_URL: "http://x/v1" },
      http: jsonHttp(wire([[1, 0]])),
    });
    const response = await router.embed(["a"]);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.model).toBe("local/bge-m3");
    expect(response.provider).toBe("local");
  });

  test("分批里任何一批失败 ⇒ 整次失败，绝不返回半批向量", async () => {
    let call = 0;
    const http: HttpClient = {
      async request(_url: string, _init?: HttpRequestInit) {
        call++;
        if (call === 1) {
          return new BufferedResponse({
            status: 200,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(JSON.stringify(wire([[1, 0]]))),
          });
        }
        return new BufferedResponse({ status: 500, headers: {}, body: new TextEncoder().encode("boom") });
      },
    };
    const long = "x".repeat(EMBED_BATCH_CHARS + 10);
    const router = new EmbeddingRouter({
      modelId: "local/bge-m3",
      env: { SPARK_LOCAL_LLM_BASE_URL: "http://x/v1" },
      http,
    });
    const response = await router.embed([long, "second"]);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.vectors).toBeNull();
    expect(response.error.message).toContain("第 2 批（共 2 批）失败");
  });

  test("空输入是合法的空结果，不是失败", async () => {
    const router = new EmbeddingRouter({
      modelId: "local/bge-m3",
      env: { SPARK_LOCAL_LLM_BASE_URL: "http://x/v1" },
      http: jsonHttp(wire([[1]])),
    });
    const response = await router.embed([]);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.vectors).toEqual([]);
  });
});

describe("标定阈值登记表", () => {
  test("表是空的：bge-m3 标定过但**没有赢过词面**，所以不登记（理由见 calibration.ts）", () => {
    // 这条断言是本 lane 结论的落点。哪天有模型真的赢过词面被登记进来，它会红——
    // 那时候要一起改的是 calibration.ts 顶部的结论、novelty_calibration.test.ts 的对照
    // 用例、以及 docs/devlog/W5-1-b.md，而不是单独把这行删掉。
    expect(Object.keys(SEMANTIC_THRESHOLDS)).toEqual([]);
  });

  test("未登记的模型一律 null（K-4：没标定 = 没判据 ⇒ novelty 强制词面）", () => {
    expect(semanticHighAffinity("local/bge-m3")).toBeNull();
    expect(semanticHighAffinity("openai/text-embedding-3-small")).toBeNull();
    expect(semanticHighAffinity(null)).toBeNull();
    expect(isCalibrated("local/bge-m3")).toBe(false);
  });

  test("注入一张表时按注入的算——语义分支要能被完整测到，不能等「哪天登记了」才第一次执行", () => {
    const injected = {
      "local/bge-m3": { high: 0.665, calibratedOn: "2026-09-10", sampleSize: 30, source: "test" },
    };
    expect(semanticHighAffinity("local/bge-m3", injected)).toBe(0.665);
    expect(isCalibrated("local/bge-m3", injected)).toBe(true);
    expect(isCalibrated("local/别的模型", injected)).toBe(false);
  });

  test("将来若有登记：每条都必须有出处与标定日期（没出处的数字比 null 更危险）", () => {
    for (const [modelId, entry] of Object.entries(SEMANTIC_THRESHOLDS)) {
      expect(parseEmbeddingModelId(modelId)).not.toBeNull();
      expect(entry.high).toBeGreaterThan(0);
      expect(entry.high).toBeLessThan(1);
      expect(entry.calibratedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.sampleSize).toBeGreaterThan(0);
      expect(entry.source).toContain("calibration.json");
    }
  });

  test("cassette 名把 / 换成 -（modelId 不能直接当文件名）", () => {
    expect(embeddingCassette("local/bge-m3")).toBe("local-bge-m3");
    expect(embeddingCassette("openai/text-embedding-3-small")).toBe("openai-text-embedding-3-small");
  });
});
