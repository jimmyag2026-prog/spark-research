import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, type ConfigOptions } from "../config";

// W6-1 α（v0.6）：connector 调用台账——G-3（usage/ledger.ts）管的是 LLM 花了多少钱，
// 这里管的是 API 调了多少次、健不健康。AMiner 等大多数数据源免费，预算闸管不到它们，
// 但 B2 每一轮真正要盯的是「限速器有没有顶住、哪个 host 在报 429/401」——这份台账
// 就是那半截的落地（DEVELOPMENT_PLAN_v0.6.md §W6-1 lane α）。
//
// **全局，不挂靠项目**：埋点在 connectors/base.ts 一处（HttpConnector.requestRaw），
// 而 connector 层刻意不知道自己在哪个项目下被调用——`ConnectorRegistry` 是进程级
// 单例，一次 `lit search` 也可能横跨多个项目共用同一批 connector 实例。硬要在这一层
// 猜 project 只会猜错，所以落盘位置是 `<dataDir()>/api_calls.jsonl`，与 usage.jsonl
// （按项目，见 usage/ledger.ts）刻意不同层，这是既有边界（ConnectorOptions 的注释：
// 「connector 层没有项目概念」）的直接推论，不是遗漏。
//
// **URL 绝不落盘，只留 host**——凭据（API key / token）经常混在 query string 里，
// 记完整 url 等于把凭据写进一份长期保留的明文日志。`ApiCallEntry` 的字段清单里
// 压根没有 url：TS 的 excess-property check 会在字面量赋值给这个类型时挡住任何
// 手滑加回去的 `url:` 字段；`tests/unit/w61_api_ledger.test.ts` 的门禁测试从源码
// 文本层面再钉一遍这条红线（双保险，不依赖读者记得这条注释）。

export interface ApiCallEntry {
  ts: string;
  connector: string;
  host: string;
  /** HTTP 状态码；或 "timeout"（请求本身没有落地）；或 "error:<类名>"（其余网络层异常）。 */
  status: number | string;
  latencyMs: number;
  /**
   * backend/src/http/ratelimit.ts 令牌桶的等待时长，单位毫秒。
   * V63（v0.8 W8-1 β）收口：`RateLimitedHttp.request()` 现在把 `acquire()` 里实测的
   * 等待时长挂在返回的 `RateLimitedResponse.rateLimitWaitMs` 上（见 ratelimit.ts），
   * `connectors/base.ts` 读回后原样入账。非限速 http（测试桩/fixture、无策略 host）
   * 没有这个字段或从未等待，落 0——这是真实的 0，不是「测不到」的占位 0。
   */
  rateLimitWaitMs: number;
}

export interface ApiCallAgg {
  calls: number;
  count429: number;
  count401: number;
  /** 非 2xx 且不是 429/401 的调用（含 timeout / error:<类名>）。 */
  otherNon2xx: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface ApiCallTotals extends ApiCallAgg {
  byConnector: Record<string, ApiCallAgg>;
  byHost: Record<string, ApiCallAgg>;
}

function emptyAgg(): ApiCallAgg {
  return { calls: 0, count429: 0, count401: 0, otherNon2xx: 0, avgLatencyMs: 0, maxLatencyMs: 0 };
}

function accumulate(agg: ApiCallAgg, status: number | string, latencyMs: number): void {
  agg.calls += 1;
  agg.maxLatencyMs = Math.max(agg.maxLatencyMs, latencyMs);
  if (status === 429) agg.count429 += 1;
  else if (status === 401) agg.count401 += 1;
  else if (!(typeof status === "number" && status >= 200 && status < 300)) agg.otherNon2xx += 1;
}

export class ApiCallStore {
  constructor(private readonly file: string) {}

  path(): string {
    return this.file;
  }

  append(entry: ApiCallEntry): void {
    // 台账是观测，不是业务——写盘失败（磁盘满/权限/只读文件系统）绝不能让调用方
    // 的真实 HTTP 请求跟着失败或重试。吞掉即可；这属于诚实记录的已知盲区（写不进去
    // 的调用统计不到，但不会伪造一条假记录去掩盖）。
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // 见上：吞掉，不打断请求本身。
    }
  }

