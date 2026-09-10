import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredDefaultModel } from "../config";
import { UsageStore, parseBudgetUsd, usageTrackingLlm } from "../usage/ledger";
import { CredentialStore } from "../daemon/credentials";
import { ConnectorRegistry } from "../connectors/registry";
import type { HttpClient } from "../http/client";
import { LLMRouter } from "../llm/router";
import { ProjectManager, ProjectError, type Project } from "../project/manager";
import { CITATION_INTEGRITY_REVIEW_KIND, type CitationIntegrityReviewMetadata } from "../agents/contract";
import { LlmCitationJudge } from "../reviewer/citation_judge";
import { CITATION_RULE, citationIntegrity, type CitationJudge } from "../reviewer/rules";
import { cliTaskRegistry, renderTaskList, renderTaskSnapshot, runCliTask } from "../cli/progress";
import type { TaskRegistry } from "../server/tasks";
import { exportLibrary, libraryKeyIndex, type ExportFormat } from "./export";
import { LibraryStore, type LibraryPaper } from "./library";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES, normalizeDoi, type LiteratureSource, type Paper } from "./models";
import { PdfDownloader } from "./pdf";
import { ReadingCardGenerator, listReadingCards, renderReadingCard } from "./reading";
import { ReviewDraftGenerator, baselinesFrom } from "./review";
import { LiteratureSearcher } from "./search";

// `spark-research lit ...` 子命令。风格与 project/cli.ts 一致：
// 返回退出码 + 输出走注入的 out/err，便于单测；不直接 process.exit。

export const LIT_HELP = `用法:
  spark-research lit search <query> [--sources a,b] [--limit N] [--add] [--tag 标签]
                                                  跨源检索（默认 ${DEFAULT_SEARCH_SOURCES.join("/")}）
  spark-research lit add <doi|arxiv-id|pmid> [--tag 标签]    按标识符入库
  spark-research lit list [--tag 标签] [--status unread|reading|read] [--json]
                                                  列出项目文献库
  spark-research lit pdf <paper-id>               下载该论文的 OA PDF
  spark-research lit read <paper-id> [--all] [--tag 标签] [--json]
                                                  生成结构化精读卡（入证据图）
  spark-research lit review [--topic 主题] [--out 文件] [--no-judge]
                                                  由精读卡生成综述草稿并跑 citation-integrity
  spark-research lit export --format bibtex|csl [--out 文件]  导出文献库
  spark-research lit sources                      列出可用文献源与凭据状态
  spark-research lit tasks [<task-id>] [--json] [--limit N]
                                                  长任务状态（read --all / review 断开后查这里）

任何子命令后加 --help 看该子命令的详细用法，例如 spark-research lit review --help
`;

