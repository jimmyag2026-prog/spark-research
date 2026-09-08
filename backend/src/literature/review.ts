import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store";
import type { LLMRouter } from "../llm/router";
import type { RecordStore } from "../project/records";
import { citedKeys } from "../reviewer/rules";
import { libraryKeyIndex } from "./export";
import type { LibraryStore } from "./library";
import { cardBaselineText, type StoredReadingCard } from "./reading";

// 综述草稿生成（DESIGN 域 A3 第 3 步）。
//
// 硬约束：草稿里的每个 [@key] 都必须是**库内论文**的 bibtex key。这条约束有两道保险：
//   第一道（本文件）：prompt 层给出 key 白名单 + 生成后校验，越界就带着越界 key 重试一次，
//                     仍越界则**抛错、不落 artifact**——不生产已知有假引用的产物。
//   第二道（reviewer/rules.ts 的 citation-integrity）：兜底检查器，对**任何来源**的草稿
//                     （本生成器、人写的、别的 agent 写的）都会重新验一遍。
// 两道保险的职责不同：第一道保证我们自己不产假引用，第二道保证假引用进不了最终产物。

export const REVIEW_DRAFT_KIND = "review_draft";

export class ReviewDraftError extends Error {
  readonly unknownKeys: string[];
  constructor(message: string, unknownKeys: string[] = []) {
    super(`ReviewDraft: ${message}`);
    this.name = "ReviewDraftError";
    this.unknownKeys = unknownKeys;
  }
}

export const REVIEW_SYSTEM_PROMPT = `你是科研综述写作助手。给定一组精读卡，写一份 Markdown 综述草稿。

引用规则（**违反即作废**）：
- 引用只能用 [@key] 形式，key 必须来自下面给出的「可用引用 key 白名单」
- 白名单之外的任何 key 都不许出现，包括你记得的真实文献——它不在本项目文献库里就不能引
- 每个实质性陈述都要带引用；确实是常识的句子可以不带，但不要写「已证明/首次/显著优于」这类强断言而不给引用
- 不要编造精读卡里没有的数字、结论、baseline 名称

结构建议：## 研究现状 / ## 方法路线对比 / ## 主要发现 / ## 局限与开放问题
只输出 Markdown 正文，不要输出 JSON、不要输出参考文献列表（由系统按 key 自动生成）。`;

export interface ReviewDraftDeps {
  llm: Pick<LLMRouter, "call">;
  library: LibraryStore;
  records?: RecordStore;
  artifacts?: ArtifactStore;
  model?: string;
  // 草稿工作副本的落盘目录（artifact 入库前先要有个文件）。默认系统临时目录。
  workDir?: string;
}

export interface GenerateDraftOptions {
  topic?: string;
  sessionId?: string | null;
  filename?: string;
  // true 时不因越界 key 报错（只给对抗测试与「先出草稿再由检查器兜底」的场景用）。
  allowUnknownKeys?: boolean;
}

export interface ReviewDraftResult {
  markdown: string;
  citedKeys: string[];
  unknownKeys: string[];
  attempts: number;
  path: string | null;
  artifactId: string | null;
  recordId: string | null;
}

export function buildReviewPrompt(cards: StoredReadingCard[], topic?: string): string {
  const allow = cards.map((c) => `- [@${c.bibtexKey}] ${c.title}`).join("\n");
  const bodies = cards
    .map((c) =>
      [
        `### [@${c.bibtexKey}] ${c.title}`,
        `研究问题: ${c.researchQuestion}`,
        `方法: ${c.methods}`,
        `核心结论: ${c.keyFindings.map((f) => `\n  - ${f}`).join("")}`,
        `局限: ${c.limitations.length > 0 ? c.limitations.map((l) => `\n  - ${l}`).join("") : " （卡片未记录）"}`,
      ].join("\n"),
    )
    .join("\n\n");
  return [
    `综述主题：${topic?.trim() || "本项目文献库的整体研究现状"}`,
    "",
    `可用引用 key 白名单（共 ${cards.length} 条，只能用这些）：`,
    allow,
    "",
    "精读卡内容：",
    bodies,
  ].join("\n");
}

// 参考文献区：由库内真实条目生成，key 与正文引用一一对应（读者能逐条核对）。
export function renderReferences(cards: StoredReadingCard[], library: LibraryStore): string {
  const lines = cards.map((card) => {
    const paper = library.get(card.paperId);
    if (!paper) return `- [@${card.bibtexKey}] ${card.title}`;
    const authors = paper.authors[0]?.name ?? "作者未知";
    const etc = paper.authors.length > 1 ? " 等" : "";
    const bits = [`${authors}${etc}`, paper.year ?? "n.d.", paper.venue ?? "未知 venue"];
    return `- [@${card.bibtexKey}] ${paper.title}. ${bits.join(". ")}.${paper.doi ? ` doi:${paper.doi}` : ""}`;
  });
  return ["## 参考文献（库内条目，key 与正文引用一一对应）", ...lines].join("\n");
}

export class ReviewDraftGenerator {
  constructor(private deps: ReviewDraftDeps) {}

