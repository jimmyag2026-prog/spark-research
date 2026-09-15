#!/usr/bin/env bun
// lane β-3 前置 · 在用模型名盘点（v0.9，USAGE_LOG U5）。
//
// 为什么这个脚本必须先于 β-3 主体跑：β-3 把 `providerForModel()` 结尾的
// `return "kimi"`（认不出一律当 Kimi）改成抛错。改完之后，**任何正在被使用、
// 但没有显式登记的模型名会当场失败**。U5 的「风险」段写得很清楚：
//   「改成抛错后，如果有人正在用某个未登记但恰好能跑的模型，会当场失败。
//     所以这条要配一次全量模型名盘点，把在用的都补登记。」
// 所以：先跑这个脚本 → 看哪些在用的名字落在「关键词兜底」或「默认兜底」上
// → 把它们补进 registry.ts 的单价表（= β-3 之后唯一的模型真源）→ 再改抛错。
//
// 扫描面（只读，绝不写任何东西）：
//   ① `<dataDir>/config.json` 的 `defaultModel` / `subAgentModel_*` / `embeddingModel`
//   ② `<dataDir>/projects/*/usage.jsonl` 里出现过的全部 `model` 值（带出现次数与
//      台账里记的 provider——台账记的是**实际发出那次调用**的 provider，与静态
//      `providerForModel()` 的判断对不上就是一处漂移证据）
//
// 用法：
//   bun scripts/inventory-model-names.ts            # Markdown 表格（贴进 devlog）
//   bun scripts/inventory-model-names.ts --json     # 结构化输出
//   bun scripts/inventory-model-names.ts --root <dir>   # 指定数据目录（默认 ~/.spark-research）
//
// 凭据安全：只读 `model` / `provider` 字段与 config.json 里的模型名键，
// 不读也不打印 credentials.json、不打印 config.json 的任何 `*_API_KEY`。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRICING } from "../backend/src/llm/providers/registry";
import { PROVIDER_MODELS, SUPPORTED_PROVIDERS, providerForModel, type Provider } from "../backend/src/llm/router";

/** 名字是怎么被路由到 provider 的——三档，后两档就是 U5 说的「静默」。 */
export type RoutingKind =
  | "explicit" // PROVIDER_MODELS 里显式登记
  | "keyword" // 关键词兜底（低保真：靠模型名里含 kimi/gpt/claude/deepseek/qwen）
  | "default" // 最终 `return "kimi"`：完全认不出，当 Kimi 发请求（U5 的核心缺陷）
  | "local"; // `local/` 前缀显式路由到本地端点，不经 providerForModel 的字典

export interface ModelUsageRow {
  model: string;
  /** 出现在哪些地方：config 键名 / `usage:<project>` 。 */
  sources: string[];
  /** usage.jsonl 里的调用次数（config-only 的名字为 0）。 */
  calls: number;
  /** 台账里实际记下的 provider（可能多个——同名模型被路由到过不同 provider 就是漂移）。 */
  ledgerProviders: string[];
  /** 现行 `providerForModel()` 的判断。 */
  routedTo: Provider | "local";
  kind: RoutingKind;
  /** 单价表里有没有它（β-3 之后这就是「登记与否」的唯一判据）。 */
  priced: boolean;
}

const LOCAL_PREFIX = /^local[/:]/;

/** 复刻 `providerForModel()` 的三档判据——**只为分类报告**，不参与任何路由决策。 */
export function classify(model: string): { routedTo: Provider | "local"; kind: RoutingKind } {
  if (LOCAL_PREFIX.test(model)) return { routedTo: "local", kind: "local" };
  for (const provider of SUPPORTED_PROVIDERS) {
    if (PROVIDER_MODELS[provider].includes(model)) return { routedTo: provider, kind: "explicit" };
  }
  const low = model.toLowerCase();
  const keyword: Array<[boolean, Provider]> = [
    [low.includes("kimi") || low.includes("moonshot"), "kimi"],
    [low.includes("gpt") || low.includes("o4"), "openai"],
    [low.includes("claude"), "anthropic"],
    [low.includes("deepseek"), "deepseek"],
    [low.includes("qwen"), "qwen"],
  ];
  for (const [hit, provider] of keyword) if (hit) return { routedTo: provider, kind: "keyword" };
  // 落到这里 = router.ts 的 `return "kimi"`。用 providerForModel 复核一次，
  // 万一将来那行改了（β-3 就是要改它），这里会立刻不一致而不是继续报旧结论。
  let routedTo: Provider | "local";
  try {
    routedTo = providerForModel(model);
  } catch {
    // β-3 落地后未登记名会抛错——分类报告不该因此中断。
    return { routedTo: "local", kind: "default" };
  }
  return { routedTo, kind: "default" };
}

