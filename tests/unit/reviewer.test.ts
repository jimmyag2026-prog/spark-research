import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageGraph } from "../../backend/src/artifacts/lineage.ts";
import type { ArtifactVersion } from "../../backend/src/artifacts/models.ts";
import { ArtifactStore } from "../../backend/src/artifacts/store.ts";
import { ReviewerAgent } from "../../backend/src/reviewer/agent.ts";
import type { ExecutionRecord } from "../../backend/src/artifacts/models.ts";

const SESSION = "s1";

function makeStore(): { store: ArtifactStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "spark-reviewer-"));
  const store = new ArtifactStore(join(dir, "artifacts.db"), join(dir, "storage"));
  return { store, dir };
}

function saveArtifact(
  store: ArtifactStore,
  dir: string,
  name: string,
  code: string,
  env: Record<string, unknown> | null,
): ArtifactVersion {
  const filePath = join(dir, name);
  writeFileSync(filePath, code);
  return store.save(filePath, code, [], env, "proj");
}

function execRecord(
  store: ArtifactStore,
  frame: string,
  cellIndex: number,
  filesWritten: string[],
): ExecutionRecord {
  return store.saveExecution({
    frame,
    cellIndex,
    kernelId: null,
    language: "python",
    source: "print(1)",
    stdout: "",
    stderr: "",
    status: "success",
    filesWritten,
    filesRead: [],
    wallTime: 0,
    cpuTime: 0,
    peakMemory: 0,
  });
}

describe("ReviewerAgent", () => {
  test("无来源的 claim 产生 hard finding 并否决", async () => {
    const { store, dir } = makeStore();
    const a = saveArtifact(store, dir, "result.txt", "df.mean()", { sessionId: SESSION, cellIndex: 0 });
    const reviewer = new ReviewerAgent(store, [], new LineageGraph());

    const result = await reviewer.review(SESSION);

    expect(result.approved).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ severity: "hard", artifactId: a.id });
    expect(result.findings[0].message).toContain("unverifiable claim");
  });

  test("approved=false 时 action 为 veto 且带 notice", async () => {
    const { store, dir } = makeStore();
    saveArtifact(store, dir, "result.txt", "df.mean()", { sessionId: SESSION, cellIndex: 0 });
    const reviewer = new ReviewerAgent(store, [], new LineageGraph());

    const result = await reviewer.review(SESSION);

    expect(result.approved).toBe(false);
    expect(result.action).toBe("inject_notice_and_veto_completion");
    expect(result.notice).toContain("veto");
  });

  test("version_mix 冲突被检测到", async () => {
    const { store, dir } = makeStore();
    const report = saveArtifact(store, dir, "report.md", "pd.concat()", {
      sessionId: SESSION,
      cellIndex: 1,
    });
    execRecord(store, SESSION, 1, ["report.md"]);

    const graph = new LineageGraph();
    graph.registerVersion({ id: "data-v1", filename: "data.csv", version: 1 });
    graph.registerVersion({ id: "data-v2", filename: "data.csv", version: 2 });
    graph.addEdge("data-v1", report.id);
    graph.addEdge("data-v2", report.id);

    const reviewer = new ReviewerAgent(store, store.listExecutionsByFrame(SESSION), graph);
    const result = await reviewer.review(SESSION);

    expect(result.findings.some((f) => f.message.includes("version_mix"))).toBe(true);
  });

  test("clean artifact 通过（approved=true）", async () => {
    const { store, dir } = makeStore();
    const a = saveArtifact(store, dir, "result.txt", "df.mean()", {
      sessionId: SESSION,
      cellIndex: 0,
    });
    execRecord(store, SESSION, 0, ["result.txt"]);

    const graph = new LineageGraph();
    graph.registerVersion({ id: a.id, filename: "result.txt", version: 1 });
    const reviewer = new ReviewerAgent(store, store.listExecutionsByFrame(SESSION), graph);
    const result = await reviewer.review(SESSION);

    expect(result.approved).toBe(true);
    expect(result.findings.filter((f) => f.severity === "hard")).toHaveLength(0);
  });

  test("figure 类 artifact 的软错误升级为 hard，chat 保持不变", async () => {
    const { store, dir } = makeStore();
    const fig = saveArtifact(store, dir, "plot.png", "plt.savefig()", {
      sessionId: SESSION,
      cellIndex: 0,
    });
    const chat = saveArtifact(store, dir, "note.txt", "print(1)", {
      sessionId: SESSION,
      cellIndex: 1,
    });
    execRecord(store, SESSION, 0, ["plot.png"]);
    execRecord(store, SESSION, 1, ["note.txt"]);

    const graph = new LineageGraph();
    graph.registerVersion({ id: "data-v1", filename: "data.csv", version: 1 });
    graph.registerVersion({ id: "data-v2", filename: "data.csv", version: 2 });
    graph.addEdge("data-v1", fig.id);
    graph.addEdge("data-v1", chat.id);

    const reviewer = new ReviewerAgent(store, store.listExecutionsByFrame(SESSION), graph);
    const result = await reviewer.review(SESSION);

    const figFinding = result.findings.find((f) => f.artifactId === fig.id);
    const chatFinding = result.findings.find((f) => f.artifactId === chat.id);
    expect(figFinding?.severity).toBe("hard");
    expect(chatFinding?.severity).toBe("soft");
    expect(result.approved).toBe(false);
  });
});
