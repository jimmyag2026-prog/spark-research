import { configuredHttpTimeoutMs } from "../config";
// 可注入的 HTTP 层：connector 一律通过 HttpClient 发请求，而不是直接调用全局 fetch。
// 这是 P2 fixture 回放机制（tests/fixtures/literature）的前提——只有 http 层可注入，
// CI 才能在完全无网络的情况下跑完跨源检索链路。

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // D-2（P10-b）：单次请求的超时上限（毫秒）。**可选**——lane D-a 同期在改
  // connectors/base.ts，不会传这个字段，NativeHttp 必须在它缺席时也套上默认超时，
  // 否则任一上游挂起就等于 CLI/server 永久卡死。传 0 或负数显式关闭超时（供已有
  // 自己超时逻辑的调用方，如 fixture 录制，避免双重计时）。
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  // 只保留少量响应头（content-type 等），不透传 set-cookie 之类。
  headers: Record<string, string>;
  url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  bytes(): Promise<Uint8Array>;
}

export interface HttpClient {
  request(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
}

const KEPT_RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition"];

export function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

// 已经读入内存的响应体。fetch 的 Response body 只能消费一次，
// 而 fixture 录制需要「既落盘又返回给调用方」，所以统一先 buffer 再包装。
export class BufferedResponse implements HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly url: string;
  private buffer: Uint8Array;

  constructor(args: { status: number; headers?: Record<string, string>; url?: string; body: Uint8Array }) {
    this.status = args.status;
    this.headers = args.headers ?? {};
    this.url = args.url ?? "";
    this.buffer = args.body;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.buffer);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  async bytes(): Promise<Uint8Array> {
    return this.buffer;
  }
}

// D-2：默认超时。环境变量覆盖，常量兜底——config/ 面板（P9）里没有对应的设置项
// （只读不改，见 docs/devlog/P10-b.md），所以走「env + 常量默认」这条已有先例的路
// （对照 backend/src/lab/wet_backend.ts 的 DEFAULT_TIMEOUT_MS）。
// 30s：文献/蛋白/化学等 connector 的单次请求正常在数百 ms～几秒内完成；30s 足够
// 覆盖冷启动 + 重试，又不会让一次挂起的上游拖垮整条检索链路太久。
// P10 收口：默认值收进 config 注册表（`CONFIG_SETTINGS.httpTimeoutMs`），优先级仍是
// env > config.json > 常量默认，与仓库其余配置项走同一套解析（P9「配置面收口」）。
// 做成函数而不是模块级常量：改了 config.json 不必重启进程。
function defaultHttpTimeoutMs(): number {
  return configuredHttpTimeoutMs(30_000);
}

// 超时与「上游返回了 4xx/5xx」结构上不同——后者仍然是一个合法的 HttpResponse
// （ok=false，有 status），前者是请求根本没有落地。用专门的错误类型让调用方
// （目前是 connectors/base.ts 的 catch）能把两者分开报告，而不是都长得像
// 「网络挂了」的裸 Error。
export class HttpTimeoutError extends Error {
  readonly timeout = true;
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "HttpTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

// 生产实现：包一层全局 fetch。
export class NativeHttp implements HttpClient {
  async request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const timeoutMs = init.timeoutMs ?? defaultHttpTimeoutMs();
    const controller = new AbortController();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
      const response = await fetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: "follow",
        signal: controller.signal,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      return new BufferedResponse({
        status: response.status,
        headers: pickHeaders(response.headers),
        url: response.url || url,
        body,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HttpTimeoutError(url, timeoutMs);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const defaultHttp: HttpClient = new NativeHttp();

// 固定响应的假 http，供单测构造确定性场景（不读 fixture 文件）。
export class StubHttp implements HttpClient {
  readonly calls: Array<{ url: string; init: HttpRequestInit }> = [];

  constructor(
    private handler: (url: string, init: HttpRequestInit) => HttpResponse | Promise<HttpResponse>,
  ) {}

  static json(payload: unknown, status = 200): StubHttp {
    return new StubHttp(
      () =>
        new BufferedResponse({
          status,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify(payload)),
        }),
    );
  }

  async request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    this.calls.push({ url, init });
    return this.handler(url, init);
  }
}
