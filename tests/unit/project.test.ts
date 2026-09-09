import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager, ProjectError, slugify } from "../../backend/src/project/manager";
import { RecordStore, RecordValidationError } from "../../backend/src/project/records";
import { runProjectCommand } from "../../backend/src/project/cli";
import { ArtifactStore } from "../../backend/src/artifacts/store";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";

const dirs: string[] = [];

function tempRoot(prefix = "spark-project-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const mockLlm = {
  call: async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return { ok: true, provider: "kimi", model, content: `[test:${model}] ${lastUser.slice(0, 80)}`, mock: false };
  },
  listModels: () => ({
    kimi: [LLMRouter.DEFAULT_MODEL],
    openai: [],
    anthropic: [],
    deepseek: [],
    qwen: [],
    openrouter: [],
  }),
};

describe("ProjectManager 生命周期", () => {
  test("create 建出完整目录布局与 project.json", () => {
    const manager = new ProjectManager(tempRoot());
    const project = manager.create("crispr-off-target", { name: "CRISPR 脱靶", description: "课题 A" });

    expect(project.slug).toBe("crispr-off-target");
    expect(project.meta.name).toBe("CRISPR 脱靶");
    expect(project.meta.status).toBe("active");
    for (const path of [
      project.paths.metaFile,
      project.paths.recordsDb,
      project.paths.artifactsDir,
      project.paths.papersDir,
      project.paths.experimentsDir,
    ]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(project.paths.root).toBe(join(manager.projectsDir, "crispr-off-target"));
    project.close();
  });

  test("root 可注入，不写 homedir", () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    manager.create("p1");
    expect(manager.root).toBe(root);
    expect(existsSync(join(root, "projects", "p1", "project.json"))).toBe(true);
  });

  test("重复 slug 报错，非法 slug 被拒（含路径穿越）", () => {
    const manager = new ProjectManager(tempRoot());
    manager.create("dup");
    expect(() => manager.create("dup")).toThrow(ProjectError);
    for (const bad of ["../escape", "with space", "UPPER", "", "-lead"]) {
      expect(() => manager.create(bad)).toThrow(ProjectError);
    }
  });

  test("open 不存在的项目报错", () => {
    const manager = new ProjectManager(tempRoot());
    expect(() => manager.open("missing")).toThrow(/不存在/);
  });

  test("list 默认不含归档，--all 语义可取回", () => {
    const manager = new ProjectManager(tempRoot());
    manager.create("alpha");
    manager.create("beta");
    manager.archive("beta");

    expect(manager.list().map((m) => m.slug)).toEqual(["alpha"]);
    expect(manager.list({ includeArchived: true }).map((m) => m.slug).sort()).toEqual(["alpha", "beta"]);
    expect(manager.list({ includeArchived: true }).find((m) => m.slug === "beta")!.status).toBe("archived");
  });

  test("archive 后重开元数据仍然正确（持久化）", () => {
    const root = tempRoot();
    new ProjectManager(root).create("gamma");
    new ProjectManager(root).archive("gamma");
    expect(new ProjectManager(root).open("gamma").meta.status).toBe("archived");
  });

  test("slugify 归一化自由字符串", () => {
    expect(slugify("Demo Project")).toBe("demo-project");
    expect(slugify("demo")).toBe("demo");
    expect(slugify("!!!")).toBeNull();
  });
});

describe("session 归属 project（AD-1）", () => {
  test("显式绑定的 session 解析到绑定项目", () => {
    const manager = new ProjectManager(tempRoot());
    manager.create("bound");
    manager.create("other");
    manager.bindSession("sess-a", "bound");
    expect(manager.projectForSession("sess-a").slug).toBe("bound");
  });

  test("未绑定的 session 落到默认项目并写回绑定", () => {
    const manager = new ProjectManager(tempRoot());
    const project = manager.projectForSession("sess-new");
    expect(project.slug).toBe("default");
    expect(manager.sessionProjectSlug("sess-new")).toBe("default");
  });

  test("当前项目存在时默认项目就是当前项目", () => {
    const manager = new ProjectManager(tempRoot());
    manager.create("first");
    manager.create("second");
    manager.setCurrent("second");
    expect(manager.projectForSession("sess-x").slug).toBe("second");
  });

  test("绑定的项目被删掉时退回默认项目（不炸）", () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    manager.create("ghost");
    manager.bindSession("sess-g", "ghost");
    rmSync(join(manager.projectsDir, "ghost"), { recursive: true, force: true });
    expect(manager.sessionProjectSlug("sess-g")).toBeNull();
    expect(manager.projectForSession("sess-g").slug).toBe("default");
  });

  test("orchestrator 把 session 关联到 project", async () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    manager.create("orch-proj");
    manager.bindSession("sess-orch", "orch-proj");

    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, {
      llm: mockLlm,
      projects: manager,
      workspaceRoot: join(root, "workspaces"),
    });
    const result = await orch.processRequest("分析一下数据", "sess-orch");
    expect(result.projectSlug).toBe("orch-proj");
  });

  test("orchestrator 遇到未知 session 落到默认项目", async () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, {
      llm: mockLlm,
      projects: manager,
      workspaceRoot: join(root, "workspaces"),
    });
    const result = await orch.processRequest("随便问问", "sess-unknown");
    expect(result.projectSlug).toBe("default");
    expect(manager.sessionProjectSlug("sess-unknown")).toBe("default");
  });

  test("未注入 ProjectManager 时行为不变（projectSlug 为 null）", async () => {
    const root = tempRoot();
    const daemon = new SparkResearchDaemon();
    const orch = new OrchestratorAgent(daemon, { llm: mockLlm, workspaceRoot: join(root, "workspaces") });
    const result = await orch.processRequest("随便问问", "sess-noproj");
    expect(result.projectSlug).toBeNull();
  });
});

