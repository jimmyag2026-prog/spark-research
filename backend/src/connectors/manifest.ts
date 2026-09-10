// P15 X-b（v0.4 W1-c）· 声明式 connector manifest：schema + 编译器。
//
// 目标：`connector.json` 声明 → 运行时编译成一个 `HttpConnector`（复用 base.ts 的既有基类，
// 不新造连接器体系）。这是方案 §4.5 说的三种装载强度里的**默认推荐路径**——manifest 只是
// 数据，不执行任意代码，编译期把它翻成受限的 URL 拼装 + 受限的响应字段抽取，
// 天然比"写一个 TS 扩展"更容易审计、更容易挡住恶意/失误的第三方声明。
//
// ── 与 v0.3.0 并发安全修复的关系（base.ts D-1）───────────────────────────────
// base.ts 已把"同名方法即 handler"的反射分发废除，改成构造期一次性写入、运行期只读的
// `handlers` 表，`call()` 只查表分发，不存在任何跨请求共享的可变实例状态（见 base.ts
// `handle()` 上方的大段注释）。本文件的编译器**只做一件事**：把 manifest 里每个
// `tools[]` 声明翻译成一条 `this.handle(tool.name, fn)` 注册，`fn` 内部只读闭包捕获的
// `tool` 声明本身（manifest 编译后不可变）和调用方传入的 `params`（每次调用各自的局部变量），
// 不引入任何新的可变共享状态。也就是说——manifest 编译出的 connector 的并发安全性
// **不是本文件重新证明的，是 base.ts 的既有契约的直接推论**：只要编译器不在 handler 闭包
// 里引入跨请求共享的可变字段，它就自动继承 D-1 的不变式。`tests/unit/connector_manifest.test.ts`
// 里复现了 `tests/concurrency/connector_race.test.ts` 同款的"并发结果与串行逐位一致"断言，
// 并用一次刻意注入共享可变状态的阴性对照验证了"如果违反这条约束，测试真的会红"。
//
// ── 表达力边界（方案 §4.5"2026-09-10 补"的三条实测约束，逐条落地）──────────────
//
// 1) **枚举参数校验**：`ManifestParamSpec.type === "enum"` 声明取值集合，编译期校验
//    `enum` 非空，调用期校验实际值 ∈ enum，否则整个 handler 抛错，请求根本不会发出。
//    bioRxiv 的 `server` 只认 `biorxiv|medrxiv`——见
//    `tests/fixtures/manifests/biorxiv.manifest.json`。
//
// 2) **声明式映射覆盖不了响应体分支**：`normalize` 的值类型被刻意收窄成"受限路径字符串"
//    （见下方 `evaluateRestrictedPath`），语法上只能表达"从固定形状里取一个字段"，
//    没有 if/else、没有"字段存在与否切换取法"的能力。BindingDB 无匹配时返回
//    HTTP 200 + 空 body（不是 404、不是某个字段为 null）——manifest 的 normalize
//    只会老老实实按声明的路径取值，取不到就是 `undefined`，**不会**、也**不该**试图
//    猜"这是空结果还是上游出错了"。这类源应该写 TS 扩展（连接器契约里另外两种装载强度
//    之一），而不是把条件分支硬塞进这里的 DSL——DSL 一旦长出 if/else 就是在重新发明
//    一门脚本语言，是本 lane 明确要避免的失控方向。`tests/fixtures/manifests/
//    bindingdb-boundary.manifest.json` 与配套测试把这条边界写成了可运行的文档。
//
// 3) **"一次 fetch 查多实体"要拆**：OpenTargets 一个接口横跨 target/disease/drug 三类
//    实体。如果用一个 `entityType` 枚举参数把它们揉进一个 tool 声明，表面上能过 (1) 的
//    枚举校验，但三类实体的响应形状不同、每类需要的 `normalize` 字段集合也不同——而
//    `normalize` 是"一个 tool 对应一份固定映射"，没有"按参数值切换映射表"的语法（这
//    正是 (2) 的同一条边界在结构层面的另一种体现）。所以进 manifest 就该拆成多个
//    `tools[]` 条目（`opentargets_target` / `opentargets_disease` / …），各自声明自己
//    的 endpoint 与 normalize。见
//    `tests/fixtures/manifests/opentargets.manifest.json`。
//
// ── SSRF 防护（manifest 相对 TS 扩展的核心优势）─────────────────────────────
// manifest 的 baseUrl / 绝对 endpoint 在**编译期**就要过出站 URL 白名单校验
// （`assertOutboundUrlAllowed`）：协议只认 http/https，主机名不能落进内网/保留地址段。
// 这在结构上是完整的：base.ts 的 `requestRaw()` 对 `{param}` 路径占位符用
// `encodeURIComponent` 替换、对查询参数用 `URLSearchParams.set`——两条路径都不可能让
// 调用方传入的参数值把 scheme/host 改掉，所以"编译期校验 baseUrl + 任何写死的绝对
// endpoint"就堵死了这条口子，不需要在每次调用时重新解析一遍 URL。

