import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRawSink, MemoryRawSink, entryHash, type RawEntry } from "../../backend/src/raw";

// v0.7 W7-D0 · L0 原始层：append-only · hash 链（门禁 G3）· blob 阈值 · hashOnly。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "spark-raw-"));
  dirs.push(d);
  return d;
}

function connectorEntry(sink: JsonlRawSink | MemoryRawSink, connector: string, i: number) {
  return sink.append({
    kind: "connector",
    provenanceClass: "upstream",
    license: "CC0-1.0",
    ts: `2026-09-11T10:00:0${i}.000Z`,
    payload: {
      connector,
      tool: "search",
      host: "example.test",
      method: "GET",
      params: { q: `query ${i}` },
      status: 200,
      latencyMs: 1,
      contentType: "application/json",
      response: sink.body(JSON.stringify({ i })),
    },
  });
}

describe("JsonlRawSink · 落盘形状", () => {
  test("connector 按 connector 名分目录、按日期分文件；其余 kind 直接按日期", () => {
    const root = tmp();
    const sink = new JsonlRawSink(root, { project: "p1" });
    connectorEntry(sink, "openalex", 1);
    sink.append({
      kind: "llm",
      provenanceClass: "model_generated",
      ts: "2026-09-11T10:00:00.000Z",
      payload: {
        provider: "openrouter",
        model: "m",
        ok: true,
        failureKind: null,
        messages: sink.body("[]"),
        response: sink.body("hi"),
        usage: { inputTokens: 1, outputTokens: 1, costUsd: null, usageUnavailable: false },
        options: {},
      },
    });
    expect(existsSync(join(root, "connector", "openalex", "2026-09-11.jsonl"))).toBe(true);
    expect(existsSync(join(root, "llm", "2026-09-11.jsonl"))).toBe(true);
    const entries = [...sink.iterate()];
    expect(entries.map((e) => e.kind).sort()).toEqual(["connector", "llm"]);
    expect(entries.every((e) => e.project === "p1")).toBe(true);
  });

  test("同文件内 prevHash 成链；verify 全绿；篡改任一行必报 brokenAt（G3）", () => {
    const root = tmp();
    const sink = new JsonlRawSink(root, { project: "p1" });
    const a = connectorEntry(sink, "openalex", 1);
    const b = connectorEntry(sink, "openalex", 2);
    const c = connectorEntry(sink, "openalex", 3);
    expect(a.prevHash).toBeNull();
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(sink.verify("connector", "openalex")).toEqual({ ok: true, lines: 3 });

    // 阴性对照：改第 2 行的一个字段，hash 对不上 → brokenAt=2；改 hash 本身 → 第 3 行 prevHash 断链。
    const file = join(root, "connector", "openalex", "2026-09-11.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[1]!) as RawEntry;
    (tampered.payload as { status: number }).status = 500;
    writeFileSync(file, [lines[0], JSON.stringify(tampered), lines[2]].join("\n") + "\n");
    const v1 = sink.verify("connector", "openalex");
    expect(v1.ok).toBe(false);
    expect(v1.brokenAt).toBe(2);

    const rehashed = { ...tampered, hash: entryHash((({ hash: _h, ...rest }) => rest)(tampered)) };
    writeFileSync(file, [lines[0], JSON.stringify(rehashed), lines[2]].join("\n") + "\n");
    const v2 = sink.verify("connector", "openalex");
    expect(v2.ok).toBe(false);
    expect(v2.brokenAt).toBe(3); // 第 2 行自洽了，但第 3 行的 prevHash 指向旧 hash
  });

  test("进程重启后链接得上：新 sink 实例从文件尾读 prevHash", () => {
    const root = tmp();
    const a = connectorEntry(new JsonlRawSink(root), "crossref", 1);
    const b = connectorEntry(new JsonlRawSink(root), "crossref", 2);
    expect(b.prevHash).toBe(a.hash);
    expect(new JsonlRawSink(root).verify("connector").ok).toBe(true);
  });

  test("超过阈值的正文落 blobs/ 并按 sha256 去重；hashOnly 不落任何正文", () => {
    const root = tmp();
    const sink = new JsonlRawSink(root, { blobThreshold: 16 });
    const big = "x".repeat(100);
    const b1 = sink.body(big);
    const b2 = sink.body(big);
    expect("blob" in b1 && b1.blob).toBeTruthy();
    expect(b1).toEqual(b2);
    const blobDir = join(root, "blobs");
    const files = readdirSync(blobDir).flatMap((d) => readdirSync(join(blobDir, d)));
    expect(files.length).toBe(1);
    expect(sink.readBlob((b1 as { blob: string }).blob)).toBe(big);
    expect(sink.body("short")).toEqual({ inline: "short" });

    const h = JsonlRawSink.hashOnly(big);
    expect("hashOnly" in h && h.bytes).toBe(100);
    expect(readdirSync(blobDir).flatMap((d) => readdirSync(join(blobDir, d))).length).toBe(1);
  });

  test("iterate 按 since/until 过滤", () => {
    const root = tmp();
    const sink = new JsonlRawSink(root);
    for (let i = 1; i <= 5; i++) connectorEntry(sink, "openalex", i);
    const mid = [...sink.iterate({ since: "2026-09-11T10:00:02.000Z", until: "2026-09-11T10:00:04.000Z" })];
    expect(mid.length).toBe(3);
  });
});

describe("MemoryRawSink · 与 Jsonl 版共用同一套 hash/链逻辑", () => {
  test("链与 verify 行为一致", () => {
    const sink = new MemoryRawSink({ project: "p" });
    const a = connectorEntry(sink, "openalex", 1);
    const b = connectorEntry(sink, "openalex", 2);
    expect(b.prevHash).toBe(a.hash);
    expect(sink.verify("connector").ok).toBe(true);
    (sink.entries[0]!.payload as { status: number }).status = 500;
    expect(sink.verify("connector").ok).toBe(false);
  });
});
