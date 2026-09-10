import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo } from "../../backend/src/onboarding/demo";
import { runInit } from "../../backend/src/onboarding/init";
import { detectLocalOllama, detectProviders } from "../../backend/src/onboarding/providers";
import { ProjectManager } from "../../backend/src/project/manager";
import { CASSETTES, searcherWith } from "../helpers/literature_scenario";

// W2-d（B-b/B-c）：init 向导 + 离线 demo。

function tmpRoot(prefix = "spark-onboarding-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sink() {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    lines,
    errLines,
    out: (line: string) => lines.push(line),
    err: (line: string) => errLines.push(line),
    text: () => lines.join("\n"),
  };
}

describe("onboarding · detectProviders（阴性对照②的钩子）", () => {
  test("没配置任何 key：全部 configured:false，capabilities 全部 null——不猜、不报已就绪", () => {
    const statuses = detectProviders({});
    expect(statuses.length).toBe(6);
    for (const s of statuses) {
      expect(s.configured).toBe(false);
      expect(s.capabilities).toBeNull();
    }
  });

  test("只配了 KIMI_API_KEY：kimi 报已配置且带能力位，其余仍然 false/null（不被隐式回退污染）", () => {
    const statuses = detectProviders({ KIMI_API_KEY: "sk-test-not-real" });
    const kimi = statuses.find((s) => s.id === "kimi")!;
    expect(kimi.configured).toBe(true);
    expect(kimi.capabilities).not.toBeNull();
    expect(kimi.capabilities!.toolCalling).toBe(true);
    expect(kimi.capabilities!.streaming).toBe(true);

    for (const s of statuses.filter((s) => s.id !== "kimi")) {
      expect(s.configured).toBe(false);
      // 这里是阴性对照②真正卡住的地方：LLMRouter.resolve() 对没配置的 provider
      // 有「隐式回退到任一已配置 provider」的机制（方便调用方不用逐个试）。
      // 如果 detectProviders 天真地对每个 provider 都去 capabilitiesFor(其代表模型)，
      // 回退会让 openai/anthropic/deepseek/qwen/openrouter 全都借用 kimi 的能力位
      // 显得「已就绪」——这条断言就是用来防止这个回归的。
      expect(s.capabilities).toBeNull();
    }
  });

  test("配置了全部 6 个 provider：全部 configured 且各自都有能力位", () => {
    const env = {
      KIMI_API_KEY: "x",
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "x",
      DEEPSEEK_API_KEY: "x",
      QWEN_API_KEY: "x",
      OPENROUTER_API_KEY: "x",
    };
    const statuses = detectProviders(env);
    expect(statuses.every((s) => s.configured)).toBe(true);
    expect(statuses.every((s) => s.capabilities !== null)).toBe(true);
  });
});

describe("onboarding · detectLocalOllama", () => {
  test("本地服务可达：reachable=true，带模型列表", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3.1" }, { name: "qwen2.5:7b" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const result = await detectLocalOllama({}, fakeFetch);
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(["llama3.1", "qwen2.5:7b"]);
    expect(result.configuredExplicitly).toBe(false);
    expect(result.note).toContain("SPARK_LOCAL_LLM_BASE_URL");
  });

  test("本地服务不可达（连接被拒/超时）：reachable=false，不抛异常", async () => {
    const fakeFetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch;
    const result = await detectLocalOllama({}, fakeFetch);
    expect(result.reachable).toBe(false);
    expect(result.models).toBeNull();
    expect(result.note).toContain("ECONNREFUSED");
  });

  test("显式设置了 SPARK_LOCAL_LLM_BASE_URL 时用那个地址，且 configuredExplicitly=true", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await detectLocalOllama({ SPARK_LOCAL_LLM_BASE_URL: "http://10.0.0.5:8080" }, fakeFetch);
    expect(calledUrl).toBe("http://10.0.0.5:8080/api/tags");
    expect(result.configuredExplicitly).toBe(true);
    expect(result.note).toBe("");
  });
});

