// v0.7 W7-D0 · L0 原始层默认实现：每 kind 一个目录、每天一个 jsonl、行内 prevHash 链。
//
// 设计稿写的是 async 接口；这里改成**同步**——四个埋点里有两个在 `finally`/包装器的
// 返回路径上，同步 append 让「记了没记」不依赖 promise 落定顺序（V27 教训里 latencyMs
// 那类时序问题的同款）。单行 appendFileSync < 1 ms，热路径无感。
//
// 体积（§4.3）：超过 `blobThreshold` 的正文落 `blobs/<aa>/<sha256>`，同 hash 去重；
// 凭据源（license 以 LicenseRef-proprietary- 开头）的响应体默认只存 hash（`hashOnly`），
// 除非 config `rawUpstreamInline=on`。

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RawAppendInput, RawBody, RawEntry, RawFilter, RawKind, RawSink, RawVerifyResult } from "./models";
import { RAW_KINDS } from "./models";

/** 只读文件最后 maxBytes（大 raw 文件每次 append 不必整读）。 */
function readTail(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // 从中间切开时第一行可能是残行——丢掉它，只要最后一整行。
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 行 hash：除 `hash` 自身外全部字段 canonical 后 sha256。verify() 用同一函数重算。 */
export function entryHash(entry: Omit<RawEntry, "hash">): string {
  return sha256Of(entry);
}

export const DEFAULT_BLOB_THRESHOLD = 64 * 1024;

export interface JsonlRawSinkOptions {
  /** 默认落进 entry.project 的那个值；sink 建在项目目录下时传 slug，全局兜底 sink 传 null。 */
  project?: string | null;
  blobThreshold?: number;
  now?: () => string;
}

function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

export class JsonlRawSink implements RawSink {
  readonly id = "jsonl";
  readonly root: string;
  private readonly project: string | null;
  private readonly blobThreshold: number;
  private readonly now: () => string;
  /** 每个文件最后一行的 hash（进程内缓存；首次 append 时从文件尾读）。 */
  private lastHash = new Map<string, string | null>();

  constructor(root: string, options: JsonlRawSinkOptions = {}) {
    this.root = root;
    this.project = options.project ?? null;
    this.blobThreshold = options.blobThreshold ?? DEFAULT_BLOB_THRESHOLD;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** connector 按 connector 名分子目录（§3.1），其余 kind 直接按日期。 */
  private fileFor(kind: RawKind, name: string | null, date: string): string {
    return name ? join(this.root, kind, name, `${date}.jsonl`) : join(this.root, kind, `${date}.jsonl`);
  }

  /**
   * V91（A6 抓到）：此前 lastHash 按进程缓存——server 与 CLI 两个进程同时往同一个 raw 文件 append 时，
   * 各自以为自己接在同一行后面，链就断了（A6 源项目 llm/connector 两条链都是这样断在多进程并发处）。
   * 现在**每次 append 都从文件尾重读上一行 hash**（只读最后 64KB），并用 `<file>.lock`（O_EXCL，过期 10s
   * 回收）把「读尾 → 写入」做成临界区。同进程内仍有缓存作为快路径核对：缓存值与文件尾不一致就以文件为准。
   */
  private readLastHash(file: string): string | null {
    let last: string | null = null;
    if (existsSync(file)) {
      const tail = readTail(file, 64 * 1024);
      const lines = tail.split("\n").filter((l) => l.trim() !== "");
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        try {
          last = (JSON.parse(lastLine) as RawEntry).hash ?? null;
        } catch {
          last = null;
        }
      }
    }
    this.lastHash.set(file, last);
    return last;
  }

  private withFileLock<T>(file: string, fn: () => T): T {
    const lock = `${file}.lock`;
    mkdirSync(dirname(file), { recursive: true });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        writeFileSync(lock, `${process.pid} ${Date.now()}`, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        // 过期锁回收：持锁进程可能被 kill -9。
        try {
          const [, stamp] = readFileSync(lock, "utf8").split(" ");
          if (Date.now() - Number(stamp) > 10_000) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          /* 锁刚被别人释放 */
        }
        if (Date.now() > deadline) throw new Error(`raw sink：等待 ${lock} 超过 5s`);
        Bun.sleepSync(5);
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* 已被回收 */
      }
    }
  }

  /**
   * 正文落盘策略：短的 inline；长的进 blobs/ 去重；`hashOnly` 由调用方决定（凭据源）。
   * 这里只负责 inline/blob 的切换。
   */
  body(text: string): RawBody {
    if (text.length <= this.blobThreshold) return { inline: text };
    const sha = sha256Text(text);
    const path = join(this.root, "blobs", sha.slice(0, 2), sha);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    }
    return { blob: sha, bytes: Buffer.byteLength(text, "utf8") };
  }

  static hashOnly(text: string): RawBody {
    return { hashOnly: sha256Text(text), bytes: Buffer.byteLength(text, "utf8") };
  }

  append(input: RawAppendInput): RawEntry {
    const ts = input.ts ?? this.now();
    const name = input.kind === "connector" ? (input.payload as { connector: string }).connector : null;
    const file = this.fileFor(input.kind, name, dateOf(ts));
    return this.withFileLock(file, () => {
      const prevHash = this.readLastHash(file);
      const draft: Omit<RawEntry, "hash"> = {
        v: 1,
        id: randomUUID(),
        ts,
        kind: input.kind,
        project: input.project === undefined ? this.project : input.project,
        sessionId: input.sessionId ?? null,
        command: input.command ?? null,
        provenanceClass: input.provenanceClass,
        license: input.license ?? null,
        prevHash,
        payload: input.payload,
      };
      const entry: RawEntry = { ...draft, hash: entryHash(draft) };
      appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
      this.lastHash.set(file, entry.hash);
      return entry;
    });
  }

  private *files(kind?: RawKind): Iterable<{ kind: RawKind; name: string | null; file: string }> {
    for (const k of kind ? [kind] : RAW_KINDS) {
      const dir = join(this.root, k);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (name.endsWith(".jsonl")) {
          yield { kind: k, name: null, file: full };
        } else if (existsSync(full) && readdirSync(full).length >= 0) {
          for (const f of readdirSync(full).sort()) {
            if (f.endsWith(".jsonl")) yield { kind: k, name, file: join(full, f) };
          }
        }
      }
    }
  }

  private *lines(file: string): Iterable<{ n: number; raw: string; entry: RawEntry | null }> {
    let n = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      n += 1;
      try {
        yield { n, raw: line, entry: JSON.parse(line) as RawEntry };
      } catch {
        yield { n, raw: line, entry: null };
      }
    }
  }

  *iterate(filter: RawFilter = {}): Iterable<RawEntry> {
    for (const { file } of this.files(filter.kind)) {
      for (const { entry } of this.lines(file)) {
        if (!entry) continue;
        if (filter.since && entry.ts < filter.since) continue;
        if (filter.until && entry.ts > filter.until) continue;
        yield entry;
      }
    }
  }

  verify(kind: RawKind, name?: string): RawVerifyResult {
    let lines = 0;
    for (const f of this.files(kind)) {
      if (name !== undefined && f.name !== name) continue;
      let prev: string | null = null;
      for (const { n, entry } of this.lines(f.file)) {
        lines += 1;
        if (!entry) return { ok: false, lines, brokenAt: n, reason: `${f.file}: 第 ${n} 行不是合法 JSON` };
        const { hash, ...rest } = entry;
        // for-sharing 导入的 llm 行 prompt 只剩 hashOnly（内容不出门），行 hash 覆盖的是原 payload——只核链。
        const promptHashed = entry.kind === "llm" && "hashOnly" in ((entry.payload as { messages?: object }).messages ?? {});
        if (!promptHashed && entryHash(rest) !== hash) return { ok: false, lines, brokenAt: n, reason: `${f.file}: 第 ${n} 行 hash 对不上` };
        if (entry.prevHash !== prev) return { ok: false, lines, brokenAt: n, reason: `${f.file}: 第 ${n} 行 prevHash 断链` };
        prev = hash;
      }
    }
    return { ok: true, lines };
  }

  /**
   * v0.7 W7-D2：导入——整行原样落盘（hash/prevHash 不重算，链随导出原样带回）。
   * 调用方保证按导出顺序逐行喂。
   */
  importEntry(entry: RawEntry): void {
    const name = entry.kind === "connector" ? (entry.payload as { connector: string }).connector : null;
    const file = this.fileFor(entry.kind, name, dateOf(entry.ts));
    this.withFileLock(file, () => {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
      this.lastHash.set(file, entry.hash);
    });
  }

  writeBlob(sha: string, text: string): void {
    const path = join(this.root, "blobs", sha.slice(0, 2), sha);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  }

  /** blob 内容读回（导出/校验用）。 */
  readBlob(sha: string): string | null {
    const path = join(this.root, "blobs", sha.slice(0, 2), sha);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
}

