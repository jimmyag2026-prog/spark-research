import { join } from "node:path";
import { ProjectManager, ProjectError, openProjectResolved } from "../project/manager";
import { UsageStore } from "../usage/ledger";
import { ApiCallStore, apiCallStorePath, type ApiCallAgg } from "../usage/api_ledger";

// G-3（v0.6）：`spark-research usage`——用量台账的人类/机器出口。
//
// 这个 dispatcher 刻意独立成文件而不是塞进 index.ts 的 switch：
// W6-1 lane α（connector 调用台账）要加 `usage api` 子命令，独立文件让它只动这里、
// 不碰 index.ts 热点（v0.5 规划里三个共享文件热点的教训）。

export interface UsageCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const HELP = `用法: spark-research usage [--project <slug>] [--json]
       spark-research usage api [--json]

  不带子命令：显示本项目的 LLM 用量台账（usage.jsonl）：调用数、tokens、已知花费
  （下界）、按命令/模型的归因。成本未知的调用单独计数——**未知不等于免费**，
  有未知就不报确定总数。

  台账由 lit read / lit review / idea new / idea check 自动记录；
  配合 --budget-usd 使用时，预算闸按「已知花费下界」判停。

  usage api：显示 connector 调用台账（api_calls.jsonl，全局，不分项目——connector
  层没有项目概念）：按 connector / host 聚合的调用数、429/401 单列、其他非 2xx、
  平均/最大延迟。由 connectors/base.ts 的每次 HTTP 调用自动记录。`;

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

export async function runUsageCommand(args: string[], deps: UsageCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const { positional, flags } = parseFlags(args);

  if (flags.help === true || args.includes("-h") || positional[0] === "help") {
    out(HELP);
    return 0;
  }

  // W6-1 α：`usage api`——connector 调用台账，全局、不分项目，所以在这里、
  // 打开 ProjectManager **之前**分流，不走下面 --project 的解析路径。
  if (positional[0] === "api") {
    if (positional.length > 1) {
      err(`❌ 未知参数 'usage api ${positional[1]}'。用法：spark-research usage api [--json]`);
      return 1;
    }
    return runUsageApiCommand(flags.json === true, deps);
  }

  if (positional.length > 0) {
    err(`❌ 未知子命令 'usage ${positional[0]}'。当前有 (默认视图) / api；用 spark-research usage --help 看用法。`);
    return 1;
  }

  const manager = deps.manager ?? new ProjectManager(deps.root);
  let project;
  try {
    const slug = flagString(flags.project);
    project = openProjectResolved(manager, slug);
  } catch (error) {
    if (error instanceof ProjectError) {
      err(`❌ ${error.message}`);
      err("下一步：spark-research project new <名称> 建项目，或 --project <slug> 指定已有项目。");
      return 1;
    }
    throw error;
  }

  try {
    const store = new UsageStore(join(project.paths.root, "usage.jsonl"));
    const totals = store.totals();
    const corrupt = store.corruptLines();

    if (flags.json === true) {
      out(JSON.stringify({ project: project.slug, ...totals, corruptLines: corrupt }, null, 2));
      return 0;
    }

    out(`📒 用量台账 · 项目 ${project.slug}`);
    if (totals.calls === 0) {
      out("  还没有 LLM 用量记录。lit read / lit review / idea new / idea check 的调用会自动入账。");
      return 0;
    }
    out(`  LLM 调用 ${totals.calls} 次 · 输入 ${totals.inputTokens} tokens · 输出 ${totals.outputTokens} tokens`);
    out(`  已知花费（下界）${fmtUsd(totals.knownCostUsd)}`);
    if (totals.unknownCostCalls > 0) {
      out(
        `  ⚠️ 其中 ${totals.unknownCostCalls} 次调用成本未知（拿不到 usage 或查不到单价）——` +
          `总花费无法确定报出，上面的数只是下界。`,
      );
      if (totals.unpricedCalls > 0) {
        out(`  ⚠️ 其中 ${totals.unpricedCalls} 次是 --allow-unpriced 放行的无单价模型调用（预算闸对它们不计价）。`);
      }
    }
    out("  按命令:");
    for (const [cmd, t] of Object.entries(totals.byCommand)) {
      out(`    ${cmd}: ${t.calls} 次 · ${fmtUsd(t.knownCostUsd)}${t.unknownCostCalls > 0 ? ` · ${t.unknownCostCalls} 次未知` : ""}`);
    }
    out("  按模型:");
    for (const [mdl, t] of Object.entries(totals.byModel)) {
      out(`    ${mdl}: ${t.calls} 次 · ${fmtUsd(t.knownCostUsd)}${t.unknownCostCalls > 0 ? ` · ${t.unknownCostCalls} 次未知` : ""}`);
    }
    if (corrupt > 0) {
      out(`  ⚠️ 台账文件有 ${corrupt} 行无法解析（文件可能被手工改过），以上统计不含这些行。`);
    }
    return 0;
  } finally {
    project.close();
  }
}

function fmtMs(v: number): string {
  return `${Math.round(v)}ms`;
}

function printApiAggTable(out: (line: string) => void, label: string, rows: Record<string, ApiCallAgg>): void {
  out(`  按${label}:`);
  const names = Object.keys(rows);
  if (names.length === 0) {
    out("    (无记录)");
    return;
  }
  for (const name of names) {
    const agg = rows[name]!;
    out(
      `    ${name}: ${agg.calls} 次 · 429×${agg.count429} · 401×${agg.count401} · ` +
        `其他非2xx×${agg.otherNon2xx} · 平均 ${fmtMs(agg.avgLatencyMs)} · 最大 ${fmtMs(agg.maxLatencyMs)}`,
    );
  }
}

// W6-1 α：`usage api` 的实现。**没有 --project**——connector 调用台账是全局的
// （见 usage/api_ledger.ts 顶部注释：connector 层没有项目概念，不该在这一层猜）。
// `deps.root` 只用于单测隔离，与 ProjectManager 的 root 是两回事，恰好复用同一个
// 字段名——同 server/context.ts 的 TaskRegistry 那条「deps.root 替身 dataDir()」惯例。
export function runUsageApiCommand(json: boolean, deps: UsageCliDeps = {}): number {
  const out = deps.out ?? ((line: string) => console.log(line));
  const store = new ApiCallStore(apiCallStorePath(deps.root ? { root: deps.root } : {}));
  const totals = store.totals();
  const corrupt = store.corruptLines();

  if (json) {
    out(JSON.stringify({ ...totals, corruptLines: corrupt }, null, 2));
    return 0;
  }

  out("📡 connector 调用台账（全局，不分项目）");
  if (totals.calls === 0) {
    out("  还没有 API 调用记录。任意 connector 发起的 HTTP 请求都会自动入账。");
    return 0;
  }
  out(
    `  调用 ${totals.calls} 次 · 429×${totals.count429} · 401×${totals.count401} · ` +
      `其他非2xx×${totals.otherNon2xx} · 平均延迟 ${fmtMs(totals.avgLatencyMs)} · 最大延迟 ${fmtMs(totals.maxLatencyMs)}`,
  );
  printApiAggTable(out, "connector", totals.byConnector);
  printApiAggTable(out, "host", totals.byHost);
  if (corrupt > 0) {
    out(`  ⚠️ 台账文件有 ${corrupt} 行无法解析（文件可能被手工改过），以上统计不含这些行。`);
  }
  return 0;
}
