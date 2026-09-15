#!/usr/bin/env bun
// R6 基线测量（v0.9 W9-2-2，任务书 docs/taskbooks/v0.9/R6_A8.md §基线）。
//
// 对若干项目各跑同一条**写死的** chat 消息 N 轮，报三个数：
//   ① 墙钟 P50 / P90（POST /api/session/chat 发出 → 200 返回）
//   ② 每轮模型调用次数（跑前后 usage.jsonl 行数差）
//   ③ 失败占比与 errorKind 分布（新增行里 ok:false 的比例；errorKind 字段 α-4 落地前为空）
//
// 口径：
//  - 消息文本不随版本变，跨版本可比；每轮新起 sessionId，避免会话记忆污染。
//  - 先过网络前提（openrouter time_connect 五次中位 < 1s 且最大 < 3s），不达标直接退出并打印五个数，**不建基线**。
//  - 每轮带 --budget-usd，预算上限由 --budget 控制（默认 0.30 美元/全部）。
//  - 输出 Markdown 表 + 原始 usage.jsonl 新增行（数字要能被复核），写到 --out。
//  - --dry-run 只做网络前提与项目/台账探测，不发任何模型调用（不花钱）。
//
// 用法：
//   bun scripts/measure-chat.ts --projects t1-protein-r3,t2-sc-r3 --rounds 5 --out docs/devlog/R6-baseline.md
//   bun scripts/measure-chat.ts --projects speed-probe --rounds 1 --dry-run

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MESSAGE = "用三句话说明什么是蛋白质的二级结构。"; // 冻结：跨版本不变
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "1" : process.argv[++i]!);
}
const base = args.get("base") ?? "http://127.0.0.1:4321";
const projects = (args.get("projects") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const rounds = Number(args.get("rounds") ?? 5);
const budgetUsd = Number(args.get("budget") ?? 0.3);
const out = args.get("out");
const dryRun = args.has("dry-run");
const dataDir = process.env.SPARK_RESEARCH_DATA_DIR ?? join(homedir(), ".spark-research");

if (projects.length === 0) {
  console.error("用法: bun scripts/measure-chat.ts --projects a,b --rounds 5 [--out file] [--budget 0.3] [--dry-run] [--base http://127.0.0.1:4321]");
  process.exit(2);
}

// ---------- 网络前提 ----------
async function connectTimes(host: string, n = 5): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const proc = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-m", "20", "-w", "%{time_connect}", host]);
    const v = Number(proc.stdout.toString().trim());
    times.push(Number.isFinite(v) && v > 0 ? v : 20);
  }
  return times;
}
const ct = await connectTimes("https://openrouter.ai");
const sorted = [...ct].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)]!;
const max = sorted[sorted.length - 1]!;
const netOk = median < 1 && max < 3;
console.log(`网络前提 openrouter time_connect: ${ct.map((t) => t.toFixed(2)).join(" / ")}s → 中位 ${median.toFixed(2)}s 最大 ${max.toFixed(2)}s → ${netOk ? "达标" : "不达标"}`);
if (!netOk) {
  console.log("不达标：不建基线。把上面五个数字写进报告，等网络达标再跑。");
  process.exit(3);
}

// ---------- 探测 server 与项目 ----------
const health = await fetch(`${base}/api/health`).then((r) => r.json() as Promise<{ version: string }>).catch(() => null);
if (!health) {
  console.error(`连不上 ${base}/api/health；先 spark-research server`);
  process.exit(4);
}
console.log(`server ${health.version} @ ${base}`);

function usagePath(slug: string): string {
  return join(dataDir, "projects", slug, "usage.jsonl");
}
function readUsage(slug: string): string[] {
  const p = usagePath(slug);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()) : [];
}
for (const slug of projects) {
  const r = await fetch(`${base}/api/projects/${encodeURIComponent(slug)}`).catch(() => null);
  if (!r || !r.ok) {
    console.error(`项目 ${slug} 不存在或读不到（HTTP ${r?.status ?? "-"}）`);
    process.exit(5);
  }
  console.log(`项目 ${slug}：台账现有 ${readUsage(slug).length} 行`);
}
if (dryRun) {
  console.log("--dry-run：不发模型调用，结束。");
  process.exit(0);
}

// ---------- 测量 ----------
type Row = { project: string; round: number; wallMs: number; calls: number; failed: number; kinds: Record<string, number>; http: number };
const rows: Row[] = [];
const rawAppend: string[] = [];
const perRoundBudget = Math.max(0.005, budgetUsd / (projects.length * rounds));

// 会话 → 项目的绑定走「当前项目」指针（UI 就是这么做的：POST /api/projects/current）。
// `/api/session/chat?project=` **不被读取**（首跑时 20 轮全记进了 speed-probe，调用数一律 0）——
// 已作为 U11 登记；这里先记住原来的当前项目，跑完改回去。
const originalCurrent = await fetch(`${base}/api/projects/current`)
  .then((r) => r.json() as Promise<{ project: { slug: string } }>)
  .then((j) => j.project.slug)
  .catch(() => null);