export function pricedModels(): Set<string> {
  const out = new Set<string>();
  for (const models of Object.values(PRICING)) for (const m of Object.keys(models)) out.add(m);
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function inventory(root: string): ModelUsageRow[] {
  const rows = new Map<string, ModelUsageRow>();
  const priced = pricedModels();
  const touch = (model: string): ModelUsageRow => {
    let row = rows.get(model);
    if (!row) {
      const { routedTo, kind } = classify(model);
      row = { model, sources: [], calls: 0, ledgerProviders: [], routedTo, kind, priced: priced.has(model) };
      rows.set(model, row);
    }
    return row;
  };

  // ① config.json
  const config = readJson(join(root, "config.json"));
  if (config) {
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== "string" || !value) continue;
      if (key === "defaultModel" || key === "embeddingModel" || key.startsWith("subAgentModel_")) {
        const row = touch(value);
        if (!row.sources.includes(`config:${key}`)) row.sources.push(`config:${key}`);
      }
    }
  }

  // ② projects/*/usage.jsonl
  const projectsDir = join(root, "projects");
  if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir)) {
      const ledger = join(projectsDir, slug, "usage.jsonl");
      if (!existsSync(ledger) || !statSync(ledger).isFile()) continue;
      for (const line of readFileSync(ledger, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let entry: { model?: unknown; provider?: unknown };
        try {
          entry = JSON.parse(line) as { model?: unknown; provider?: unknown };
        } catch {
          continue; // 半行/损坏行跳过，不让一条坏记录中断整次盘点
        }
        if (typeof entry.model !== "string" || !entry.model) continue;
        const row = touch(entry.model);
        row.calls++;
        const src = `usage:${slug}`;
        if (!row.sources.includes(src)) row.sources.push(src);
        if (typeof entry.provider === "string" && entry.provider && !row.ledgerProviders.includes(entry.provider)) {
          row.ledgerProviders.push(entry.provider);
        }
      }
    }
  }

  return [...rows.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

const KIND_LABEL: Record<RoutingKind, string> = {
  explicit: "显式登记",
  keyword: "关键词兜底",
  default: "默认兜底（→kimi）",
  local: "local/ 显式前缀",
};

function markdown(rows: ModelUsageRow[], root: string): string {
  const lines: string[] = [];
  lines.push(`数据目录：\`${root}\` · 模型名 ${rows.length} 个`);
  lines.push("");
  lines.push("| 模型名 | 调用次数 | 出现在 | 现行路由 | 判据 | 单价表 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    const ledger = r.ledgerProviders.length ? `（台账记 ${r.ledgerProviders.join("/")}）` : "";
    lines.push(
      `| \`${r.model}\` | ${r.calls} | ${r.sources.join(" · ") || "—"} | ${r.routedTo}${ledger} | ${KIND_LABEL[r.kind]} | ${r.priced ? "有" : "**无**"} |`,
    );
  }
  const risky = rows.filter((r) => r.kind !== "explicit" && r.kind !== "local" && !r.priced);
  lines.push("");
  if (risky.length === 0) {
    lines.push("**β-3 影响面：无。** 在用的模型名全部显式登记或已在单价表里，改抛错不会打断任何人。");
  } else {
    lines.push(
      `**β-3 影响面：${risky.length} 个在用模型名靠兜底命中且不在单价表里**——` +
        `改抛错前必须补登记，否则这些名字会当场失败：`,
    );
    for (const r of risky) lines.push(`- \`${r.model}\`（${KIND_LABEL[r.kind]} → ${r.routedTo}，${r.calls} 次调用）`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf("--root");
  const root =
    rootIdx >= 0 && argv[rootIdx + 1]
      ? argv[rootIdx + 1]!
      : process.env.SPARK_RESEARCH_DATA_DIR || join(homedir(), ".spark-research");
  const rows = inventory(root);
  console.log(argv.includes("--json") ? JSON.stringify({ root, models: rows }, null, 2) : markdown(rows, root));
}
