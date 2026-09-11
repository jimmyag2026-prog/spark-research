import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_SETTINGS } from "../../backend/src/config";
import { CLI_COMMANDS, extractUsage } from "../../backend/src/contract/cli_registry";
import { buildContract, renderContractJson } from "../../backend/src/contract";
import { runContractCommand } from "../../backend/src/contract/cli";
import { MANIFEST_SCHEMA_VERSION } from "../../backend/src/data/manifest";
import { MCP_TOOLS } from "../../backend/src/mcp/tools";
import { SCHEMA_OUTPUT, renderSchemas } from "../../scripts/gen-contract-schemas";

// W8-2 · runtime contract 门禁（DEVELOPMENT_PLAN_v0.8.md §四：契约与真源对撞，AD-12 第 10 条）。
// 阴性对照（已验红，见 docs/devlog/W8-2-contract.md（文件名 runtime_contract：仓库已有 contract.test.ts 是扩展契约验收的））：
//   · index.ts 删一个 case → 第 1 条红   · MCP_TOOLS 删一个工具 → 第 3 条红
//   · 改 server/types.ts 不重跑生成器 → 第 6 条红

const REPO = join(import.meta.dir, "../..");

function mainSwitchCases(): Set<string> {
  const src = readFileSync(join(REPO, "backend/src/index.ts"), "utf8");
  const start = src.indexOf("const cmd = process.argv[2];");
  const end = src.indexOf("if (import.meta.main)");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  const cases = new Set<string>();
  for (const m of body.matchAll(/^\s*case "([^"]+)":/gm)) cases.add(m[1]!);
  // `case undefined:`（零参数 = welcome）没有字符串标签，用 welcome 代表
  return cases;
}

describe("contract · CLI 半边与 index.ts 主 switch 对撞", () => {
  test("注册表的命令∪别名 == index.ts 主 switch 的 case 集合（逐项相等，多一少一都红）", () => {
    const fromIndex = mainSwitchCases();
    const fromRegistry = new Set<string>();
    for (const c of CLI_COMMANDS) {
      fromRegistry.add(c.command);
      for (const a of c.aliases) fromRegistry.add(a);
    }
    const onlyIndex = [...fromIndex].filter((c) => !fromRegistry.has(c)).sort();
    const onlyRegistry = [...fromRegistry].filter((c) => !fromIndex.has(c)).sort();
    expect({ onlyIndex, onlyRegistry }).toEqual({ onlyIndex: [], onlyRegistry: [] });
  });

  test("没有独立 HELP 的命令：登记的 usage 行必须逐字出现在 index.ts 主 HELP 里（不许编）", () => {
    const src = readFileSync(join(REPO, "backend/src/index.ts"), "utf8");
    for (const c of CLI_COMMANDS) for (const line of c.usage ?? []) expect(src).toContain(line);
  });

  test("extractUsage：子命令、位置参数、旗标（含缩进说明行里的旗标）确定性提取", () => {
    const help = `用法:
  spark-research demo plan --purpose "<x>" [--json] -- <argv...>
                                 说明
      --target local|modal       执行地
      --upload <相对路径>         可重复
  spark-research demo approve <jobId> [--actor 谁] [--run]
`;
    const entries = extractUsage(help, "demo");
    expect(entries.map((e) => e.subcommand)).toEqual(["approve", "plan"]);
    expect(entries.find((e) => e.subcommand === "plan")!.flags).toEqual(["--json", "--purpose", "--target", "--upload"]);
    expect(entries.find((e) => e.subcommand === "approve")!.positionals).toEqual(["<jobId>"]);
    expect(extractUsage(help, "demo")).toEqual(entries); // 幂等
  });

  test("每个带 HELP 的命令至少提取出一条用法行；lit 的子命令级 HELP 合并进去", () => {
    const contract = buildContract();
    for (const c of contract.cli.commands) {
      const spec = CLI_COMMANDS.find((s) => s.command === c.command)!;
      if (spec.help) expect(c.usages.length).toBeGreaterThan(0);
    }
    const lit = contract.cli.commands.find((c) => c.command === "lit")!;
    const review = lit.usages.find((u) => u.subcommand === "review")!;
    expect(review.flags).toContain("--budget-usd"); // 只在子命令 HELP 里出现
    expect(review.flags).toContain("--allow-unpriced");
  });
});

