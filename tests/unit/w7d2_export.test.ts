import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { LibraryStore } from "../../backend/src/literature/library";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";
import { JsonlRawSink } from "../../backend/src/raw";
import { exportProject, latestManifest } from "../../backend/src/data/export";
import { importExport, verifyExportDir } from "../../backend/src/data/import";
import { runDataCommand } from "../../backend/src/data/cli";
import { reportFor } from "../../backend/src/report/cli";

// v0.7 W7-D2 · 门禁 G5：export → 空项目 import → records/edges/journal/raw 逐条相等、report diff 为空；
// G6 的导出面：--for-sharing 产物里 grep 不到 upstream 内容，stub 保边，manifest.excluded 如实。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "spark-export-"));
  dirs.push(d);
  return d;
}
const paper = (title: string, doi: string): Paper => ({ ...emptyPaper(), title, doi, year: 2023, abstract: "上游摘要 SECRET-UPSTREAM-TEXT", sources: ["openalex"], citedByCount: 9 });

function seedProject(root: string, slug: string) {
  const manager = new ProjectManager(root);
  const project = manager.create(slug, { name: "导出样本", description: "样本项目" });
  const records = project.records();
  const library = new LibraryStore(project.paths.libraryDb, { records });
  const added = library.add(paper("Upstream paper", "10.9/up"));
  const idea = records.create({ type: "idea", title: "思路", content: "用户写的思路", provenanceClass: "user_authored" });
  const card = records.create({ type: "reading", title: "精读卡", content: "模型写的卡", provenanceClass: "model_generated", metadata: { basis: "abstract" } });
  const obs = records.create({ type: "observation", title: "观测", content: "算出来的", provenanceClass: "derived", metadata: { deterministic: true } });
  const paperRecord = records.list({ type: "paper" })[0]!;
  records.link(card.id, paperRecord.id, "cites");
  records.link(obs.id, idea.id, "derives_from");
  records.update(idea.id, { content: "用户改过的思路" });
  // raw：一条 connector（upstream）+ 一条 llm + 一个 blob
  const sink = project.raw() as JsonlRawSink;
  const big = "x".repeat(70 * 1024);
  sink.append({ kind: "connector", provenanceClass: "upstream", license: "CC0-1.0", payload: { connector: "openalex", tool: "search", host: "api.openalex.org", method: "GET", params: { q: "a" }, status: 200, latencyMs: 1, contentType: "application/json", response: sink.body("SECRET-UPSTREAM-RAW") } });
  sink.append({ kind: "llm", provenanceClass: "model_generated", license: "LicenseRef-spark-user-owned", payload: { provider: "openrouter", model: "m", ok: true, failureKind: null, messages: sink.body("[]"), response: sink.body(big), usage: { inputTokens: 1, outputTokens: 1, costUsd: null, usageUnavailable: false }, options: {} } });
  // artifact
  const f = join(root, "out.csv");
  writeFileSync(f, "a,b\n1,2\n");
  const saved = project.artifacts().save(f, "print(1)", [], { sessionId: "s1", cellIndex: 0 }, slug);
  records.createFromArtifact(saved, { provenanceClass: "derived", evidence: "computed", metadata: { kind: "test_artifact" } });
  writeFileSync(join(project.paths.root, "usage.jsonl"), `${JSON.stringify({ ts: "2026-09-11T00:00:00.000Z", command: "lit-read", provider: "openrouter", model: "m", ok: true, inputTokens: 1, outputTokens: 1, costUsd: 0.01 })}\n`);
  library.close();
  return { manager, project, ids: { idea: idea.id, card: card.id, obs: obs.id, paperRecord: paperRecord.id, paperId: added.paper.id } };
}

function normalizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(({ project: _p, ...rest }) => rest).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