// V39：子命令级帮助。
//
// 外部验收撞到的形状：`lit review --help` **直接开跑**——`--help` 被 parseFlags 当成一个
// 普通 flag 收走，`sub` 仍是 "review"，于是命令照常执行（还会真的打模型）。
// 「帮助不可用」不是小事：一个不知内情的调用方唯一的自我教学手段就是 --help，
// 它一执行，人就只能靠猜。
//
// 每条子命令一段：用法行 + 它到底做什么 + 相关的下一步命令。
export const LIT_SUBCOMMAND_HELP: Record<string, string> = {
  search: `用法: spark-research lit search <query> [--sources a,b] [--limit N] [--add] [--tag 标签]

  跨源并行检索并按 DOI/标题去重合并。默认源: ${DEFAULT_SEARCH_SOURCES.join(", ")}
  --sources  逗号分隔，可选: ${LITERATURE_SOURCES.join(", ")}
  --limit    去重后展示/入库的上限（默认 10，同时作为每源取回条数）
  --add      把本次结果写进当前项目的文献库（并重建引文边）
  --tag      入库时打的标签，逗号分隔（仅与 --add 同用时有意义）

  下一步: lit list 看库 · lit read <paper-id> 生成精读卡`,

  add: `用法: spark-research lit add <doi|arxiv-id|pmid> [--sources a,b] [--tag 标签]

  按标识符取单篇入库。默认源: ${DEFAULT_SEARCH_SOURCES.join(", ")}
  识别的标识符形态: DOI（10.xxxx/yyy）· arXiv id（2101.00001 / cs/0101001）
                    · PMID（纯数字）· OpenAlex id（W123456789）
  找不到时会逐源说明是 ok / skipped / failed，并给出下一步。

  下一步: lit search "<标题关键词>" --add（不知道标识符时用检索入库）`,

  list: `用法: spark-research lit list [--tag 标签] [--status unread|reading|read] [--q 关键词] [--json]

  列出当前项目文献库。id 显示前 8 位，后续命令可直接用这个前缀。`,

  pdf: `用法: spark-research lit pdf <paper-id>

  下载该论文的开放获取 PDF（只走 OA 渠道，不绕付费墙）。
  不可得时把原因记进库内 pdf_reason，不会重复重试。`,

  read: `用法: spark-research lit read <paper-id> | --all [--tag 标签] [--redo] [--budget-usd N] [--model M] [--json]

  --all 默认跳过已有精读卡的论文（重跑接续不重复花钱），--redo 强制全部重读。
  --budget-usd N：本项目累计已知花费达 $N 即停止新的 LLM 调用（已完成的卡保留）。

  生成结构化精读卡（研究问题/方法/核心结论/局限/与本项目关系）并落进证据图。
  --all 是长任务：会打印任务句柄与逐篇进度，断开后用 lit tasks <task-id> 查状态。

  下一步: lit review 由精读卡生成综述草稿`,

  review: `用法: spark-research lit review [--topic 主题] [--out 文件] [--no-judge] [--session id] [--budget-usd N] [--model M]

  由已有精读卡生成综述草稿，并逐条核验引用（citation-integrity）。
  --budget-usd N：本项目累计已知花费达 $N 即停止新的 LLM 调用（判定失败降级为可见 soft finding）。
  --no-judge 关掉 LLM 判定，只做库内 key 的机械核对（快，但弱）。
  有 hard finding（伪造/库外引用）时退出码为 1，草稿不可用于交付。
  这是长任务：会打印任务句柄与阶段进度，断开后用 lit tasks <task-id> 查状态。

  前置: 至少一张精读卡（lit read <paper-id> 或 lit read --all）`,

  export: `用法: spark-research lit export --format bibtex|csl [--out 文件] [--tag 标签]

  导出文献库。不给 --out 就打到 stdout。
  bibtex key 由全库有序列表统一计算（第一作者姓+年份+标题首词，冲突加 a/b/c）。`,

  sources: `用法: spark-research lit sources

  列出文献域连接器、各自的凭据状态与工具。只显示「是否已配置」，绝不显示凭据值。`,

  tasks: `用法: spark-research lit tasks [<task-id>] [--json] [--limit N]

  查长任务状态。不给 id 就列最近的任务；给了 id（支持前 8 位前缀）就展开
  状态/进度/事件日志。任务快照落在项目目录下的 tasks/，进程重启后仍在。`,
};

export interface LitCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 注入点：测试用 FixtureHttp 回放，生产走真实网络。
  http?: HttpClient;
  searcher?: LiteratureSearcher;
  // 未注入时用默认 CredentialStore（AD-2：只在 daemon/CLI 进程内读取）。
  credentials?: CredentialStore;
  // P3：精读卡 / 综述生成用的模型。测试一律注入 fake，不打真实 API。
  llm?: Pick<LLMRouter, "call">;
  model?: string;
  // 引用一致性判定器；不注入时用 LlmCitationJudge 包住上面的 llm。
  judge?: CitationJudge;
  // V35：长任务句柄的 registry。不注入时按项目根目录建一个（落盘到 <项目>/tasks/），
  // 这样断开/重启之后 `lit tasks` 还查得到。测试注入纯内存的那个。
  taskRegistry?: TaskRegistry;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSources(raw: string | undefined): LiteratureSource[] {
  if (!raw) return DEFAULT_SEARCH_SOURCES;
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = names.filter((n) => !LITERATURE_SOURCES.includes(n as LiteratureSource));
  if (invalid.length > 0) {
    throw new Error(`未知文献源: ${invalid.join(", ")}（可用: ${LITERATURE_SOURCES.join(", ")}）`);
  }
  return names as LiteratureSource[];
}

function formatAuthors(paper: Paper, max = 3): string {
  if (paper.authors.length === 0) return "作者未知";
  const names = paper.authors.slice(0, max).map((a) => a.name);
  return names.join(", ") + (paper.authors.length > max ? " 等" : "");
}

function printPaper(paper: Paper, index: number, out: (line: string) => void): void {
  out(`${String(index + 1).padStart(2)}. ${paper.title}`);
  out(`    ${formatAuthors(paper)}${paper.year ? ` · ${paper.year}` : ""}${paper.venue ? ` · ${paper.venue}` : ""}`);
  const bits: string[] = [];
  if (paper.doi) bits.push(`doi:${paper.doi}`);
  if (paper.citedByCount !== null) bits.push(`被引 ${paper.citedByCount}`);
  bits.push(`来源 ${paper.sources.join("+")}`);
  if (paper.pdfUrl) bits.push("有 OA PDF");
  out(`    ${bits.join(" · ")}`);
}

function printLibraryPaper(paper: LibraryPaper, index: number, out: (line: string) => void): void {
  const pdfMark =
    paper.pdfStatus === "downloaded" ? "PDF✓" : paper.pdfStatus === "unavailable" ? "PDF✗" : "PDF—";
  out(`${String(index + 1).padStart(2)}. [${paper.id.slice(0, 8)}] ${paper.title}`);
  out(
    `    ${formatAuthors(paper)}${paper.year ? ` · ${paper.year}` : ""} · ${paper.readingStatus} · ${pdfMark}` +
      (paper.tags.length > 0 ? ` · 标签 ${paper.tags.join(",")}` : ""),
  );
}

