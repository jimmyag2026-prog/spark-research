#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Python SDK 生成器（W8-2 SDK lane）。
//
// 口径（AD-7 / W8-sdk.md）：SDK 是 HTTP 的薄投影，不新增能力、不手写方法表。
// 输入是 `bun backend/src/index.ts contract --json` 的输出（不导入 backend/src 内部
// 模块——契约本体归主会话，这里只当它是一份外部黑盒 JSON）。
//
// 输出两个文件，逐字节确定性（同 gen-llms-txt.ts / gen-contract-schemas.ts 的口径）：
//   sdk/python/spark_research/_generated.py  — 每条 HTTP 路由一个方法
//   sdk/python/spark_research/_types.py      — contract.definitions 的每个类型一个 TypedDict/别名
//
// 用法：
//   bun scripts/gen-sdk-python.ts            写盘
//   bun scripts/gen-sdk-python.ts --check     只比对不写盘，不一致 exit 1（CI / 幂等门禁用）

const REPO_ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(REPO_ROOT, "sdk", "python", "spark_research");
const GENERATED_PY = join(OUT_DIR, "_generated.py");
const TYPES_PY = join(OUT_DIR, "_types.py");

// ── 契约类型（只取用得到的字段，其余当 unknown 处理） ──────────────────────────

interface ContractRoute {
  method: string;
  path: string;
  group: string;
}

interface RuntimeContract {
  contractVersion: number;
  version: string;
  http: { routes: ContractRoute[]; schemas: Record<string, unknown> };
  definitions: Record<string, JsonSchema>;
  [key: string]: unknown;
}

type JsonSchema = Record<string, unknown>;

// ── 1. 取契约：真跑 CLI，不导入 backend/src 内部（保持"黑盒投影"口径） ──────────

