// P10-a · D-1：connector 层 P0 并发竞态回归测试。
//
// 背景（外部评审复现的 P0 缺陷）：`HttpConnector`（backend/src/connectors/base.ts）
// 旧版用单值实例字段 `__handlingTool` 防止「handler → 通用 URL 拼装路径」这一步递归
// 重入自己。但这个字段跨请求共享：并发请求 A 在 `await` 网络响应期间字段保持为某个
// 工具名，此时并发请求 B 调**同一个 connector 实例**的同一个工具，会被误判为「正在
// 重入」而被直接跳过 handler，落到零参数映射的通用路径——OpenAlex 的 `query` 不翻译
// 成 `search`、EuropePMC 丢 `format=json`、AMiner 的凭据缺失检查被跳过。
//
// 修复见 backend/src/connectors/base.ts：`call()` 改成查一张构造期一次性写入、运行期
// 只读的 handlers 表分发，不再有任何跨请求共享的可变实例状态；handler 内部要落到
// 通用路径时调用 `requestRaw()`，它不查 handler 表，结构性地不会递归回到 handler 自己。
//
// 本文件验证：单实例高并发混合工具调用下，每个请求最终发出的 URL / 参数 / headers
// 与逐个串行调用完全一致——即并发本身不改变任何一次调用的行为。

import { describe, expect, test } from "bun:test";
import { BufferedResponse, StubHttp, type HttpRequestInit } from "../../backend/src/http/client";
import { EuropePMCConnector, OpenAlexConnector } from "../../backend/src/connectors/literature";
import { AMinerConnector, isCredentialMissing } from "../../backend/src/connectors/aminer";
import type { CredentialProvider } from "../../backend/src/connectors/base";

// ─────────────────────────────────────────────────────────────────────────────
// echo http：把这次 HTTP 请求本身（url / method / headers / body）原样编码进响应体。
//
// 这样 `connector.call()` 的返回值就是「这次调用具体发出了什么请求」的自描述记录，
// 不需要去读共享的 `StubHttp.calls[]` 数组按顺序反推是哪个并发任务发的——并发下
// calls[] 的追加顺序是**完成顺序**，不是**发起顺序**，用它做按位比对本身就不可靠。
// 每个请求还带一个随机小延迟，制造真实的 await 交错，不是伪并发。
// ─────────────────────────────────────────────────────────────────────────────
interface Echo {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function echoHttp(): StubHttp {
  return new StubHttp(async (url, init: HttpRequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
    const echo: Echo = {
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ?? null,
    };
    return new BufferedResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(echo)),
    });
  });
}

function fakeCredentials(values: Record<string, string>): CredentialProvider {
  return {
    has: () => true,
    get: () => values,
  };
}

interface ConnectorsBag {
  openalex: OpenAlexConnector;
  europepmc: EuropePMCConnector;
  aminerCreds: AMinerConnector;
  aminerNoCreds: AMinerConnector;
}

function makeConnectors(http: StubHttp): ConnectorsBag {
  return {
    openalex: new OpenAlexConnector({ http }),
    europepmc: new EuropePMCConnector({ http }),
    aminerCreds: new AMinerConnector({ http, credentials: fakeCredentials({ api_key: "test-aminer-token" }) }),
    aminerNoCreds: new AMinerConnector({ http }),
  };
}

interface Job {
  label: string;
  // 刻意走 `connector.call(toolName, params)`——这是 registry / daemon / swarm /
  // orchestrator 的实际调用形态，也正是旧版 `__handlingTool` 竞态发生的那条路径。
  // 直接调用子类的 `search()` / `getPaper()` 等类型化方法测不出这个 bug：那些方法
  // 内部现在直接调 `requestRaw()`，根本不经过 `call()` 的分发表。
  exec: (connectors: ConnectorsBag) => Promise<unknown>;
}

// 7 种 job 轮流分布，覆盖 OpenAlex / EuropePMC 两个真实文献子类 + AMiner（含凭据
// 缺失分支），且刻意让同一个 connector 实例交替收到不同工具名的请求（search 与
// getPaper 交错），这正是触发旧竞态所需的形状。
function buildJobs(n: number): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 7;
    switch (kind) {
      case 0:
        jobs.push({
          label: `openalex.search#${i}`,
          exec: (c) => c.openalex.call("search", { query: `AlphaFold-${i}`, limit: (i % 5) + 1 }),
        });
        break;
      case 1:
        jobs.push({
          label: `openalex.getPaper#${i}`,
          exec: (c) => c.openalex.call("getPaper", { id: `10.1000/oa-${i}` }),
        });
        break;
      case 2:
        jobs.push({
          label: `europepmc.search#${i}`,
          exec: (c) => c.europepmc.call("search", { query: `crispr-${i}`, limit: (i % 4) + 1 }),
        });
        break;
      case 3:
        jobs.push({
          label: `europepmc.getPaper#${i}`,
          exec: (c) => c.europepmc.call("getPaper", { id: `PMC${1000000 + i}` }),
        });
        break;
      case 4:
        jobs.push({
          label: `aminer.search#${i}`,
          exec: (c) => c.aminerCreds.call("search", { query: `协同过滤-${i}` }),
        });
        break;
      case 5:
        jobs.push({
          label: `aminer.getPaper#${i}`,
          exec: (c) => c.aminerCreds.call("getPaper", { id: `paper-${i}` }),
        });
        break;
      default:
        jobs.push({
          label: `aminer.search-no-creds#${i}`,
          exec: (c) => c.aminerNoCreds.call("search", { query: `no-creds-${i}` }),
        });
    }
  }
  return jobs;
}

