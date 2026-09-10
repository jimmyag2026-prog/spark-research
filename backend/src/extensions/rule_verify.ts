// W2-c · `ext verify` 对 kind="rule" 的契约化验收。
//
// 任务书原话：「纯函数性检查：零 IO、确定性（同输入两次同输出）、无外部状态」。
// 规则的契约形状照抄 `backend/src/lab/safety.ts` 的 `SafetyRule`（本文件不 import
// 那个类型——lab/safety.ts 不在本 lane 名下——只是结构上对齐，鸭子类型足够）：
//   { id: string; check: string; description: string; evaluate(input): { check, passed, detail? } }
//
// 「零 IO」**验不出"绝对没有"**，只能验"源码里没有明显的 IO 原语"（静态扫描）——
// 这与「不是沙箱」的诚实表述一致：扫描挡得住"忘了/没注意到用了 fs"，挡不住
// 存心用 `globalThis["fe" + "tch"]` 这类拼接绕过静态扫描的恶意代码。

import { readFileSync } from "node:fs";
import type { VerifyCheck } from "./connector_verify";

export interface RuleVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

interface RuleLike {
  id: string;
  check: string;
  description: string;
  evaluate: (input: unknown) => unknown;
}

// 静态扫描：源码文本里出现这些 token 就当作「疑似有 IO」——宁可假阳性（要求作者
// 说明为什么这不是真的 IO），不要假阴性。
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+["']node:(fs|net|http|https|child_process|dgram|tls|dns)["']/, label: "import node:fs/net/http(s)/child_process/dgram/tls/dns" },
  { pattern: /require\(\s*["']node:(fs|net|http|https|child_process|dgram|tls|dns)["']\s*\)/, label: "require node:fs/net/http(s)/child_process/dgram/tls/dns" },
  { pattern: /\bfetch\s*\(/, label: "调用 fetch()" },
  { pattern: /\bXMLHttpRequest\b/, label: "使用 XMLHttpRequest" },
  { pattern: /Bun\.spawn|Bun\.file|Bun\.write/, label: "使用 Bun 的进程/文件 API" },
  { pattern: /\bDate\.now\(\)|new\s+Date\(\)/, label: "读当前时间（破坏确定性：同输入不再保证两次同输出）" },
  { pattern: /Math\.random\(\)/, label: "使用 Math.random()（破坏确定性）" },
];

function staticIoScan(source: string): VerifyCheck {
  const hits = FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(source)).map((h) => h.label);
  if (hits.length > 0) {
    return {
      name: "静态扫描：源码里没有明显的 IO / 非确定性原语",
      ok: false,
      detail: `发现疑似违反"零 IO / 确定性"的用法：${hits.join("；")}`,
    };
  }
  return { name: "静态扫描：源码里没有明显的 IO / 非确定性原语", ok: true };
}

function isRuleLike(mod: unknown): mod is { rule: RuleLike; VERIFY_SAMPLE_INPUT: unknown } {
  const m = mod as Record<string, unknown>;
  const rule = m.rule as Partial<RuleLike> | undefined;
  return (
    !!rule &&
    typeof rule.id === "string" &&
    typeof rule.check === "string" &&
    typeof rule.description === "string" &&
    typeof rule.evaluate === "function" &&
    "VERIFY_SAMPLE_INPUT" in m
  );
}

export async function verifyRuleExtension(entryPath: string): Promise<RuleVerifyResult> {
  const checks: VerifyCheck[] = [];
  const source = readFileSync(entryPath, "utf8");
  checks.push(staticIoScan(source));

  let mod: unknown;
  try {
    mod = await import(entryPath);
  } catch (error) {
    return {
      ok: false,
      checks: [...checks, { name: "模块可加载且导出契约形状", ok: false, detail: `import 抛错：${error instanceof Error ? error.message : String(error)}` }],
    };
  }

  if (!isRuleLike(mod)) {
    return {
      ok: false,
      checks: [
        ...checks,
        {
          name: "模块可加载且导出契约形状",
          ok: false,
          detail: `期望具名导出 rule: { id, check, description, evaluate(input) } 与 VERIFY_SAMPLE_INPUT（供 ext verify 调用 evaluate 两次比对确定性），实际导出：${Object.keys(mod as object).join(", ")}`,
        },
      ],
    };
  }
  checks.push({ name: "模块可加载且导出契约形状", ok: true });

  const { rule, VERIFY_SAMPLE_INPUT } = mod;
  if (rule.id.trim() === "" || rule.description.trim() === "") {
    checks.push({ name: "id / description 非空", ok: false, detail: `id="${rule.id}" description="${rule.description}"` });
  } else {
    checks.push({ name: "id / description 非空", ok: true });
  }

  try {
    const first = rule.evaluate(VERIFY_SAMPLE_INPUT);
    const second = rule.evaluate(VERIFY_SAMPLE_INPUT);
    const same = JSON.stringify(first) === JSON.stringify(second);
    checks.push({
      name: "确定性：同一 VERIFY_SAMPLE_INPUT 求值两次结果相同",
      ok: same,
      detail: same ? undefined : `第一次：${JSON.stringify(first)}\n第二次：${JSON.stringify(second)}`,
    });
  } catch (error) {
    checks.push({
      name: "确定性：同一 VERIFY_SAMPLE_INPUT 求值两次结果相同",
      ok: false,
      detail: `evaluate(VERIFY_SAMPLE_INPUT) 抛错：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