describe("RecordStore", () => {
  function store(): RecordStore {
    return new RecordStore(join(tempRoot("spark-records-"), "records.db"), "demo");
  }

  test("7 种 record 类型都能写入并读回", () => {
    const s = store();
    const types = [
      "idea",
      "decision",
      "experiment",
      "observation",
      "conclusion",
      "paper",
    ] as const;
    for (const type of types) {
      const rec = s.create({ type, content: `${type} 内容`, evidence: "inferred" });
      expect(s.get(rec.id)!.type).toBe(type);
    }
    const artifactRec = s.create({
      type: "artifact",
      content: "plot.png",
      evidence: "computed",
      artifactId: "artifact-1",
    });
    expect(s.get(artifactRec.id)!.artifactId).toBe("artifact-1");
    expect(s.count()).toBe(7);
    s.close();
  });

  test("record 带 origin / evidence / metadata 并原样读回", () => {
    const s = store();
    const rec = s.create({
      type: "observation",
      title: "峰值偏移",
      content: "在 37°C 观察到峰值偏移",
      evidence: "observed",
      origin: { kind: "cell", sessionId: "sess-1", ref: "sess-1:3" },
      metadata: { instrument: "plate-reader", replicate: 2 },
    });
    const got = s.get(rec.id)!;
    expect(got.evidence).toBe("observed");
    expect(got.origin).toEqual({ kind: "cell", sessionId: "sess-1", ref: "sess-1:3", connector: null });
    expect(got.metadata).toEqual({ instrument: "plate-reader", replicate: 2 });
    expect(got.project).toBe("demo");
    s.close();
  });

  test("非法类型 / 非法证据标签 / artifact 缺 id 都被拒", () => {
    const s = store();
    expect(() => s.create({ type: "nonsense" as never, content: "x" })).toThrow(RecordValidationError);
    expect(() => s.create({ type: "idea", content: "x", evidence: "guessed" as never })).toThrow(
      RecordValidationError,
    );
    expect(() => s.create({ type: "artifact", content: "x" })).toThrow(/requires artifactId/);
    s.close();
  });

  test("5 种边都能建，边的两端必须存在", () => {
    const s = store();
    const idea = s.create({ type: "idea", content: "假设 H1" });
    const paper = s.create({ type: "paper", content: "Smith 2024", evidence: "sourced" });
    const obs = s.create({ type: "observation", content: "实验数据", evidence: "observed" });
    const conclusion = s.create({ type: "conclusion", content: "结论 C1" });
    const older = s.create({ type: "conclusion", content: "旧结论" });

    s.link(paper.id, idea.id, "supports");
    s.link(obs.id, idea.id, "contradicts");
    s.link(conclusion.id, obs.id, "derives_from");
    s.link(conclusion.id, paper.id, "cites");
    s.link(conclusion.id, older.id, "supersedes");

    expect(s.listEdges().length).toBe(5);
    expect(s.listEdges("cites")).toHaveLength(1);
    expect(s.edgesOf(idea.id).incoming.map((e) => e.type).sort()).toEqual(["contradicts", "supports"]);
    expect(s.edgesOf(conclusion.id).outgoing).toHaveLength(3);

    expect(() => s.link(idea.id, "missing-id", "supports")).toThrow(/not found/);
    expect(() => s.link("missing-id", idea.id, "supports")).toThrow(/not found/);
    expect(() => s.link(idea.id, idea.id, "supports")).toThrow(/self edge/);
    expect(() => s.link(idea.id, paper.id, "reeks_of" as never)).toThrow(/unknown edge type/);
    s.close();
  });

  test("重复建同一条边幂等", () => {
    const s = store();
    const a = s.create({ type: "idea", content: "a" });
    const b = s.create({ type: "idea", content: "b" });
    s.link(a.id, b.id, "supports");
    s.link(a.id, b.id, "supports");
    expect(s.listEdges()).toHaveLength(1);
    s.close();
  });

  test("list 支持按类型 / session / 证据标签过滤", () => {
    const s = store();
    s.create({ type: "idea", content: "i1", origin: { kind: "session", sessionId: "s1" } });
    s.create({ type: "idea", content: "i2", origin: { kind: "session", sessionId: "s2" } });
    s.create({ type: "observation", content: "o1", evidence: "observed", origin: { kind: "session", sessionId: "s1" } });

    expect(s.list({ type: "idea" })).toHaveLength(2);
    expect(s.list({ type: ["idea", "observation"] })).toHaveLength(3);
    expect(s.list({ sessionId: "s1" })).toHaveLength(2);
    expect(s.list({ evidence: "observed" })).toHaveLength(1);
    expect(s.list({ limit: 1 })).toHaveLength(1);
    s.close();
  });

  test("graph 以 record 为中心双向展开", () => {
    const s = store();
    const idea = s.create({ type: "idea", content: "H1" });
    const paper = s.create({ type: "paper", content: "P1", evidence: "sourced" });
    const conclusion = s.create({ type: "conclusion", content: "C1" });
    const far = s.create({ type: "decision", content: "D1" });
    s.link(paper.id, idea.id, "supports");
    s.link(conclusion.id, idea.id, "derives_from");
    s.link(far.id, conclusion.id, "supports");

    const depth1 = s.graph(idea.id, 1);
    expect(depth1.nodes.map((n) => n.id).sort()).toEqual([idea.id, paper.id, conclusion.id].sort());
    const depth2 = s.graph(idea.id, 2);
    expect(depth2.nodes).toHaveLength(4);
    expect(depth2.edges).toHaveLength(3);
    expect(() => s.graph("missing")).toThrow(RecordValidationError);
    s.close();
  });

  // P7：时间线端点要的三个过滤维度。放在存储层测是因为 total 与「这一页」共用同一套谓词，
  // 谓词错了在 HTTP 层只会表现为「翻页时总数变来变去」，很难定位。
  test("since / until 按时间窗过滤（含端点）", () => {
    const s = store();
    for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
      s.create({ type: "idea", content: day, createdAt: `${day}T00:00:00.000Z` });
    }
    expect(s.list({ since: "2026-01-02T00:00:00.000Z" })).toHaveLength(2);
    expect(s.list({ until: "2026-01-02T00:00:00.000Z" })).toHaveLength(2);
    expect(
      s.list({ since: "2026-01-02T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" }).map((r) => r.content),
    ).toEqual(["2026-01-02"]);
    s.close();
  });

  test("offset 分页；只给 offset 不给 limit 也要正确跳过", () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      s.create({ type: "idea", content: `i${i}`, createdAt: `2026-02-0${i + 1}T00:00:00.000Z` });
    }
    expect(s.list({ limit: 2 }).map((r) => r.content)).toEqual(["i0", "i1"]);
    expect(s.list({ limit: 2, offset: 2 }).map((r) => r.content)).toEqual(["i2", "i3"]);
    expect(s.list({ offset: 3 }).map((r) => r.content)).toEqual(["i3", "i4"]);
    expect(s.list({ offset: 99 })).toHaveLength(0);
    s.close();
  });

  test("count(filter) 与 list(filter) 用同一套谓词", () => {
    const s = store();
    s.create({ type: "idea", content: "a", createdAt: "2026-03-01T00:00:00.000Z" });
    s.create({ type: "idea", content: "b", createdAt: "2026-03-05T00:00:00.000Z" });
    s.create({ type: "paper", content: "c", createdAt: "2026-03-05T00:00:00.000Z" });
    expect(s.count()).toBe(3);
    expect(s.count({ type: "idea" })).toBe(2);
    expect(s.count({ type: "idea", since: "2026-03-02T00:00:00.000Z" })).toBe(1);
    // 分页参数不该影响总数——这正是把 limit/offset 排除在谓词之外的原因。
    expect(s.count({ type: "idea", limit: 1 })).toBe(2);
    s.close();
  });
});

