// W5-1-e · V27/V33 —— 资产内嵌与危险默认路径的回归门禁。
//
// 这些测试的**已知局限**必须先写在前面，否则它们会给人虚假的安全感：
// 单元测试跑在源码模式下，`import.meta.dir` 是真实目录，磁盘上那份 `schema.sql` /
// `runner.py` / `*.txt` 全都在——**源码模式下的测试永远抓不到 V27 本身**
// （这正是 V27 活到 v0.4 的原因，见 docs/devlog/F-c.md）。
// 真正的验收是 `docs/devlog/W5-1-e.md` 里那份**真二进制冒烟**。
//
// 那这里测什么？测「修法有没有落到位」这件源码模式下**可判定**的事：
//   1. 内嵌内容与磁盘上那份逐字节一致（漏 import 一个 prompt / schema 会红）；
//   2. 解包机制真的能产出一个外部 python 打得开、且 import 得到同包模块的**真实路径**
//      （这条直接 spawn 真 python 验，不是形状断言）；
//   3. 生产代码里不再有「读资产的 `import.meta.dir`」与「归一化到文件系统根的默认路径」——
//      这条是**源码级**判据，二进制里坏不坏由它决定，源码模式下就能钉死。

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { EMBEDDED_PROMPTS, readPromptText } from "../../backend/src/agents/prompts";
import ARTIFACTS_SCHEMA_SQL from "../../backend/src/artifacts/schema.sql" with { type: "text" };
import LITERATURE_SCHEMA_SQL from "../../backend/src/literature/schema.sql" with { type: "text" };
import PROJECT_SCHEMA_SQL from "../../backend/src/project/schema.sql" with { type: "text" };
import {
  RUNNING_IN_COMPILED_BINARY,
  materializeAsset,
  materializeAssetTree,
} from "../../backend/src/assets/embedded";
import { OpenMMPlatform } from "../../backend/src/simulation/openmm";
import { PyRefPlatform } from "../../backend/src/simulation/pyref";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SRC = join(REPO_ROOT, "backend/src");
const PROMPT_DIR = join(SRC, "agents/prompt");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

// 注释里到处都在讲 `import.meta.dir` 的历史（这是好事，别让门禁逼着人删注释），
// 所以判据只看**代码行**：把行注释与块注释剥掉之后还剩下的 `import.meta.dir`。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("V27 · 内嵌资产与磁盘上那份一致", () => {
  test("八个 agent prompt 全部内嵌，且内容与 backend/src/agents/prompt/*.txt 逐字节一致", () => {
    const onDisk = readdirSync(PROMPT_DIR)
      .filter((f) => f.endsWith(".txt"))
      .sort();
    // 集合相等：磁盘上多一个 prompt 而 prompts.ts 没跟着 import，那个子代理在单二进制里
    // 会静默降智成 `[prompt missing: x.txt]`——这条断言就是防这个。
    expect(Object.keys(EMBEDDED_PROMPTS).sort()).toEqual(onDisk);
    for (const filename of onDisk) {
      expect(EMBEDDED_PROMPTS[filename]).toBe(readFileSync(join(PROMPT_DIR, filename), "utf8"));
    }
  });

  test("三个 schema.sql 的内嵌副本与磁盘上那份一致（建表语句不许分叉）", () => {
    const sites: Array<[string, string]> = [
      ["backend/src/project/schema.sql", PROJECT_SCHEMA_SQL],
      ["backend/src/artifacts/schema.sql", ARTIFACTS_SCHEMA_SQL],
      ["backend/src/literature/schema.sql", LITERATURE_SCHEMA_SQL],
    ];
    for (const [rel, embedded] of sites) {
      expect(embedded).toBe(readFileSync(join(REPO_ROOT, rel), "utf8"));
      // 内嵌的必须真是建表语句，不是 bun 在源码模式下给的那个文件路径字符串
      //（不带 `with { type: "text" }` 时 bun 返回的就是路径——这条断言防的是漏写属性）。
      expect(embedded).toContain("CREATE TABLE");
    }
  });

  test("readPromptText：磁盘优先（调用方传的 promptDir 依然说了算），读不到才落内嵌副本", () => {
    // 磁盘那份存在时读磁盘。
    expect(readPromptText(PROMPT_DIR, "core.txt")).toBe(readFileSync(join(PROMPT_DIR, "core.txt"), "utf8"));
    // 目录不存在（= 单二进制里 `/$bunfs/root/prompt` 的处境）时落内嵌副本，而不是 null。
    expect(readPromptText("/nonexistent-prompt-dir-w51e", "core.txt")).toBe(EMBEDDED_PROMPTS["core.txt"]);
    // 内嵌里也没有的文件仍然如实返回 null——兜底不许把「这个 prompt 不存在」也吞掉。
    expect(readPromptText("/nonexistent-prompt-dir-w51e", "no-such-prompt.txt")).toBeNull();
  });
});

