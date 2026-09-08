import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BufferedResponse, defaultHttp, type HttpClient, type HttpRequestInit, type HttpResponse } from "./client";

// fixture 回放机制（DEVELOPMENT_PLAN 三、测试策略）：
//   replay（默认，CI）  从 tests/fixtures/literature/<cassette>.json 读录制好的响应，零网络。
//   record（本地手工）  打真实网络，同时把响应落盘成 fixture。
//   live               打真实网络但不落盘（调试用）。
//
// 安全不变量（凭据纪律）：**请求头永远不落盘**。
// 录制只保存 method + 规范化 URL + 响应体，Authorization / api key 这类
// 只存在于请求头或被列入 VOLATILE_QUERY_KEYS 的查询参数里的东西，结构上不可能进 fixture。

export type FixtureMode = "replay" | "record" | "live";

// 参与请求匹配时被剔除的查询参数：礼貌头邮箱会因机器而异，凭据类参数绝不能进 key。
const VOLATILE_QUERY_KEYS = new Set([
  "mailto",
  "email",
  "api_key",
  "apikey",
  "apiKey",
  "token",
  "access_token",
  "key",
]);

const TEXT_CONTENT_RE = /(json|xml|text|javascript|html|atom)/i;

export interface FixtureResponseData {
  status: number;
  headers: Record<string, string>;
  // 文本响应体（JSON / XML / Atom）。
  body?: string;
  // 二进制响应体（PDF 等）只留截断样本，避免大文件进 git。
  bodyBase64?: string;
  bodyLength?: number;
  bodySha256?: string;
  truncated?: boolean;
}

export interface FixtureEntry {
  key: string;
  method: string;
  url: string;
  // 请求体只留哈希：既能区分不同 POST，又不会把 POST body 里的敏感内容写进 fixture。
  bodyHash?: string;
  response: FixtureResponseData;
  recordedAt: string;
}

export interface FixtureFile {
  cassette: string;
  note: string;
  entries: FixtureEntry[];
}

export interface FixtureHttpOptions {
  dir: string;
  cassette: string;
  mode?: FixtureMode;
  // record/live 模式下真正打网络的客户端，默认 NativeHttp。
  upstream?: HttpClient;
  // 二进制响应体保留的最大字节数（超出即截断），默认 2 KiB。
  maxBinaryBytes?: number;
  // 文本响应体保留的最大字符数，默认 512 KiB。
  maxTextChars?: number;
}

export const FIXTURE_NOTE =
  "Recorded by FixtureHttp. Request headers are never persisted; credential-bearing query params are stripped from the match key.";

export function fixtureModeFromEnv(env: Record<string, string | undefined> = process.env): FixtureMode {
  const raw = (env.FIXTURE_MODE ?? "").toLowerCase();
  if (raw === "record") return "record";
  if (raw === "live") return "live";
  return "replay";
}

// 规范化 URL：剔除易变/凭据类查询参数并按字典序排序，保证 key 稳定可复现。
export function canonicalUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !VOLATILE_QUERY_KEYS.has(name))
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  url.search = "";
  for (const [name, value] of params) url.searchParams.append(name, value);
  return url.toString();
}

export function fixtureKey(method: string, url: string, body?: string): string {
  const bodyHash = body ? createHash("sha256").update(body).digest("hex").slice(0, 12) : "";
  const raw = `${method.toUpperCase()} ${canonicalUrl(url)}${bodyHash ? ` #${bodyHash}` : ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export class FixtureMissError extends Error {
  constructor(
    readonly cassettePath: string,
    method: string,
    url: string,
  ) {
    super(
      `fixture miss: ${method.toUpperCase()} ${canonicalUrl(url)}\n` +
        `  cassette: ${cassettePath}\n` +
        `  用 FIXTURE_MODE=record 在本地重新录制后再跑回放。`,
    );
    this.name = "FixtureMissError";
  }
}