import { HttpConnector, type ConnectorMetadata, type ConnectorOptions, type HttpConnectorConfig, type HttpTool } from "./base";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export type ManifestParamType = "string" | "number" | "boolean" | "enum";

export interface ManifestParamSpec {
  type: ManifestParamType;
  // 缺省值：调用方没传这个参数时代入的值；不算"缺参数"。
  default?: string | number | boolean;
  // 未提供且无 default 时是否报错（默认 false，即可选）。
  required?: boolean;
  // type === "enum" 时必填：允许的取值集合。
  enum?: string[];
  // 最终发给上游时用的 key 名（用于"入参名跟上游查询参数名不一致"的场景，
  // 如 PubMed 的 query → term）。缺省沿用参数本名。
  mapTo?: string;
}

export interface ManifestTool {
  name: string;
  description: string;
  // 相对路径（拼到 baseUrl 后面）或绝对 URL（会被 SSRF 白名单单独校验）。
  // 支持 `{paramName}` 占位符——见 base.ts `requestRaw()`，替换值经过 encodeURIComponent。
  endpoint: string;
  method?: "GET" | "POST";
  responseType?: "json" | "text";
  // 声明式参数校验/改名表；见上方 ManifestParamSpec。
  params?: Record<string, ManifestParamSpec>;
  // 恒定附加参数（如 PubMed 的 retmode=json）。调用方显式传同名参数可覆盖。
  defaults?: Record<string, string | number | boolean>;
  // 响应归一化：输出字段名 → 受限路径字符串（语法见 evaluateRestrictedPath）。
  // 不声明则原样透传上游响应。
  normalize?: Record<string, string>;
}

export interface ConnectorManifestMetadata {
  domain: string;
  apiKeyRequired: boolean;
  caveat?: string;
}

