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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RawAppendInput, RawBody, RawEntry, RawFilter, RawKind, RawSink, RawVerifyResult } from "./models";
import { RAW_KINDS } from "./models";

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

  private readLastHash(file: string): string | null {
    if (this.lastHash.has(file)) return this.lastHash.get(file)!;
    let last: string | null = null;
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
      const tail = lines[lines.length - 1];
      if (tail) {
        try {
          last = (JSON.parse(tail) as RawEntry).hash ?? null;
        } catch {
          last = null;
        }
      }
    }
    this.lastHash.set(file, last);
    return last;
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
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    this.lastHash.set(file, entry.hash);
    return entry;
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
        if (entryHash(rest) !== hash) return { ok: false, lines, brokenAt: n, reason: `${f.file}: 第 ${n} 行 hash 对不上` };
        if (entry.prevHash !== prev) return { ok: false, lines, brokenAt: n, reason: `${f.file}: 第 ${n} 行 prevHash 断链` };
        prev = hash;
      }
    }
    return { ok: true, lines };
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
