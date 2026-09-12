import { describe, expect, test } from "bun:test";
import {
  CASSETTES,
  PER_SOURCE,
  SEARCH_QUERY,
  SEARCH_SOURCES,
  fixtureHttp,
  searcherWith,
} from "../helpers/literature_scenario";
import { FakeJudge, FakeLlm, cardJson } from "../helpers/review_scenario";
import { makeServer, seedLibrary } from "../helpers/server_scenario";

// P7 · 文献域端点。检索走 fixture 回放，精读卡/综述走 fake LLM——没有一条路径打真实服务。

interface Paper {
  id: string;
  title: string;
  bibtexKey: string | null;
  readingStatus: string;
  tags: string[];
}

describe("HTTP · lit sources / 库读取", () => {
  test("GET /api/lit/sources 只报「是否已配置」，不报凭据值（AD-2）", async () => {
    const fx = makeServer();
    try {
      const { status, body } = await fx.get<{
        sources: Array<{ name: string; apiKeyRequired: boolean; credentialConfigured: boolean | null }>;
        defaults: string[];
      }>("/api/lit/sources");
      expect(status).toBe(200);
      expect(body.sources.map((s) => s.name)).toContain("openalex");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("apiKey\":\"");
      expect(serialized).not.toContain("token");
      const withKey = body.sources.filter((s) => s.apiKeyRequired);
      expect(withKey.length).toBeGreaterThan(0);
      for (const source of withKey) expect(typeof source.credentialConfigured).toBe("boolean");
      expect(body.defaults.length).toBeGreaterThan(0);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/lit/papers 带 bibtex key；标签/状态过滤", async () => {
    const fx = makeServer();
    try {
      seedLibrary(fx.project, 3);
      const all = await fx.get<{ papers: Paper[]; citations: number }>("/api/lit/papers");
      expect(all.status).toBe(200);
      expect(all.body.papers).toHaveLength(3);
      expect(all.body.papers[0]!.bibtexKey).toMatch(/^[a-z]+\d{4}/);

      await fx.patch(`/api/lit/papers/${all.body.papers[0]!.id}`, {
        readingStatus: "read",
        tags: ["核心"],
      });
      const byStatus = await fx.get<{ papers: Paper[] }>("/api/lit/papers?status=read");
      expect(byStatus.body.papers).toHaveLength(1);
      const byTag = await fx.get<{ papers: Paper[] }>("/api/lit/papers?tag=核心");
      expect(byTag.body.papers).toHaveLength(1);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/lit/papers/:id 支持 id 前缀；不存在 → 404", async () => {
    const fx = makeServer();
    try {
      const { ids } = seedLibrary(fx.project, 3);
      const byPrefix = await fx.get<{ paper: Paper }>(`/api/lit/papers/${ids[0]!.slice(0, 8)}`);
      expect(byPrefix.status).toBe(200);
      expect(byPrefix.body.paper.id).toBe(ids[0]!);
      expect((await fx.get("/api/lit/papers/zzzzzzzz")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/lit/export 输出 bibtex / csl；未知格式 → 400", async () => {
    const fx = makeServer();
    try {
      seedLibrary(fx.project, 2);
      const bib = await fx.text("/api/lit/export?format=bibtex");
      expect(bib.status).toBe(200);
      expect(bib.body).toContain("@article{");
      const csl = await fx.text("/api/lit/export?format=csl");
      expect(JSON.parse(csl.body)).toHaveLength(2);
      expect((await fx.get("/api/lit/export?format=xml")).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · lit search（fixture 回放）", () => {
  test("POST /api/lit/search 返回任务句柄（202）并可轮询到结果", async () => {
    const fx = makeServer({ searcher: searcherWith(CASSETTES.search, "replay") });
    try {
      const submitted = await fx.post<{ task: { id: string; state: string } }>("/api/lit/search", {
        query: SEARCH_QUERY,
        sources: SEARCH_SOURCES,
        limit: PER_SOURCE,
      });
      expect(submitted.status).toBe(202);
      expect(submitted.body.task.id).toBeTruthy();

      // 轮询直到落定（这是 UI 走的路径）。
      let state = submitted.body.task.state;
      for (let i = 0; i < 200 && state !== "succeeded" && state !== "failed"; i++) {
        await Bun.sleep(20);
        const polled = await fx.get<{ task: { state: string } }>(`/api/tasks/${submitted.body.task.id}`);
        state = polled.body.task.state;
      }
      expect(state).toBe("succeeded");
    } finally {
      await fx.stop();
    }
  });

  test("await=true 同步返回；各源结果如实汇报（不是静默丢弃）", async () => {
    const fx = makeServer({ searcher: searcherWith(CASSETTES.search, "replay") });
    try {
      const { status, task } = await fx.run("/api/lit/search", {
        query: SEARCH_QUERY,
        sources: SEARCH_SOURCES,
        limit: PER_SOURCE,
      });
      expect(status).toBe(200);
      const result = task.result as {
        papers: unknown[];
        sources: Array<{ source: string; outcome: string }>;
        totalBeforeDedupe: number;
        mergedCount: number;
        afterDedupe: number;
        added: null;
      };
      expect(result.papers.length).toBeGreaterThan(0);
      expect(result.afterDedupe).toBe(result.totalBeforeDedupe - result.mergedCount);
      expect(result.sources.map((s) => s.source).sort()).toEqual([...SEARCH_SOURCES].sort());
      expect(result.added).toBeNull();
    } finally {
      await fx.stop();
    }
  });

  test("search add:true 入库并在证据图上落 paper record", async () => {
    const fx = makeServer({ searcher: searcherWith(CASSETTES.search, "replay") });
    try {
      const { task } = await fx.run("/api/lit/search", {
        query: SEARCH_QUERY,
        sources: SEARCH_SOURCES,
        limit: PER_SOURCE,
        add: true,
        tags: ["alphafold"],
      });
      const result = task.result as { added: { added: number; merged: number; project: string } };
      expect(result.added.added).toBeGreaterThan(0);
      const papers = await fx.get<{ papers: Paper[] }>("/api/lit/papers?tag=alphafold");
      expect(papers.body.papers.length).toBe(result.added.added);
      const records = await fx.get<{ total: number }>("/api/records?type=paper");
      expect(records.body.total).toBe(result.added.added);
    } finally {
      await fx.stop();
    }
  });

  test("缺 query → 400；未知文献源 → 400", async () => {
    const fx = makeServer({ searcher: searcherWith(CASSETTES.search, "replay") });
    try {
      expect((await fx.post("/api/lit/search", {})).status).toBe(400);
      expect((await fx.post("/api/lit/search", { query: "x", sources: ["nope"] })).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/lit/papers 按 DOI 入库（fixture 回放）", async () => {
    const fx = makeServer({ searcher: searcherWith(CASSETTES.fetchById, "replay") });
    try {
      const { status, task } = await fx.run("/api/lit/papers", {
        identifier: "10.1038/s41586-021-03819-2",
        tags: ["核心"],
      });
      expect(status).toBe(200);
      const result = task.result as { paper: { title: string }; merged: boolean };
      expect(result.paper.title.toLowerCase()).toContain("alphafold");
    } finally {
      await fx.stop();
    }
  });

  test("PDF 不可得是结果不是异常（任务成功 + result.ok=false）", async () => {
    const fx = makeServer({ http: fixtureHttp(CASSETTES.pdf, "replay") });
    try {
      const { ids } = seedLibrary(fx.project, 1);
      const { task } = await fx.run(`/api/lit/papers/${ids[0]!}/pdf`);
      expect(task.state).toBe("succeeded");
      const result = task.result as { result: { ok: boolean; reason?: string } };
      expect(result.result.ok).toBe(false);
      expect(result.result.reason).toBeTruthy();
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · lit read / review（fake LLM）", () => {
  test("POST /api/lit/read 单篇生成精读卡并入证据图", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson()]) });
    try {
      const { ids } = seedLibrary(fx.project, 1);
      const { status, task } = await fx.run("/api/lit/read", { paperId: ids[0]! });
      expect(status).toBe(200);
      const result = task.result as { cards: Array<{ recordId: string }>; failures: unknown[] };
      expect(result.cards).toHaveLength(1);
      expect(result.failures).toHaveLength(0);

      const record = await fx.get<{ record: { type: string; evidence: string; metadata: Record<string, unknown> } }>(
        `/api/records/${result.cards[0]!.recordId}`,
      );
      expect(record.body.record.type).toBe("reading");
      expect(record.body.record.evidence).toBe("sourced");
      expect(record.body.record.metadata.kind).toBe("reading_card");
    } finally {
      await fx.stop();
    }
  });

  test("read all:true 批量；GET /api/lit/cards 列出卡片", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson()]) });
    try {
      seedLibrary(fx.project, 3);
      const { task } = await fx.run("/api/lit/read", { all: true });
      expect((task.result as { cards: unknown[] }).cards).toHaveLength(3);
      const cards = await fx.get<{ cards: unknown[] }>("/api/lit/cards");
      expect(cards.body.cards).toHaveLength(3);
    } finally {
      await fx.stop();
    }
  });

  test("read 全失败 → 任务 failed（「成功 0 张」不该是绿的）", async () => {
    const fx = makeServer({ llm: new FakeLlm(["这不是 JSON"]) });
    try {
      const { ids } = seedLibrary(fx.project, 1);
      const { status, task } = await fx.run("/api/lit/read", { paperId: ids[0]! });
      expect(status).toBe(500);
      expect(task.state).toBe("failed");
      expect(task.error?.message).toContain("全部生成失败");
    } finally {
      await fx.stop();
    }
  });

  test("read 缺 paperId 且没有 all → 400", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson()]) });
    try {
      expect((await fx.post("/api/lit/read", {})).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("综述：无精读卡先跑 review → 任务失败并给出下一步", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson()]) });
    try {
      seedLibrary(fx.project, 1);
      const { task } = await fx.run("/api/lit/review", {});
      expect(task.state).toBe("failed");
      expect(task.error?.message).toContain("精读卡");
    } finally {
      await fx.stop();
    }
  });

  test("综述生成 + citation-integrity 一次做完（引用真实 → 不 veto）", async () => {
    const llm = new FakeLlm([cardJson()]);
    const fx = makeServer({ llm, judge: new FakeJudge() });
    try {
      seedLibrary(fx.project, 2);
      await fx.run("/api/lit/read", { all: true });
      const keys = (await fx.get<{ papers: Paper[] }>("/api/lit/papers")).body.papers.map((p) => p.bibtexKey!);
      llm.queueNext(`# 综述\n\n第一篇的方法值得参考 [@${keys[0]}]，第二篇给了基线 [@${keys[1]}]。`);

      const { status, task } = await fx.run("/api/lit/review", { topic: "蛋白结构预测" });
      expect(status).toBe(200);
      const result = task.result as {
        draft: { markdown: string; artifactId: string; recordId: string; citedKeys: string[] };
        citation: { citations: unknown[]; findings: Array<{ severity: string }> };
        vetoed: boolean;
      };
      expect(result.draft.citedKeys.sort()).toEqual([keys[0]!, keys[1]!].sort());
      expect(result.citation.findings.filter((f) => f.severity === "hard")).toHaveLength(0);
      expect(result.vetoed).toBe(false);
      expect(result.draft.artifactId).toBeTruthy();
      // V104：HTTP 综述与 CLI 同一语义——落 citation-integrity observation record（阴性对照：路由去掉 records.create → 红）。
      const withRecord = task.result as { citationReviewRecordId: string; citationGap: { total: number; judged: number } };
      expect(withRecord.citationReviewRecordId).toBeTruthy();
      expect(withRecord.citationGap.total).toBeGreaterThanOrEqual(withRecord.citationGap.judged);
      const obs = await fx.get<{ records: Array<{ id: string; metadata?: { kind?: string } }> }>("/api/records?type=observation");
      expect(obs.body.records.some((r) => r.id === withRecord.citationReviewRecordId && r.metadata?.kind === "citation-integrity-review")).toBe(true);
    } finally {
      await fx.stop();
    }
  });

  // 伪造引用有两道防线，HTTP 层要把两道都暴露出来，且不能给调用方任何绕过口子。
  // 第一道在生成器里（白名单 + 重试一次），所以库外 key 根本产不出草稿 → 任务失败。
  test("综述引用库外 key → 生成器拒稿，任务 failed 并点名越界 key", async () => {
    const llm = new FakeLlm([cardJson()]);
    const fx = makeServer({ llm, judge: new FakeJudge() });
    try {
      seedLibrary(fx.project, 2);
      await fx.run("/api/lit/read", { all: true });
      llm.queueNext("# 综述\n\n有一项工作证明了这一点 [@nonexistent2099fake]。");
      llm.queueNext("# 综述\n\n改了一版，还是编的 [@another2099fake]。");

      const { status, task } = await fx.run("/api/lit/review", {});
      expect(status).toBe(500);
      expect(task.state).toBe("failed");
      expect(task.error?.message).toContain("越界 key");
      // API 不提供 allowUnknownKeys 之类的开关——「让我引一条库外文献」不该是一个参数。
      const forced = await fx.run("/api/lit/review", { allowUnknownKeys: true });
      expect(forced.task.state).toBe("failed");
    } finally {
      await fx.stop();
    }
  });

  // 第二道防线是 citation-integrity：key 在库内，但结论与精读卡对不上 → soft finding。
  // soft 只提示不否决（P3 决策 D3），所以 vetoed 必须是 false——这条正是最容易写错的地方。
  test("引用真实但结论与精读卡冲突 → soft finding，且不 veto", async () => {
    const llm = new FakeLlm([cardJson()]);
    const fx = makeServer({ llm, judge: new FakeJudge(["全面超越所有已有方法"]) });
    try {
      seedLibrary(fx.project, 2);
      await fx.run("/api/lit/read", { all: true });
      const keys = (await fx.get<{ papers: Paper[] }>("/api/lit/papers")).body.papers.map((p) => p.bibtexKey!);
      llm.queueNext(`# 综述\n\n该方法全面超越所有已有方法 [@${keys[0]}]。另一篇给了基线 [@${keys[1]}]。`);

      const { status, task } = await fx.run("/api/lit/review", {});
      expect(status).toBe(200);
      const result = task.result as {
        vetoed: boolean;
        citation: { findings: Array<{ severity: string; message: string }> };
      };
      expect(result.citation.findings.some((f) => f.severity === "soft")).toBe(true);
      expect(result.citation.findings.some((f) => f.severity === "hard")).toBe(false);
      expect(result.vetoed).toBe(false);
    } finally {
      await fx.stop();
    }
  });
});
