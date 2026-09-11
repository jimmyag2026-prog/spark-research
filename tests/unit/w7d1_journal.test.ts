import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../../backend/src/project/records";
import { ProjectManager } from "../../backend/src/project/manager";
import { LibraryStore } from "../../backend/src/literature/library";
import { retractOrphanRecords } from "../../backend/src/literature/reading";
import { runLitCommand } from "../../backend/src/literature/cli";
import { runReportCommand } from "../../backend/src/report/cli";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";

// v0.7 W7-D1 · L1 records_journal：append-only 日志（门禁 G4：重放 == 投影；篡改必红）·
// V24 repair 恢复路径 · V30 tombstone（library.remove 不再硬删，lit remove 是生产调用方）。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "spark-journal-"));
  dirs.push(d);
  return d;
}
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}
const paper = (title: string, doi: string): Paper => ({
  ...emptyPaper(),
  title,
  doi,
  year: 2024,
  abstract: "摘要",
  sources: ["openalex"],
  citedByCount: 3,
});

describe("records_journal · 每次写口一行、同事务、成链", () => {
  test("create / update ×2 / link 各落一行；history 按 seq；verifyJournal 绿", () => {
    const store = new RecordStore(join(tmp(), "records.db"), "p");
    const a = store.create({ type: "idea", content: "v1", title: "t1", provenanceClass: "user_authored" });
    const b = store.create({ type: "reading", content: "r", provenanceClass: "model_generated" });
    store.update(a.id, { content: "v2" });
    store.update(a.id, { title: "t2", metadata: { k: 1 } }, { expectedRev: 2 });
    store.link(a.id, b.id, "derives_from");
    store.link(a.id, b.id, "derives_from"); // 幂等重复不落日志
    const h = store.history(a.id);
    expect(h.map((e) => e.op)).toEqual(["create", "update", "update", "link"]);
    expect(h[0]!.patch.title).toBe("t1");
    expect(h[1]!.patch).toEqual({ content: "v2" });
    expect(h[2]!.revBefore).toBe(2);
    expect(h[2]!.revAfter).toBe(3);
    expect(h[3]!.patch).toEqual({ targetId: b.id, type: "derives_from" });
    const all = store.journalEntries();
    expect(all.length).toBe(5);
    expect(all[0]!.prevHash).toBeNull();
    for (let i = 1; i < all.length; i++) expect(all[i]!.prevHash).toBe(all[i - 1]!.hash);
    expect(store.verifyJournal()).toEqual({ ok: true, lines: 5 });
    store.close();
  });

  test("G4 · 重放日志得到的投影与 records 表逐字段相等；篡改任一行 verify 必红", () => {
    const db = join(tmp(), "records.db");
    const store = new RecordStore(db, "p");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(store.create({ type: "observation", content: `c${i}`, title: `t${i}`, provenanceClass: "derived", metadata: { i } }).id);
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let k = 0; k < 40; k++) {
      const id = ids[Math.floor(rnd() * ids.length)]!;
      const r = rnd();
      if (r < 0.4) store.update(id, { content: `c${k}` });
      else if (r < 0.7) store.update(id, { metadata: { [`m${k % 5}`]: k } });
      else store.update(id, { title: `T${k}` });
    }
    // 重放：从 create 快照起按 seq 叠 patch，与投影比。
    for (const id of ids) {
      const h = store.history(id);
      const base = h[0]!.patch as { title: string; content: string; metadata: string };
      let title = base.title;
      let content = base.content;
      let metadata = JSON.parse(base.metadata) as Record<string, unknown>;
      for (const e of h.slice(1)) {
        if (e.op !== "update") continue;
        if (typeof e.patch.title === "string") title = e.patch.title;
        if (typeof e.patch.content === "string") content = e.patch.content;
        if (e.patch.metadata) metadata = { ...metadata, ...(e.patch.metadata as Record<string, unknown>) };
      }
      const now = store.get(id)!;
      expect({ title: now.title, content: now.content, metadata: now.metadata }).toEqual({ title, content, metadata });
    }
    expect(store.verifyJournal().ok).toBe(true);
    // 阴性对照（内置）：直接改第 3 行的 patch → hash 对不上；改 hash 本身 → 第 4 行断链。
    const raw = new Database(db);
    raw.query("UPDATE records_journal SET patch = ? WHERE seq = 3").run(JSON.stringify({ content: "tampered" }));
    raw.close();
    const v = store.verifyJournal();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    store.close();
  });

  test("老库首次打开：既有 record 各落一行 op=backfill 快照；再开不重复", () => {
    const db = join(tmp(), "records.db");
    const s1 = new RecordStore(db, "p");
    s1.create({ type: "idea", content: "a", provenanceClass: "user_authored" });
    s1.create({ type: "idea", content: "b", provenanceClass: "user_authored" });
    s1.close();
    const raw = new Database(db);
    raw.exec("DROP TABLE records_journal");
    raw.close();
    const s2 = new RecordStore(db, "p");
    expect(s2.journalEntries().map((e) => e.op)).toEqual(["backfill", "backfill"]);
    s2.close();
    const s3 = new RecordStore(db, "p");
    expect(s3.journalEntries().length).toBe(2);
    s3.close();
  });
});

