// W2-c · `ext verify` 对 kind="skill" 的契约化验收。
//
// 任务书原话：「P9 的 frontmatter schema 校验 + 声明的 e2e 存在且能跑」。两步都直接
// 复用已有真源，不重写：frontmatter schema 校验用 `backend/src/skills/frontmatter.ts`
// 的 `parseSkillFrontmatter`（P9 交付，只读 import，不在本 lane 名下不代表不能用它）；
// "能跑" 用 `bun test <validation 文件>` 实跑一次并看退出码，不是"文件存在就当过"。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter, SkillFrontmatterError } from "../skills/frontmatter";
import type { VerifyCheck } from "./connector_verify";

export interface SkillVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

export async function verifySkillExtension(extensionDir: string): Promise<SkillVerifyResult> {
  const checks: VerifyCheck[] = [];
  const skillPath = join(extensionDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    return { ok: false, checks: [{ name: "SKILL.md 存在", ok: false, detail: `找不到 ${skillPath}` }] };
  }
  checks.push({ name: "SKILL.md 存在", ok: true });

  let validation: string[] = [];
  try {
    const source = readFileSync(skillPath, "utf8");
    // repoRoot 传扩展目录本身：validation 里的相对路径是相对扩展目录的
    // （扩展是一个自包含单元，不应该假设仓库内部的相对路径）。
    const frontmatter = parseSkillFrontmatter(source, { path: skillPath, repoRoot: extensionDir });
    validation = frontmatter.validation;
    checks.push({ name: "frontmatter schema 校验（P9 真源 parseSkillFrontmatter）", ok: true });
  } catch (error) {
    const detail = error instanceof SkillFrontmatterError ? error.message : String(error);
    return { ok: false, checks: [...checks, { name: "frontmatter schema 校验（P9 真源 parseSkillFrontmatter）", ok: false, detail }] };
  }

  if (validation.length === 0) {
    // parseSkillFrontmatter 本身已经要求 validation 至少一条，理论上到不了这里；
    // 防御性兜底，避免"没有任何东西可跑"被误判为"跑通了"。
    return { ok: false, checks: [...checks, { name: "声明的 e2e 存在且能跑", ok: false, detail: "validation 为空" }] };
  }

  for (const rel of validation) {
    const abs = join(extensionDir, rel);
    if (!existsSync(abs)) {
      checks.push({ name: `e2e 存在：${rel}`, ok: false, detail: `找不到 ${abs}（frontmatter 校验阶段应该已经拦到这个——如果走到这里说明 repoRoot 传参有问题）` });
      continue;
    }
    if (!rel.endsWith(".test.ts")) {
      checks.push({ name: `e2e 存在：${rel}`, ok: true, detail: "文件存在，但不是 *.test.ts，ext verify 不知道怎么执行它（跳过“能跑”检查，只验证了存在）" });
      continue;
    }
    try {
      const proc = Bun.spawn(["bun", "test", abs], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-15).join("\n");
      checks.push({ name: `e2e 能跑：${rel}`, ok: exitCode === 0, detail: tail });
    } catch (error) {
      checks.push({ name: `e2e 能跑：${rel}`, ok: false, detail: `spawn bun test 失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