export class FixtureHttp implements HttpClient {
  readonly mode: FixtureMode;
  readonly path: string;
  private entries = new Map<string, FixtureEntry>();
  private upstream: HttpClient;
  private maxBinaryBytes: number;
  private maxTextChars: number;
  private dirty = false;

  constructor(options: FixtureHttpOptions) {
    this.mode = options.mode ?? fixtureModeFromEnv();
    this.path = join(options.dir, `${options.cassette}.json`);
    this.upstream = options.upstream ?? defaultHttp;
    this.maxBinaryBytes = options.maxBinaryBytes ?? 2048;
    this.maxTextChars = options.maxTextChars ?? 512 * 1024;
    this.load();
  }

  get size(): number {
    return this.entries.size;
  }

  load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FixtureFile;
    for (const entry of parsed.entries ?? []) this.entries.set(entry.key, entry);
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(join(this.path, ".."), { recursive: true });
    const file: FixtureFile = {
      cassette: this.path.split("/").pop()!.replace(/\.json$/, ""),
      note: FIXTURE_NOTE,
      entries: [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    };
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n");
    this.dirty = false;
  }

  async request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const method = (init.method ?? "GET").toUpperCase();
    const key = fixtureKey(method, url, init.body);

    if (this.mode === "replay") {
      const entry = this.entries.get(key);
      if (!entry) throw new FixtureMissError(this.path, method, url);
      return this.toResponse(entry, url);
    }

    const response = await this.upstream.request(url, init);
    if (this.mode === "record") {
      this.entries.set(key, await this.toEntry(key, method, url, init.body, response));
      this.dirty = true;
      this.save();
    }
    return response;
  }

  private toResponse(entry: FixtureEntry, url: string): HttpResponse {
    const data = entry.response;
    const body =
      data.bodyBase64 !== undefined
        ? Uint8Array.from(Buffer.from(data.bodyBase64, "base64"))
        : new TextEncoder().encode(data.body ?? "");
    return new BufferedResponse({ status: data.status, headers: data.headers, url, body });
  }

  private async toEntry(
    key: string,
    method: string,
    url: string,
    body: string | undefined,
    response: HttpResponse,
  ): Promise<FixtureEntry> {
    const raw = await response.bytes();
    const contentType = response.headers["content-type"] ?? "";
    const isText = TEXT_CONTENT_RE.test(contentType) || contentType === "";
    const sha256 = createHash("sha256").update(raw).digest("hex");

    const data: FixtureResponseData = {
      status: response.status,
      headers: { ...response.headers },
      bodyLength: raw.byteLength,
      bodySha256: sha256,
    };
    if (isText) {
      const text = new TextDecoder().decode(raw);
      // 文本响应体**绝不截断**：截断的 JSON 是坏 fixture，回放时 JSON.parse 会炸，
      // 而且是那种「看起来录好了、跑起来才发现」的隐性故障。宁可当场报错，
      // 让录制者去收窄请求（减少 page size、用 select 裁字段）。
      if (text.length > this.maxTextChars) {
        throw new Error(
          `fixture 响应体过大（${text.length} > ${this.maxTextChars} 字符）: ${canonicalUrl(url)}\n` +
            `  截断文本会产出无法解析的 fixture。请收窄请求（减小 per-page / 用 select 裁字段），` +
            `或调大 FixtureHttp 的 maxTextChars。`,
        );
      }
      data.truncated = false;
      data.body = text;
    } else {
      // PDF 等二进制：只留头部样本（用于校验 magic bytes），本体不入库。
      data.truncated = raw.byteLength > this.maxBinaryBytes;
      data.bodyBase64 = Buffer.from(raw.slice(0, this.maxBinaryBytes)).toString("base64");
    }

    return {
      key,
      method,
      url: canonicalUrl(url),
      bodyHash: body ? createHash("sha256").update(body).digest("hex").slice(0, 12) : undefined,
      response: data,
      recordedAt: new Date().toISOString(),
    };
  }
}
