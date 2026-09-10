// W2-d（B-c）：`spark-research demo` —— 零网络、零 API key 的离线示例项目。
//
// **不重造**：完整的"提出问题 → 文献入库 → 精读卡 → 综述 → co-explore → novelty check
// → 干实验（真 pyref）→ 结论卡 → review 门槛 → 导出报告"链路已经是 P8 交付的
// `scripts/demo-research-thread.ts`（`runResearchThread`）——它走真实 CLI 入口，
// 外部依赖全部换成 cassette 回放 + 脚本化 fake LLM，唯一"真跑"的是零依赖的 pyref
// 子进程。这里只是把它包成一个 CLI 子命令，加上人看得懂的输出（证据图 + 报告全貌）。
//
// **已知坑（BACKLOG V27，如实记录，不在本 lane 修）**：`runResearchThread` 建项目
// 时会经过 `backend/src/project/records.ts` 的
// `readFileSync(join(import.meta.dir, "schema.sql"))`（**实测确认**：`spark-research
// project new` 在编译产物里同样会炸，跟本 lane 无关，是所有会建项目的命令的共同底
// 座），另外还间接依赖 `tests/helpers/literature_scenario.ts` / `ideation_scenario.ts`
// 里的 `join(import.meta.dir, "..", "fixtures", "literature")`——这些文件全部不在
// 本 lane 所有权内（`backend/src/project/**`、`tests/helpers/**`），不能改。
// `import.meta.dir` 在 `bun build --compile` 产出的单二进制里指向虚拟的
// `/$bunfs/root/`，运行期用它拼路径读任何文件都会 ENOENT。**这意味着 `spark-research
// demo`（以及 `init`，同样要建项目）在编译产物里都会坏，源码运行（`bun
// backend/src/index.ts demo` / 开发环境的 npx）不受影响。** 下面用
// `import.meta.dir` 自身的取值做一次运行时环境判断，编译产物里给出可读的诊断而不是
// 让用户看一段裸 ENOENT 堆栈——不精确断言是"哪一个"文件读不到（可能是 schema.sql，
// 也可能是 fixture），只如实说"编译产物里的已知限制"，把具体病灶交给 devlog。
// 真正的根治属于 BACKLOG V27 那 17 个文件的系统性修复（改成静态 import，像
// backend/src/index.ts 读 package.json 那样让打包器把内容编译进二进制），
// 不是本 lane 能单独解决的。
import { writeFileSync } from "node:fs";
import { runResearchThread, type ThreadOptions } from "../../../scripts/demo-research-thread";

const RUNNING_IN_COMPILED_BINARY = import.meta.dir.startsWith("/$bunfs");

export interface DemoOptions extends Pick<ThreadOptions, "root" | "slug"> {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** 额外把报告 markdown 落盘一份（demo 本身已经把全文打到 stdout）。 */
  outFile?: string;
}

function looksLikeFixtureReadFailure(message: string): boolean {
  return /ENOENT|no such file or directory|Failed to open/i.test(message);
}

export async function runDemo(options: DemoOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));

  out("");
  out("Spark Research · demo（离线示例项目：零网络、零 API key）");
  out("");

  const started = Date.now();
  try {
    const result = await runResearchThread({
      root: options.root,
      slug: options.slug,
      log: (line) => out(line),
    });
    const elapsedMs = Date.now() - started;

    out("");
    out(`证据图（${result.slug}）`);
    out(`  approvedConclusions: ${result.report.counts.approvedConclusions}`);
    out(`  unverifiedConclusions: ${result.report.counts.unverifiedConclusions}`);
    out(`  papers: ${result.report.counts.papers}  readings: ${result.report.counts.readings}  ideas: ${result.report.counts.ideas}`);
    out(`  dryExperiments: ${result.report.counts.dryExperiments}  observations: ${result.report.counts.observations}`);
    out(`  引用 record 数: ${result.report.recordIds.length}`);
    out("");
    out("研究报告全貌");
    out("─".repeat(60));
    out(result.report.markdown);
    out("─".repeat(60));
    out("");
    if (options.outFile) {
      writeFileSync(options.outFile, result.report.markdown);
      out(`报告已另存为：${options.outFile}`);
    }
    out(`✅ ${result.steps.length} 步全部通过，用时 ${(elapsedMs / 1000).toFixed(1)}s（工作区 ${result.root}）`);
    out("");
    out("下一步：这只是一个只读示例项目。用 `spark-research init` 建一个你自己的真实项目。");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (RUNNING_IN_COMPILED_BINARY && looksLikeFixtureReadFailure(message)) {
      err("❌ demo 在这个单二进制发行版里跑不了（BACKLOG V27 的已知限制，不是网络问题）：");
      err("   编译产物里 import.meta.dir 指向虚拟路径 /$bunfs/root/，demo 建项目 /");
      err("   读取示例数据依赖的文件路径读不到（ENOENT）。");
      err("   请改用源码运行：`bun backend/src/index.ts demo`（或克隆仓库后 `bun run` 跑源码）。");
      err(`   原始错误：${message}`);
      return 1;
    }
    err(`❌ demo 失败：${message}`);
    return 1;
  }
}