describe("record ↔ artifact 互链（AD-3）", () => {
  test("createFromArtifact 用 artifact id 建立跨表引用", () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    const project = manager.create("linked");

    const file = join(root, "result.csv");
    writeFileSync(file, "a,b\n1,2\n");
    const artifact = project.artifacts().save(file, "df.to_csv('result.csv')", [], {
      sessionId: "sess-1",
      cellIndex: 2,
    });

    const records = project.records();
    const rec = records.createFromArtifact(artifact);
    expect(rec.type).toBe("artifact");
    expect(rec.artifactId).toBe(artifact.id);
    expect(rec.origin.sessionId).toBe("sess-1");
    expect(records.list({ artifactId: artifact.id })).toHaveLength(1);

    // 从 record 回到 artifacts 表拿到本体，两张表通过 id 互链。
    const back = project.artifacts().get(rec.artifactId!)!;
    expect(back.filename).toBe("result.csv");
    expect(back.projectSlug).toBe("linked");
    project.close();
  });

  test("observation → artifact 的 derives_from 边可查", () => {
    const root = tempRoot();
    const project = new ProjectManager(root).create("graphy");
    const file = join(root, "fig.png");
    writeFileSync(file, "PNGDATA");
    const artifact = project.artifacts().save(file, "plt.savefig('fig.png')", [], {});
    const records = project.records();
    const artRec = records.createFromArtifact(artifact);
    const obs = records.create({ type: "observation", content: "曲线在 30 分钟饱和", evidence: "observed" });
    records.link(obs.id, artRec.id, "derives_from");

    const graph = records.graph(artRec.id, 1);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges[0]!.type).toBe("derives_from");
    project.close();
  });
});

