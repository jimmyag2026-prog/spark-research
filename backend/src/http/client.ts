// 可注入的 HTTP 层：connector 一律通过 HttpClient 发请求，而不是直接调用全局 fetch。
// 这是 P2 fixture 回放机制（tests/fixtures/literature）的前提——只有 http 层可注入，
// CI 才能在完全无网络的情况下跑完跨源检索链路。

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
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

// 生产实现：包一层全局 fetch。
export class NativeHttp implements HttpClient {
  async request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "follow",
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return new BufferedResponse({
      status: response.status,
      headers: pickHeaders(response.headers),
      url: response.url || url,
      body,
    });
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
