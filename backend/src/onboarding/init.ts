// W2-d（B-b）：`spark-research init` 向导。
//
// 流程（任务书 §2·1）：建项目 → 探测可用 provider（含本地 Ollama）→ 跑一次真实
// 文献检索 → 展示证据图 → 打印下一步三条命令。
//
// 设计取舍：**不做交互式问答**（不用 readline 问项目名）。理由——
//   1. 向导的产出要能在 CI/脚本里确定性验证（阴性对照②就是直接调用这个函数断言输出），
//      readline 会把它变成只能人肉验证的东西。
//   2. `spark-research auth`（既有命令）已经是这个仓库里"交互问答"的先例，本向导延续
//      `doctor`/`capabilities` 的路线：非交互、一次性把状态摊开讲清楚。
//   3. 项目名不给就用时间戳生成一个，`openOrCreate` 是幂等的——重复跑 `init` 不会报错。
//
// 不属于本 lane 所有权、这里只读不改：`literature/cli.ts`（复用 `runLitCommand` 做真实检索，
// 不重新拼一遍 ConnectorRegistry/CredentialStore 装配逻辑）、`report/cli.ts`（复用 `reportFor`
// 拿证据图统计，不重新实现一遍 buildReport 的口径）、`project/manager.ts`。
import { CredentialStore } from "../daemon/credentials";
import type { LitCliDeps } from "../literature/cli";
import { runLitCommand } from "../literature/cli";
import { ProjectManager, type Project } from "../project/manager";
import { reportFor } from "../report/cli";
import { detectLocalOllama, detectProviders } from "./providers";

export interface InitOptions {
  /** 项目 slug；省略则用时间戳生成一个（`research-YYYYMMDD-HHmm`）。 */
  slug?: string;
  name?: string;
  description?: string;
  /** 演示性检索词；省略用一个通用的默认课题。 */
  query?: string;
  root?: string;
  manager?: ProjectManager;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** 测试注入：把真实网络/凭据换成 fixture（同 `LitCliDeps` 的口径）。 */
  searcher?: LitCliDeps["searcher"];
  http?: LitCliDeps["http"];
  credentials?: CredentialStore;
  now?: () => Date;
}

function pad(text: string, target: number): string {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return text + " ".repeat(Math.max(1, target - n));
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function defaultSlug(now: () => Date): string {
  const d = now();
  return `research-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

const DEFAULT_QUERY = "large language model reasoning";

export async function runInit(options: InitOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const manager = options.manager ?? new ProjectManager(options.root);
  const slug = options.slug ?? defaultSlug(now);
  const query = options.query?.trim() || DEFAULT_QUERY;

  out("");
  out("Spark Research · init 向导");
  out("");

  let project: Project;
  try {
    project = manager.openOrCreate(slug, {
      name: options.name ?? slug,
      description: options.description ?? `由 init 向导创建于 ${now().toISOString()}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`❌ 建项目失败：${message}`);
    // BACKLOG V27（如实记录，根因不在本 lane 所有权内）：建项目会经过
    // `project/records.ts` 的 `readFileSync(join(import.meta.dir, "schema.sql"))`——
    // **实测确认**编译产物（`bun build --compile`）里这条路径读不到（ENOENT），
    // `spark-research project new` 同样会炸，是所有建项目命令的共同底座问题，
    // 不是 init 自己引入的。这里只补一句诊断，不假装能修。
    if (import.meta.dir.startsWith("/$bunfs") && /ENOENT/i.test(message)) {
      err("   这是单二进制发行版的已知限制（BACKLOG V27）：编译产物里 import.meta.dir");
      err("   指向虚拟路径，建项目读不到 schema.sql。请改用源码运行：`bun backend/src/index.ts init`。");
    }
    return 1;
  }

  try {
    manager.setCurrent(slug);
    out(`① 项目 '${slug}' 已就绪（已切为当前项目）`);

    // ② 探测 provider（如实报告——阴性对照②要卡的就是"未配置报成已就绪"）。
    out("");
    out("② Provider 探测");
    const providers = detectProviders(env);
    let anyReady = false;
    for (const p of providers) {
      anyReady = anyReady || p.configured;
      const status = p.configured ? "✅ 已配置" : "·  未配置";
      const cap = p.capabilities;
      const capText = cap
        ? `tool_calling=${cap.toolCalling ? "是" : "否"} json_mode=${cap.jsonMode ? "是" : "否"} streaming=${cap.streaming ? "是" : "否"}`
        : "能力未知（没配置就不猜）";
      out(`  ${status}  ${pad(p.id, 12)}env=${pad(p.envVar, 20)}${capText}`);
    }
    const local = await detectLocalOllama(env, options.fetchImpl ?? fetch);
    if (local.reachable) {
      anyReady = true;
      out(`  ✅ 已配置  ${pad("local", 12)}${local.baseUrl}  模型 ${local.models?.length ?? 0} 个  tool_calling=否 json_mode=否 streaming=是（保守上报）`);
      if (local.note) out(`             ${local.note}`);
    } else {
      out(`  ·  未配置  ${pad("local", 12)}${local.baseUrl}  不可达（${local.note}）`);
    }
    if (!anyReady) {
      out("");
      out("  ⚠️  没有任何 provider 就绪：文献检索不需要模型仍可跑；chat / co-explore / lit read/review 会失败。");
      out("     运行 `spark-research auth` 配置一个，或起本地 Ollama 并设置 SPARK_LOCAL_LLM_BASE_URL。");
    }

    // ③ 跑一次真实文献检索
    out("");
    out(`③ 文献检索：\"${query}\"`);
    const litDeps: LitCliDeps = {
      manager,
      out: (line: string) => out(`  ${line}`),
      err: (line: string) => err(`  ${line}`),
      root: options.root,
      ...(options.searcher ? { searcher: options.searcher } : {}),
      ...(options.http ? { http: options.http } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    };
    const searchCode = await runLitCommand(["search", query, "--limit", "10", "--add"], litDeps);
    if (searchCode !== 0) {
      out("  ⚠️  检索未完全成功——可能没有网络，或该来源需要凭据（不影响其余步骤）。");
    }

    // ④ 展示证据图
    out("");
    out("④ 证据图（当前项目统计）");
    const report = reportFor(project);
    for (const [key, value] of Object.entries(report.counts)) out(`  ${pad(key + ":", 22)}${value}`);

    // ⑤ 下一步三条命令
    out("");
    out("⑤ 下一步");
    out(`  spark-research lit search "<你的课题>" --add   继续检索文献入库`);
    out(`  spark-research report export                    导出研究报告（证据图 → Markdown）`);
    out(`  spark-research server                            起 Web 工作台（浏览器里继续）`);
    out("");
    return 0;
  } finally {
    project.close();
  }
}
