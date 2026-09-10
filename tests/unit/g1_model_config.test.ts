import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredDefaultModel } from "../../backend/src/config";
import { LLMRouter, PROVIDER_MODELS, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { priceFor } from "../../backend/src/llm/providers/registry";
import { llmExtras } from "../../backend/src/llm/types";
import { runLitCommand } from "../../backend/src/literature/cli";
import { LibraryStore } from "../../backend/src/literature/library";
import { ProjectManager } from "../../backend/src/project/manager";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";

// G-1（v0.6）：模型配置化 + z-ai/glm-5.3-flash 登记。
//
// 三件事各有一组断言：
// 1. 定价表：B2 轮次指定模型必须能定价——BudgetLedger 判 $2 闸靠它，查不到价
//    这次调用的成本就是「未知」，闸永远不会确定超（诚实但等于没有闸）。
// 2. 路由表：z-ai/glm-5.3-flash 必须显式在 PROVIDER_MODELS.openrouter——
//    providerForModel 的关键词兜底认不出 "z-ai"，不登记会静默落到 kimi adapter。
// 3. CLI 模型解析链：`--model` flag > 注入 deps.model > config.json defaultModel >
//    内部默认。此前 CLI 是三个入口里唯一不读 defaultModel 的（V40 只写不读的形状）。

describe("G-1 · z-ai/glm-5.3-flash 登记", () => {
  test("定价表有条目且两个方向单价为正（含 5.5% 手续费的实效价）", () => {
    const price = priceFor("openrouter", "z-ai/glm-5.3-flash", { env: {} });
    expect(price).not.toBeNull();
    expect(price!.inputPerMillionUsd).toBeGreaterThan(0);
    expect(price!.outputPerMillionUsd).toBeGreaterThan(0);
    // 实效价必须 ≥ 挂牌价（0.075/0.25）——低于挂牌价一定是登记错了方向或忘了手续费。
    expect(price!.inputPerMillionUsd).toBeGreaterThanOrEqual(0.075);
    expect(price!.outputPerMillionUsd).toBeGreaterThanOrEqual(0.25);
  });

  test("PROVIDER_MODELS.openrouter 显式含 z-ai/glm-5.3-flash", () => {
    expect(PROVIDER_MODELS.openrouter).toContain("z-ai/glm-5.3-flash");
  });

  test("调用真的路由到 openrouter 的 baseUrl（而不是关键词兜底落到 kimi）", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const router = new LLMRouter({ OPENROUTER_API_KEY: "test-key", KIMI_API_KEY: "test-key-2" }, { fetchImpl });
    await router.call([{ role: "user", content: "hi" }], "z-ai/glm-5.3-flash");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain("openrouter.ai");
    expect(seen[0]).not.toContain("moonshot");
  });
});

class ModelCapturingLlm {
  readonly models: Array<string | undefined> = [];
  call = async (messages: ChatMessage[], model?: string): Promise<LlmResponse> => {
    this.models.push(model);
    const title = messages.map((m) => m.content).join("\n").match(/标题: (.+)/)?.[1] ?? "未知";
    return {
      ok: true,
      ...llmExtras(),
      provider: "openrouter",
      model: model ?? LLMRouter.DEFAULT_MODEL,
      content: JSON.stringify({
        researchQuestion: `《${title.slice(0, 40)}》的问题`,
        methods: "方法",
        keyFindings: ["发现"],
        limitations: ["局限"],
        relationToProject: "背景",
      }),
    };
  };
}

describe("G-1 · CLI 模型解析链（lit read）", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spark-g1-model-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seedOnePaper() {
    const manager = new ProjectManager(tmp);
    const project = manager.create("g1-model", { name: "g1" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
      sources: SEARCH_SOURCES,
      perSource: PER_SOURCE,
    });
    library.add(searched.papers[0]!, { tags: ["background"] });
    return manager;
  }

  test("config.json 的 defaultModel 被 CLI 读到（root 注入，V40 反例）", async () => {
    const manager = await seedOnePaper();
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ defaultModel: "z-ai/glm-5.3-flash" }), { mode: 0o600 });
    const llm = new ModelCapturingLlm();
    const code = await runLitCommand(["read", "--all"], { manager, root: tmp, llm, out: () => {}, err: () => {} });
    expect(code).toBe(0);
    expect(llm.models.length).toBeGreaterThan(0);
    expect(llm.models.every((m) => m === "z-ai/glm-5.3-flash")).toBe(true);
  });

  test("--model flag 覆盖 config 的 defaultModel", async () => {
    const manager = await seedOnePaper();
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ defaultModel: "z-ai/glm-5.3-flash" }), { mode: 0o600 });
    const llm = new ModelCapturingLlm();
    const code = await runLitCommand(["read", "--all", "--model", "flag-wins"], {
      manager,
      root: tmp,
      llm,
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(0);
    expect(llm.models.every((m) => m === "flag-wins")).toBe(true);
  });

  test("都没配置时落到设置项默认值（与 DEFAULT_MODEL 同值——最终 wire model 与改动前一致）", async () => {
    const manager = await seedOnePaper();
    const llm = new ModelCapturingLlm();
    const code = await runLitCommand(["read", "--all"], { manager, root: tmp, llm, out: () => {}, err: () => {} });
    expect(code).toBe(0);
    expect(llm.models.every((m) => m === LLMRouter.DEFAULT_MODEL)).toBe(true);
  });
});

describe("G-1 · configuredDefaultModel helper", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spark-g1-helper-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("未配置 → 设置项默认值（与 DEFAULT_MODEL 同值）；显式空串同样归一到默认（config 层既有语义）", () => {
    expect(configuredDefaultModel({ root: tmp, env: {} })).toBe(LLMRouter.DEFAULT_MODEL);
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ defaultModel: "" }), { mode: 0o600 });
    expect(configuredDefaultModel({ root: tmp, env: {} })).toBe(LLMRouter.DEFAULT_MODEL);
  });

  test("配置了就返回配置值", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ defaultModel: "m-1" }), { mode: 0o600 });
    expect(configuredDefaultModel({ root: tmp, env: {} })).toBe("m-1");
  });
});
