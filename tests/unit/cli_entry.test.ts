import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { welcome } from "../../backend/src/index";

// `spark-research`（零参数）与入口点基础设施的单测。
//
// index.ts 的 `main()` 现在挂在 `if (import.meta.main) main();` 后面（W1-d 加的），
// 所以这里 `import { welcome } from "../../backend/src/index"` 只会拿到导出的函数，
// 不会在 import 期间真的跑一遍 CLI（不会碰真实 ~/.spark-research，也不会因为
// `process.argv` 在测试跑者下不可预期而炸）。真正的入口路径（--version/--help/
// 零参数不炸）另外用 Bun.spawn 起真进程验证，两层加起来才是完整覆盖。

const REPO_ROOT = join(import.meta.dir, "../..");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-cli-entry-"));
}

describe("welcome()（零参数引导，DI 单测）", () => {
  test("未配置 key 时提示 auth 是第一步", () => {
    const lines: string[] = [];
    welcome({ out: (l) => lines.push(l), auth: null, frontendBuilt: true, configDir: "/x", version: "9.9.9" });
    const text = lines.join("\n");
    expect(text).toContain("spark-research auth");
    expect(text).toContain("v9.9.9");
  });

  test("已配置 key 时不再把 auth 列为下一步", () => {
    const lines: string[] = [];
    welcome({
      out: (l) => lines.push(l),
      auth: { provider: "kimi", key: "sk-x" },
      frontendBuilt: true,
      configDir: "/x",
    });
    const text = lines.join("\n");
    expect(text).toContain("kimi（已配置）");
    expect(text).not.toContain("spark-research auth");
  });

  test("阴性对照②：打包产物（前端构建）缺失时不报错、不沉默，明确标出状态并指向 doctor 拿修复命令", () => {
    const lines: string[] = [];
    expect(() => {
      welcome({ out: (l) => lines.push(l), auth: null, frontendBuilt: false, configDir: "/x" });
    }).not.toThrow();
    const text = lines.join("\n");
    expect(text).toContain("未构建");
    // 零参数路径本身保持精简（不重复打印每条修复命令），具体的 `bun run build:web`
    // 由 `spark-research doctor` 给出——这里断言零参数路径确实指向了它，
    // 而不是断言两条路径的输出内容重复。
    expect(text).toContain("spark-research doctor");
  });

  test("已构建时不再提示前端未构建", () => {
    const lines: string[] = [];
    welcome({ out: (l) => lines.push(l), auth: { provider: "kimi", key: "x" }, frontendBuilt: true, configDir: "/x" });
    expect(lines.join("\n")).not.toContain("未构建");
  });

  test("零参数路径不会主动起 server（W2-d 向导的范围，本 lane 刻意不做）", () => {
    const lines: string[] = [];
    welcome({ out: (l) => lines.push(l), auth: null, frontendBuilt: false, configDir: "/x" });
    const text = lines.join("\n");
    expect(text).not.toContain("listening at http");
  });
});

async function runCli(args: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", "backend/src/index.ts", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

// 真进程冒烟测试：跑的是真实入口（和 `npx spark-research` 走同一份代码），
// 不是编译产物（编译产物的资源内嵌是独立的已知限制，见 docs/devlog/W1-d.md）。
describe("CLI 入口 · 真进程冒烟（bun backend/src/index.ts）", () => {
  test("--version 打印版本号且不打印整份 HELP", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    const trimmed = stdout.trim();
    expect(trimmed).toMatch(/^\d+\.\d+\.\d+/);
    expect(stdout).not.toContain("用法:");
  });

  test("-v 与 --version 行为一致", async () => {
    const a = await runCli(["--version"]);
    const b = await runCli(["-v"]);
    expect(b.stdout.trim()).toBe(a.stdout.trim());
    expect(b.code).toBe(0);
  });

  test("--help 打印用法且退出码 0", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("用法:");
    expect(stdout).toContain("spark-research doctor");
  });

  test("零参数：干净的临时数据目录下不炸、退出码 0、给出下一步", async () => {
    const dataDir = tmpRoot();
    const { code, stdout, stderr } = await runCli([], {
      env: { SPARK_RESEARCH_DATA_DIR: dataDir, KIMI_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Spark Research v");
    expect(stdout).toContain("下一步");
  });

  test("未知命令：打印 HELP 且退出码非零（不是静默失败）", async () => {
    const { code, stdout } = await runCli(["this-command-does-not-exist"]);
    expect(code).toBe(1);
    expect(stdout).toContain("用法:");
  });

  test("doctor：真进程跑一次，三档依赖字段齐全（用系统 python3 保证结果确定，不依赖本机 venv 状态）", async () => {
    const dataDir = tmpRoot();
    const { code, stdout } = await runCli(["doctor", "--json"], {
      env: { SPARK_RESEARCH_DATA_DIR: dataDir, SPARK_PYTHON: "/usr/bin/python3" },
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.tiers.map((t: { id: string }) => t.id).sort()).toEqual(["core", "lab", "science"]);
    expect(report.tiers.find((t: { id: string }) => t.id === "core").available).toBe(true);
  }, 20_000);

  test("doctor：文本渲染永远带「前端」小节且不崩溃，无论产物是否已构建", async () => {
    // 打包产物是否已构建这个具体分支，已经在 tests/unit/doctor.test.ts 的
    // DI 单测（注入 frontendDir 到已建/未建两种目录）里精确覆盖过——那里能控制变量，
    // 这里只需确认真进程端到端跑一次不炸、字段确实出现在输出里（阴性对照②的真进程复核）。
    const dataDir = tmpRoot();
    const { code, stdout } = await runCli(["doctor"], {
      env: { SPARK_RESEARCH_DATA_DIR: dataDir, SPARK_PYTHON: "/usr/bin/python3" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("前端");
  }, 20_000);
});
