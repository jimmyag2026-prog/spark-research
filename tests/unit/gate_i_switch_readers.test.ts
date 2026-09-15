import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// 闸门 I · 形状 ③：类型上的行为开关字段必须有读取点（AD-17，v0.9）。
//
// 形状来源（BACKLOG V137）：`LlmError.retryable` 与 `CallOptions.maxRetries` 都定义了、
// 也都被赋值了，但 `router.ts` 从来没读过——整个代码库里没有任何重试循环。与 V40
// （配置项只写不读，`config_reader_parity` 抓）和 U10（函数参数声明了不读，
// `gate_i_param_readers` 抓）是同一个病的三个部位。
//
// 判据（如实说明能力边界）：
// - 扫描对象：`backend/src/llm/types.ts` 里**所有** boolean / number（含 `| null`）字段，
//   自动解析、不手写清单——新增字段自动入网。
// - 「读者」= 在 backend/src（types.ts 自身除外）出现 `.field` 且**不是**下面三种写法：
//     ① 赋值 / 对象字面量键：`.field =`、`field:`（这是写，不是读）
//     ② **同名转发**：`field: x.field`——把值原样抄进另一个**同形**对象，没有任何分支依赖它。
//        V137 时 `retryable` 在 embeddings 子树里就有两处这种转发（`retryable: response.error.retryable`），
//        看起来像有读者，实际上仍然没有任何地方据此决定重不重试。同名转发不算读。
//        **异名映射算读**：`max_tokens: options.maxTokens` 是把值送进请求体，provider 会消费它——
//        第一版把所有转发都排除，误杀了 maxTokens；收紧为「只排除同名」。
//     ③ 注释里的提及（先剥注释再匹配）。
//   另外承认解构读法：`const { field } = x`。
// - 抓得到「声明了没人读」；抓不到「读了但没起作用」（那要跑起来才知道，是 lane β
//   那条「无 key provider 必失败」门禁的活）。也抓不到跨文件同名字段的误归属——
//   文本级启发式，字段名撞车时会高估读者数（宁可漏报不误报的方向）。
//   **已知的一处误归属，如实记**：`anthropic.ts` 里 `const { kind, retryable } = classifyHttpError(...)`
//   是解构 classify 的返回值，不是读 `LlmError.retryable`；本测试会把它算成读者，
//   所以 v0.8.0 上 `retryable` **不进**红名单。V137 的历史对照由 `maxRetries` 承担。
// - 历史阴性对照：本测试在 `v0.8.0`（644cccd）检出上**必须红**，红名单至少含 maxRetries（V137）；
//   同时首次运行即抓到三个新的同族：`ProviderCapabilities` 的 toolCalling / streaming / usageReported
//   （router.ts:123 构造、无人消费）——进 I-3 盘点。闸门 H（PR #109）合入后 maxRetries 转绿。

const BACKEND_SRC = join(import.meta.dir, "../../backend/src");
const TYPES = join(BACKEND_SRC, "llm/types.ts");