describe("V27 · .py 解包出来的是外部进程真能打开的路径", () => {
  test("materializeAsset 产出绝对路径、内容一致、且幂等（同内容不换目录）", () => {
    const first = materializeAsset("w51e-test", "hello.py", "print('hi')\n");
    expect(isAbsolute(first)).toBe(true);
    expect(existsSync(first)).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("print('hi')\n");
    expect(materializeAsset("w51e-test", "hello.py", "print('hi')\n")).toBe(first);
    // 内容变了必须换目录，否则会读到上一个版本。
    expect(materializeAsset("w51e-test", "hello.py", "print('bye')\n")).not.toBe(first);
  });

  test("解包路径不含 /$bunfs（这正是 F-c 证明 type:\"file\" 走不通的那个坑）", () => {
    const path = materializeAsset("w51e-test", "probe.py", "pass\n");
    expect(path).not.toContain("/$bunfs");
  });

  test("真 spawn：外部 python 能打开解包出来的 runner.py，并 import 到同包模块", () => {
    // 这条是本文件里唯一直接对着 F-c §3.2/§3.3 的结论做实证的测试：
    // 不是断言「路径长得对」，是真的让一个**外部**进程按这个路径去执行。
    const root = materializeAssetTree("w51e-test-tree", {
      "simulation/__init__.py": "",
      "simulation/sim_runtime.py": "VALUE = 42\n",
      "simulation/pyref/__init__.py": "",
      "simulation/pyref/runner.py":
        "import sys\n" +
        "from pathlib import Path\n" +
        "sys.path.insert(0, str(Path(__file__).resolve().parents[2]))\n" +
        "from simulation.sim_runtime import VALUE\n" +
        "print(VALUE)\n",
    });
    const script = join(root, "simulation", "pyref", "runner.py");
    const result = spawnSync("python3", [script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  });

  test("pyref / openmm 的 entryPointFor 指向解包后的真实文件，且同包依赖也在", () => {
    for (const platform of [new PyRefPlatform({ root: "/tmp" }), new OpenMMPlatform({ root: "/tmp" })]) {
      // entryPointFor 是 protected——这里走 prepare() 之外的最短路径读它。
      const entry = (platform as unknown as { entryPointFor: (k: string) => string }).entryPointFor(
        platform.kinds[0]!,
      );
      expect(isAbsolute(entry)).toBe(true);
      expect(entry).not.toContain("/$bunfs");
      expect(existsSync(entry)).toBe(true);
      // runner.py 的 `sys.path.insert(0, parents[2])` 之后必须 import 得到 simulation.sim_runtime。
      const treeRoot = resolve(entry, "../../..");
      expect(existsSync(join(treeRoot, "simulation", "sim_runtime.py"))).toBe(true);
      expect(existsSync(join(treeRoot, "simulation", "__init__.py"))).toBe(true);
    }
  });

  test("解包出来的 runner.py 与仓库里那份逐字节一致（不许出现两份分叉的 runner）", () => {
    const pyref = (new PyRefPlatform({ root: "/tmp" }) as unknown as { entryPointFor: (k: string) => string })
      .entryPointFor("damped-oscillator");
    expect(readFileSync(pyref, "utf8")).toBe(
      readFileSync(join(SRC, "simulation/pyref/runner.py"), "utf8"),
    );
  });
});

describe("V33 · 危险默认路径不许归一化到文件系统根", () => {
  // V33 本体：`join(import.meta.dir, "../../../workspaces")` 在编译产物里是 `/workspaces`，
  // 而下一行就是 `mkdirSync(..., {recursive:true})`——往文件系统根写。
  // 源码模式下测不到 `/$bunfs`，但**可以**测「生产代码里还有没有这种写法」。
  const ROOT_ESCAPING = /import\.meta\.dir\s*,\s*["'](?:\.\.\/){3,}/;

  test("生产代码里没有 join(import.meta.dir, \"../../..\") 这类会跳到根的默认路径", () => {
    const offenders: string[] = [];
    for (const file of walkTs(SRC)) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (ROOT_ESCAPING.test(code)) offenders.push(relative(REPO_ROOT, file));
    }
    // 允许留下的：venv 兜底路径（`../../../.venv/bin/python`）——它们后面紧跟 existsSync
    // 门控，读不到就退化成 "python3"，不写盘、不崩溃（F-c §1.2 已分类为安全）。
    const VENV_FALLBACK_OK = new Set([
      "backend/src/kernels/manager.ts",
      "backend/src/lab/wet_backend.ts",
      "backend/src/simulation/platform.ts",
      // 前端产物目录：existsSync 门控，读不到只走「未构建」分支（归属 server/app.ts 的 lane）。
      "backend/src/server/app.ts",
      // 脚手架/ext verify：见下面两条测试——它们的跳根写法被显式关在
      // RUNNING_IN_COMPILED_BINARY 判断后面，编译产物里根本走不到。
      "backend/src/scaffold/cli.ts",
      "backend/src/extensions/platform_verify.ts",
    ]);
    expect(offenders.filter((f) => !VENV_FALLBACK_OK.has(f))).toEqual([]);
  });

  test("orchestrator 的 workspaceRoot 默认值挂在数据目录下，不再从 import.meta.dir 往上跳", () => {
    const src = stripComments(readFileSync(join(SRC, "agents/orchestrator.ts"), "utf8"));
    expect(src).toContain('join(dataDir(), "workspaces")');
    expect(src).not.toContain('"../../../workspaces"');
  });

  test("orchestrator 默认 workspaceRoot 真的落在 SPARK_RESEARCH_DATA_DIR 下，且不是 /workspaces", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { OrchestratorAgent } = await import("../../backend/src/agents/orchestrator");
    const { SparkResearchDaemon } = await import("../../backend/src/daemon/daemon");

    const tmp = mkdtempSync(join(tmpdir(), "w51e-ws-"));
    const previous = process.env.SPARK_RESEARCH_DATA_DIR;
    process.env.SPARK_RESEARCH_DATA_DIR = tmp;
    try {
      const orch = new OrchestratorAgent(new SparkResearchDaemon(), {
        llm: { call: async () => ({ content: "" }) as never, listModels: () => [] as never },
      });
      expect(orch.workspaceRoot).toBe(join(tmp, "workspaces"));
      expect(orch.workspaceRoot).not.toBe("/workspaces");
      expect(existsSync(orch.workspaceRoot)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SPARK_RESEARCH_DATA_DIR;
      else process.env.SPARK_RESEARCH_DATA_DIR = previous;
    }
  });

  test("scaffold 的默认 repoRoot 在编译产物里是显式拒绝，不是静默写到 /", () => {
    const src = readFileSync(join(SRC, "scaffold/cli.ts"), "utf8");
    // 跳根写法只允许出现在 RUNNING_IN_COMPILED_BINARY 抛错之后。
    expect(src).toContain("RUNNING_IN_COMPILED_BINARY");
    expect(src).toContain("只在源码 checkout 里可用");
    // 源码模式下行为不变：能算出一个真实的仓库根。
    expect(RUNNING_IN_COMPILED_BINARY).toBe(false);
  });

  test("ext verify 的 REPO_ROOT 在编译产物里是 null，不会拿 / 当 cwd 去 spawn", () => {
    const src = readFileSync(join(SRC, "extensions/platform_verify.ts"), "utf8");
    expect(src).toContain("RUNNING_IN_COMPILED_BINARY ? null : resolve(import.meta.dir");
    expect(src).toContain("REPO_ROOT === null || CONTRACT_HELPER === null");
  });
});

describe("V27 · 生产代码里不再有「读资产的 import.meta.dir」", () => {
  test("F-c 表里那 10 处资产读取点全部不再用 import.meta.dir 拼资产路径", () => {
    const sites: Array<[string, string[]]> = [
      ["backend/src/project/records.ts", ["schema.sql"]],
      ["backend/src/artifacts/store.ts", ["schema.sql"]],
      ["backend/src/literature/library.ts", ["schema.sql"]],
      ["backend/src/lab/wet_backend.ts", ["opentrons_backend.py"]],
      ["backend/src/kernels/manager.ts", ["python_kernel.py"]],
      ["backend/src/simulation/openmm/index.ts", ["runner.py"]],
      ["backend/src/simulation/pyref/index.ts", ["runner.py"]],
      ["backend/src/agents/orchestrator.ts", ["prompt"]],
      ["backend/src/agents/sub_agent.ts", ["prompt"]],
      ["backend/src/ideation/coexplore.ts", ["prompt"]],
    ];
    const offenders: string[] = [];
    for (const [rel, assets] of sites) {
      const code = stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
      for (const asset of assets) {
        // 判据：同一行里既出现 import.meta.dir 又出现资产名 → 还是老写法。
        for (const line of code.split("\n")) {
          if (line.includes("import.meta.dir") && line.includes(asset)) {
            offenders.push(`${rel}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
