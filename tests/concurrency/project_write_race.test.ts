import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";

// v0.7 alpha.6 · R4 P1-5 复现：同项目两个进程各自反复做「idea check 落库」那一组动作——
// 打开项目四库（records/library/artifacts/findings）→ 存 artifact → createFromArtifact → update record →
// findings.reviewTarget。期望零 "database is locked"。

const WORKER = `
const root = process.argv[2], tag = process.argv[3], n = Number(process.argv[4]);
const { ProjectManager } = await import(${JSON.stringify(join(import.meta.dir, "../../backend/src/project/manager.ts"))});
const { LibraryStore } = await import(${JSON.stringify(join(import.meta.dir, "../../backend/src/literature/library.ts"))});
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
let locked = 0; const other = [];
const where = {};
for (let i = 0; i < n; i++) {
  let step = "open";
  try {
    const project = new ProjectManager(root).open("race");
    const records = project.records(); step = "library-open";
    const library = new LibraryStore(project.paths.libraryDb, { records }); step = "artifacts-open";
    project.artifacts(); step = "findings-open";
    project.findings(); step = "artifact-save";
    const f = join(root, tag + "-" + i + ".txt"); writeFileSync(f, "x" + i);
    const art = project.artifacts().save(f, "code", [], { sessionId: tag, cellIndex: i }, "race"); step = "createFromArtifact";
    const rec = records.createFromArtifact(art, { provenanceClass: "derived", evidence: "computed" }); step = "update";
    records.update(rec.id, { title: tag + i }); step = "reviewTarget";
    project.findings().reviewTarget({ project: "race", target: { kind: "artifact", id: art.id }, checker: "citation-integrity", hits: [{ severity: "soft", fingerprint: "fp" + i, evidence: "e" }] }); step = "close";
    library.close(); project.close();
  } catch (e) {
    if (String(e).includes("database is locked")) { locked++; where[step] = (where[step] ?? 0) + 1; } else other.push(step + ": " + String(e).slice(0, 200));
  }
}
console.log(JSON.stringify({ tag, locked, other, where }));
`;

describe("同项目两进程并发『idea check 式』落库", () => {
  test("各 60 次 → 零 database is locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-prace-"));
    const manager = new ProjectManager(dir);
    manager.create("race").close();
    const script = join(dir, "worker.ts");
    writeFileSync(script, WORKER);
    const spawn = (tag: string) => Bun.spawn(["bun", script, dir, tag, "60"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [a, b] = [spawn("A"), spawn("B")];
    const [outA, outB, errA, errB, ca, cb] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text(), new Response(a.stderr).text(), new Response(b.stderr).text(), a.exited, b.exited]);
    if (ca !== 0 || cb !== 0) throw new Error(`worker 退出码 ${ca}/${cb}\n${errA}\n${errB}`);
    const ra = JSON.parse(outA.trim().split("\n").pop()!) as { locked: number; other: string[] };
    const rb = JSON.parse(outB.trim().split("\n").pop()!) as { locked: number; other: string[] };
    const report = JSON.stringify({ A: ra, B: rb });
    expect(ra.locked + rb.locked, report).toBe(0);
    expect(ra.other.length + rb.other.length, report).toBe(0);
    const p = manager.open("race");
    expect(p.records().count()).toBe(120);
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});