export function getContract(): RuntimeContract {
  const proc = Bun.spawnSync(["bun", "backend/src/index.ts", "contract", "--json"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`contract --json 失败（exit ${proc.exitCode}）: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString()) as RuntimeContract;
}

// ── 2. JSON Schema（契约 definitions 用的子集）→ Python 类型注解 ───────────────

function pyLiteral(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  return JSON.stringify(String(v));
}

function pyType(schema: JsonSchema | undefined): string {
  if (schema == null || typeof schema !== "object") return "Any";
  if (typeof schema.$ref === "string") {
    const m = /^#\/definitions\/(.+)$/.exec(schema.$ref);
    return m ? m[1]! : "Any";
  }
  if ("const" in schema) return `Literal[${pyLiteral(schema.const)}]`;
  if (Array.isArray(schema.enum)) {
    const vals = schema.enum as unknown[];
    if (vals.length > 0 && vals.every((v) => typeof v === "string")) {
      return `Literal[${vals.map((v) => pyLiteral(v)).join(", ")}]`;
    }
    return "Any";
  }
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf as JsonSchema[];
    const hasNull = variants.some((v) => v && v.type === "null");
    const rest = variants.filter((v) => !(v && v.type === "null"));
    const mapped = [...new Set(rest.map((v) => pyType(v)))];
    if (mapped.length === 0) return hasNull ? "None" : "Any";
    const body = mapped.join(" | ");
    return hasNull ? `${body} | None` : body;
  }
  const t = schema.type as string | undefined;
  if (t === "string") return "str";
  if (t === "number") return "float";
  if (t === "boolean") return "bool";
  if (t === "null") return "None";
  if (t === "array") {
    const items = schema.items as JsonSchema | undefined;
    const inner = items && Object.keys(items).length > 0 ? pyType(items) : "Any";
    return `list[${inner}]`;
  }
  if (t === "object") return "dict[str, Any]";
  return "Any";
}

function isPlainEnum(schema: JsonSchema): boolean {
  return Array.isArray(schema.enum) && schema.type === undefined;
}

// 顶层 definitions 里一个 object 类型 → TypedDict class(es)。
// 有必填又有可选字段时用「必填基类 + total=False 子类继承」的老式写法：不依赖
// typing_extensions.NotRequired，跨 Python 3.10+ 都能跑。
function renderTypedDict(name: string, schema: JsonSchema): string {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const requiredFields = Object.keys(props).filter((k) => required.has(k));
  const optionalFields = Object.keys(props).filter((k) => !required.has(k));

  if (requiredFields.length === 0 && optionalFields.length === 0) {
    return `class ${name}(TypedDict):\n    pass`;
  }
  if (optionalFields.length === 0) {
    const lines = [`class ${name}(TypedDict):`];
    for (const f of requiredFields) lines.push(`    ${pyKey(f)}: ${pyType(props[f])}`);
    return lines.join("\n");
  }
  if (requiredFields.length === 0) {
    const lines = [`class ${name}(TypedDict, total=False):`];
    for (const f of optionalFields) lines.push(`    ${pyKey(f)}: ${pyType(props[f])}`);
    return lines.join("\n");
  }
  const baseName = `_${name}Required`;
  const lines = [`class ${baseName}(TypedDict):`];
  for (const f of requiredFields) lines.push(`    ${pyKey(f)}: ${pyType(props[f])}`);
  lines.push("");
  lines.push(`class ${name}(${baseName}, total=False):`);
  for (const f of optionalFields) lines.push(`    ${pyKey(f)}: ${pyType(props[f])}`);
  return lines.join("\n");
}

// 契约字段名都是合法 Python 标识符（camelCase）；留一个钩子以防将来出现非标识符键。
function pyKey(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : JSON.stringify(field);
}

export function renderTypesPy(contract: RuntimeContract): string {
  const defs = contract.definitions ?? {};
  const header = `"""自动生成，勿手改——来源：\`contract.definitions\`（\`spark-research contract --json\`）。

改法：不要编辑本文件，改 \`scripts/gen-sdk-python.ts\` 后跑 \`bun run gen:sdk\` 重新生成。
契约每加一个类型，这里就多一个 TypedDict / 类型别名；契约不变，重新生成逐字节相等。
"""
from __future__ import annotations

from typing import Any, Literal, TypedDict

`;
  const names = Object.keys(defs).sort();
  const blocks = names.map((name) => {
    const schema = defs[name]!;
    if (isPlainEnum(schema)) return `${name} = ${pyType(schema)}`;
    if (schema.type === "object") return renderTypedDict(name, schema);
    return `${name} = ${pyType(schema)}`;
  });
  return header + blocks.join("\n\n\n") + "\n";
}

// ── 3. HTTP 路由 → 方法名 / 签名 / 请求体 ──────────────────────────────────────

function buildMethodName(route: ContractRoute): string {
  if (route.path === "/*") return "root_get_root";
  const afterApi = route.path.replace(/^\/api\//, "");
  const segs = afterApi
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith(":") ? `by_${seg.slice(1)}` : seg));
  return [route.group, route.method.toLowerCase(), ...segs].join("_");
}

interface PathTemplate {
  paramNames: string[];
  /** 形如 "/api/projects/{slug}/archive" 的模板，`{name}` 待替换成 `quote(str(name))`。 */
  template: string;
  wildcard: boolean;
}

function buildPathTemplate(route: ContractRoute): PathTemplate {
  if (route.path === "/*") {
    return { paramNames: ["path"], template: "/{path}", wildcard: true };
  }
  const paramNames: string[] = [];
  const parts = route.path
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        paramNames.push(name);
        return `{${name}}`;
      }
      return seg;
    });
  return { paramNames, template: "/" + parts.join("/"), wildcard: false };
}

function pyFString(tpl: PathTemplate): string {
  let out = tpl.template;
  for (const p of tpl.paramNames) {
    const safe = tpl.wildcard ? "/" : "";
    out = out.replace(`{${p}}`, `{quote(str(${p}), safe='${safe}')}`);
  }
  return `f"${out}"`;
}

// 契约本身不带「路由 → 响应 schema」的映射（见 docs/devlog/W8-2-contract.md
// 「未做 / 留给 SDK lane」）。这张表不是靠命名规则猜出来的——是我们逐条读了
// `backend/src/server/routes/**` 的 handler 源码，确认响应体在**顶层**（不套
// `{project: ...}` / `{paper: ...}` 这类信封）之后才收进来的。实测发现同一个
// 分组内 GET 和 POST/PATCH 是否套壳并不一致（比如 `GET /api/projects` 直接是
// ProjectListResponse，`GET /api/projects/:slug` 却是 `{project: ProjectSummary}`），
// 没法从路径/方法机械可靠地推断，所以宁可只标一小撮验证过的路由，其余一律
// `dict[str, Any]`——标错的类型提示比没有类型提示更糟。
const VERIFIED_RETURN_TYPES: Record<string, string> = {
  "GET /api/projects": "ProjectListResponse",
  "GET /api/records": "RecordTimelinePage",
  "GET /api/records/:id": "RecordDetailResponse",
  "GET /api/records/:id/graph": "RecordGraphResponse",
  "GET /api/lineage/:versionId": "LineageResponse",
  "GET /api/artifacts": "ArtifactListResponse",
  "POST /api/chat": "ChatResponse",
  "GET /api/tasks/:id": "TaskResponse",
};

function returnTypeFor(route: ContractRoute, knownTypes: Set<string>): string {
  const key = `${route.method} ${route.path}`;
  const guess = VERIFIED_RETURN_TYPES[key];
  if (guess && knownTypes.has(guess)) return guess;
  return "dict[str, Any]";
}

function renderMethod(route: ContractRoute, knownTypes: Set<string>): string {
  const name = buildMethodName(route);
  const tpl = buildPathTemplate(route);
  const returnType = returnTypeFor(route, knownTypes);
  const pathExpr = pyFString(tpl);
  const pathParams = tpl.paramNames.map((p) => `${p}: str`);
  if (route.method === "GET") {
    const sig = ["self", ...pathParams, "**params: Any"].join(", ");
    return [
      `    def ${name}(${sig}) -> ${returnType}:`,
      `        """GET ${route.path}"""`,
      `        return self.request("GET", ${pathExpr}, params=params)`,
    ].join("\n");
  }
  const sig = ["self", ...pathParams, "body: dict[str, Any] | None = None"].join(", ");
  return [
    `    def ${name}(${sig}) -> ${returnType}:`,
    `        """${route.method} ${route.path}"""`,
    `        return self.request("${route.method}", ${pathExpr}, body=body)`,
  ].join("\n");
}

export function renderGeneratedPy(contract: RuntimeContract): string {
  const routes = contract.http.routes;
  const knownTypes = new Set(Object.keys(contract.definitions ?? {}));

  const names = routes.map(buildMethodName);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`gen-sdk-python: 方法名撞车（契约路由变了，命名规则要跟着改）: ${[...new Set(dupes)].join(", ")}`);
  }

  const header = `"""自动生成，勿手改——来源：\`http.routes\`（\`spark-research contract --json\`）。

一条契约路由一个方法，方法名 = \`<group>_<verb>_<路径段>\`（路径参数变 \`by_<name>\`）。
改法：不要编辑本文件，改 \`scripts/gen-sdk-python.ts\` 后跑 \`bun run gen:sdk\` 重新生成。
门禁 \`tests/unit/w8_sdk_generated.test.ts\` 钉住幂等性 + 路由数 == 方法数。
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._types import *  # noqa: F401,F403


class GeneratedClient:
    """由契约生成的 HTTP 方法集合。\`Client\`（见 client.py）继承它并提供真正的 \`request()\`。"""

    def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, body: Any = None) -> Any:
        raise NotImplementedError  # Client 覆写

`;
  const body = routes.map((r) => renderMethod(r, knownTypes)).join("\n\n");
  return header + body + "\n";
}

// ── 4. main ────────────────────────────────────────────────────────────────

function main(): void {
  const check = process.argv.includes("--check");
  const contract = getContract();
  const generated = renderGeneratedPy(contract);
  const types = renderTypesPy(contract);

  if (check) {
    const curGenerated = existsSync(GENERATED_PY) ? readFileSync(GENERATED_PY, "utf8") : null;
    const curTypes = existsSync(TYPES_PY) ? readFileSync(TYPES_PY, "utf8") : null;
    const ok = curGenerated === generated && curTypes === types;
    if (!ok) {
      console.error("gen-sdk-python --check: 生成物与仓库不一致，运行 `bun run gen:sdk` 重新生成。");
      process.exitCode = 1;
      return;
    }
    console.log("gen-sdk-python --check: 一致。");
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(GENERATED_PY, generated);
  writeFileSync(TYPES_PY, types);
  console.log(`写入 ${GENERATED_PY}`);
  console.log(`写入 ${TYPES_PY}`);
  console.log(`路由数 ${contract.http.routes.length} == 方法数 ${contract.http.routes.length}`);
}

if (import.meta.main) main();