function printSourceStatus(
  statuses: Array<{ source: string; outcome: string; count: number; error?: string; note?: string }>,
  out: (line: string) => void,
): void {
  out("各源结果:");
  for (const s of statuses) {
    const mark = s.outcome === "ok" ? "✅" : s.outcome === "skipped" ? "⏭️ " : "❌";
    const detail = s.outcome === "ok" ? `${s.count} 条` : (s.note ?? s.error ?? s.outcome);
    out(`  ${mark} ${s.source}: ${detail}`);
  }
}

// V36：`lit add` 找不到时的下一步指引。
//
// 旧消息只有一行「未能在 a/b/c 中找到标识符 'X'」——它说了**哪里错了**，没说**该试什么**。
// 外部验收的原话是「靠猜绕过去」。样板是 `lab approve` 的 V19 拒绝消息（lab/cli.ts:229）：
// 那条消息把「为什么拒绝 → 这是什么机制 → 真人该怎么做 → 自动化该怎么做」四件事一次说全。
//
// 这里照同样的质量写，但内容必须**由本次实际发生的事推出来**，不能是一段万能套话：
//   1. 标识符长什么样 → 该由哪个源解析 → 那个源这次在不在检索集里（V34 的复发面：
//      一个 arxiv id 配一组不含 arxiv 的默认源，正是外部验收撞到的那次「未找到」）；
//   2. 有源被跳过/失败吗 → 是缺凭据还是网络错 → 分别怎么处理；
//   3. 兜底：不知道标识符时该用 `lit search ... --add`。

export type IdentifierShape = "doi" | "arxiv" | "pmid" | "openalex" | "unknown";

export function classifyIdentifier(raw: string): IdentifierShape {
  const id = raw.trim();
  if (normalizeDoi(id)) return "doi";
  // arXiv：2101.00001（含可选 vN）与旧式 cs/0101001
  if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(id)) return "arxiv";
  if (/^(arxiv:)?[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(id)) return "arxiv";
  if (/^W\d+$/i.test(id)) return "openalex";
  if (/^\d{1,8}$/.test(id)) return "pmid";
  return "unknown";
}

// 各标识符形态由哪些源解析得了。用于「你给的是 arXiv id，但这次没查 arxiv」这类精确提示。
/**
 * 各标识符形态由哪些源解析得了。
 *
 * **这张表是真源，不只是提示文案的素材。** `literature/search.ts` 的 `fetchOne()` 用它
 * 决定「这个源该不该拿这个 id 去查」——见那里的注释与 BACKLOG S1/V48。
 *
 * 之前 search.ts 里有一份**写死的三源白名单**（crossref/openalex/biorxiv + DOI 判断），
 * 其余源一律透传原始 id。后果被零上下文外部验收当场抓到：`lit add 9999.99999`
 * （一个不存在的 arXiv id）被 pubmed 的 eutils「宽容解析」成 PMID 9999，
 * **导入了一篇完全无关的 1978 年论文并报 ✅、退出码 0**。
 * 同一件事两份手写副本——这是 V34 / V37 / V46 之后的第四次，所以按同样的办法治：只留一个真源。
 */
export const SHAPE_SOURCES: Record<IdentifierShape, LiteratureSource[]> = {
  doi: ["crossref", "openalex", "europepmc", "semanticscholar"],
  arxiv: ["arxiv", "semanticscholar"],
  pmid: ["pubmed", "europepmc"],
  openalex: ["openalex"],
  unknown: [],
};

const SHAPE_LABEL: Record<IdentifierShape, string> = {
  doi: "DOI",
  arxiv: "arXiv id",
  pmid: "PMID",
  openalex: "OpenAlex id",
  unknown: "无法识别的标识符形态",
};

