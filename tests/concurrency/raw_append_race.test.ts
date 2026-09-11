import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRawSink } from "../../backend/src/raw";

// V91（A6 抓到）：两个进程（server + CLI）往同一个 raw 文件 append，按进程缓存的 lastHash 让链断掉。
// 现在读尾 + 文件锁：两个真实子进程各 100 次 append 同一 connector 文件，链必须完整、行数 200。
// 阴性对照：把 append 里的 withFileLock 去掉且恢复缓存 → 本测试红。

const WORKER = `
const { JsonlRawSink } = await import(${JSON.stringify(join(import.meta.dir, "../../backend/src/raw/sink.ts"))});
const [root, tag, n] = process.argv.slice(2);
const sink = new JsonlRawSink(root, { project: "race" });
for (let i = 0; i < Number(n); i++) {
  sink.append({ kind: "connector", provenanceClass: "upstream", license: "CC0-1.0", ts: "2026-09-11T10:00:00.000Z",
    payload: { connector: "openalex", tool: "search", host: "h", method: "GET", params: { tag, i }, status: 200, latencyMs: 1, contentType: null, response: sink.body(tag + i) } });
}
console.log("done");
`;

describe("raw sink 两进程并发 append 同一文件", () => {
  test("各 100 次 → 200 行、链完整", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-rawrace-"));
    const root = join(dir, "raw");
    const script = join(dir, "worker.ts");
    writeFileSync(script, WORKER);
    const spawn = (tag: string) => Bun.spawn(["bun", script, root, tag, "100"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [a, b] = [spawn("A"), spawn("B")];
    const [ea, eb, ca, cb] = await Promise.all([new Response(a.stderr).text(), new Response(b.stderr).text(), a.exited, b.exited]);
    if (ca !== 0 || cb !== 0) throw new Error(`worker 退出码 ${ca}/${cb}\n${ea}\n${eb}`);
    const sink = new JsonlRawSink(root, { project: "race" });
    const v = sink.verify("connector", "openalex");
    expect(v).toEqual({ ok: true, lines: 200 });
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