describe("G5 · export → import 往返", () => {
  test("records / edges / journal / raw / artifacts / library 逐条相等，report diff 为空；manifest 可核", () => {
    const root = tmp();
    const { manager, project } = seedProject(root, "src");
    const result = exportProject(project, { now: () => "2026-09-11T10:00:00.000Z" });
    expect(existsSync(join(result.dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(result.dir, "records", "type=idea", "date=" + new Date().toISOString().slice(0, 10), "part-0.jsonl"))).toBe(true);
    const m = result.manifest;
    expect(m.share).toBe("src");
    expect(m.schemas.records.tables.paper).toBe(1);
    expect(m.schemas.edges.count).toBe(2);
    expect(m.schemas.raw.tables).toEqual({ connector: 1, llm: 1 });
    expect(m.schemas.artifacts.versions).toBe(1);
    expect(m.schemas.artifacts.executionRecords).toBe(0); // V82：如实导空
    expect(m.schemas.library.papers).toBe(1);
    expect(m.prevManifestHash).toBeNull();
    expect(m.provenanceClasses.upstream).toBe(1);
    expect(verifyExportDir(result.dir).ok).toBe(true);
    // blob 也导出了
    const llmRow = JSON.parse(readFileSync(join(result.dir, "raw", "kind=llm", "date=" + new Date().toISOString().slice(0, 10), "part-0.jsonl"), "utf8").trim()) as { payload: { response: { blob: string } } };
    expect(existsSync(join(result.dir, "raw", "blobs", llmRow.payload.response.blob.slice(0, 2), llmRow.payload.response.blob))).toBe(true);

    const imported = importExport(manager, result.dir, "dst");
    expect(imported.verified).toBe(true);
    const src = project.records();
    const dst = imported.project.records();
    expect(normalizeRows(dst.exportRecordRows())).toEqual(normalizeRows(src.exportRecordRows()));
    expect(dst.exportEdgeRows()).toEqual(src.exportEdgeRows());
    expect(dst.journalEntries()).toEqual(src.journalEntries());
    expect(dst.verifyJournal().ok).toBe(true);
    const srcRaw = [...(project.raw() as JsonlRawSink).iterate()];
    const dstRaw = [...(imported.project.raw() as JsonlRawSink).iterate()];
    expect(dstRaw).toEqual(srcRaw);
    expect((imported.project.raw() as JsonlRawSink).verify("llm").ok).toBe(true);
    expect((imported.project.raw() as JsonlRawSink).readBlob(llmRow.payload.response.blob)).toBe("x".repeat(70 * 1024));
    const srcArt = project.artifacts().exportVersions();
    const dstArt = imported.project.artifacts().exportVersions();
    expect(dstArt.map((v) => [v.row.id, v.row.checksum, v.contentBase64])).toEqual(srcArt.map((v) => [v.row.id, v.row.checksum, v.contentBase64]));
    const srcLib = new LibraryStore(project.paths.libraryDb, { records: src });
    const dstLib = new LibraryStore(imported.project.paths.libraryDb, { records: dst });
    expect(dstLib.exportRows()).toEqual(srcLib.exportRows());
    srcLib.close();
    dstLib.close();
    // report diff 为空（slug 归一化）
    const md = (p: typeof project) => String(reportFor(p, { now: "2026-09-11T10:00:00.000Z" }).markdown).replaceAll(p.slug, "<slug>");
    expect(md(imported.project)).toBe(md(project));
    imported.project.close();
    project.close();
  });

  test("增量：第二次导出带 prevManifestHash 成链；import 拒绝非空项目", () => {
    const root = tmp();
    const { manager, project } = seedProject(root, "chain");
    const first = exportProject(project, { now: () => "2026-09-11T10:00:00.000Z" });
    expect(latestManifest(project)?.hash).toBe(first.manifestHash);
    const second = exportProject(project, { now: () => "2026-09-11T11:00:00.000Z", since: "2026-09-11T10:00:00.000Z" });
    expect(second.manifest.prevManifestHash).toBe(first.manifestHash);
    expect(() => importExport(manager, first.dir, "chain")).toThrow(/已存在/);
    project.close();
  });
});

describe("G6 导出面 · --for-sharing", () => {
  test("upstream 打桩保边、journal/raw/library 上游不出门、manifest.excluded 如实；产物 grep 不到上游内容", () => {
    const root = tmp();
    const { manager, project, ids } = seedProject(root, "share");
    const result = exportProject(project, { forSharing: true, now: () => "2026-09-11T10:00:00.000Z" });
    const m = result.manifest;
    expect(m.forSharing).toBe(true);
    expect(m.excluded).toEqual({ recordsStubbed: 1, journalStubbed: 1, rawDropped: 1, libraryDropped: 1 });
    expect(m.schemas.library.papers).toBe(0);
    expect(m.schemas.raw.tables).toEqual({ llm: 1 });
    expect(m.schemas.edges.count).toBe(2); // 边保住
    expect(m.provenanceClasses.upstream).toBeUndefined();
    // 产物里没有上游内容
    let all = "";
    for (const f of m.files) all += readFileSync(join(result.dir, f.path), "utf8");
    expect(all.includes("SECRET-UPSTREAM")).toBe(false);
    expect(all.includes("Upstream paper")).toBe(false);
    // stub 行存在且只有骨架
    const paperFile = m.files.find((f) => f.path.startsWith("records/type=paper/"))!;
    const stub = JSON.parse(readFileSync(join(result.dir, paperFile.path), "utf8").trim()) as Record<string, unknown>;
    expect(stub.stub).toBe(true);
    expect(stub.id).toBe(ids.paperRecord);
    expect(stub.content).toBeUndefined();
    // import 后 stub 是空内容 record，边仍在
    const imported = importExport(manager, result.dir, "share-dst");
    const rec = imported.project.records().get(ids.paperRecord)!;
    expect(rec.content).toBe("");
    expect(rec.metadata.stub).toBe(true);
    expect(imported.project.records().edgesOf(ids.card).outgoing.map((e) => e.targetId)).toContain(ids.paperRecord);
    imported.project.close();
    project.close();
  });

  test("CLI：data export / verify / import 三条可达", async () => {
    const root = tmp();
    const { project } = seedProject(root, "cli");
    project.close();
    const out: string[] = [];
    const err: string[] = [];
    const deps = { root, out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => "2026-09-11T10:00:00.000Z" };
    expect(await runDataCommand(["export", "--project", "cli", "--for-sharing"], deps)).toBe(0);
    const dir = out.find((l) => l.includes("已导出项目"))!.split("→ ")[1]!.trim();
    expect(await runDataCommand(["verify", dir], deps)).toBe(0);
    const code = await runDataCommand(["import", dir, "--project", "cli-dst"], deps);
    expect(err.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("--for-sharing（AD-16）");
    // 篡改一个文件 → verify 红
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    writeFileSync(join(dir, m.files[0]!.path), "tampered\n");
    expect(await runDataCommand(["verify", dir], deps)).toBe(1);
    expect(await runDataCommand(["import", dir, "--project", "cli-dst2"], deps)).toBe(1);
  });
});
