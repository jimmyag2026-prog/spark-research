import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExpCommand } from "../../backend/src/experiment/cli";
import { ProjectManager } from "../../backend/src/project/manager";

// R2-P0（V64 防线补全）：R1 只给 lit/idea/report 修了 --project，R2 零上下文实测
// 当场抓到 exp 是盲区——用户命令行里明明带着 --project，实验记录仍写进并发会话
// 指向的另一个项目。这次全部 CLI 收口到 openProjectResolved 单点，并立门禁。

const BACKEND_SRC = join(import.meta.dir, "../../backend/src");

function walkCliFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkCliFiles(full));
    else if (full.endsWith("/cli.ts") || full.endsWith("cli/usage.ts")) out.push(full);
  }
  return out;
}

describe("R2-P0 · --project 全 CLI 收口", () => {
  test("门禁：CLI 文件禁止裸调 manager.defaultProject()（必须经 openProjectResolved）", () => {
    // 唯一豁免：project/cli.ts —— project new/open/list 管理的就是全局指针本身，
    // 它读写 defaultProject 是语义本体，不是绕过。
    const offenders = walkCliFiles(BACKEND_SRC)
      .filter((f) => !f.endsWith("project/cli.ts"))
      .filter((f) => readFileSync(f, "utf8").includes(".defaultProject()"));
    expect(offenders).toEqual([]);
  });

  test("行为：exp list --project 指定项目，不受全局指针影响（T2 实测 P0 的回归）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spark-r2p0-"));
    try {
      const manager = new ProjectManager(tmp);
      manager.create("proj-b", { name: "B" }).close();
      // 指针指向后建的 A（模拟并发会话切走指针）
      manager.create("proj-a", { name: "A" }).close();

      const outB: string[] = [];
      const code = await runExpCommand(["list", "--project", "proj-b"], {
        manager,
        root: tmp,
        out: (l: string) => outB.push(l),
        err: (l: string) => outB.push(l),
      } as never);
      expect(code).toBe(0);
      // 输出归属 proj-b（空实验列表也必须是 B 的空，不是 A 的）
      expect(outB.join("\n")).toContain("proj-b");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── R2-T2 点名的另两条（同一修复窗口，放同文件避免碎文件）────────────────────

import { runReportCommand } from "../../backend/src/report/cli";
import { runIdeaCommand } from "../../backend/src/ideation/cli";

describe("R2 · --help 统一拦截（V39 家族补全）", () => {
  test("report export --help 显示帮助而不是真的执行导出", async () => {
    const out: string[] = [];
    const code = await runReportCommand(["export", "--help"], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("用法");
  });

  test("idea new --help 显示帮助而不是掉进交互 REPL", async () => {
    const out: string[] = [];
    const code = await runIdeaCommand(["new", "--help"], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      ask: async () => {
        throw new Error("不该进入交互模式");
      },
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("用法");
  });
});