async function runJobs(order: "serial" | "parallel", jobs: Job[]): Promise<unknown[]> {
  const http = echoHttp();
  const connectors = makeConnectors(http);
  if (order === "serial") {
    const out: unknown[] = [];
    for (const job of jobs) {
      out.push(await job.exec(connectors));
    }
    return out;
  }
  return Promise.all(jobs.map((job) => job.exec(connectors)));
}

const N = 140; // >= 100，7 种 job 类型各 20 个

describe("connector 并发竞态回归（P10-a D-1，P0）", () => {
  test(`单实例 ${N} 并发混合工具调用，结果与串行逐个调用逐位一致`, async () => {
    const jobs = buildJobs(N);
    const serial = await runJobs("serial", jobs);
    const parallel = await runJobs("parallel", jobs);

    expect(serial.length).toBe(jobs.length);
    expect(parallel.length).toBe(jobs.length);

    for (let i = 0; i < jobs.length; i++) {
      // 阴性对照（已在 devlog 里记录验证过程）：把 base.ts 的 call() 临时改回旧的
      // `__handlingTool` 单值实例字段实现（子类方法相应改回 `super.call(...)`）后
      // 重跑本测试，会在这一行 toEqual 上失败——并发 run 里若干 job 的 echo 会退化成
      // 通用 URL 直通（缺 search=/format=json 等映射参数，或 AMiner 凭据检查被跳过），
      // 与串行 run 的正确结果不一致。
      expect(parallel[i]).toEqual(serial[i]);
    }
  });

  test("并发下 OpenAlex 的 query→search / per-page 映射未被跳过", async () => {
    const jobs = buildJobs(N);
    const parallel = await runJobs("parallel", jobs);
    const searchJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("openalex.search#"));
    expect(searchJobs.length).toBe(20);
    for (const { job, echo } of searchJobs) {
      const i = Number(job.label.split("#")[1]);
      expect(echo.url).toContain("api.openalex.org/works");
      expect(echo.url).toContain(`search=AlphaFold-${i}`);
      expect(echo.url).toContain(`per-page=${(i % 5) + 1}`);
      expect(echo.url).toContain("mailto=");
      // 竞态触发时会退化成通用直通：原样把 `query` 当成 querystring key，
      // 而不是映射成 OpenAlex 认的 `search`。这里断言错误形态不存在。
      expect(echo.url).not.toContain(`query=AlphaFold-${i}`);
    }
  });

  test("并发下 EuropePMC 的 format=json / resultType=core 未被跳过", async () => {
    const jobs = buildJobs(N);
    const parallel = await runJobs("parallel", jobs);
    const searchJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("europepmc.search#"));
    expect(searchJobs.length).toBe(20);
    for (const { echo } of searchJobs) {
      // 缺 format=json 是评审报告里点名的具体后果：EuropePMC 默认返回 XML，
      // 归一化按 JSON 解析会直接把结果集清零。
      expect(echo.url).toContain("format=json");
      expect(echo.url).toContain("resultType=core");
    }

    const getPaperJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("europepmc.getPaper#"));
    expect(getPaperJobs.length).toBe(20);
    for (const { job, echo } of getPaperJobs) {
      const i = Number(job.label.split("#")[1]);
      expect(echo.url).toContain(`PMCID%3APMC${1000000 + i}`);
      expect(echo.url).toContain("format=json");
    }
  });

  test("并发下 AMiner 的凭据缺失检查（未配置）未被跳过", async () => {
    const jobs = buildJobs(N);
    const parallel = await runJobs("parallel", jobs);
    const noCredsJobs = jobs
      .map((job, idx) => ({ job, result: parallel[idx] }))
      .filter(({ job }) => job.label.startsWith("aminer.search-no-creds#"));
    expect(noCredsJobs.length).toBe(20);
    for (const { result } of noCredsJobs) {
      // 竞态触发时，这条检查会被跳过，直接落到通用路径打真实（这里是 stub）请求——
      // 断言这里必须是结构化的「未配置凭据」结果，且没有发起任何 HTTP 请求。
      expect(isCredentialMissing(result)).toBe(true);
      const missing = result as { configured: boolean; results: unknown[] };
      expect(missing.configured).toBe(false);
      expect(missing.results).toEqual([]);
    }
  });

  test("并发下 AMiner 已配置凭据时 Authorization header 正确携带且未跳过", async () => {
    const jobs = buildJobs(N);
    const parallel = await runJobs("parallel", jobs);
    const searchJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("aminer.search#"));
    expect(searchJobs.length).toBe(20);
    for (const { echo } of searchJobs) {
      expect(echo.headers.Authorization).toBe("test-aminer-token");
      expect(echo.url).toContain("/paper/search");
      expect(echo.url).toContain("title=");
    }

    const getPaperJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("aminer.getPaper#"));
    expect(getPaperJobs.length).toBe(20);
    for (const { job, echo } of getPaperJobs) {
      const i = Number(job.label.split("#")[1]);
      expect(echo.method).toBe("POST");
      expect(echo.headers.Authorization).toBe("test-aminer-token");
      expect(JSON.parse(echo.body!)).toEqual({ ids: [`paper-${i}`] });
    }
  });
});