async function setCurrent(slug: string): Promise<void> {
  const r = await fetch(`${base}/api/projects/current`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (!r.ok) throw new Error(`切当前项目到 ${slug} 失败：HTTP ${r.status}`);
}
process.on("exit", () => {
  if (originalCurrent) console.log(`（当前项目已改回 ${originalCurrent}）`);
});

// `budgetUsd` 是**项目累计已知花费**的上限（不是本次调用的额度）：已知花费 + 在飞预留 + 本次估价 > 上限就拒。
// 课题项目上已经有几美分到几美元的历史花费，直接传 perRoundBudget 会 20 轮全被拒（HTTP 200、0 调用、0.0s）。
// 所以每轮取「该项目当前已知花费 + 本轮额度」——总额度语义不变，仍是 --budget 均摊。
async function knownCost(slug: string): Promise<number> {
  const j = (await fetch(`${base}/api/usage?project=${encodeURIComponent(slug)}`).then((r) => r.json())) as {
    totals?: { knownCostUsd?: number };
    knownCostUsd?: number;
  };
  return j.totals?.knownCostUsd ?? j.knownCostUsd ?? 0;
}

for (const slug of projects) {
  await setCurrent(slug);
  for (let r = 1; r <= rounds; r++) {
    const before = readUsage(slug);
    const cap = (await knownCost(slug)) + perRoundBudget;
    const t0 = performance.now();
    const res = await fetch(`${base}/api/session/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: `r6-${slug}-${r}-${Date.now()}`, message: MESSAGE, mode: "chat", budgetUsd: cap }),
    }).catch((e) => ({ status: 0, statusText: String(e) } as Response));
    const wallMs = performance.now() - t0;
    const after = readUsage(slug);
    const added = after.slice(before.length);
    let failed = 0;
    const kinds: Record<string, number> = {};
    for (const l of added) {
      try {
        const j = JSON.parse(l) as { ok?: boolean; errorKind?: string };
        if (j.ok === false) {
          failed++;
          const k = j.errorKind ?? "(未记录)";
          kinds[k] = (kinds[k] ?? 0) + 1;
        }
      } catch {
        /* 残行不计 */
      }
    }
    let gated = false;
    try {
      const bodyText = await res.text();
      gated = bodyText.includes("预算闸") && bodyText.includes("拒绝");
      if (gated) console.log(`  ⚠️ 本轮被预算闸拒绝（HTTP 仍是 200）：${bodyText.slice(0, 160).replace(/\n/g, " ")}`);
    } catch {
      /* 读不到 body 不影响计数 */
    }
    rows.push({ project: slug, round: r, wallMs, calls: added.length, failed: failed + (gated ? 1 : 0), kinds: gated ? { ...kinds, "(预算闸拒绝)": 1 } : kinds, http: res.status });
    rawAppend.push(`### ${slug} · 第 ${r} 轮（HTTP ${res.status}，${(wallMs / 1000).toFixed(1)}s，新增 ${added.length} 行）`, "```json", ...added, "```", "");
    console.log(`${slug} r${r}: HTTP ${res.status} 墙钟 ${(wallMs / 1000).toFixed(1)}s 调用 ${added.length} 失败 ${failed}`);
  }
}

if (originalCurrent) await setCurrent(originalCurrent).catch((e) => console.error(String(e)));

// ---------- 汇总 ----------
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)]!;
}
const lines: string[] = [];
lines.push(`# R6 基线 · ${new Date().toISOString()}`, "", `server ${health.version} · 消息「${MESSAGE}」· 每项目 ${rounds} 轮 · 网络前提 中位 ${median.toFixed(2)}s 最大 ${max.toFixed(2)}s（达标）`, "");
lines.push("| 项目 | 墙钟 P50 | 墙钟 P90 | 调用/轮 中位 | 调用/轮 最大 | 失败轮 | errorKind 分布 |", "|---|---:|---:|---:|---:|---:|---|");
for (const slug of projects) {
  const rs = rows.filter((x) => x.project === slug);
  const walls = rs.map((x) => x.wallMs / 1000);
  const calls = rs.map((x) => x.calls);
  const kinds: Record<string, number> = {};
  for (const x of rs) for (const [k, v] of Object.entries(x.kinds)) kinds[k] = (kinds[k] ?? 0) + v;
  lines.push(`| ${slug} | ${pct(walls, 50).toFixed(1)}s | ${pct(walls, 90).toFixed(1)}s | ${pct(calls, 50)} | ${Math.max(...calls)} | ${rs.filter((x) => x.failed > 0).length}/${rs.length} | ${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(" ") || "—"} |`);
}
lines.push("", "## 原始 usage.jsonl 新增行（可复核）", "", ...rawAppend);
const report = lines.join("\n");
console.log("\n" + lines.slice(0, 4 + projects.length).join("\n"));
if (out) {
  if (existsSync(out)) appendFileSync(out, "\n\n" + report);
  else writeFileSync(out, report);
  console.log(`\n已写 ${out}`);
}
