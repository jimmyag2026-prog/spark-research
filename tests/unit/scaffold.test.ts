import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planScaffold, runNewCommand } from "../../backend/src/scaffold/cli";
import { parseSkillFrontmatter } from "../../backend/src/skills/frontmatter";

// P9 · 脚手架。
//
// 最重要的一条断言在最后：**生成的测试桩真的能跑**。
// 生成一堆 `// TODO: 写测试` 的模板毫无价值——那让使用者从调试别人的骨架开始。
// 所以这里把脚手架生成到仓库内的临时目录，然后真的 `bun test` 跑一遍它生成的测试。
// 生成到仓库内是必要的：模板里的 import 是相对路径，只有在仓库树里才解析得到，
// 而这正是真实使用时的情形。

const REPO_ROOT = join(import.meta.dir, "../..");

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(REPO_ROOT, ".tmp-scaffold-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function capture(): { lines: string[]; out: (l: string) => void } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l) };
}

async function runGeneratedTests(files: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bun", "test", ...files], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

describe("脚手架 · 参数与安全", () => {
  test("name 必须是 kebab-case", () => {
    expect(() => planScaffold("connector", "BioRxiv")).toThrow(/kebab-case/);
    expect(() => planScaffold("connector", "3source")).toThrow(/kebab-case/);
    expect(planScaffold("connector", "bio-rxiv").name).toBe("bio-rxiv");
  });

  test("绝不覆盖已存在的文件", () => {
    const { dir, cleanup } = scratch();
    try {
      const target = join(dir, "src");
      const tests = join(dir, "tests");
      mkdirSync(target, { recursive: true });
      mkdirSync(tests, { recursive: true });
      writeFileSync(join(target, "demo-src.ts"), "// 我先在这儿");
      const { lines, out } = capture();
      const code = runNewCommand(["connector", "demo-src"], {
        repoRoot: REPO_ROOT,
        targetDir: target,
        testDir: tests,
        out,
        err: out,
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("不覆盖已有代码");
      // 冲突时一个文件都不写（写一半比不写更糟）。
      expect(existsSync(join(tests, "connector_demo_src.test.ts"))).toBe(false);
      expect(readFileSync(join(target, "demo-src.ts"), "utf8")).toBe("// 我先在这儿");
    } finally {
      cleanup();
    }
  });

  test("--dry-run 只列文件不写盘", () => {
    const { dir, cleanup } = scratch();
    try {
      const { lines, out } = capture();
      const code = runNewCommand(["skill", "dry-demo", "--dry-run"], {
        repoRoot: REPO_ROOT,
        targetDir: join(dir, "skill"),
        testDir: join(dir, "tests"),
        out,
        err: out,
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("未写盘");
      expect(existsSync(join(dir, "skill", "SKILL.md"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("未知类型报错并给出可用类型", () => {
    const { lines, out } = capture();
    expect(runNewCommand(["rule", "x"], { out, err: out })).toBe(1);
    expect(lines.join("\n")).toContain("skill / connector / platform");
  });

  test("每种类型都给出「接下来做什么」，含注册步骤", () => {
    // 生成了文件却不告诉人「还要去 registry 注册」，是脚手架最常见的坑：
    // 代码在那儿，但 capabilities 里看不到，使用者会以为自己写错了。
    expect(planScaffold("connector", "demo-x").followUp.join("\n")).toContain("BUILTIN_CONNECTORS");
    expect(planScaffold("platform", "demo-x").followUp.join("\n")).toContain("SIMULATION_PLATFORM_IDS");
    expect(planScaffold("skill", "demo-x").followUp.join("\n")).toContain("AD-5");
  });
});

describe("脚手架 · 生成物当场可用（CI 真跑一遍）", () => {
  test("skill 模板：frontmatter 合规且生成的测试通过", async () => {
    const { dir, cleanup } = scratch();
    try {
      const skillDir = join(dir, "hello-source");
      const testDir = join(dir, "tests");
      const { out } = capture();
      expect(
        runNewCommand(["skill", "hello-source"], {
          repoRoot: REPO_ROOT,
          targetDir: skillDir,
          testDir,
          out,
          err: out,
        }),
      ).toBe(0);

      // 生成的 SKILL.md 必须**当场**过 frontmatter 校验（包括 validation 指向的文件存在）。
      const fm = parseSkillFrontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"), {
        repoRoot: REPO_ROOT,
      });
      expect(fm.name).toBe("hello-source");
      expect(fm.triggers.length).toBeGreaterThan(0);

      const result = await runGeneratedTests([join(testDir, "skill_hello_source.test.ts")]);
      expect(result.output).toContain("0 fail");
      expect(result.code).toBe(0);
    } finally {
      cleanup();
    }
  }, 60_000);

  test("connector 模板（免 key）：生成的契约测试通过", async () => {
    const { dir, cleanup } = scratch();
    try {
      const testDir = join(dir, "tests");
      const { out } = capture();
      expect(
        runNewCommand(["connector", "openfree"], {
          repoRoot: REPO_ROOT,
          targetDir: dir,
          testDir,
          out,
          err: out,
        }),
      ).toBe(0);
      const result = await runGeneratedTests([join(testDir, "connector_openfree.test.ts")]);
      expect(result.output).toContain("0 fail");
      expect(result.code).toBe(0);
    } finally {
      cleanup();
    }
  }, 60_000);

  test("connector 模板（带 key）：凭据降级与不泄漏的用例都通过", async () => {
    const { dir, cleanup } = scratch();
    try {
      const testDir = join(dir, "tests");
      const { out } = capture();
      expect(
        runNewCommand(["connector", "paidsource", "--with-key"], {
          repoRoot: REPO_ROOT,
          targetDir: dir,
          testDir,
          out,
          err: out,
        }),
      ).toBe(0);
      const generated = readFileSync(join(dir, "paidsource.ts"), "utf8");
      // 带 key 的模板必须把 AD-2 的两条纪律写进代码：降级不抛错、凭据只从 daemon 拿。
      expect(generated).toContain("configured: false");
      expect(generated).toContain("AD-2");
      const result = await runGeneratedTests([join(testDir, "connector_paidsource.test.ts")]);
      expect(result.output).toContain("0 fail");
      expect(result.code).toBe(0);
    } finally {
      cleanup();
    }
  }, 60_000);

  test("platform 模板：**直接复用 P5 契约测试套件**并全绿", async () => {
    // 这是 P9 对 SimulationPlatform 一节的核心主张：
    // 新平台的验收不是「自己写几个测试」，而是把 openmm/pyref 过的那套原样跑一遍。
    const { dir, cleanup } = scratch();
    try {
      const platformDir = join(dir, "demoplat");
      const testDir = join(dir, "tests");
      const { out } = capture();
      expect(
        runNewCommand(["platform", "demoplat"], {
          repoRoot: REPO_ROOT,
          targetDir: platformDir,
          testDir,
          out,
          err: out,
        }),
      ).toBe(0);
      expect(existsSync(join(platformDir, "runner.py"))).toBe(true);

      const generatedTest = readFileSync(join(testDir, "platform_demoplat.test.ts"), "utf8");
      expect(generatedTest).toContain("describeSimulationContract");

      const result = await runGeneratedTests([join(testDir, "platform_demoplat.test.ts")]);
      expect(result.output).toContain("0 fail");
      expect(result.code).toBe(0);
    } finally {
      cleanup();
    }
  }, 180_000);
});
