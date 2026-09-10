// W2-c · `ext verify` 对 kind="platform" 的契约化验收。
//
// 任务书原话：「直接复用 P5 已有的 SimulationPlatform 契约测试套件（AD-4 当初"两个实现
// 验证接口"的投资在这里回本）」。那套套件是 `tests/helpers/simulation_contract.ts` 的
// `describeSimulationContract(config)`——它在**调用时**用 bun:test 的 `describe`/`test`
// 注册一组测试，设计上是给"静态 import 后在一个 *.test.ts 文件里跑"用的，不是给运行时
// 库函数调用用的。`ext verify` 是一条 CLI 命令（运行时），不是一次 `bun test` 执行。
//
// 做法：生成一个临时 *.test.ts 文件，原样 `import { describeSimulationContract }`
// 并喂给它扩展提供的 case（见下方 contract.json 的形状），再 spawn 一次
// `bun test <临时文件>`，解析退出码与摘要行。这是"直接复用"而不是"重新实现"——
// 契约测试的断言逻辑一个字都没有抄进本文件，跑的就是 tests/helpers/simulation_contract.ts
// 里那 13 条断言本身。
//
// 已知限制（如实记录）：这条路径依赖仓库源码树（`tests/helpers/simulation_contract.ts`
// 的相对/绝对路径），只在从 git checkout 跑（`bun run` / 开发环境）时可用；
// `bun build --compile` 产出的单二进制里没有 tests/ 目录，这条 verify 在编译产物里
// 会明确报错（而不是假装通过），不是静默退化。

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { VerifyCheck } from "./connector_verify";
import { RUNNING_IN_COMPILED_BINARY } from "../assets/embedded";

// V27/V33 同类：`resolve(import.meta.dir, "../../..")` 在编译产物里归一化成 **`/`**，
// 于是 CONTRACT_HELPER 变成 `/tests/helpers/simulation_contract.ts`，
// 而 `cwd: REPO_ROOT` 会把 `bun test` 子进程的工作目录设成文件系统根。
//
// 与 scaffold 同一裁定：`ext verify --kind platform` 复用的是仓库 `tests/` 目录下的契约
// 测试套件，这个依赖在单二进制发行版里本来就不成立（本文件头部"已知限制"早已写明）。
// 所以不给它编一个假的 repoRoot——在编译产物里把 REPO_ROOT 置为 null，让下面
// `existsSync(CONTRACT_HELPER)` 那道既有的门直接如实报错，且**永远不会**拿 `/` 当 cwd 去 spawn。
const REPO_ROOT: string | null = RUNNING_IN_COMPILED_BINARY ? null : resolve(import.meta.dir, "../../..");
const CONTRACT_HELPER = REPO_ROOT === null ? null : join(REPO_ROOT, "tests/helpers/simulation_contract.ts");

export interface PlatformContractFixture {
  okSpec: unknown;
  equivalentSpec: unknown;
  differentSpec: unknown;
  slowSpec: unknown;
  failingSpec: unknown;
  invalidSpec: unknown;
  expectedOutputs: string[];
  summaryKeys: string[];
  runTimeoutMs: number;
}

export interface PlatformVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

function readContractFixture(extensionDir: string): { fixture: PlatformContractFixture | null; error?: string } {
  const path = join(extensionDir, "contract.json");
  if (!existsSync(path)) {
    return { fixture: null, error: `找不到 ${path}——platform 扩展必须提供 contract.json（okSpec/equivalentSpec/.../runTimeoutMs），ext verify 才能构造 SimulationContractCase 复用 P5 契约测试套件` };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PlatformContractFixture>;
    const required: (keyof PlatformContractFixture)[] = [
      "okSpec",
      "equivalentSpec",
      "differentSpec",
      "slowSpec",
      "failingSpec",
      "invalidSpec",
      "expectedOutputs",
      "summaryKeys",
      "runTimeoutMs",
    ];
    const missing = required.filter((k) => raw[k] === undefined);
    if (missing.length > 0) {
      return { fixture: null, error: `contract.json 缺少字段：${missing.join(", ")}` };
    }
    return { fixture: raw as PlatformContractFixture };
  } catch (error) {
    return { fixture: null, error: `contract.json 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function verifyPlatformExtension(extensionDir: string, entryPath: string, name: string): Promise<PlatformVerifyResult> {
  const checks: VerifyCheck[] = [];

  if (REPO_ROOT === null || CONTRACT_HELPER === null || !existsSync(CONTRACT_HELPER)) {
    const where = CONTRACT_HELPER ?? "tests/helpers/simulation_contract.ts（单二进制发行版里没有 tests/ 目录）";
    return {
      ok: false,
      checks: [
        {
          name: "P5 契约测试套件可用",
          ok: false,
          detail: `找不到 ${where}——这条 verify 只在源码 checkout 里可用（见本文件头部"已知限制"），编译产物里会如实报错而不是假装通过`,
        },
      ],
    };
  }

  if (!existsSync(entryPath)) {
    return { ok: false, checks: [{ name: "入口文件存在", ok: false, detail: `找不到 ${entryPath}` }] };
  }
  checks.push({ name: "入口文件存在", ok: true });

  const { fixture, error } = readContractFixture(extensionDir);
  if (!fixture) {
    return { ok: false, checks: [...checks, { name: "contract.json 提供契约测试算例", ok: false, detail: error }] };
  }
  checks.push({ name: "contract.json 提供契约测试算例", ok: true });

  const tmpDir = mkdtempSync(join(tmpdir(), "spark-ext-verify-platform-"));
  const tmpTestFile = join(tmpDir, `${name}.contract.test.ts`);
  const source = `
// 自动生成——ext verify 临时文件，跑完即弃。不要手改。
import { describeSimulationContract } from ${JSON.stringify(CONTRACT_HELPER.replace(/\.ts$/, ""))};
import { createPlatform } from ${JSON.stringify(entryPath.replace(/\.ts$/, ""))};

describeSimulationContract({
  name: ${JSON.stringify(name)},
  make: (root: string) => createPlatform(root),
  okSpec: ${JSON.stringify(fixture.okSpec)} as any,
  equivalentSpec: ${JSON.stringify(fixture.equivalentSpec)} as any,
  differentSpec: ${JSON.stringify(fixture.differentSpec)} as any,
  slowSpec: ${JSON.stringify(fixture.slowSpec)} as any,
  failingSpec: ${JSON.stringify(fixture.failingSpec)} as any,
  invalidSpec: ${JSON.stringify(fixture.invalidSpec)} as any,
  expectedOutputs: ${JSON.stringify(fixture.expectedOutputs)},
  summaryKeys: ${JSON.stringify(fixture.summaryKeys)},
  runTimeoutMs: ${JSON.stringify(fixture.runTimeoutMs)},
});
`;
  writeFileSync(tmpTestFile, source, "utf8");

  try {
    const proc = Bun.spawn(["bun", "test", tmpTestFile], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`.trim();
    const tail = output.split("\n").slice(-30).join("\n");
    checks.push({
      name: "P5 SimulationPlatform 契约测试套件（describeSimulationContract，13 条断言）",
      ok: exitCode === 0,
      detail: tail,
    });
  } catch (error) {
    checks.push({
      name: "P5 SimulationPlatform 契约测试套件（describeSimulationContract，13 条断言）",
      ok: false,
      detail: `spawn bun test 失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
