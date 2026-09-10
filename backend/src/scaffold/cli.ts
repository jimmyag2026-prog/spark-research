import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNING_IN_COMPILED_BINARY } from "../assets/embedded";
import {
  connectorTemplate,
  platformTemplate,
  skillTemplate,
  toClassName,
  type GeneratedFile,
} from "./templates";

// 脚手架 CLI（P9 交付物 2）：`spark-research new skill|connector|platform <name>`。
//
// 为什么值得有：三个扩展点的「样板」都不长，但**样板里的纪律很长**——
// connector 的凭据降级要回「未配置」而不是抛错、platform 的 runner 必须写完结果
// 再写 done.json、skill 必须有配套验证。这些是 P2/P5/P6 实测踩出来的，
// 靠读文档记不住，靠模板才带得走。所以模板里注释比代码多是有意的。
//
// 两条硬规则：
//   1. **绝不覆盖已存在的文件**——脚手架毁掉别人的代码是不可接受的。
//   2. 生成的测试桩当场能跑（CI 里真的会跑一遍，见 tests/unit/scaffold.test.ts）。

export const NEW_HELP = `用法:
  spark-research new skill <name>                 生成技能骨架 + 配套验证桩
  spark-research new connector <name> [--with-key] 生成 connector + 契约测试桩
  spark-research new platform <name>              生成仿真平台 + runner.py + 契约测试接线

  --with-key   connector 走凭据服务（AD-2：凭据只在 daemon，未配置时优雅降级）
  --root DIR   仓库根（默认按当前文件位置推断）
  --dry-run    只打印将要生成的文件，不写盘

name 用小写 kebab-case（如 biorxiv、vasp-md）。
生成后：① 把 TODO 补掉 ② 跑生成的测试 ③ 注册到对应 registry（生成器会打印怎么注册）。
`;

export type ScaffoldKind = "skill" | "connector" | "platform";

export interface ScaffoldDeps {
  repoRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 覆盖目标目录（测试用）。
  targetDir?: string;
  testDir?: string;
}

export interface ScaffoldPlan {
  kind: ScaffoldKind;
  name: string;
  files: GeneratedFile[];
  followUp: string[];
}

// V27/V33 同类：`join(import.meta.dir, "../../..")` 在 `bun build --compile` 产物里
// 归一化成 **`/`**（`import.meta.dir` 是 `/$bunfs/root`，往上跳的层数比虚拟路径还深）。
// 脚手架的产出是**往仓库里写新源码文件**，所以这不是"少读一个文件"，是
// `new skill foo` 会试图往 `/backend/src/skills/foo/` 写东西。
//
// 这一处刻意**不**"修好"（F-c §5.1 的裁定）：`new skill|connector|platform` 语义上就
// 要求有一个源码仓库可写，编译产物里根本没有这么个东西，给它编一个假的 repoRoot 只会
// 把失败推迟到更莫名其妙的地方。正确处置是**立刻、明确地拒绝**，而不是静默写到 `/`。
function defaultRepoRoot(): string {
  if (RUNNING_IN_COMPILED_BINARY) {
    throw new Error(
      "`new skill|connector|platform` 只在源码 checkout 里可用：脚手架要往仓库写新的源码文件，" +
        "单二进制发行版里没有仓库可写（编译产物里默认 repoRoot 会退化成文件系统根目录 `/`，" +
        "所以这里直接拒绝而不是照着写）。请改用源码运行：`bun backend/src/index.ts new ...`，" +
        "或显式传 --repo-root 指向一个真实的 checkout。",
    );
  }
  return join(import.meta.dir, "../../..");
}