export interface ConnectorManifest {
  // connector 注册名，同 registry 里其它 connector 的 `name`。
  id: string;
  baseUrl: string;
  description: string;
  tools: ManifestTool[];
  metadata?: ConnectorManifestMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSRF 出站 URL 白名单
// ─────────────────────────────────────────────────────────────────────────────
//
// 已知限制（如实记录，不假装完备）：这是**字面量**校验——只看 manifest 里写死的
// 主机名/字面 IP，不做 DNS 解析，所以挡不住"域名当时解析到公网 IP、请求发出后才被
// DNS rebinding 改指向内网"这类运行时攻击。三条硬约束里要求的是"manifest 里塞
// file:// 或内网地址直接被拒"，这条校验完整覆盖了这个范围；DNS rebinding 防护需要
// 在实际发请求那一层（NativeHttp）做连接前 IP 复核，超出本 lane 的文件所有权
// （backend/src/http/client.ts 不在本 lane 名下），留给后续。

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function parseIpv4(hostname: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const octets = m.slice(1, 5).map((s) => Number(s));
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

function ipv4Blocked(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 私网
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私网
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 私网
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local（含云 metadata 169.254.169.254）
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function hostnameBlocked(hostnameRaw: string): boolean {
  let hostname = hostnameRaw.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }

  const v4 = parseIpv4(hostname);
  if (v4) return ipv4Blocked(v4);

  // IPv6 字面量：最常见的几类保留段，字符串前缀判断（不做完整地址算术）。
  if (hostname === "::1" || hostname === "::") return true; // loopback / unspecified
  if (/^f[cd][0-9a-f]{0,2}:/.test(hostname)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]?:/.test(hostname)) return true; // fe80::/10 link-local

  // IPv4-mapped IPv6，点分十进制形式：::ffff:127.0.0.1
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(hostname);
  if (mappedDotted) {
    const inner = parseIpv4(mappedDotted[1]!);
    if (inner) return ipv4Blocked(inner);
  }

  // IPv4-mapped IPv6，WHATWG URL 解析器会把它规范化成的十六进制分组形式：
  // ::ffff:127.0.0.1 → [::ffff:7f00:1]。两组十六进制各拆成高/低字节还原成 4 个八位组。
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (mappedHex) {
    const g1 = Number.parseInt(mappedHex[1]!, 16);
    const g2 = Number.parseInt(mappedHex[2]!, 16);
    const octets = [(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff];
    return ipv4Blocked(octets);
  }

  return false;
}

export function assertOutboundUrlAllowed(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ManifestError(`manifest 声明了一个无法解析的 URL："${rawUrl}"`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new ManifestError(
      `manifest 出站 URL 协议不在白名单（只允许 http/https）：协议是 "${url.protocol}"，URL 是 "${rawUrl}"`,
    );
  }
  if (hostnameBlocked(url.hostname)) {
    throw new ManifestError(
      `manifest 出站 URL 指向内网/保留地址段，已拒绝（SSRF 防护）：主机名是 "${url.hostname}"，URL 是 "${rawUrl}"`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 受限响应映射 DSL
// ─────────────────────────────────────────────────────────────────────────────
//
// 语法（刻意收窄，不是 JSONPath 全集）：`.` 分隔的一串"标识符" + 可选的
// `[<非负整数>]` 下标，例如 `data.results[0].title`、`hits[2]`。
// 不支持：通配符（`*`）、递归下降（`..`）、过滤表达式（`[?(...)]`）、
// 函数调用、任何形式的条件分支。表达不了就该换 TS 扩展——这是本文件顶部
// 文档里"表达力约束 #2"的直接实现。
const PATH_SEGMENT_RE = /^([A-Za-z_$][\w$]*)((?:\[\d+\])*)$/;

// 编译期语法校验（不求值，只查语法是否落在受限子集内）。用于 validateManifest，
// 让"DSL 写错了"在 manifest 加载时就报错，而不是等到第一次调用才炸。
export function assertRestrictedPathSyntax(path: string, where: string): void {
  if (path === "" || path === "$") return; // "$" / "" 表示整个响应体
  for (const seg of path.split(".")) {
    if (!PATH_SEGMENT_RE.test(seg)) {
      throw new ManifestError(
        `${where}：受限映射 DSL 不支持路径片段 "${seg}"（只允许 "标识符" 或 "标识符[数字]" 的固定组合，` +
          `不支持通配符 / 过滤表达式 / 函数调用 / 条件分支——这类响应要写 TS 扩展，不要硬塞进 manifest）。完整路径："${path}"`,
      );
    }
  }
}

function objGet(cur: unknown, key: string): unknown {
  if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
  return (cur as Record<string, unknown>)[key];
}

function arrGet(cur: unknown, index: number): unknown {
  if (!Array.isArray(cur)) return undefined;
  return cur[index];
}

// 求值。找不到就返回 undefined（不抛错）——"取不到"是响应形状不含该字段的正常结果，
// 不是 DSL 语法错误；语法错误已经在编译期被 assertRestrictedPathSyntax 拦下了。
export function evaluateRestrictedPath(root: unknown, path: string): unknown {
  if (path === "" || path === "$") return root;
  let cur = root;
  for (const seg of path.split(".")) {
    const m = PATH_SEGMENT_RE.exec(seg);
    if (!m) return undefined; // 理论上不会走到这里（编译期已校验），防御性兜底。
    const key = m[1]!;
    cur = objGet(cur, key);
    const indices = m[2]!.match(/\d+/g) ?? [];
    for (const idxStr of indices) {
      cur = arrGet(cur, Number(idxStr));
    }
  }
  return cur;
}

// ─────────────────────────────────────────────────────────────────────────────
// 编译期校验
// ─────────────────────────────────────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_-]*$/;
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function validateManifest(manifest: ConnectorManifest): void {
  if (!manifest || typeof manifest !== "object") {
    throw new ManifestError("manifest 不是一个对象");
  }
  if (!manifest.id || !ID_RE.test(manifest.id)) {
    throw new ManifestError(`manifest.id 非法（要求 /^[a-z][a-z0-9_-]*$/）："${manifest.id}"`);
  }
  if (!manifest.baseUrl || typeof manifest.baseUrl !== "string") {
    throw new ManifestError(`manifest "${manifest.id}"：baseUrl 缺失或不是字符串`);
  }
  assertOutboundUrlAllowed(manifest.baseUrl);

  if (!manifest.description || typeof manifest.description !== "string") {
    throw new ManifestError(`manifest "${manifest.id}"：description 缺失`);
  }

  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    throw new ManifestError(`manifest "${manifest.id}"：tools 不能为空`);
  }

  const seen = new Set<string>();
  for (const tool of manifest.tools) {
    if (!tool.name || !TOOL_NAME_RE.test(tool.name)) {
      throw new ManifestError(`manifest "${manifest.id}"：tool 名非法："${tool.name}"`);
    }
    if (seen.has(tool.name)) {
      throw new ManifestError(`manifest "${manifest.id}"：重复的 tool 名 "${tool.name}"`);
    }
    seen.add(tool.name);

    if (!tool.endpoint || typeof tool.endpoint !== "string") {
      throw new ManifestError(`manifest "${manifest.id}" tool "${tool.name}"：endpoint 缺失`);
    }
    if (tool.endpoint.startsWith("http")) {
      assertOutboundUrlAllowed(tool.endpoint);
    }
    if (tool.method !== undefined && tool.method !== "GET" && tool.method !== "POST") {
      throw new ManifestError(`manifest "${manifest.id}" tool "${tool.name}"：method 只支持 GET/POST，收到 "${tool.method}"`);
    }
    if (tool.responseType !== undefined && tool.responseType !== "json" && tool.responseType !== "text") {
      throw new ManifestError(
        `manifest "${manifest.id}" tool "${tool.name}"：responseType 只支持 json/text，收到 "${tool.responseType}"`,
      );
    }

    for (const [key, spec] of Object.entries(tool.params ?? {})) {
      if (!spec || typeof spec !== "object") {
        throw new ManifestError(`manifest "${manifest.id}" tool "${tool.name}"：参数 "${key}" 的声明不是对象`);
      }
      if (!["string", "number", "boolean", "enum"].includes(spec.type)) {
        throw new ManifestError(
          `manifest "${manifest.id}" tool "${tool.name}"：参数 "${key}" 的 type 非法："${spec.type}"（只支持 string/number/boolean/enum）`,
        );
      }
      if (spec.type === "enum" && (!Array.isArray(spec.enum) || spec.enum.length === 0)) {
        throw new ManifestError(
          `manifest "${manifest.id}" tool "${tool.name}"：参数 "${key}" 声明为 enum 但没有给出非空的 enum 取值列表` +
            `——这正是硬约束 #1（bioRxiv server 参数）要求的：声明不了枚举的 manifest 挡不住脏输入。`,
        );
      }
      if (spec.type === "enum" && spec.default !== undefined && !spec.enum!.includes(String(spec.default))) {
        throw new ManifestError(
          `manifest "${manifest.id}" tool "${tool.name}"：参数 "${key}" 的 default "${spec.default}" 不在它自己声明的 enum 里`,
        );
      }
    }

    for (const [field, path] of Object.entries(tool.normalize ?? {})) {
      assertRestrictedPathSyntax(path, `manifest "${manifest.id}" tool "${tool.name}" normalize."${field}"`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编译器
// ─────────────────────────────────────────────────────────────────────────────

class ManifestConnector extends HttpConnector {
  private readonly manifestId: string;
  // 只读：编译期从 manifest 拷贝出来的 tool 声明表，运行期不再被写入。
  // handler 闭包只捕获这张表里对应的**单个** tool 对象（值不可变）+ 每次调用各自的
  // 局部变量，不存在任何跨调用共享的可变字段——见文件头部"与并发安全修复的关系"。
  private readonly toolSpecs: ReadonlyMap<string, ManifestTool>;

  constructor(manifest: ConnectorManifest, options: ConnectorOptions = {}) {
    const config: HttpConnectorConfig = {
      baseUrl: manifest.baseUrl,
      description: manifest.description,
      tools: manifest.tools.map(
        (t): HttpTool => ({
          name: t.name,
          description: t.description,
          endpoint: t.endpoint,
          method: t.method,
          responseType: t.responseType,
        }),
      ),
      metadata: manifest.metadata
        ? ({
            domain: manifest.metadata.domain,
            apiKeyRequired: manifest.metadata.apiKeyRequired,
            status: "available",
            caveat: manifest.metadata.caveat,
          } satisfies ConnectorMetadata)
        : undefined,
    };
    super(manifest.id, config, options);
    this.manifestId = manifest.id;
    const specs = new Map<string, ManifestTool>();
    for (const tool of manifest.tools) specs.set(tool.name, tool);
    this.toolSpecs = specs;

    // 每个 tool 声明 → 一条 handle() 注册。这一步是本 lane 对方案 §4.5"P10 之后修订"
    // 那段话的具体落地：manifest 的每个 tool 天然继承 D-1 的并发安全性质，
    // 因为这里注册的每个 handler 都只是"查表 + 调用下面的 invoke()"，不引入新状态。
    for (const tool of manifest.tools) {
      this.handle(tool.name, (params) => this.invoke(tool, params));
    }
  }

  // 供阴性对照③使用的"故意破坏并发安全"开关。**只在测试里通过子类/猴子补丁触发**，
  // 生产路径永远是 false，见 tests/unit/connector_manifest.test.ts 的说明。
  // 保留在这里是为了让阴性对照能在不改动这个文件的前提下，通过继承覆盖 invoke() 来复现——
  // 见测试文件里的 `BrokenManifestConnector`。

  private async invoke(tool: ManifestTool, callerParams: Record<string, unknown>): Promise<unknown> {
    // 局部变量，仅属于本次调用；与并发中的其它调用互不共享。
    const mapped: Record<string, unknown> = { ...(tool.defaults ?? {}), ...callerParams };

    for (const [key, spec] of Object.entries(tool.params ?? {})) {
      let value = mapped[key];
      if (value === undefined) {
        if (spec.default !== undefined) {
          value = spec.default;
        } else if (spec.required) {
          throw new ManifestError(
            `connector "${this.manifestId}" tool "${tool.name}"：缺少必填参数 "${key}"`,
          );
        } else {
          continue;
        }
      }

      if (spec.type === "enum") {
        if (typeof value !== "string" || !spec.enum!.includes(value)) {
          throw new ManifestError(
            `connector "${this.manifestId}" tool "${tool.name}"：参数 "${key}" 不在枚举取值内` +
              `（只允许 ${spec.enum!.join("|")}），收到 ${JSON.stringify(value)}`,
          );
        }
      } else if (spec.type === "number") {
        if (typeof value !== "number" || Number.isNaN(value)) {
          throw new ManifestError(
            `connector "${this.manifestId}" tool "${tool.name}"：参数 "${key}" 必须是 number，收到 ${JSON.stringify(value)}`,
          );
        }
      } else if (spec.type === "boolean") {
        if (typeof value !== "boolean") {
          throw new ManifestError(
            `connector "${this.manifestId}" tool "${tool.name}"：参数 "${key}" 必须是 boolean，收到 ${JSON.stringify(value)}`,
          );
        }
      } else if (spec.type === "string") {
        if (typeof value !== "string") {
          throw new ManifestError(
            `connector "${this.manifestId}" tool "${tool.name}"：参数 "${key}" 必须是 string，收到 ${JSON.stringify(value)}`,
          );
        }
      }

      const targetKey = spec.mapTo ?? key;
      delete mapped[key];
      mapped[targetKey] = value;
    }

    const raw = await this.requestRaw(tool.name, mapped);
    if (!tool.normalize) return raw;

    const out: Record<string, unknown> = {};
    for (const [field, path] of Object.entries(tool.normalize)) {
      out[field] = evaluateRestrictedPath(raw, path);
    }
    return out;
  }
}

export function compileManifest(manifest: ConnectorManifest, options: ConnectorOptions = {}): HttpConnector {
  validateManifest(manifest);
  return new ManifestConnector(manifest, options);
}

export function loadManifestFromJson(json: string, options: ConnectorOptions = {}): HttpConnector {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ManifestError(`manifest JSON 解析失败：${(error as Error).message}`);
  }
  return compileManifest(parsed as ConnectorManifest, options);
}