/** 测试用：全在内存，链与 hash 逻辑与 Jsonl 版共用同一函数。 */
export class MemoryRawSink implements RawSink {
  readonly id = "memory";
  readonly entries: RawEntry[] = [];
  private readonly project: string | null;
  private lastHash = new Map<string, string | null>();

  constructor(options: { project?: string | null } = {}) {
    this.project = options.project ?? null;
  }

  body(text: string): RawBody {
    return { inline: text };
  }

  append(input: RawAppendInput): RawEntry {
    const ts = input.ts ?? new Date().toISOString();
    const name = input.kind === "connector" ? (input.payload as { connector: string }).connector : "";
    const key = `${input.kind}/${name}/${dateOf(ts)}`;
    const prevHash = this.lastHash.get(key) ?? null;
    const draft: Omit<RawEntry, "hash"> = {
      v: 1,
      id: randomUUID(),
      ts,
      kind: input.kind,
      project: input.project === undefined ? this.project : input.project,
      sessionId: input.sessionId ?? null,
      command: input.command ?? null,
      provenanceClass: input.provenanceClass,
      license: input.license ?? null,
      prevHash,
      payload: input.payload,
    };
    const entry: RawEntry = { ...draft, hash: entryHash(draft) };
    this.entries.push(entry);
    this.lastHash.set(key, entry.hash);
    return entry;
  }

  *iterate(filter: RawFilter = {}): Iterable<RawEntry> {
    for (const e of this.entries) {
      if (filter.kind && e.kind !== filter.kind) continue;
      if (filter.since && e.ts < filter.since) continue;
      if (filter.until && e.ts > filter.until) continue;
      yield e;
    }
  }

  verify(kind: RawKind, name?: string): RawVerifyResult {
    const chains = new Map<string, string | null>();
    let lines = 0;
    for (const e of this.entries) {
      if (e.kind !== kind) continue;
      const n = e.kind === "connector" ? (e.payload as { connector: string }).connector : "";
      if (name !== undefined && n !== name) continue;
      lines += 1;
      const key = `${n}/${dateOf(e.ts)}`;
      const { hash, ...rest } = e;
      if (entryHash(rest) !== hash) return { ok: false, lines, brokenAt: lines, reason: "hash 对不上" };
      if (e.prevHash !== (chains.get(key) ?? null)) return { ok: false, lines, brokenAt: lines, reason: "prevHash 断链" };
      chains.set(key, hash);
    }
    return { ok: true, lines };
  }
}