describe("artifact 的 project 字段接真实 project 引用", () => {
  test("Project.artifacts() 默认写入本项目 slug", () => {
    const root = tempRoot();
    const project = new ProjectManager(root).create("real-proj");
    const file = join(root, "a.csv");
    writeFileSync(file, "x\n1\n");
    const artifact = project.artifacts().save(file, "code", [], {});
    expect(artifact.project).toBe("real-proj");
    expect(artifact.projectSlug).toBe("real-proj");
    expect(project.artifacts().listByProjectSlug("real-proj")).toHaveLength(1);
    project.close();
  });

  test("注入 ProjectManager 时自由字符串被解析成真实 slug", () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    manager.create("demo-project");
    const store = new ArtifactStore(join(root, "artifacts.db"), join(root, "storage"), {
      projects: manager,
    });
    const file = join(root, "b.csv");
    writeFileSync(file, "x\n1\n");

    const resolved = store.save(file, "code", [], {}, "Demo Project");
    expect(resolved.project).toBe("Demo Project");
    expect(resolved.projectSlug).toBe("demo-project");

    const unresolved = store.save(file, "code", [], {}, "从来没有的项目");
    expect(unresolved.projectSlug).toBeNull();
    store.close();
  });

  test("旧库（无 project_slug 列）打开后自动迁移且旧数据可读", () => {
    const root = tempRoot();
    const dbPath = join(root, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, filename TEXT NOT NULL, version INTEGER NOT NULL,
      content_type TEXT NOT NULL, checksum TEXT NOT NULL, storage_path TEXT NOT NULL,
      extracted_code TEXT, code_description TEXT, lineage_messages TEXT NOT NULL DEFAULT '[]',
      environment_snapshot TEXT, parent_version_id TEXT, producing_cell_id TEXT,
      dependency_mappings TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE (project, filename, version));`);
    legacy
      .query(
        `INSERT INTO artifacts (id, project, filename, version, content_type, checksum, storage_path, created_at)
         VALUES ('old-1', 'Legacy Project', 'old.csv', 1, 'text/csv', 'deadbeef', ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(join(root, "storage", "old-1__old.csv"));
    legacy.close();

    const store = new ArtifactStore(dbPath, join(root, "storage"));
    const listed = store.listByProject("Legacy Project");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.project).toBe("Legacy Project");
    // 迁移时按 slug 规则回填，旧行不丢。
    expect(listed[0]!.projectSlug).toBe("legacy-project");

    // 迁移后仍能正常写入新数据。
    const file = join(root, "new.csv");
    writeFileSync(file, "x\n1\n");
    const fresh = store.save(file, "code", [], {}, "Legacy Project");
    expect(fresh.projectSlug).toBe("legacy-project");
    store.close();
  });
});

