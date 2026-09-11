import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../../backend/src/project/records";

// v0.7 alpha.6 · V80 真因：DEFERRED 事务在「读→写升级」时后来者立即拿到 SQLITE_BUSY，busy_timeout 不起作用；
// 写事务改 BEGIN IMMEDIATE 后才真正排队。两个**真实子进程**各 150 次 create（每次一条 records + 一条 journal
// 同事务），期望零 "database is locked"。阴性对照：把 records.ts 里的 tx.immediate() 改回 tx() → 本测试红。

const WORKER = `
const { RecordStore } = await import(${JSON.stringify(join(import.meta.dir, "../../backend/src/project/records.ts"))});
const [db, tag, n] = process.argv.slice(2);
const store = new RecordStore(db, "race");
let locked = 0;
for (let i = 0; i < Number(n); i++) {
  try {
    const r = store.create({ type: "observation", content: tag + "-" + i, provenanceClass: "derived" });
    store.update(r.id, { title: "t" + i });
  } catch (e) {
    if (String(e).includes("database is locked")) locked++; else throw e;
  }
}
store.close();
console.log(JSON.stringify({ tag, locked }));
`;

describe("records.db 两进程并发写", () => {
  test("各 150 次 create+update → 零 database is locked，行数 == 300，journal 链完整", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-race-"));
    const db = join(dir, "records.db");
    new RecordStore(db, "race").close();
    const script = join(dir, "worker.ts");
    await Bun.write(script, WORKER);
    const spawn = (tag: string) =>
      Bun.spawn(["bun", script, db, tag, "150"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [a, b] = [spawn("A"), spawn("B")];
    const [outA, outB, codeA, codeB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text(), a.exited, b.exited]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    const ra = JSON.parse(outA.trim().split("\n").pop()!) as { locked: number };
    const rb = JSON.parse(outB.trim().split("\n").pop()!) as { locked: number };
    expect(ra.locked + rb.locked).toBe(0);
    const store = new RecordStore(db, "race");
    expect(store.count()).toBe(300);
    expect(store.verifyJournal().ok).toBe(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
