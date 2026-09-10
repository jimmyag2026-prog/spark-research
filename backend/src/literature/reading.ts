import type { LLMRouter } from "../llm/router";
import type { RecordStore } from "../project/records";
import type { ResearchRecord } from "../project/models";
import { libraryKeyIndex } from "./export";
import type { LibraryPaper, LibraryStore } from "./library";

// 精读卡 pipeline（DESIGN 域 A3 第 2 步）：库内论文 → 结构化卡片 → record。
//
// 三条硬约束：
// 1. 只对**库内**论文生成卡片（卡片必须能锚回一个真实的 library paper + 它的 paper record）。
// 2. LLM 输出必须过 schema 校验；非法输出重试一次，仍非法则抛错并如实报告校验失败原因，
//    **绝不**用「部分字段可用」的半成品糊弄过去——半成品会成为 P3 引用核验的错误基准。
// 3. 卡片落成 record 后，用 cites 边连到该论文的 paper record（AD-3 的同一张证据图）。

export const READING_CARD_KIND = "reading_card";

export interface ReadingCard {
  // 库内论文 id（library.db 的 papers.id）
  paperId: string;
  // 生成时刻的 bibtex key；综述与核验一律**重新按当前库计算**，这里只作展示与追溯用。
  bibtexKey: string;
  title: string;
  researchQuestion: string;
  methods: string;
  keyFindings: string[];
  limitations: string[];
  relationToProject: string;
}

export interface StoredReadingCard extends ReadingCard {
  recordId: string;
  createdAt: string;
  model: string | null;
}

export class ReadingCardError extends Error {
  readonly attempts: number;
  readonly validationErrors: string[];
  constructor(message: string, options: { attempts: number; validationErrors?: string[] } ) {
    super(`ReadingCard: ${message}`);
    this.name = "ReadingCardError";
    this.attempts = options.attempts;
    this.validationErrors = options.validationErrors ?? [];
  }
}

// ── schema 校验 ─────────────────────────────────────────────────────────────

// LLM 常把 JSON 包在 ```json 围栏或前后夹带解释文字里；这里做一次宽松提取，
// 但**不做字段级修补**——提取失败或字段缺失就是校验失败。
export function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export interface CardValidation {
  ok: boolean;
  errors: string[];
  fields?: Omit<ReadingCard, "paperId" | "bibtexKey" | "title">;
}

// 精读卡 schema：研究问题 / 方法 / 核心结论 / 局限 / 与本项目关系（DESIGN 域 A3）。
// keyFindings 至少 1 条——一篇读不出任何结论的论文，卡片没有存在价值。
// limitations 允许为空数组（有些论文确实没写局限），但**字段必须在且必须是数组**。
export function validateReadingCardPayload(payload: unknown): CardValidation {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["输出不是 JSON 对象"] };
  }
  const obj = payload as Record<string, unknown>;
  for (const field of ["researchQuestion", "methods", "relationToProject"]) {
    if (!nonEmptyString(obj[field])) errors.push(`字段 '${field}' 缺失或不是非空字符串`);
  }
  const findings = obj.keyFindings;
  if (!Array.isArray(findings) || findings.length === 0 || !findings.every(nonEmptyString)) {
    errors.push("字段 'keyFindings' 必须是至少 1 条非空字符串的数组");
  }
  const limitations = obj.limitations;
  if (!Array.isArray(limitations) || !limitations.every(nonEmptyString)) {
    errors.push("字段 'limitations' 必须是字符串数组（可为空数组）");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    fields: {
      researchQuestion: (obj.researchQuestion as string).trim(),
      methods: (obj.methods as string).trim(),
      keyFindings: (findings as string[]).map((f) => f.trim()),
      limitations: (limitations as string[]).map((l) => l.trim()),
      relationToProject: (obj.relationToProject as string).trim(),
    },
  };
}

// ── prompt ──────────────────────────────────────────────────────────────────

export const READING_CARD_SYSTEM_PROMPT = `你是科研文献精读助手。给定一篇论文的元数据与摘要，产出一张结构化精读卡。

只输出一个 JSON 对象，不要任何解释文字，字段如下：
{
  "researchQuestion": "这篇论文要回答的研究问题（一句话）",
  "methods": "使用的方法/数据/实验设计（2-3 句）",
  "keyFindings": ["核心结论 1", "核心结论 2"],
  "limitations": ["作者承认或可推断的局限"],
  "relationToProject": "与本研究项目的关系：可借鉴什么、可对比什么、缺口在哪"
}

纪律（违反即视为无效输出）：
- 只依据给定的元数据与摘要作答。摘要没提到的数字、样本量、baseline 名称一律不要凭记忆补全。
- 不确定的地方写「摘要未提及」，不要编造。
- keyFindings 至少 1 条，每条必须是这篇论文自己的结论，不是领域常识。`;