  readAll(): ApiCallEntry[] {
    if (!existsSync(this.file)) return [];
    const out: ApiCallEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ApiCallEntry;
        // 最小结构校验：坏行跳过但**计数**，不静默吞（与 usage/ledger.ts 同口径）。
        if (
          typeof parsed.connector !== "string" ||
          typeof parsed.host !== "string" ||
          typeof parsed.ts !== "string" ||
          (typeof parsed.status !== "number" && typeof parsed.status !== "string")
        ) {
          this.corrupt += 1;
          continue;
        }
        out.push(parsed);
      } catch {
        this.corrupt += 1;
      }
    }
    return out;
  }

  private corrupt = 0;

  /** readAll 中跳过的坏行数（文件被手改/写坏时不装作没看见）。 */
  corruptLines(): number {
    return this.corrupt;
  }

  totals(): ApiCallTotals {
    const entries = this.readAll();
    const totals: ApiCallTotals = { ...emptyAgg(), byConnector: {}, byHost: {} };
    let totalLatencySum = 0;
    const connectorLatencySum: Record<string, number> = {};
    const hostLatencySum: Record<string, number> = {};

    for (const e of entries) {
      accumulate(totals, e.status, e.latencyMs);
      totalLatencySum += e.latencyMs;

      const conn = (totals.byConnector[e.connector] ??= emptyAgg());
      accumulate(conn, e.status, e.latencyMs);
      connectorLatencySum[e.connector] = (connectorLatencySum[e.connector] ?? 0) + e.latencyMs;

      const host = (totals.byHost[e.host] ??= emptyAgg());
      accumulate(host, e.status, e.latencyMs);
      hostLatencySum[e.host] = (hostLatencySum[e.host] ?? 0) + e.latencyMs;
    }

    totals.avgLatencyMs = totals.calls > 0 ? totalLatencySum / totals.calls : 0;
    for (const [name, agg] of Object.entries(totals.byConnector)) {
      agg.avgLatencyMs = agg.calls > 0 ? connectorLatencySum[name]! / agg.calls : 0;
    }
    for (const [name, agg] of Object.entries(totals.byHost)) {
      agg.avgLatencyMs = agg.calls > 0 ? hostLatencySum[name]! / agg.calls : 0;
    }
    return totals;
  }
}

/** `<dataDir()>/api_calls.jsonl` 的路径解析——生产路径不传 options，走真实 dataDir()。 */
export function apiCallStorePath(options: ConfigOptions = {}): string {
  return join(dataDir(options), "api_calls.jsonl");
}

/**
 * base.ts 的埋点入口：每次 HTTP 调用落一行。签名上刻意只收 `host`，不收 `url`——
 * 配合 `ApiCallEntry` 没有 url 字段的类型约束，调用方连「手滑传个 url 进来」的
 * 语法空间都没有。
 *
 * 每次调用都新建一个 `ApiCallStore`（而不是缓存单例）：这个类只是持有一个文件路径
 * 字符串，构造零 I/O；换来的好处是路径按**当次调用时**的 `dataDir()` 现算，不会因为
 * 进程里更早的一次调用把路径缓存死——单测里常见的模式是同一个 bun 进程内先后
 * 用不同的 `SPARK_RESEARCH_DATA_DIR` 跑多个用例（见 extensions.test.ts 等既有先例），
 * 缓存单例会让后面的用例读到前一个用例的目录。
 */
export function recordApiCall(
  entry: { connector: string; host: string; status: number | string; latencyMs: number; rateLimitWaitMs: number },
  options: { store?: ApiCallStore; configOptions?: ConfigOptions } = {},
): void {
  const store = options.store ?? new ApiCallStore(apiCallStorePath(options.configOptions));
  store.append({ ts: new Date().toISOString(), ...entry });
}