describe("contract · MCP / HTTP / 配置 / manifest", () => {
  test("MCP 工具名与 inputSchema 与 MCP_TOOLS 逐项相等", () => {
    const contract = buildContract();
    const expected = [...MCP_TOOLS].map((t) => t.name).sort();
    expect(contract.mcp.tools.map((t) => t.name)).toEqual(expected);
    for (const t of contract.mcp.tools) {
      const src = MCP_TOOLS.find((x) => x.name === t.name)!;
      expect(t.inputSchema).toEqual(src.inputSchema);
      expect(t.longRunning).toBe(src.longRunning === true);
    }
  });

  test("MCP 是 HTTP 的投影：每个工具 request() 出来的 method+path 都命中契约里的某条路由", () => {
    const contract = buildContract();
    const routes = contract.http.routes.map((r) => ({
      method: r.method,
      re: new RegExp("^" + r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+") + "$"),
    }));
    const dummyFor = (schema: Record<string, unknown>): unknown => {
      if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
      switch (schema.type) {
        case "string":
          return Array.isArray(schema.enum) ? schema.enum[0] : "x";
        case "number":
        case "integer":
          return 1;
        case "boolean":
          return true;
        case "array":
          return [];
        default:
          return {};
      }
    };
    const misses: string[] = [];
    for (const tool of MCP_TOOLS) {
      const schema = tool.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) args[k] = dummyFor(v);
      const req = tool.request(args);
      const path = req.path.split("?")[0]!;
      const hit = routes.some((r) => r.method === req.method && r.re.test(path));
      if (!hit) misses.push(`${tool.name} → ${req.method} ${path}`);
    }
    expect(misses).toEqual([]);
  });

  test("HTTP 路由：≥ 70 条、无重复、全部排序、含 /api/health 与 lit/projects/data 组", () => {
    const contract = buildContract();
    const keys = contract.http.routes.map((r) => `${r.method} ${r.path}`);
    expect(keys.length).toBeGreaterThanOrEqual(70);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("GET /api/health");
    const groups = new Set(contract.http.routes.map((r) => r.group));
    for (const g of ["lit", "projects", "ideas", "experiments", "lab", "compute", "records", "usage"]) expect(groups.has(g)).toBe(true);
    expect([...contract.http.routes].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))).toEqual(contract.http.routes);
  });

  test("配置项键集合 == CONFIG_SETTINGS；凭据项不带值", () => {
    const contract = buildContract();
    expect(contract.config.settings.map((s) => s.key).sort()).toEqual(CONFIG_SETTINGS.map((s) => s.key).sort());
    const secrets = contract.config.settings.filter((s) => s.secret);
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) expect(s.defaultValue).toBeNull();
    expect(JSON.stringify(contract)).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });

  test("manifest schema：schemaVersion const == MANIFEST_SCHEMA_VERSION，必填字段齐全", () => {
    const contract = buildContract();
    const ref = contract.data.manifestSchema as { $ref: string };
    const def = contract.definitions[ref.$ref.replace("#/definitions/", "")] as { properties: Record<string, unknown>; required: string[] };
    expect((def.properties.schemaVersion as { const: number }).const).toBe(MANIFEST_SCHEMA_VERSION);
    for (const k of ["share", "generator", "createdAt", "range", "forSharing", "prevManifestHash", "dcat", "schemas", "licenses", "provenanceClasses", "excluded", "rootHash", "files"]) {
      expect(def.required).toContain(k);
    }
  });

  test("schemas.generated.json 与源类型一致（重新生成逐字节相等——改了 server/types.ts / data/manifest.ts 要重跑生成器）", () => {
    const committed = readFileSync(join(REPO, SCHEMA_OUTPUT), "utf8");
    expect(renderSchemas(REPO) === committed, `${SCHEMA_OUTPUT} 过期——请跑 bun scripts/gen-contract-schemas.ts 后提交`).toBe(true);
  });
});

describe("contract · 确定性与 CLI", () => {
  test("两次 buildContract 输出逐字节相等（无时间戳、全排序）", () => {
    expect(renderContractJson(buildContract())).toBe(renderContractJson(buildContract()));
  });

  test("contract --json 可解析；--write 落盘；无参数打计数", async () => {
    const out: string[] = [];
    expect(await runContractCommand(["--json"], { out: (l) => out.push(l), err: () => {} })).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.contractVersion).toBe(1);
    expect(parsed.cli.commands.some((c: { command: string }) => c.command === "contract")).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "contract-"));
    const file = join(dir, "nested", "contract.json");
    expect(await runContractCommand(["--write", file], { out: () => {}, err: () => {} })).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(parsed.version);
    const summary: string[] = [];
    expect(await runContractCommand([], { out: (l) => summary.push(l), err: () => {} })).toBe(0);
    expect(summary.join("\n")).toContain("HTTP 路由");
    const errs: string[] = [];
    expect(await runContractCommand(["--write"], { out: () => {}, err: (l) => errs.push(l) })).toBe(1);
    expect(errs.join("\n")).toContain("--write");
  });
});