describe("V24 · repair：按日志把投影重建到第 N 步", () => {
  test("重建到早期 seq 恢复旧内容；落 op=repair 日志且需署名", () => {
    const store = new RecordStore(join(tmp(), "records.db"), "p");
    const r = store.create({ type: "conclusion", content: "原稿", title: "结论", provenanceClass: "user_authored", metadata: { a: 1 } });
    store.update(r.id, { content: "改坏了", metadata: { a: 2, b: 3 } });
    const seqCreate = store.history(r.id)[0]!.seq;
    expect(() => store.repair(r.id, { toSeq: seqCreate, actor: "" })).toThrow(/署名/);
    const fixed = store.repair(r.id, { toSeq: seqCreate, actor: "reviewer" });
    expect(fixed.content).toBe("原稿");
    expect(fixed.metadata).toEqual({ a: 1 });
    const h = store.history(r.id);
    expect(h[h.length - 1]!.op).toBe("repair");
    expect(h[h.length - 1]!.actor).toBe("reviewer");
    expect(store.verifyJournal().ok).toBe(true);
    // 重建到「改坏」那一步也行——repair 不是回滚，是选定步。
    const again = store.repair(r.id, { toSeq: h[1]!.seq, actor: "reviewer" });
    expect(again.content).toBe("改坏了");
    store.close();
  });
});

describe("V30 · library.remove 是 tombstone；lit remove 是生产调用方", () => {
  test("remove 后 get/list/count 不见它、getIncludingRemoved 见；孤儿 record 被 tombstone；re-add 复活", () => {
    const manager = new ProjectManager(tmp());
    const project = manager.create("tomb");
    const records = project.records();
    const library = new LibraryStore(project.paths.libraryDb, { records });
    const added = library.add(paper("A paper", "10.1/abc"));
    const paperRecord = records.list({ type: "paper" })[0]!;
    expect(library.count()).toBe(1);

    expect(library.remove(added.paper.id, "测试移除")).toBe(true);
    expect(library.get(added.paper.id)).toBeNull();
    expect(library.list().length).toBe(0);
    expect(library.count()).toBe(0);
    expect(library.getIncludingRemoved(added.paper.id)?.removedAt).toBeTruthy();

    const summary = retractOrphanRecords(records, library);
    expect(summary.retracted).toEqual([paperRecord.id]);
    expect(records.get(paperRecord.id)!.metadata.retracted).toBe(true);
    const ops = records.history(paperRecord.id).map((e) => e.op);
    expect(ops[ops.length - 1]).toBe("tombstone");

    // re-add 同一 DOI → 复活同一行，不产生第二篇。
    const revived = library.add(paper("A paper", "10.1/abc"));
    expect(revived.paper.id).toBe(added.paper.id);
    expect(library.get(added.paper.id)).not.toBeNull();
    expect(library.count()).toBe(1);
    library.close();
    project.close();
  });

  test("CLI：lit remove <doi> 走同一动作；report records --history / --repair 可达", async () => {
    const root = tmp();
    const manager = new ProjectManager(root);
    const project = manager.create("cli-tomb");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    library.add(paper("B paper", "10.2/xyz"));
    library.close();
    const rec = project.records().list({ type: "paper" })[0]!;
    project.close();

    const cap = capture();
    expect(await runLitCommand(["remove", "10.2/xyz", "--project", "cli-tomb", "--reason", "重复"], { root, ...cap.deps })).toBe(0);
    expect(cap.out.join("\n")).toContain("撤回 1 条");
    expect(await runLitCommand(["remove", "10.2/xyz", "--project", "cli-tomb"], { root, ...cap.deps })).toBe(1);

    const cap2 = capture();
    expect(await runReportCommand(["records", "--history", rec.id, "--project", "cli-tomb"], { root, ...cap2.deps })).toBe(0);
    expect(cap2.out.join("\n")).toContain("tombstone");
    const cap3 = capture();
    expect(await runReportCommand(["records", "--repair", rec.id, "--to-seq", "1", "--project", "cli-tomb"], { root, ...cap3.deps })).toBe(1); // 缺 --actor
    expect(await runReportCommand(["records", "--repair", rec.id, "--to-seq", "1", "--actor", "me", "--project", "cli-tomb"], { root, ...cap3.deps })).toBe(0);
  });
});