/** 故意留空的字段：必须写清为什么没有读者是合理的。空字符串不算登记。 */
const ALLOWLIST: Record<string, string> = {
  // 例：`LlmUsage.costUsd`：只由记账层写、由 usage 读侧消费——不在这里登记，因为它有读者。
  // ---- v0.9 闸门 I-3 盘点（2026-09-14，main@644cccd 首跑抓到；alpha.2 前必须移除，否则陈旧检查红）----
  streaming: "V143：ProviderCapabilities 三字段之一，router.ts:123 构造、无人消费。lane α-1 看门狗只对 streaming 生效，接线后移除",
  usageReported: "V143：同上。lane α-4 用它区分「上游没返 usage」与「查不到单价」，接线后移除",
  toolCalling: "V143：同上。子代理 tool loop 提供工具前应核一次；归收口接线（sub_agent.ts），接线后移除",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** 从 types.ts 抓所有 `name?: boolean|number(|null)` 字段名（去重）。 */
function switchFields(): string[] {
  const src = stripComments(readFileSync(TYPES, "utf8"));
  const re = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\??:\s*(?:boolean|number)(?:\s*\|\s*null)?\s*;/gm;
  const names = new Set<string>();
  for (const m of src.matchAll(re)) names.add(m[1]!);
  return [...names].sort();
}

function readerCount(field: string, files: string[]): { count: number; where: string[] } {
  const dot = new RegExp(`\\.${field}\\b(?!\\s*[:=?])`, "g");
  // 同名转发：`field: x.field` / `field: x?.field`（键名 == 字段名，值是对该字段的成员访问）。
  // 异名映射（`max_tokens: opts.maxTokens`）不在此列，算读。
  const forward = new RegExp(`(?<![A-Za-z0-9_])${field}\\s*:\\s*[A-Za-z_][A-Za-z0-9_.?]*\\.${field}\\b`, "g");
  const destructure = new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`, "g");
  let count = 0;
  const where: string[] = [];
  for (const f of files) {
    if (f === TYPES) continue;
    const t = stripComments(readFileSync(f, "utf8"));
    const dots = (t.match(dot) ?? []).length;
    const fwd = (t.match(forward) ?? []).length;
    const des = (t.match(destructure) ?? []).length;
    const n = Math.max(0, dots - fwd) + des;
    if (n > 0) {
      count += n;
      where.push(`${relative(BACKEND_SRC, f)} ×${n}`);
    }
  }
  return { count, where };
}

describe("闸门 I · 形状 ③ · llm/types.ts 的行为开关字段必须有读者（AD-17）", () => {
  const files = walk(BACKEND_SRC);
  const fields = switchFields();

  test("扫描面非空：types.ts 里能解析出 boolean/number 字段", () => {
    expect(fields.length).toBeGreaterThan(5);
  });

  test("每个开关字段在 backend/src 里至少有一个真实读者（转发与注释不算）", () => {
    const orphans = fields.filter((f) => readerCount(f, files).count === 0);
    const unregistered = orphans.filter((f) => !(f in ALLOWLIST) || !ALLOWLIST[f]!.trim());
    expect(
      unregistered,
      `这些字段声明了、可能也被赋值了，但没有任何读取点（V137 形状）。\n` +
        `要么给它接上生产读者，要么删掉声明，要么在 ALLOWLIST 里登记并写清理由：\n  ${unregistered.join("\n  ")}`,
    ).toEqual([]);
  });

  test("ALLOWLIST 不许陈旧：登记了的字段一旦有了读者就必须移除", () => {
    const stale = Object.keys(ALLOWLIST).filter((f) => !fields.includes(f) || readerCount(f, files).count > 0);
    expect(stale, `这些条目已不再是孤儿或已不存在，请从 ALLOWLIST 移除：\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  test("判据自检：同名转发不算读者，异名映射与分支判断算", () => {
    const count = (src: string, field: string) => {
      const dot = new RegExp(`\\.${field}\\b(?!\\s*[:=?])`, "g");
      const forward = new RegExp(`(?<![A-Za-z0-9_])${field}\\s*:\\s*[A-Za-z_][A-Za-z0-9_.?]*\\.${field}\\b`, "g");
      return (src.match(dot) ?? []).length - (src.match(forward) ?? []).length;
    };
    // 与真实 V137 同形：只有 `retryable: x.retryable` 这种同名转发时，读者数必须是 0。
    expect(count("const a = { retryable: err.retryable };\nconst b = { retryable: res.error.retryable };", "retryable")).toBe(0);
    // 真读：分支判断必须算 1。
    expect(count("if (err.retryable) retry();", "retryable")).toBe(1);
    // 异名映射：值被送进另一形状的对象（请求体），必须算 1——第一版误杀了 maxTokens。
    expect(count("const body = { max_tokens: opts.maxTokens };", "maxTokens")).toBe(1);
  });
});