function paperBrief(paper: LibraryPaper): string {
  const authors = paper.authors.slice(0, 8).map((a) => a.name).join(", ") || "作者未知";
  const lines = [
    `标题: ${paper.title}`,
    `作者: ${authors}${paper.authors.length > 8 ? " 等" : ""}`,
    `年份: ${paper.year ?? "未知"}`,
    `venue: ${paper.venue ?? "未知"}`,
    `DOI: ${paper.doi ?? "无"}`,
    `摘要: ${paper.abstract ?? "（库内无摘要，只能基于标题与元数据作答，请在不确定处写「摘要未提及」）"}`,
  ];
  if (paper.notes.trim()) lines.push(`用户笔记: ${paper.notes.trim()}`);
  return lines.join("\n");
}

export function buildReadingCardPrompt(paper: LibraryPaper, projectContext?: string): string {
  const context = projectContext?.trim()
    ? `本研究项目的背景：${projectContext.trim()}`
    : "本研究项目的背景：未提供；relationToProject 请只写「这篇工作可被哪类项目借鉴/对比」，不要臆测具体项目。";
  return `${context}\n\n待精读论文：\n${paperBrief(paper)}`;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

export function renderReadingCard(card: ReadingCard): string {
  const bullets = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- （未提及）");
  return [
    `# 精读卡 [@${card.bibtexKey}] ${card.title}`,
    "",
    `## 研究问题\n${card.researchQuestion}`,
    "",
    `## 方法\n${card.methods}`,
    "",
    `## 核心结论\n${bullets(card.keyFindings)}`,
    "",
    `## 局限\n${bullets(card.limitations)}`,
    "",
    `## 与本项目的关系（inferred）\n${card.relationToProject}`,
  ].join("\n");
}

// 给引用核验用的对照摘要：只含卡片里「这篇论文说了什么」的部分，
// 不含 relationToProject（那是对本项目的推断，不是论文的陈述，拿它当对照会误判）。
export function cardBaselineText(card: ReadingCard): string {
  return [
    `研究问题: ${card.researchQuestion}`,
    `方法: ${card.methods}`,
    `核心结论: ${card.keyFindings.join("; ")}`,
    `局限: ${card.limitations.length > 0 ? card.limitations.join("; ") : "（卡片未记录）"}`,
  ].join("\n");
}

// ── 生成器 ──────────────────────────────────────────────────────────────────

export interface ReadingCardDeps {
  llm: Pick<LLMRouter, "call">;
  library: LibraryStore;
  records?: RecordStore;
  model?: string;
  // 「与本项目关系」一栏的项目背景；不给时 prompt 会明确要求不臆测。
  projectContext?: string;
}

export interface GenerateCardOptions {
  sessionId?: string | null;
  // 生成后把库内阅读状态推进到 read（默认 true）。
  markRead?: boolean;
}

export interface GenerateCardResult {
  card: StoredReadingCard;
  paper: LibraryPaper;
  attempts: number;
}

export class ReadingCardGenerator {
  constructor(private deps: ReadingCardDeps) {}

  async generate(paperId: string, options: GenerateCardOptions = {}): Promise<GenerateCardResult> {
    const paper = this.deps.library.get(paperId);
    if (!paper) throw new ReadingCardError(`论文 '${paperId}' 不在项目文献库中`, { attempts: 0 });

    const model = this.deps.model;
    const userPrompt = buildReadingCardPrompt(paper, this.deps.projectContext);
    let lastErrors: string[] = [];
    let lastRaw = "";
    // 区分「模型没答上来」与「答了但不合 schema」——两种失败的处理动作完全不同
    // （前者查 key/网络，后者查 prompt/模型能力），错误消息不能把它们混成一句。
    let lastFailure: "call" | "schema" = "schema";

    // 最多两次：第一次正常生成，第二次把校验失败原因回灌给模型（DEVELOPMENT_PLAN 要求「重试一次」）。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages = [
        { role: "system" as const, content: READING_CARD_SYSTEM_PROMPT },
        { role: "user" as const, content: userPrompt },
      ];
      if (attempt === 2) {
        messages.push({
          role: "user" as const,
          content:
            `上一次输出不符合精读卡 schema，请只重新输出修正后的 JSON 对象。校验失败原因：\n` +
            lastErrors.map((e) => `- ${e}`).join("\n"),
        });
      }

      const response = model
        ? await this.deps.llm.call(messages, model)
        : await this.deps.llm.call(messages);

      if (!response.ok) {
        lastErrors = [`模型调用失败: ${response.error?.message ?? "未知原因"}`];
        lastFailure = "call";
        continue;
      }
      lastRaw = response.content;
      const validation = validateReadingCardPayload(extractJsonObject(response.content));
      if (!validation.ok) {
        lastErrors = validation.errors;
        lastFailure = "schema";
        continue;
      }

      const card: ReadingCard = {
        paperId: paper.id,
        bibtexKey: this.keyFor(paper.id),
        title: paper.title,
        ...validation.fields!,
      };
      const stored = this.persist(card, paper, response.model, options);
      if (options.markRead !== false) {
        this.deps.library.update(paper.id, { readingStatus: "read" });
      }
      return { card: stored, paper: this.deps.library.get(paper.id)!, attempts: attempt };
    }

    // 如实报错：区分失败类型；只有模型确实产出过内容时才附原始片段（否则只是把错误消息复读一遍）。
    const reason = lastFailure === "call" ? "模型两次都没能返回内容" : "重试 1 次后输出仍不合 schema";
    throw new ReadingCardError(
      `论文 '${paper.title}' 的精读卡生成失败（${reason}）: ${lastErrors.join("; ")}` +
        (lastFailure === "schema" && lastRaw ? `\n原始输出（截断 300 字）: ${lastRaw.slice(0, 300)}` : ""),
      { attempts: 2, validationErrors: lastErrors },
    );
  }

  // 批量：逐篇独立结算，一篇失败不影响其余（返回 failures 由调用方如实汇报）。
  async generateMany(
    paperIds: string[],
    options: GenerateCardOptions = {},
  ): Promise<{ cards: StoredReadingCard[]; failures: Array<{ paperId: string; error: string }> }> {
    const cards: StoredReadingCard[] = [];
    const failures: Array<{ paperId: string; error: string }> = [];
    for (const id of paperIds) {
      try {
        cards.push((await this.generate(id, options)).card);
      } catch (error) {
        failures.push({ paperId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { cards, failures };
  }

  private keyFor(paperId: string): string {
    return libraryKeyIndex(this.deps.library.list()).byId.get(paperId) ?? paperId;
  }

  private persist(
    card: ReadingCard,
    paper: LibraryPaper,
    model: string | null,
    options: GenerateCardOptions,
  ): StoredReadingCard {
    const records = this.deps.records;
    if (!records) {
      return { ...card, recordId: "", createdAt: new Date().toISOString(), model };
    }
    // record 类型选 observation：精读卡是「对一篇文献的观察」，evidence=sourced 表明
    // 它的内容锚在一个外部来源上（区别于实验产出的 observed）。见 devlog P3 决策 D1。
    const record = records.create({
      type: "reading",
      title: `精读卡：${paper.title}`,
      content: renderReadingCard(card),
      evidence: "sourced",
      origin: { kind: "session", sessionId: options.sessionId ?? null, ref: paper.id },
      metadata: {
        kind: READING_CARD_KIND,
        libraryPaperId: paper.id,
        bibtexKey: card.bibtexKey,
        doi: paper.doi,
        model,
        // 卡片里唯一属于「推断」的字段，单独标出来，核验时不拿它当对照基准。
        inferredFields: ["relationToProject"],
        card: {
          researchQuestion: card.researchQuestion,
          methods: card.methods,
          keyFindings: card.keyFindings,
          limitations: card.limitations,
          relationToProject: card.relationToProject,
        },
      },
    });
    // 证据图：精读卡 --cites--> 该论文的 paper record。
    if (paper.recordId) records.link(record.id, paper.recordId, "cites");
    return { ...card, recordId: record.id, createdAt: record.createdAt, model };
  }
}

// ── 读取已有卡片 ─────────────────────────────────────────────────────────────

function cardFromRecord(record: ResearchRecord, keyById: Map<string, string>): StoredReadingCard | null {
  const meta = record.metadata as Record<string, unknown>;
  if (meta.kind !== READING_CARD_KIND) return null;
  const paperId = typeof meta.libraryPaperId === "string" ? meta.libraryPaperId : null;
  const payload = meta.card;
  if (!paperId) return null;
  const validation = validateReadingCardPayload(payload);
  if (!validation.ok) return null;
  return {
    paperId,
    // key 一律按**当前库**重算：库增删会让冲突后缀漂移，存量 key 可能已过期。
    bibtexKey: keyById.get(paperId) ?? (typeof meta.bibtexKey === "string" ? meta.bibtexKey : paperId),
    title: record.title.replace(/^精读卡：/, ""),
    ...validation.fields!,
    recordId: record.id,
    createdAt: record.createdAt,
    model: typeof meta.model === "string" ? meta.model : null,
  };
}

// 列出项目内已有的精读卡（按创建时间）。同一篇论文多次生成时保留最新一张。
export function listReadingCards(records: RecordStore, library: LibraryStore): StoredReadingCard[] {
  const keyById = libraryKeyIndex(library.list()).byId;
  const latest = new Map<string, StoredReadingCard>();
  for (const record of records.list({ type: "reading" })) {
    const card = cardFromRecord(record, keyById);
    // 库里已删除的论文，其残留卡片不再参与综述与核验。
    if (!card || !library.get(card.paperId)) continue;
    latest.set(card.paperId, card);
  }
  return [...latest.values()];
}

// ── E-6：删除论文留孤儿 record（证据图不撒谎）───────────────────────────────
//
// `library.remove()`（library.ts，本 lane 无编辑权）只删 `papers` 表那一行。
// records.db 里同一篇论文的 `type:"paper"` record（library.ts 入库时创建，见
// DESIGN 域 C1）、以及挂在它上面的精读卡 `type:"reading"` record（本文件
// `persist()` 创建）都会变成孤儿——它们仍然留在 records.db 里，`records.list()`
// / `records.graph()` 照常能读到，但指向的库内论文已经不存在了。
// `listReadingCards()` 只在"列精读卡给综述用"这一条路径上过滤掉孤儿（上面的
// `library.get(card.paperId)` 判断），证据图本身并不知道这件事——任何直接读
// records.db 的消费方（报告导出、lineage、图可视化）看到的还是一条"健康"的
// record，这与"证据图不撒谎"的项目主张相悖。
//
// RecordStore 没有 delete()（P10-d D-9 的乐观并发设计只支持 update；证据图的
// 哲学本来就是"不删、标状态"）——这里走 `metadata.retracted` 标记而不是物理
// 删除，对应验收口径里"或标 retracted"的那一支，也不需要给 RecordStore 新增
// 任何方法。
//
// 这是一次**可重复调用的对账扫描**，不依赖挂进 `library.remove()`（那需要改
// library.ts，不在本 lane 的文件所有权内）——按当前库存量状态做一次全量核对，
// 天然幂等：已经标过 retracted 的不会重复处理。
export interface OrphanRecordSummary {
  // 本次新标记为 retracted 的 record id（paper + reading 两类都算）。
  retracted: string[];
  // 已经是 retracted、本次跳过的（用于观测，不代表有问题）。
  alreadyRetracted: number;
  // 扫描过的、声明了 libraryPaperId 的 paper/reading record 总数。
  scanned: number;
}

function libraryPaperIdOf(record: ResearchRecord): string | null {
  const id = (record.metadata as Record<string, unknown>).libraryPaperId;
  return typeof id === "string" && id ? id : null;
}

// 扫描 records.db 里所有 `paper` / `reading` 类型的 record，把指向"库里已不存在
// 的论文"的那些标 `metadata.retracted = true`（外加 retractedAt / retractedReason，
// 便于报告与 lineage 展示时解释"这条证据为什么带删除线"）。
export function retractOrphanRecords(records: RecordStore, library: LibraryStore): OrphanRecordSummary {
  const retracted: string[] = [];
  let alreadyRetracted = 0;
  let scanned = 0;

  for (const record of records.list({ type: ["paper", "reading"] })) {
    const paperId = libraryPaperIdOf(record);
    if (!paperId) continue; // 不是"锚在某篇库内论文"的 record，不归这次对账管
    scanned++;
    if ((record.metadata as Record<string, unknown>).retracted === true) {
      alreadyRetracted++;
      continue;
    }
    if (library.get(paperId) !== null) continue; // 论文还在库里，不是孤儿
    records.update(record.id, {
      metadata: {
        retracted: true,
        retractedAt: new Date().toISOString(),
        retractedReason: "关联论文已从项目文献库删除",
      },
    });
    retracted.push(record.id);
  }

  return { retracted, alreadyRetracted, scanned };
}