export function planScaffold(
  kind: ScaffoldKind,
  name: string,
  options: { repoRoot?: string; withCredentials?: boolean; targetDir?: string; testDir?: string } = {},
): ScaffoldPlan {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`name '${name}' 必须是小写 kebab-case（字母开头，只含小写字母/数字/连字符）`);
  }
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const testDir = options.testDir ?? join(repoRoot, "tests/unit");
  const className = toClassName(name);

  switch (kind) {
    case "skill": {
      const targetDir = options.targetDir ?? join(repoRoot, "backend/src/skills", name);
      return {
        kind,
        name,
        files: skillTemplate({ name, className, targetDir, testDir, repoRoot }),
        followUp: [
          "把 SKILL.md 里的占位段落补成真实内容（triggers 写「用户会怎么开口」，不是能力名）",
          "在 backend/src/skills/README.md 的技能表里加一行",
          `跑一次：bun test tests/unit/skill_${name.replace(/-/g, "_")}.test.ts`,
          "技能只有配套验证真跑通才算完成（AD-5）——frontmatter 校验只是起点",
        ],
      };
    }
    case "connector": {
      const targetDir = options.targetDir ?? join(repoRoot, "backend/src/connectors");
      return {
        kind,
        name,
        files: connectorTemplate(
          { name, className, targetDir, testDir, repoRoot },
          { withCredentials: Boolean(options.withCredentials) },
        ),
        followUp: [
          `在 backend/src/connectors/registry.ts 的 BUILTIN_CONNECTORS 里按域加一条 { name: "${name}", config: ${name.replace(/-/g, "")}Config }`,
          `并在 CONNECTOR_CLASSES 里登记 ${name}: ${className}Connector（否则会退化成不带自定义头的通用 HttpConnector）`,
          ...(options.withCredentials
            ? [
                `配置凭据：凭据以 connector id '${name}' 为键存进 ~/.spark-research/credentials.json（0600），值本体永不出 daemon`,
                "确认未配置凭据时的降级路径：统一检索应把它标成 skipped 而不是 failed",
              ]
            : ["确认礼貌头带上了 contactEmail（spark-research config set contactEmail you@lab.edu）"]),
          `跑一次：bun test tests/unit/connector_${name.replace(/-/g, "_")}.test.ts`,
          "注册后 `spark-research capabilities` 会自动列出它——不用手写清单",
        ],
      };
    }
    case "platform": {
      const targetDir = options.targetDir ?? join(repoRoot, "backend/src/simulation", name);
      return {
        kind,
        name,
        files: platformTemplate({ name, className, targetDir, testDir, repoRoot }),
        followUp: [
          `在 backend/src/simulation/registry.ts 的 SIMULATION_PLATFORM_IDS 里加 "${name}"，并在 get() 的 switch 里接上 ${className}Platform`,
          "填好契约测试的 6 个 spec（failingSpec 要是**真实**的失败模式，不是人为的错误开关）",
          `跑一次：bun test tests/unit/platform_${name.replace(/-/g, "_")}.test.ts —— 这套就是新平台的验收标准`,
          "deterministic 位要诚实：同一 spec 逐位可复现才是 true，填错会让下游结论用错对账口径",
        ],
      };
    }
  }
}

export function runNewCommand(args: string[], deps: ScaffoldDeps = {}): number {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const [kind, name, ...rest] = args;

  if (!kind || kind === "help" || kind === "--help" || kind === "-h") {
    out(NEW_HELP);
    return kind ? 0 : 1;
  }
  if (!["skill", "connector", "platform"].includes(kind)) {
    err(`未知类型 '${kind}'（可用：skill / connector / platform）`);
    err(NEW_HELP);
    return 1;
  }
  if (!name) {
    err(`用法: spark-research new ${kind} <name>`);
    return 1;
  }

  const dryRun = rest.includes("--dry-run");
  const withCredentials = rest.includes("--with-key");
  const rootIndex = rest.indexOf("--root");
  const repoRoot = rootIndex >= 0 ? rest[rootIndex + 1] : deps.repoRoot;

  let plan: ScaffoldPlan;
  try {
    plan = planScaffold(kind as ScaffoldKind, name, {
      repoRoot,
      withCredentials,
      targetDir: deps.targetDir,
      testDir: deps.testDir,
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // 先整体检查再写：写了一半发现冲突比什么都不写更糟。
  const existing = plan.files.filter((file) => existsSync(file.path));
  if (existing.length > 0) {
    err("以下文件已存在，脚手架不覆盖已有代码：");
    for (const file of existing) err(`  ${file.path}`);
    return 1;
  }

  if (dryRun) {
    out(`将要生成 ${plan.files.length} 个文件（--dry-run，未写盘）：`);
    for (const file of plan.files) out(`  ${file.path}`);
    return 0;
  }

  for (const file of plan.files) {
    mkdirSync(join(file.path, ".."), { recursive: true });
    writeFileSync(file.path, file.content);
    out(`✅ ${file.path}`);
  }
  out("");
  out("接下来：");
  for (const step of plan.followUp) out(`  · ${step}`);
  out("");
  out(`扩展点的完整契约与最小可运行示例见 docs/EXTENDING.md（${plan.kind} 一节）。`);
  return 0;
}
