import { writeFileSync } from "node:fs";
import { CredentialStore } from "../daemon/credentials";
import { ConnectorRegistry } from "../connectors/registry";
import type { HttpClient } from "../http/client";
import { LLMRouter } from "../llm/router";
import { ProjectManager, ProjectError, type Project } from "../project/manager";
import { CITATION_INTEGRITY_REVIEW_KIND, type CitationIntegrityReviewMetadata } from "../agents/contract";
import { LlmCitationJudge } from "../reviewer/citation_judge";
import { CITATION_RULE, citationIntegrity, type CitationJudge } from "../reviewer/rules";
import { exportLibrary, libraryKeyIndex, type ExportFormat } from "./export";
import { LibraryStore, type LibraryPaper } from "./library";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES, type LiteratureSource, type Paper } from "./models";
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
`;

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
        const targets: LibraryPaper[] = [];
        if (flags.all === true) {
          targets.push(...library.list({ tag: flagString(flags.tag) }));
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

        const generator = new ReadingCardGenerator({
          llm: deps.llm ?? new LLMRouter(),
          library,
          records,
          model: deps.model,
          projectContext: project.meta.description || undefined,
        });
        const { cards, failures } = await generator.generateMany(targets.map((p) => p.id));

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

        const llm = deps.llm ?? new LLMRouter();
        const generator = new ReviewDraftGenerator({
          llm,
          library,
          records,
          artifacts: project.artifacts(),
          model: deps.model,
          workDir: project.paths.artifactsDir,
        });
        const topic = flagString(flags.topic);
        const draft = await generator.generate(cards, {
          topic,
          sessionId: flagString(flags.session) ?? null,
        });

        // 兜底核验：无论草稿是谁写的，引用一律逐条对照库内 key + 精读卡。
        const judge = flags["no-judge"] === true ? undefined : (deps.judge ?? new LlmCitationJudge(llm, deps.model));
        const check = await citationIntegrity({
          draft: draft.markdown,
          knownKeys: libraryKeyIndex(library.list()).keys,
          baselines: baselinesFrom(cards),
          judge,
          artifactId: draft.artifactId ?? "",
          location: "text/markdown",
        });

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
