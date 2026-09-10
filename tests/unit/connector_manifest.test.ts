// P15 X-b（v0.4 W1-c）· 声明式 connector manifest 的单测。
//
// 覆盖四类断言：
//   1) 编译期 schema 校验（合法通过 / 各类非法输入各自报错）
//   2) SSRF 出站 URL 白名单（阴性对照①的证据）
//   3) 方案 §4.5"2026-09-10 补"三条表达力硬约束的验收用例
//      （bioRxiv 枚举 / BindingDB 响应体分支边界 / OpenTargets 多实体拆分）
//   4) 并发不变式复现（同 tests/concurrency/connector_race.test.ts 的断言写法，
//      只读参考那个文件，不修改它——见本文件末尾）

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BufferedResponse, StubHttp, type HttpRequestInit } from "../../backend/src/http/client";
import {
  ManifestError,
  assertOutboundUrlAllowed,
  assertRestrictedPathSyntax,
  compileManifest,
  evaluateRestrictedPath,
  loadManifestFromJson,
  validateManifest,
  type ConnectorManifest,
} from "../../backend/src/connectors/manifest";

const FIXTURES = resolve(import.meta.dir, "../fixtures/manifests");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function parseFixture(name: string): ConnectorManifest {
  return JSON.parse(readFixture(name)) as ConnectorManifest;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 编译期 schema 校验
// ─────────────────────────────────────────────────────────────────────────────

describe("manifest schema 校验", () => {
  test("合法 manifest 编译成功，工具列表与声明一致", () => {
    const manifest = parseFixture("example.manifest.json");
    const connector = compileManifest(manifest);
    expect(connector.name).toBe("example-manifest-demo");
    const tools = connector.listTools().map((t) => t.name);
    expect(tools).toEqual(["search", "getById", "createThing"]);
  });

  test("loadManifestFromJson 直接吃字符串", () => {
    const connector = loadManifestFromJson(readFixture("example.manifest.json"));
    expect(connector.name).toBe("example-manifest-demo");
  });

  test("非法 JSON 字符串报错", () => {
    expect(() => loadManifestFromJson("{not json")).toThrow(ManifestError);
  });

  test("id 非法（大写/以数字开头）被拒", () => {
    const base = parseFixture("example.manifest.json");
    expect(() => validateManifest({ ...base, id: "Bad-Id" })).toThrow(/manifest\.id 非法/);
    expect(() => validateManifest({ ...base, id: "9bad" })).toThrow(/manifest\.id 非法/);
  });

  test("缺 baseUrl / description / tools 各自报错", () => {
    const base = parseFixture("example.manifest.json");
    expect(() => validateManifest({ ...base, baseUrl: "" })).toThrow(/baseUrl/);
    expect(() => validateManifest({ ...base, description: "" })).toThrow(/description/);
    expect(() => validateManifest({ ...base, tools: [] })).toThrow(/tools 不能为空/);
  });

  test("重复的 tool 名被拒", () => {
    const base = parseFixture("example.manifest.json");
    const dup: ConnectorManifest = { ...base, tools: [base.tools[0]!, base.tools[0]!] };
    expect(() => validateManifest(dup)).toThrow(/重复的 tool 名/);
  });

  test("tool 缺 endpoint 被拒", () => {
    const base = parseFixture("example.manifest.json");
    const bad: ConnectorManifest = {
      ...base,
      tools: [{ ...base.tools[0]!, endpoint: "" }],
    };
    expect(() => validateManifest(bad)).toThrow(/endpoint 缺失/);
  });

  test("method / responseType 取值超出白名单被拒", () => {
    const base = parseFixture("example.manifest.json");
    expect(() =>
      validateManifest({ ...base, tools: [{ ...base.tools[0]!, method: "PUT" as any }] }),
    ).toThrow(/method 只支持/);
    expect(() =>
      validateManifest({ ...base, tools: [{ ...base.tools[0]!, responseType: "xml" as any }] }),
    ).toThrow(/responseType 只支持/);
  });

  test("enum 参数没给取值列表被拒——硬约束 #1 的编译期一半", () => {
    const base = parseFixture("example.manifest.json");
    const bad: ConnectorManifest = {
      ...base,
      tools: [
        {
          ...base.tools[0]!,
          params: { server: { type: "enum" } as any },
        },
      ],
    };
    expect(() => validateManifest(bad)).toThrow(/声明为 enum 但没有给出非空的 enum 取值列表/);
  });

  test("enum 的 default 不在自己声明的取值里被拒", () => {
    const base = parseFixture("example.manifest.json");
    const bad: ConnectorManifest = {
      ...base,
      tools: [
        {
          ...base.tools[0]!,
          params: { server: { type: "enum", enum: ["a", "b"], default: "c" } },
        },
      ],
    };
    expect(() => validateManifest(bad)).toThrow(/default "c" 不在它自己声明的 enum 里/);
  });

  test("normalize 路径语法非法被拒——通配符/函数调用类写法直接编译期报错", () => {
    const base = parseFixture("example.manifest.json");
    const bad: ConnectorManifest = {
      ...base,
      tools: [{ ...base.tools[0]!, normalize: { x: "results[*].title" } }],
    };
    expect(() => validateManifest(bad)).toThrow(/受限映射 DSL 不支持路径片段/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 受限路径 DSL 求值单测（独立于 HTTP，纯函数）
// ─────────────────────────────────────────────────────────────────────────────

describe("受限映射 DSL", () => {
  test("对象/数组下标混合路径求值", () => {
    const root = { data: { results: [{ title: "A" }, { title: "B" }] }, meta: { total: 2 } };
    expect(evaluateRestrictedPath(root, "data.results[0].title")).toBe("A");
    expect(evaluateRestrictedPath(root, "data.results[1].title")).toBe("B");
    expect(evaluateRestrictedPath(root, "meta.total")).toBe(2);
    expect(evaluateRestrictedPath(root, "$")).toEqual(root);
  });

  test("取不到就是 undefined，不抛错——这是『取不到』与『语法错』的边界", () => {
    const root = { a: { b: 1 } };
    expect(evaluateRestrictedPath(root, "a.c")).toBeUndefined();
    expect(evaluateRestrictedPath(root, "a.b[0]")).toBeUndefined();
    expect(evaluateRestrictedPath(null, "a.b")).toBeUndefined();
    expect(evaluateRestrictedPath({}, "a.b.c")).toBeUndefined();
  });

  test("语法非法的路径在编译期就报错，不是等到求值", () => {
    expect(() => assertRestrictedPathSyntax("a.*.b", "where")).toThrow(/受限映射 DSL 不支持/);
    expect(() => assertRestrictedPathSyntax("a..b", "where")).toThrow(/受限映射 DSL 不支持/);
    expect(() => assertRestrictedPathSyntax("a[?(@.x>1)]", "where")).toThrow(/受限映射 DSL 不支持/);
    expect(() => assertRestrictedPathSyntax("fn(a)", "where")).toThrow(/受限映射 DSL 不支持/);
  });

  test("端到端：manifest 的 normalize 声明把嵌套响应拍平成声明的输出字段名", async () => {
    const manifest: ConnectorManifest = {
      id: "normalize-demo",
      baseUrl: "https://api.example.org",
      description: "normalize 端到端演示",
      tools: [
        {
          name: "search",
          description: "检索",
          endpoint: "/v1/search",
          params: { query: { type: "string", required: true } },
          normalize: { items: "results", total: "meta.total", firstTitle: "results[0].title" },
        },
      ],
    };
    const http = StubHttp.json({ results: [{ title: "A" }, { title: "B" }], meta: { total: 2 } });
    const connector = compileManifest(manifest, { http });
    const result = await connector.call("search", { query: "x" });
    expect(result).toEqual({ items: [{ title: "A" }, { title: "B" }], total: 2, firstTitle: "A" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) SSRF 出站 URL 白名单 —— 阴性对照①的证据
// ─────────────────────────────────────────────────────────────────────────────

describe("SSRF 出站 URL 白名单（阴性对照①）", () => {
  test("file:// 协议的 baseUrl 被拒绝，编译不会成功", () => {
    const manifest = parseFixture("ssrf-blocked/file-url.manifest.json");
    expect(() => compileManifest(manifest)).toThrow(ManifestError);
    expect(() => compileManifest(manifest)).toThrow(/协议不在白名单/);
  });

  test("云 metadata 的 link-local 地址（169.254.169.254）被拒绝", () => {
    const manifest = parseFixture("ssrf-blocked/internal-ip.manifest.json");
    expect(() => compileManifest(manifest)).toThrow(ManifestError);
    expect(() => compileManifest(manifest)).toThrow(/内网\/保留地址段/);
  });

  test.each([
    ["http://127.0.0.1/", true],
    ["http://127.1.2.3/", true],
    ["http://10.0.0.5/", true],
    ["http://172.16.0.1/", true],
    ["http://172.31.255.255/", true],
    ["http://172.32.0.1/", false], // 172.32 不在 172.16-31 私网段内，应放行
    ["http://192.168.1.1/", true],
    ["http://169.254.169.254/", true],
    ["http://100.64.0.1/", true], // CGNAT
    ["http://0.0.0.0/", true],
    ["http://[::1]/", true],
    ["http://[fc00::1]/", true],
    ["http://[fe80::1]/", true],
    ["http://[::ffff:127.0.0.1]/", true],
    ["http://localhost/", true],
    ["http://foo.localhost/", true],
    ["http://internal-service.internal/", true],
    ["file:///etc/passwd", true],
    ["ftp://example.com/", true],
    ["https://api.openalex.org/works", false],
    ["https://example.com/", false],
  ])("%s → blocked=%s", (url, blocked) => {
    if (blocked) {
      expect(() => assertOutboundUrlAllowed(url)).toThrow(ManifestError);
    } else {
      expect(() => assertOutboundUrlAllowed(url)).not.toThrow();
    }
  });

  test("绝对 URL 形式的 tool.endpoint 也要过白名单，不能靠相对路径绕开", () => {
    const base = parseFixture("example.manifest.json");
    const bad: ConnectorManifest = {
      ...base,
      tools: [{ ...base.tools[0]!, endpoint: "http://169.254.169.254/latest/meta-data/" }],
    };
    expect(() => compileManifest(bad)).toThrow(/内网\/保留地址段/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// echo http（与 tests/concurrency/connector_race.test.ts 同款手法）：
// 把请求本身编码进响应体，让调用结果自描述"这次到底发出了什么请求"。
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
    const echo: Echo = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null };
    return new BufferedResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(echo)),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3a) 硬约束 #1：bioRxiv 的 server 枚举 —— 阴性对照②的证据
// ─────────────────────────────────────────────────────────────────────────────

describe("硬约束 #1 · 枚举参数校验（bioRxiv server）", () => {
  test("合法枚举值正确拼进 URL 路径", async () => {
    const http = echoHttp();
    const connector = compileManifest(parseFixture("biorxiv.manifest.json"), { http });
    const echo = (await connector.call("getDetails", { server: "medrxiv", doi: "10.1101/2024.01.01.000001" })) as Echo;
    expect(echo.url).toContain("/details/medrxiv/10.1101");
  });

  test("非法枚举值被拒绝，且从未发出任何 HTTP 请求（阴性对照②）", async () => {
    const http = echoHttp();
    const connector = compileManifest(parseFixture("biorxiv.manifest.json"), { http });
    await expect(
      connector.call("getDetails", { server: "eviladmin", doi: "10.1101/x" }),
    ).rejects.toThrow(/参数 "server" 不在枚举取值内/);
    expect(http.calls.length).toBe(0);
  });

  test("缺失必填参数（server 未传）被拒绝，且未发出请求", async () => {
    const http = echoHttp();
    const connector = compileManifest(parseFixture("biorxiv.manifest.json"), { http });
    await expect(connector.call("getDetails", { doi: "10.1101/x" })).rejects.toThrow(/缺少必填参数 "server"/);
    expect(http.calls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b) 硬约束 #3：OpenTargets 拆成多个 tool，而不是一个万能 entityType 参数
// ─────────────────────────────────────────────────────────────────────────────

describe("硬约束 #3 · 多实体接口拆成多个 tool（OpenTargets）", () => {
  test("三个 tool 各自声明独立的 endpoint 与 normalize，互不干扰", async () => {
    const manifest = parseFixture("opentargets.manifest.json");
    expect(manifest.tools.map((t) => t.name)).toEqual(["getTarget", "getDisease", "getDrug"]);

    const http = new StubHttp((url: string) => {
      if (url.includes("/target/")) {
        return jsonResponse({ data: { target: { approvedSymbol: "BRCA1", approvedName: "BRCA1 DNA repair", biotype: "protein_coding" } } });
      }
      if (url.includes("/disease/")) {
        return jsonResponse({ data: { disease: { name: "breast cancer", description: "...", therapeuticAreas: [{ name: "oncology" }] } } });
      }
      return jsonResponse({ data: { drug: { name: "Olaparib", drugType: "Small molecule", maximumClinicalTrialPhase: 4 } } });
    });
    const connector = compileManifest(manifest, { http });

    const target = (await connector.call("getTarget", { id: "ENSG00000012048" })) as Record<string, unknown>;
    expect(target.symbol).toBe("BRCA1");
    expect(target.biotype).toBe("protein_coding");

    const disease = (await connector.call("getDisease", { id: "EFO_0000305" })) as Record<string, unknown>;
    expect(disease.name).toBe("breast cancer");
    expect(disease.therapeuticAreas).toBe("oncology");

    const drug = (await connector.call("getDrug", { id: "CHEMBL521" })) as Record<string, unknown>;
    expect(drug.name).toBe("Olaparib");
    expect(drug.maxPhase).toBe(4);
  });
});

// 小工具：单条 JSON 响应（比 StubHttp.json 更适合"按 URL 分流返回不同 body"的场景）。
function jsonResponse(payload: unknown): BufferedResponse {
  return new BufferedResponse({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3c) 硬约束 #2：BindingDB 的响应体分支边界——文档化为可运行的测试
// ─────────────────────────────────────────────────────────────────────────────

describe("硬约束 #2 · 声明式映射覆盖不了响应体分支（BindingDB 边界）", () => {
  test("manifest 本身可以正常编译——边界在『行为』，不在『能不能声明』", () => {
    const manifest = parseFixture("bindingdb-boundary.manifest.json");
    expect(() => compileManifest(manifest)).not.toThrow();
  });

  test("上游返回 HTTP 200 + 真正的空 body 时，manifest 路径直接炸（JSON 解析失败），" +
    "而不是优雅地识别成『无匹配』——这正是硬约束 #2 的具体后果", async () => {
    const http = new StubHttp(
      () => new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("") }),
    );
    const connector = compileManifest(parseFixture("bindingdb-boundary.manifest.json"), { http });
    await expect(connector.call("getLigandBindingByUniprot", { uniprot: "P12345" })).rejects.toThrow();
  });

  test("上游返回 HTTP 200 + `{}` 时，normalize 静默给出 undefined——" +
    "manifest 无法区分『真的没数据』与『字段路径写错/上游 schema 变了』，这两种情况长得一模一样", async () => {
    const http = StubHttp.json({});
    const connector = compileManifest(parseFixture("bindingdb-boundary.manifest.json"), { http });
    const result = (await connector.call("getLigandBindingByUniprot", { uniprot: "P12345" })) as Record<string, unknown>;
    expect(result.affinity).toBeUndefined();
    // 断言的重点：上面这一行对『真无匹配』和『manifest 路径写错了』返回的结果完全相同——
    // 这就是文档里说的"declarative 映射覆盖不了响应体分支"，这类源该走 TS 扩展。
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) 并发不变式复现（阴性对照③的正向基线；破坏版见 devlog）
//
// 只读参考 tests/concurrency/connector_race.test.ts 的写法，这里独立复现同款断言，
// 不修改那个文件。用 example.manifest.json + biorxiv.manifest.json 编译出的两个
// ManifestConnector 实例，单实例高并发混合工具调用，验证结果与串行逐位一致。
// ─────────────────────────────────────────────────────────────────────────────

interface ManifestConnectors {
  example: ReturnType<typeof compileManifest>;
  biorxiv: ReturnType<typeof compileManifest>;
}

function makeManifestConnectors(http: StubHttp): ManifestConnectors {
  return {
    example: compileManifest(parseFixture("example.manifest.json"), { http }),
    biorxiv: compileManifest(parseFixture("biorxiv.manifest.json"), { http }),
  };
}

interface Job {
  label: string;
  exec: (c: ManifestConnectors) => Promise<unknown>;
}

function buildJobs(n: number): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 4;
    switch (kind) {
      case 0:
        jobs.push({
          label: `example.search#${i}`,
          exec: (c) => c.example.call("search", { query: `alpha-${i}`, limit: (i % 5) + 1 }),
        });
        break;
      case 1:
        jobs.push({
          label: `example.getById#${i}`,
          exec: (c) => c.example.call("getById", { id: `rec-${i}` }),
        });
        break;
      case 2:
        jobs.push({
          label: `example.createThing#${i}`,
          exec: (c) => c.example.call("createThing", { kind: (["a", "b", "c"] as const)[i % 3] }),
        });
        break;
      default:
        jobs.push({
          label: `biorxiv.getDetails#${i}`,
          exec: (c) =>
            c.biorxiv.call("getDetails", {
              server: i % 2 === 0 ? "biorxiv" : "medrxiv",
              doi: `10.1101/x-${i}`,
            }),
        });
    }
  }
  return jobs;
}

async function runJobs(order: "serial" | "parallel", jobs: Job[]): Promise<unknown[]> {
  const http = echoHttp();
  const connectors = makeManifestConnectors(http);
  if (order === "serial") {
    const out: unknown[] = [];
    for (const job of jobs) out.push(await job.exec(connectors));
    return out;
  }
  return Promise.all(jobs.map((job) => job.exec(connectors)));
}

const N = 140;

describe("manifest connector 并发不变式复现（同 connector_race.test.ts 断言写法）", () => {
  test(`单实例 ${N} 并发混合工具调用，结果与串行逐个调用逐位一致`, async () => {
    const jobs = buildJobs(N);
    const serial = await runJobs("serial", jobs);
    const parallel = await runJobs("parallel", jobs);

    expect(serial.length).toBe(jobs.length);
    expect(parallel.length).toBe(jobs.length);

    for (let i = 0; i < jobs.length; i++) {
      // 阴性对照③（实跑记录见 docs/devlog/W1-c.md）：临时把 manifest.ts 的
      // ManifestConnector.invoke 改成读写一个跨调用共享的实例字段（模拟旧
      // __handlingTool 那类竞态），重跑本测试会在这一行 toEqual 上失败。
      expect(parallel[i]).toEqual(serial[i]);
    }
  });

  test("并发下 example.search 的 query→q mapTo / defaults.format 映射未被跳过", async () => {
    const jobs = buildJobs(N);
    const parallel = await runJobs("parallel", jobs);
    const searchJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("example.search#"));
    expect(searchJobs.length).toBe(35);
    for (const { job, echo } of searchJobs) {
      const i = Number(job.label.split("#")[1]);
      expect(echo.url).toContain(`q=alpha-${i}`);
      expect(echo.url).toContain(`limit=${(i % 5) + 1}`);
      expect(echo.url).toContain("format=json");
      expect(echo.url).not.toContain("query=alpha");
    }
  });

  test("并发下 biorxiv.getDetails 的 server 路径占位符替换未被跳过/串味", async () => {
    const jobs = buildJobs(N);
    const parallel = await runJobs("parallel", jobs);
    const bioJobs = jobs
      .map((job, idx) => ({ job, echo: parallel[idx] as Echo }))
      .filter(({ job }) => job.label.startsWith("biorxiv.getDetails#"));
    expect(bioJobs.length).toBe(35);
    for (const { job, echo } of bioJobs) {
      const i = Number(job.label.split("#")[1]);
      const expectedServer = i % 2 === 0 ? "biorxiv" : "medrxiv";
      expect(echo.url).toContain(`/details/${expectedServer}/10.1101%2Fx-${i}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W3-d · 判断证据：arXiv/PubMed 走 manifest 还是 TS 扩展的实测
//
// 两条互为对照的 fixture（tests/fixtures/manifests/pubmed-esearch-only.manifest.json
// 与 arxiv-xml-normalize-probe.manifest.json）+ 下面两组测试，具体验证 docs/devlog/W3-d.md
// 的判断依据：manifest 能表达"单次请求、JSON 响应"的那一半，但表达不了"响应是 XML"
// 或"需要串两次请求"的部分——这两个缺口都比 W1-c 当初标出的字符串前缀映射更根本。
// ─────────────────────────────────────────────────────────────────────────────

describe("W3-d 判断证据 · manifest 表达力边界（arXiv/PubMed 实测）", () => {
  test("正向：PubMed esearch 单独一跳（query→term 纯改名 + defaults）manifest 完全够用", async () => {
    const manifest = parseFixture("pubmed-esearch-only.manifest.json");
    const http = echoHttp();
    const connector = compileManifest(manifest, { http });
    const echo = (await connector.call("search", { query: "alphafold", retmax: 5 })) as Echo;
    expect(echo.url).toContain("term=alphafold");
    expect(echo.url).toContain("db=pubmed");
    expect(echo.url).toContain("retmode=json");
    expect(echo.url).toContain("retmax=5");
    expect(echo.url).not.toContain("query=alphafold");
  });

  test("反向：XML(text) 响应喂给 normalize，每个字段都拿到 undefined——不是路径写错了，是 DSL 没有『XML→对象树』这一步", async () => {
    const manifest = parseFixture("arxiv-xml-normalize-probe.manifest.json");
    const xmlBody =
      '<?xml version="1.0"?><feed><entry><title>Attention Is All You Need</title></entry><totalResults>1</totalResults></feed>';
    const http = new StubHttp(async () => {
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/atom+xml" },
        body: new TextEncoder().encode(xmlBody),
      });
    });
    const connector = compileManifest(manifest, { http });
    const result = await connector.call("search", { search_query: "all:test" });
    // 响应体里明明真的有 <title>Attention Is All You Need</title>，但 normalize 的
    // "feed.entry.title" 路径求值时第一步 objGet(rawXmlString, "feed") 就因为
    // `typeof cur !== "object"` 直接返回 undefined——问题不在路径语法，在这个 DSL
    // 压根没有"先把 XML 解析成对象树"这一步。
    expect(result).toEqual({ title: undefined, totalResults: undefined });
  });
});