export function addNotFoundGuidance(
  id: string,
  sources: LiteratureSource[],
  statuses: Array<{ source: string; outcome: string; count: number; error?: string; note?: string }>,
): string[] {
  const lines: string[] = [];
  const shape = classifyIdentifier(id);
  const queried = new Set<string>(sources);
  const capable = SHAPE_SOURCES[shape];
  const missing = capable.filter((s) => !queried.has(s));

  lines.push("下一步:");
  if (shape === "unknown") {
    lines.push(
      `  · '${id}' 不像 DOI（10.xxxx/yyy）、arXiv id（2101.00001）、PMID（纯数字）或 OpenAlex id（W…）中的任何一种。` +
        "lit add 只按标识符取单篇；如果这是标题或关键词，用 lit search 而不是 lit add。",
    );
  } else if (missing.length > 0) {
    // 这一条就是 V34 的复发面：能解析它的源不在本次检索集里。说清楚、给出可直接粘的命令。
    lines.push(
      `  · 这看起来是一个 ${SHAPE_LABEL[shape]}，能解析它的源是 ${capable.join(" / ")}，` +
        `但本次只查了 ${sources.join(" / ")}——加上它再试：`,
    );
    lines.push(`      spark-research lit add ${id} --sources ${[...sources, ...missing].join(",")}`);
  } else {
    lines.push(
      `  · 这看起来是一个 ${SHAPE_LABEL[shape]}，能解析它的源（${capable.join(" / ")}）本次都查了` +
        "——多半是这条记录确实不在这些库里（很新、或未被收录）。",
    );
  }

  const skipped = statuses.filter((s) => s.outcome === "skipped");
  const failed = statuses.filter((s) => s.outcome === "failed");
  if (skipped.length > 0) {
    // 「跳过」有两种完全不同的原因，处理动作也完全不同（配凭据 vs 换源），
    // 合成一句「多为缺凭据或解析不了」等于把判断又推回给用户——那正是 V36 要治的。
    // 每条 status 自带 note，按它分开说。
    const credential = skipped.filter((s) => (s.note ?? "").includes("凭据"));
    const unparsable = skipped.filter((s) => !(s.note ?? "").includes("凭据"));
    if (credential.length > 0) {
      lines.push(
        `  · 缺凭据被跳过的源: ${credential.map((s) => s.source).join(", ")}` +
          "——用 spark-research lit sources 看各源的凭据状态；这些源本次根本没发出请求。",
      );
    }
    if (unparsable.length > 0) {
      lines.push(
        `  · 解析不了这个 id 形态、直接跳过的源: ${unparsable.map((s) => s.source).join(", ")}` +
          "——它们不认这种标识符，不是「查过了没有」。",
      );
    }
  }
  if (failed.length > 0) {
    lines.push(
      `  · 出错的源: ${failed.map((s) => s.source).join(", ")}` +
        "——这是调用失败（网络/限流/上游 5xx），不是「没有这篇论文」。稍后重试，或先用其余源。",
    );
  }
  lines.push(`  · 不确定标识符时，改用检索入库: spark-research lit search "<标题或关键词>" --add`);
  return lines;
}

// 打开当前项目并拿到文献库句柄（含 records 联动）。
function openLibrary(manager: ProjectManager): { project: Project; library: LibraryStore } {
  const project = manager.defaultProject();
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  return { project, library };
}

