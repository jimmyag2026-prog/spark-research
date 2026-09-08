import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../backend/src/artifacts/store";
import { LineageGraph } from "../../backend/src/artifacts/lineage";

describe("ArtifactStore", () => {
  let dir: string;
  let store: ArtifactStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "spark-artifacts-"));
    store = new ArtifactStore(join(dir, "artifacts.db"), join(dir, "storage"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("save 后能 get 到，checksum 正确", () => {
    const file = join(dir, "result.csv");
    const content = "a,b,c\n1,2,3\n";
    writeFileSync(file, content);

    const artifact = store.save(file, "df.to_csv('result.csv')", [], {}, "demo");

    expect(artifact.id).toBeTruthy();
    expect(artifact.version).toBe(1);
    expect(artifact.filename).toBe("result.csv");
    expect(artifact.checksum).toBe(createHash("sha256").update(content).digest("hex"));

    const got = store.get(artifact.id);
    expect(got).not.toBeNull();
    expect(got!.checksum).toBe(artifact.checksum);
    expect(got!.content).toBe(content);
    expect(got!.storagePath).toContain(join(dir, "storage"));
  });

  test("同一 filename 第二次保存 version=2", () => {
    const file = join(dir, "plot.png");
    writeFileSync(file, "PNGDATA1");
    const v1 = store.save(file, "plt.savefig('plot.png')", [], {}, "demo");
    expect(v1.version).toBe(1);

    writeFileSync(file, "PNGDATA2");
    const v2 = store.save(file, "plt.savefig('plot.png')", [], {}, "demo");
    expect(v2.version).toBe(2);
    expect(v2.parentVersionId).toBe(v1.id);
    expect(v2.checksum).not.toBe(v1.checksum);
  });

  test("getLineageGraph 返回正确的依赖关系", () => {
    const fA = join(dir, "clean.csv");
    writeFileSync(fA, "x,y\n1,2\n");
    const a = store.save(fA, "clean()", [], {}, "demo");

    const fB = join(dir, "analysis.csv");
    writeFileSync(fB, "mean=1.5\n");
    const b = store.save(
      fB,
      "analyze()",
      [{ role: "assistant", content: "reads clean.csv", file: "clean.csv", kind: "read" }],
      {},
      "demo",
    );

    const graph = store.getLineageGraph(b.id);
    expect(graph.nodes.length).toBe(2);
    const nodeIds = graph.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual([a.id, b.id].sort());

    const edge = graph.edges.find(
      (e) => e.sourceVersionId === a.id && e.targetVersionId === b.id,
    );
    expect(edge).toBeTruthy();
  });

  test("listByProject 返回正确数量", () => {
    const list = store.listByProject("demo");
    expect(list.length).toBe(5);
    expect(list.every((a) => a.project === "demo")).toBe(true);
  });

  test("listBySession 按 producingCellId 过滤", () => {
    const file = join(dir, "session_out.csv");
    writeFileSync(file, "k,v\n1,1\n");
    store.save(file, "out()", [], { sessionId: "sess-1", cellIndex: 3 }, "demo");
    store.save(file, "out2()", [], { sessionId: "sess-2", cellIndex: 0 }, "demo");

    const bySess = store.listBySession("sess-1");
    expect(bySess.length).toBe(1);
    expect(bySess[0].producingCellId).toBe("sess-1:3");
  });
});

describe("LineageGraph", () => {
  test("hasVersionConflicts 能检测 version_mix 冲突", () => {
    const graph = new LineageGraph([
      { id: "a1", filename: "data.csv", version: 1 },
      { id: "a2", filename: "data.csv", version: 2 },
      { id: "b", filename: "b.csv", version: 1 },
      { id: "c", filename: "c.csv", version: 1 },
      { id: "d", filename: "d.csv", version: 1 },
    ]);
    graph.addEdge("a1", "b");
    graph.addEdge("a2", "c");
    graph.addEdge("b", "d");
    graph.addEdge("c", "d");

    const conflicts = graph.hasVersionConflicts("d");
    expect(conflicts).not.toBeNull();
    const mix = conflicts.find((c) => c.type === "version_mix");
    expect(mix).toBeTruthy();
    expect(mix!.artifact).toBe("data.csv");
    expect([...mix!.versions].sort()).toEqual(["a1", "a2"]);
  });

  test("hasVersionConflicts 检测 stale_input", () => {
    const graph = new LineageGraph([
      { id: "a1", filename: "data.csv", version: 1 },
      { id: "a2", filename: "data.csv", version: 2 },
      { id: "b", filename: "b.csv", version: 1 },
    ]);
    graph.addEdge("a1", "b");

    const conflicts = graph.hasVersionConflicts("b");
    const stale = conflicts.find((c) => c.type === "stale_input");
    expect(stale).toBeTruthy();
    expect(stale!.artifact).toBe("data.csv");
    expect(stale!.latestVersionId).toBe("a2");
    expect(conflicts.some((c) => c.type === "version_mix")).toBe(false);
  });

  test("getGraph 返回子图结构与边", () => {
    const graph = new LineageGraph([
      { id: "a", filename: "a.csv", version: 1 },
      { id: "b", filename: "b.csv", version: 1 },
      { id: "c", filename: "c.csv", version: 1 },
    ]);
    graph.addEdge("a", "b");
    graph.addEdge("b", "c");

    const sub = graph.getGraph("c");
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(sub.edges).toHaveLength(2);
  });
});