  async generate(cards: StoredReadingCard[], options: GenerateDraftOptions = {}): Promise<ReviewDraftResult> {
    if (cards.length === 0) {
      throw new ReviewDraftError("没有可用的精读卡；先跑 spark-research lit read <paper-id> 生成精读卡");
    }
    const allowed = new Set(cards.map((c) => c.bibtexKey));
    // 白名单以**当前库**为准：卡片 key 已由 listReadingCards 重算过，这里再核一遍防漂移。
    const libraryKeys = new Set(libraryKeyIndex(this.deps.library.list()).keys);
    for (const key of allowed) {
      if (!libraryKeys.has(key)) {
        throw new ReviewDraftError(`精读卡的 key '${key}' 已不在库内（论文可能被删除），请重新生成精读卡`, [key]);
      }
    }

    const userPrompt = buildReviewPrompt(cards, options.topic);
    let lastMarkdown = "";
    let lastUnknown: string[] = [];
    let lastError = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages = [
        { role: "system" as const, content: REVIEW_SYSTEM_PROMPT },
        { role: "user" as const, content: userPrompt },
      ];
      if (attempt === 2) {
        messages.push({
          role: "user" as const,
          content:
            lastUnknown.length > 0
              ? `上一稿使用了不在白名单里的 key：${lastUnknown.map((k) => `[@${k}]`).join(", ")}。` +
                `请只用白名单里的 key 重写整篇草稿；找不到合适文献支撑的陈述就删掉，不要换个 key 硬凑。`
              : `上一稿无效（${lastError}）。请重新输出 Markdown 正文，至少包含一处 [@key] 引用。`,
        });
      }

      const response = this.deps.model
        ? await this.deps.llm.call(messages, this.deps.model)
        : await this.deps.llm.call(messages);
      if (!response.ok) {
        lastError = `模型调用失败: ${response.content}`;
        lastUnknown = [];
        continue;
      }

      const markdown = response.content.trim();
      lastMarkdown = markdown;
      if (!markdown) {
        lastError = "模型返回空内容";
        lastUnknown = [];
        continue;
      }
      const keys = citedKeys(markdown);
      if (keys.length === 0) {
        lastError = "草稿里没有任何 [@key] 引用";
        lastUnknown = [];
        continue;
      }
      const unknown = keys.filter((k) => !allowed.has(k));
      lastUnknown = unknown;
      if (unknown.length > 0 && !options.allowUnknownKeys) {
        lastError = `使用了白名单外的 key: ${unknown.join(", ")}`;
        continue;
      }

      const full = `${markdown}\n\n${renderReferences(cards, this.deps.library)}\n`;
      const persisted = this.persist(full, cards, keys, response.model, options);
      return { markdown: full, citedKeys: keys, unknownKeys: unknown, attempts: attempt, ...persisted };
    }

    throw new ReviewDraftError(
      `综述草稿生成失败（重试 1 次后仍不合格）: ${lastError}` +
        (lastUnknown.length > 0 ? `；越界 key: ${lastUnknown.join(", ")}` : "") +
        `\n原始输出（截断 300 字）: ${lastMarkdown.slice(0, 300)}`,
      lastUnknown,
    );
  }

  private persist(
    markdown: string,
    cards: StoredReadingCard[],
    keys: string[],
    model: string,
    options: GenerateDraftOptions,
  ): { path: string | null; artifactId: string | null; recordId: string | null } {
    const filename = options.filename ?? `review-draft-${new Date().toISOString().slice(0, 10)}.md`;
    const dir = this.deps.workDir ?? tmpdir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, markdown);

    const artifacts = this.deps.artifacts;
    if (!artifacts) return { path, artifactId: null, recordId: null };
    // extractedCode 传空串：草稿不是代码产物，没有产生它的 cell，
    // 不该被 reviewer 的 trace-don't-recompute 规则当成待溯源的代码声明（见 rules.hasClaim）。
    const artifact = artifacts.save(path, "", [], {
      sessionId: options.sessionId ?? null,
      generator: "literature-review",
    });

    const records = this.deps.records;
    if (!records) return { path, artifactId: artifact.id, recordId: null };

    // 草稿是 artifact record（AD-3：artifactId 互链）。evidence=inferred——
    // 草稿是由精读卡组织出来的推断产物，不是观察也不是计算结果。
    const record = records.createFromArtifact(artifact, {
      title: `综述草稿：${options.topic?.trim() || "项目文献库"}`,
      content: markdown,
      evidence: "inferred",
      origin: { kind: "session", sessionId: options.sessionId ?? null, ref: artifact.id },
      metadata: {
        kind: REVIEW_DRAFT_KIND,
        topic: options.topic ?? null,
        citedKeys: keys,
        cardRecordIds: cards.map((c) => c.recordId).filter(Boolean),
        model,
      },
    });

    const keyToPaper = libraryKeyIndex(this.deps.library.list()).byKey;
    for (const card of cards) {
      // 草稿 --derives_from--> 精读卡
      if (card.recordId) records.link(record.id, card.recordId, "derives_from");
    }
    for (const key of keys) {
      // 草稿 --cites--> 被引论文的 paper record
      const paper = keyToPaper.get(key);
      if (paper?.recordId) records.link(record.id, paper.recordId, "cites");
    }
    return { path, artifactId: artifact.id, recordId: record.id };
  }
}

// 综述核验用的对照基准集合：key → 精读卡摘要。
export function baselinesFrom(cards: StoredReadingCard[]): Map<string, { key: string; title: string; summary: string }> {
  return new Map(
    cards.map((card) => [card.bibtexKey, { key: card.bibtexKey, title: card.title, summary: cardBaselineText(card) }]),
  );
}