export async function runLitCommand(args: string[], deps: LitCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseFlags(rest);
  // G-1（v0.6）：模型解析链 `--model` flag > 注入的 deps.model > config.json 的
  // defaultModel > 各 pipeline 内部默认（undefined 透传）。此前 CLI 是三个入口里
  // 唯一不读 defaultModel 的（HTTP 的 ctx.model() 与 agent 的 configuredSubAgentModel
  // 都读）——用户设了默认模型，精读/综述照走代码默认，V40「只写不读」的形状。
  const model = flagString(flags.model) ?? deps.model ?? configuredDefaultModel({ root: deps.root });

  // V39：`lit <sub> --help` 必须显示帮助、**不执行**。放在 switch 之前，
  // 因为它对每条子命令一视同仁——放进各 case 里就会漏掉新加的子命令（这正是
  // 本次 `tasks` 加进来时会踩到的坑）。
  //
  // 不读 parseFlags 的结果而是直接扫 rest：`-h` 是单横线，parseFlags 会把它当**位置参数**
  // 收进 positional（`if (!arg.startsWith("--"))`）。写这条门时先按 `flags.h` 判，
  // 结果 `lit export -h` 照样真的执行了——测试里它甚至打到了真实工作区的文献库。
  // 这就是 V39 本身的形状：帮助入口被当成了普通参数。
  const wantsHelp = rest.includes("--help") || rest.includes("-h");
  if (wantsHelp && typeof sub === "string") {
    const detail = LIT_SUBCOMMAND_HELP[sub];
    if (detail) {
      out(detail);
      return 0;
    }
  }

  const makeSearcher = (): LiteratureSearcher => {
    if (deps.searcher) return deps.searcher;
    const credentials = deps.credentials ?? new CredentialStore({ root: deps.root });
    return new LiteratureSearcher(
      new ConnectorRegistry({ http: deps.http, credentials }).registerBuiltins(),
    );
  };

  try {
    switch (sub) {
      case "search": {
        const query = positional.join(" ").trim();
        if (!query) {
          err("用法: spark-research lit search <query>");
          return 1;
        }
        const sources = parseSources(flagString(flags.sources));
        const limit = Number(flagString(flags.limit) ?? 10) || 10;
        const result = await makeSearcher().search(query, { sources, perSource: limit, limit });

        // 三个数字含义不同，不能混为一谈：原始条数 / 合并掉的条数 / 实际展示条数（受 --limit 截断）。
        const afterDedupe = result.totalBeforeDedupe - result.mergedCount;
        out(
          `检索 "${query}"：${result.totalBeforeDedupe} 条原始结果 → 去重合并掉 ${result.mergedCount} 条 ` +
            `→ 剩 ${afterDedupe} 条` +
            (result.papers.length < afterDedupe ? `（--limit 截断后展示 ${result.papers.length} 条）` : ""),
        );
        printSourceStatus(result.sources, out);
        out("");
        result.papers.forEach((paper, i) => printPaper(paper, i, out));

        if (flags.add === true || typeof flags.add === "string") {
          const { project, library } = openLibrary(manager);
          const tags = flagString(flags.tag)?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
          let added = 0;
          let merged = 0;
          for (const paper of result.papers) {
            const res = library.add(paper, { tags });
            res.merged ? merged++ : added++;
          }
          library.rebuildCitations();
          out("");
          out(`✅ 已入库项目 '${project.slug}'：新增 ${added} 篇，合并 ${merged} 篇`);
          library.close();
          project.close();
        }
        return 0;
      }

      case "add": {
        const id = positional[0];
        if (!id) {
          err("用法: spark-research lit add <doi|arxiv-id|pmid>");
          return 1;
        }
        const sources = parseSources(flagString(flags.sources));
        const result = await makeSearcher().fetchById(id, { sources });
        if (result.papers.length === 0) {
          err(`❌ 未能在 ${sources.join("/")} 中找到标识符 '${id}' 对应的论文`);
          printSourceStatus(result.sources, err);
          // V36：只说「哪里错了」不够，必须给下一步（样板见 lab approve 的 V19 拒绝消息）。
          for (const line of addNotFoundGuidance(id, sources, result.sources)) err(line);
          return 1;
        }
        const { project, library } = openLibrary(manager);
        const tags = flagString(flags.tag)?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
        const added = library.add(result.papers[0]!, { tags });
        library.rebuildCitations();
        out(added.merged ? `✅ 已合并进已有条目（项目 ${project.slug}）` : `✅ 已入库（项目 ${project.slug}）`);
        out(`  [${added.paper.id.slice(0, 8)}] ${added.paper.title}`);
        out(`  来源 ${added.paper.sources.join("+")}${added.paper.doi ? ` · doi:${added.paper.doi}` : ""}`);
        if (added.paper.recordId) out(`  证据图 record: ${added.paper.recordId}`);
        library.close();
        project.close();
        return 0;
      }

      case "list": {
        const { project, library } = openLibrary(manager);
        const papers = library.list({
          tag: flagString(flags.tag),
          readingStatus: flagString(flags.status) as LibraryPaper["readingStatus"] | undefined,
          q: flagString(flags.q),
        });
        if (flags.json === true) {
          out(JSON.stringify(papers, null, 2));
        } else if (papers.length === 0) {
          out(`项目 '${project.slug}' 的文献库为空。用 spark-research lit search <query> --add 入库。`);
        } else {
          out(`项目 '${project.slug}' 文献库：${papers.length} 篇（引文边 ${library.citations().length} 条）`);
          papers.forEach((paper, i) => printLibraryPaper(paper, i, out));
        }
        library.close();
        project.close();
        return 0;
      }

      case "pdf": {
        const paperId = positional[0];
        if (!paperId) {
          err("用法: spark-research lit pdf <paper-id>");
          return 1;
        }
        const { project, library } = openLibrary(manager);
        // 支持传 id 前缀（list 里展示的是前 8 位）。
        const match = library.get(paperId) ?? library.list().find((p) => p.id.startsWith(paperId));
        if (!match) {
          err(`❌ 论文 '${paperId}' 不在库中`);
          library.close();
          project.close();
          return 1;
        }
        const downloader = new PdfDownloader({
          http: deps.http,
          papersDir: project.paths.papersDir,
          library,
        });
        const result = await downloader.download(match.id);
        if (result.ok) {
          out(`✅ 已下载: ${result.path}`);
          out(`  来源 ${result.origin} · ${result.bytes} 字节 · ${result.checksum}`);
        } else {
          out(`⚠️  不可得（${result.reason}）: ${result.message}`);
          out("  已记入库内 pdf_reason，不会重复重试。");
        }
        library.close();
        project.close();
        return result.ok ? 0 : 1;
      }

      case "read": {
        const { project, library } = openLibrary(manager);
        const records = project.records();
        let targets: LibraryPaper[] = [];
        if (flags.all === true) {
          targets.push(...library.list({ tag: flagString(flags.tag) }));
          // G-3（v0.6）：--all 默认跳过已有精读卡的论文——预算闸「优雅停后重跑接续」
          // 的另一半：不跳过的话，resume 等于把已完成的部分再花一遍钱。--redo 强制全读。
          if (flags.redo !== true) {
            const readIds = new Set(listReadingCards(records, library).map((c) => c.paperId));
            const before = targets.length;
            targets = targets.filter((p) => !readIds.has(p.id));
            const skipped = before - targets.length;
            if (skipped > 0) out(`⏭️  跳过 ${skipped} 篇已有精读卡的论文（--redo 强制重读）`);
            if (targets.length === 0) {
              out(`✅ 全部 ${before} 篇论文都已有精读卡，无事可做（--redo 强制重读）`);
              library.close();
              project.close();
              return 0;
            }
          }
        } else {
          const paperId = positional[0];
          if (!paperId) {
            err("用法: spark-research lit read <paper-id> | --all [--tag 标签]");
            library.close();
            project.close();
            return 1;
          }
          const match = library.get(paperId) ?? library.list().find((p) => p.id.startsWith(paperId));
          if (!match) {
            err(`❌ 论文 '${paperId}' 不在库中`);
            library.close();
            project.close();
            return 1;
          }
          targets.push(match);
        }
        if (targets.length === 0) {
          err("❌ 没有可精读的论文（库为空或标签无匹配）");
          library.close();
          project.close();
          return 1;
        }

        const budget = parseBudgetUsd(flags["budget-usd"], err);
        if (!budget.ok) {
          library.close();
          project.close();
          return 1;
        }
        // G-3：所有 LLM 调用过台账（usage.jsonl 按项目落盘）；--budget-usd 设了闸，
        // 达到即拒绝后续调用（已完成的卡都已保存，拒绝消息里有下一步）。
        const usageLlm = usageTrackingLlm({
          llm: deps.llm ?? new LLMRouter(),
          store: new UsageStore(join(project.paths.root, "usage.jsonl")),
          command: "lit-read",
          budgetUsd: budget.value,
          configOptions: { root: deps.root },
        });
        const generator = new ReadingCardGenerator({
          llm: usageLlm,
          library,
          records,
          model,
          projectContext: project.meta.description || undefined,
        });

        // V35：接 TaskRegistry（不是另起一套 CLI 进度机制——见 cli/progress.ts 文件头）。
        // 单篇精读只有一步，套任务只会多两行噪音；`--all` 才是外部验收撞到的那条
        // 「8 分钟零输出」路径，所以只有它走任务。
        const asTask = flags.all === true;
        const generateAll = () =>
          runCliTask({
            kind: "lit-read",
            label: `精读卡 ×${targets.length}`,
            project: project.slug,
            root: project.paths.root,
            registry: deps.taskRegistry,
            out,
            quiet: flags.json === true,
            run: (handle) => {
              handle.progress(0, targets.length, "开始生成精读卡");
              return generator.generateMany(targets.map((p) => p.id), {
                onProgress: ({ done, total, ok, title, paperId }) =>
                  handle.progress(done, total, `${ok ? "✅" : "❌"} ${title ?? paperId}`),
              });
            },
          });

        const { cards, failures } = asTask
          ? // 任务失败（run 抛出）时 value 为 null——generateMany 自己逐篇兜底，
            // 正常不会走到这里；真走到了就如实按「全失败」结算，不假装有结果。
            ((await generateAll()).value ?? {
              cards: [] as Awaited<ReturnType<typeof generator.generateMany>>["cards"],
              failures: targets.map((p) => ({ paperId: p.id, error: "任务异常终止" })),
            })
          : await generator.generateMany(targets.map((p) => p.id));

        if (flags.json === true) {
          out(JSON.stringify({ cards, failures }, null, 2));
        } else {
          for (const card of cards) {
            out(renderReadingCard(card));
            out(`\n（record: ${card.recordId}）\n`);
          }
          if (cards.length > 0) out(`✅ 生成 ${cards.length} 张精读卡（项目 ${project.slug}）`);
          // 失败必须可见，不能被「成功 N 张」盖过去；全失败时更不该先报一个 ✅。
          for (const failure of failures) err(`❌ ${failure.paperId}: ${failure.error}`);
          if (failures.length > 0) {
            err(`共 ${failures.length}/${targets.length} 篇精读卡生成失败`);
          }
        }
        library.close();
        project.close();
        return failures.length > 0 && cards.length === 0 ? 1 : 0;
      }

      case "review": {
        const { project, library } = openLibrary(manager);
        const records = project.records();
        const cards = listReadingCards(records, library);
        if (cards.length === 0) {
          err("❌ 项目里还没有精读卡。先跑 spark-research lit read <paper-id> 或 lit read --all");
          library.close();
          project.close();
          return 1;
        }

        const reviewBudget = parseBudgetUsd(flags["budget-usd"], err);
        if (!reviewBudget.ok) {
          library.close();
          project.close();
          return 1;
        }
        // G-3：草稿与逐条引用判定共用同一个带台账/预算闸的 llm（judge 的花费同样入账）。
        const llm = usageTrackingLlm({
          llm: deps.llm ?? new LLMRouter(),
          store: new UsageStore(join(project.paths.root, "usage.jsonl")),
          command: "lit-review",
          budgetUsd: reviewBudget.value,
          configOptions: { root: deps.root },
        });
        const generator = new ReviewDraftGenerator({
          llm,
          library,
          records,
          artifacts: project.artifacts(),
          model,
          workDir: project.paths.artifactsDir,
        });
        const topic = flagString(flags.topic);
        // 兜底核验：无论草稿是谁写的，引用一律逐条对照库内 key + 精读卡。
        const judge = flags["no-judge"] === true ? undefined : (deps.judge ?? new LlmCitationJudge(llm, model));

        // V35：综述是两段长活（写草稿 + 逐条判引用），过去同样是零输出。
        // 两段合成一个任务，阶段用 note 报——粒度到「阶段」就够了，
        // 再细就得改 review.ts / reviewer/rules.ts（不在本 lane 的文件所有权内）。
        const reviewTask = await runCliTask({
          kind: "lit-review",
          label: `综述草稿（${cards.length} 张精读卡）`,
          project: project.slug,
          root: project.paths.root,
          registry: deps.taskRegistry,
          out,
          run: async (handle) => {
            handle.note(`生成综述草稿（${cards.length} 张精读卡${topic ? ` · 主题「${topic}」` : ""}）`);
            const draft = await generator.generate(cards, {
              topic,
              sessionId: flagString(flags.session) ?? null,
            });
            handle.note(
              `草稿完成（引用 ${draft.citedKeys.length} 条）→ 开始 citation-integrity` +
                (judge ? "（含 LLM 判定）" : "（--no-judge：只做库内 key 机械核对）"),
            );
            const check = await citationIntegrity({
              draft: draft.markdown,
              knownKeys: libraryKeyIndex(library.list()).keys,
              baselines: baselinesFrom(cards),
              judge,
              artifactId: draft.artifactId ?? "",
              location: "text/markdown",
            });
            handle.note(`citation-integrity 完成：解析 ${check.citations.length} 处，判定 ${check.judgedCount} 处`);
            return { draft, check };
          },
        });
        if (!reviewTask.value) {
          // 任务失败是一等结果：如实报，不吞掉异常也不假装生成了草稿。
          err(`❌ 综述生成失败: ${reviewTask.snapshot.error?.message ?? "未知原因"}`);
          err(`  任务句柄 ${reviewTask.snapshot.id.slice(0, 8)}——用 spark-research lit tasks 展开事件日志看卡在哪一步`);
          library.close();
          project.close();
          return 1;
        }
        const { draft, check } = reviewTask.value;

        const target = flagString(flags.out);
        if (target) writeFileSync(target, draft.markdown);

        out(`✅ 综述草稿已生成（项目 ${project.slug}，基于 ${cards.length} 张精读卡）`);
        out(`  引用 ${draft.citedKeys.length} 条 · artifact ${draft.artifactId ?? "未入库"} · record ${draft.recordId ?? "未入库"}`);
        out(`  文件: ${target ?? draft.path}`);
        out("");
        out(`citation-integrity: 解析引用 ${check.citations.length} 处，判定 ${check.judgedCount} 处` +
          (check.judgeErrors > 0 ? `（${check.judgeErrors} 处判定失败）` : ""));
        const hard = check.findings.filter((f) => f.severity === "hard");
        const soft = check.findings.filter((f) => f.severity === "soft");
        for (const finding of check.findings) {
          out(`  ${finding.severity === "hard" ? "⛔" : "⚠️ "} ${finding.message}`);
        }

        // W3-c：把这次核验落成一条 observation record——W2-b 的 literature-review 契约
        // （agents/contract.ts，只读）的 citations_verified stage 判据是「存在
        // metadata.kind === CITATION_INTEGRITY_REVIEW_KIND 的 observation record，且最近一次
        // hardFindingCount === 0」；此前这条命令只把结果打印到 stdout，不落证据图，该 stage
        // 因此在生产里永远过不了（详见 docs/devlog/W2-b.md「citations_verified 的已知缺口」
        // 一节留下的交接快照，本 lane 原样接上）。
        // metadata 直接内联在 records.create() 调用里，不拆一个中间变量——这不只是风格
        // 选择：tests/unit/narrative_parity.test.ts 新增的「存储层生产写入方」门禁核实的
        // 就是「.create({ ... kind: CITATION_INTEGRITY_REVIEW_KIND ... }) 是不是同一次调用」，
        // 拆成中间变量会让这条结构性核实变得脆弱（regex 分不清「变量造出来了」和「变量真的
        // 被传给了 create()」），直接内联让「构造」与「落库」在源码里是同一个不可分割的
        // 调用表达式，判据不需要做变量流追踪就能可靠核实。
        const citationReviewRecord = records.create({
          type: "observation",
          title: `citation-integrity 核验：${draft.recordId ?? draft.artifactId ?? "草稿未入库"}`,
          content:
            `解析引用 ${check.citations.length} 处，判定 ${check.judgedCount} 处，` +
            `${hard.length} 条 hard finding，${soft.length} 条 soft finding`,
          evidence: "computed",
          origin: { kind: "session", sessionId: flagString(flags.session) ?? null, ref: draft.artifactId ?? null },
          // RecordInput.metadata 是 Record<string, unknown>（schema 不区分 record 类型）；
          // 用 `satisfies` 先按 CitationIntegrityReviewMetadata 做一次结构校验（少个字段/
          // 类型错了在这里就编译不过），再降级成落库用的宽类型，不丢字段也不绕开类型检查。
          metadata: ({
            kind: CITATION_INTEGRITY_REVIEW_KIND,
            checker: CITATION_RULE,
            // draft.recordId 在这条路径上必然存在：本命令固定传了 records + artifacts 给
            // ReviewDraftGenerator（见上面的构造），只有两者都缺失时 persist() 才会留空。
            targetRecordId: draft.recordId ?? "",
            hardFindingCount: hard.length,
            softFindingCount: soft.length,
          } satisfies CitationIntegrityReviewMetadata) as unknown as Record<string, unknown>,
        });
        out(`  citation-integrity record: ${citationReviewRecord.id}`);

        if (hard.length > 0) {
          err(`⛔ Review vetoed: ${hard.length} 条 hard finding（伪造/库外引用），草稿不可用于交付`);
        } else {
          out(`✅ 无 hard finding${soft.length > 0 ? `（${soft.length} 条 soft 提示，不否决）` : ""}`);
        }
        library.close();
        project.close();
        return hard.length > 0 ? 1 : 0;
      }

      case "export": {
        const format = (flagString(flags.format) ?? "bibtex") as ExportFormat;
        if (format !== "bibtex" && format !== "csl") {
          err(`❌ 未知导出格式 '${format}'（可用: bibtex, csl）`);
          return 1;
        }
        const { project, library } = openLibrary(manager);
        const papers = library.list({ tag: flagString(flags.tag) });
        const content = exportLibrary(papers, format);
        const target = flagString(flags.out);
        if (target) {
          writeFileSync(target, content);
          out(`✅ 已导出 ${papers.length} 篇到 ${target}（格式 ${format}）`);
        } else {
          out(content.trimEnd());
        }
        library.close();
        project.close();
        return 0;
      }

      case "tasks": {
        // V35 的第三条腿：进度看得见还不够，**断开之后要查得回来**。
        // 快照由 TaskRegistry 落在 <项目>/tasks/<id>.json（W4-c 的 V11），
        // 新进程用同一个 root 建 registry 就会 hydrate 回来——所以这里只是读，不重跑任何东西。
        const project = manager.defaultProject();
        const registry = deps.taskRegistry ?? cliTaskRegistry(project.paths.root);
        const wanted = positional[0];
        if (wanted) {
          const snapshot =
            registry.get(wanted) ?? registry.list().find((t) => t.id.startsWith(wanted)) ?? null;
          if (!snapshot) {
            err(`❌ 没有 id 以 '${wanted}' 开头的任务记录`);
            err("下一步:");
            err("  · 不带 id 跑 spark-research lit tasks 看最近的任务句柄");
            err(`  · 任务快照落在 ${project.paths.root}/tasks/；被清理或跑在别的项目下都会查不到`);
            project.close();
            return 1;
          }
          if (flags.json === true) out(JSON.stringify(snapshot, null, 2));
          else for (const line of renderTaskSnapshot(snapshot)) out(line);
          project.close();
          return 0;
        }
        const limit = Number(flagString(flags.limit) ?? 20) || 20;
        const snapshots = registry.list({ limit });
        if (flags.json === true) {
          out(JSON.stringify(snapshots, null, 2));
        } else {
          out(`项目 '${project.slug}' 的长任务（最近 ${snapshots.length} 条）:`);
          for (const line of renderTaskList(snapshots)) out(line);
        }
        project.close();
        return 0;
      }

      case "sources": {
        const credentials = deps.credentials ?? new CredentialStore({ root: deps.root });
        const registry = new ConnectorRegistry({ http: deps.http, credentials }).registerBuiltins();
        out("文献域连接器:");
        for (const entry of registry.listAll().filter((c) => c.domain === "literature")) {
          const needsKey = entry.metadata?.apiKeyRequired ?? false;
          // 只显示「是否已配置」，绝不显示凭据值本身（AD-2）。
          const keyMark = needsKey ? (credentials.has(entry.name) ? "凭据已配置" : "凭据未配置") : "免 key";
          out(`  ${entry.name.padEnd(16)} ${keyMark.padEnd(12)} ${entry.description}`);
          out(`  ${" ".repeat(16)} 工具: ${entry.tools.map((t) => t.name).join(", ")}`);
        }
        return 0;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(LIT_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 lit 子命令 '${sub}'`);
        err(LIT_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