describe("onboarding · runInit", () => {
  test("零 provider 配置：仍然建成项目、跑完检索、给出证据图，且诚实报告『未配置』", async () => {
    const root = tmpRoot();
    const manager = new ProjectManager(root);
    const io = sink();
    const code = await runInit({
      slug: "onboarding-test",
      query: "AlphaFold protein structure prediction",
      manager,
      root,
      out: io.out,
      err: io.err,
      env: {},
      fetchImpl: (async () => {
        throw new Error("本地 Ollama 探测不该打真实网络之外的口子");
      }) as unknown as typeof fetch,
      searcher: searcherWith(CASSETTES.search, "replay"),
    });
    expect(code).toBe(0);
    expect(manager.exists("onboarding-test")).toBe(true);
    expect(manager.currentSlug()).toBe("onboarding-test");

    const text = io.text();
    // 没配置的 provider 必须诚实说"未配置"，不能说"已配置"/"已就绪"。
    expect(text).toContain("未配置");
    expect(text).not.toMatch(/kimi[^\n]*✅ 已配置/);
    // 证据图与下一步命令都得出现。
    expect(text).toContain("证据图");
    expect(text).toContain("spark-research report export");
    expect(text).toContain("spark-research server");

    const papersLine = io.lines.find((l) => l.includes("papers:"));
    expect(papersLine).toBeDefined();
    expect(Number(papersLine!.split("papers:")[1]!.trim())).toBeGreaterThan(0);
  });

  test("配置了 KIMI_API_KEY：provider 状态如实报『已配置』且带能力位", async () => {
    const root = tmpRoot();
    const manager = new ProjectManager(root);
    const io = sink();
    const code = await runInit({
      slug: "onboarding-configured",
      manager,
      root,
      out: io.out,
      err: io.err,
      env: { KIMI_API_KEY: "sk-test" },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      searcher: searcherWith(CASSETTES.search, "replay"),
    });
    expect(code).toBe(0);
    const text = io.text();
    expect(text).toMatch(/✅ 已配置\s+kimi/);
    expect(text).not.toContain("没有任何 provider 就绪");
  });

  test("重复跑 init（同一个 slug）是幂等的，不报错", async () => {
    const root = tmpRoot();
    const manager = new ProjectManager(root);
    const deps = {
      manager,
      root,
      out: () => {},
      err: () => {},
      env: {},
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      searcher: searcherWith(CASSETTES.search, "replay"),
    };
    expect(await runInit({ ...deps, slug: "repeat-me" })).toBe(0);
    expect(await runInit({ ...deps, slug: "repeat-me" })).toBe(0);
    expect(manager.exists("repeat-me")).toBe(true);
  });

  test("不给 slug 时自动生成一个可用的项目名", async () => {
    const root = tmpRoot();
    const manager = new ProjectManager(root);
    const code = await runInit({
      manager,
      root,
      out: () => {},
      err: () => {},
      env: {},
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      searcher: searcherWith(CASSETTES.search, "replay"),
      now: () => new Date("2026-09-10T12:34:00Z"),
    });
    expect(code).toBe(0);
    expect(manager.list().some((p) => p.slug.startsWith("research-"))).toBe(true);
  });
});

describe("onboarding · runDemo（阴性对照①的钩子：断网 + 无 key 仍能跑通）", () => {
  test("即使全局 fetch 被换成必抛错的假实现，demo 依旧走完整条研究线索", async () => {
    const originalFetch = globalThis.fetch;
    // 模拟"完全没有网络"：任何网络请求都立刻抛错。demo 全程不该调用它——
    // 用它本身抛错来证明 demo 没有偷偷打网络，而不是让 demo 侥幸躲过一次真实请求。
    globalThis.fetch = (async () => {
      throw new Error("网络已禁用（阴性对照①：demo 不许依赖网络）");
    }) as unknown as typeof fetch;
    const io = sink();
    try {
      const code = await runDemo({ out: io.out, err: io.err });
      expect(code).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const text = io.text();
    expect(text).toContain("步全部通过");
    expect(text).toContain("approvedConclusions");
    expect(text).toContain("研究报告全貌");
    // 报告里应该看得到真实的证据链接（record id 出现在 markdown 里）。
    expect(text).toMatch(/## 四、结论/);
  });

  test("demo 是确定性回放：两次跑步数一致", async () => {
    const first = sink();
    const second = sink();
    expect(await runDemo({ out: first.out, err: first.err })).toBe(0);
    expect(await runDemo({ out: second.out, err: second.err })).toBe(0);
    const countLine = (io: ReturnType<typeof sink>) =>
      io.lines.find((l) => l.includes("approvedConclusions"));
    expect(countLine(first)).toBe(countLine(second));
  });

  test("--out 落盘：报告 markdown 真的写到文件里", async () => {
    const outFile = join(tmpRoot(), "demo-report.md");
    const io = sink();
    const code = await runDemo({ out: io.out, err: io.err, outFile });
    expect(code).toBe(0);
    const written = await Bun.file(outFile).text();
    expect(written).toContain("## 四、结论");
  });
});