describe("project CLI", () => {
  function run(args: string[], root: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runProjectCommand(args, { root, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("project new / list / open / archive 全流程", () => {
    const root = tempRoot();
    const created = run(["new", "photocat", "--name", "光催化", "--desc", "课题 B"], root);
    expect(created.code).toBe(0);
    expect(created.out).toContain("已创建项目 'photocat'");
    expect(created.out).toContain("光催化");

    run(["new", "second"], root);
    const listed = run(["list"], root);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("photocat");
    expect(listed.out).toContain("second");
    // 第一个创建的项目自动成为当前项目
    expect(listed.out).toContain("* photocat");

    const opened = run(["open", "second"], root);
    expect(opened.code).toBe(0);
    expect(opened.out).toContain("当前项目已切换为 'second'");
    expect(run(["list"], root).out).toContain("* second");

    const archived = run(["archive", "second"], root);
    expect(archived.code).toBe(0);
    expect(run(["list"], root).out).not.toContain("second");
    expect(run(["list", "--all"], root).out).toContain("[已归档]");
  });

  test("错误用法返回非零退出码且不抛异常", () => {
    const root = tempRoot();
    expect(run(["new"], root).code).toBe(1);
    expect(run(["open", "missing"], root).code).toBe(1);
    expect(run(["new", "../escape"], root).err).toContain("无效的 project slug");
    expect(run(["bogus"], root).code).toBe(1);
    expect(run([], root).code).toBe(1);
    expect(run(["help"], root).code).toBe(0);
  });

  test("空目录 list 给出引导文案", () => {
    expect(run(["list"], tempRoot()).out).toContain("暂无项目");
  });
});

describe("e2e：建项目 → 写 record + artifact → 重开 → 数据完整", () => {
  test("持久化往返", () => {
    const root = tempRoot("spark-e2e-");
    const sessionId = "sess-e2e";

    // 1. CLI 建项目
    const lines: string[] = [];
    const code = runProjectCommand(["new", "e2e-proj", "--name", "端到端"], {
      root,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(0);

    // 2. 会话归属该项目，写入 artifact + 一串 record 与边
    const manager = new ProjectManager(root);
    manager.bindSession(sessionId, "e2e-proj");
    const project = manager.projectForSession(sessionId);
    expect(project.slug).toBe("e2e-proj");

    const file = join(root, "measurements.csv");
    writeFileSync(file, "t,y\n0,1\n1,2\n");
    const artifact = project
      .artifacts()
      .save(file, "df.to_csv('measurements.csv')", [], { sessionId, cellIndex: 1 });

    const records = project.records();
    const idea = records.create({
      type: "idea",
      title: "H1",
      content: "光强与产率正相关",
      evidence: "inferred",
      origin: { kind: "session", sessionId },
    });
    const paper = records.create({
      type: "paper",
      title: "Smith 2024",
      content: "doi:10.0000/fake",
      evidence: "sourced",
      origin: { kind: "connector", connector: "openalex" },
    });
    const artRec = records.createFromArtifact(artifact);
    const obs = records.create({
      type: "observation",
      content: "产率随光强线性上升",
      evidence: "observed",
      origin: { kind: "cell", sessionId, ref: `${sessionId}:1` },
    });
    const conclusion = records.create({
      type: "conclusion",
      content: "在测试区间内 H1 成立",
      evidence: "computed",
      origin: { kind: "session", sessionId },
    });
    records.link(paper.id, idea.id, "supports");
    records.link(obs.id, artRec.id, "derives_from");
    records.link(conclusion.id, obs.id, "derives_from");
    records.link(conclusion.id, paper.id, "cites");

    const artifactId = artifact.id;
    const conclusionId = conclusion.id;

    // 3. 关闭所有存储句柄，模拟进程退出
    project.close();

    // 4. 重新打开（新 manager / 新 store 实例）
    const reopened = new ProjectManager(root);
    expect(reopened.sessionProjectSlug(sessionId)).toBe("e2e-proj");
    const again = reopened.open("e2e-proj");
    expect(again.meta.name).toBe("端到端");

    const rec2 = again.records();
    expect(rec2.count()).toBe(5);
    expect(rec2.list({ type: "conclusion" })).toHaveLength(1);
    expect(rec2.list({ sessionId })).toHaveLength(4);
    expect(rec2.listEdges()).toHaveLength(4);

    const graph = rec2.graph(conclusionId, 3);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      [conclusionId, obs.id, paper.id, artRec.id, idea.id].sort(),
    );

    // artifact 本体与 record 的跨表引用在重开后仍成立
    const art2 = again.artifacts().get(artifactId)!;
    expect(art2.content).toBe("t,y\n0,1\n1,2\n");
    expect(art2.projectSlug).toBe("e2e-proj");
    expect(again.artifacts().listBySession(sessionId)).toHaveLength(1);
    expect(rec2.list({ artifactId })[0]!.type).toBe("artifact");
    again.close();
  });
});
