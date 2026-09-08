import { libraryKeyIndex } from "../literature/export";
import type { LibraryStore } from "../literature/library";
import type { ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
import {
  IDEA_CARD_KIND,
  NOVELTY_STATUSES,
  ideaTitle,
  renderIdeaCard,
  validateEvidenceList,
  type IdeaCard,
  type IdeaEvidence,
  type NoveltyStatus,
  type StoredIdeaCard,
} from "./models";

// 思路库（DESIGN §3.2「思路库」+ 域 C1）：idea 卡的读写与证据边维护。
//
// 边的方向按**语义**读：`A --supports--> B` 念作「A 支持 B」。
// 所以是 paper --supports--> idea（论文支持这条思路），不是反过来。
// 这与 P3 的 cites 边（新产物 --cites--> 被引论文）方向相反，但两者都是照字面语义走的，
// 反过来写才是错的。查一条 idea 的支撑文献 = 看它的 **incoming** supports 边。

export class IdeaStoreError extends Error {
  constructor(message: string) {
    super(`IdeaStore: ${message}`);
    this.name = "IdeaStoreError";
  }
}

export interface CreateIdeaOptions {
  sessionId?: string | null;
  model?: string | null;
}

export class IdeaStore {
  constructor(
    private records: RecordStore,
    private library: LibraryStore,
  ) {}

  create(card: IdeaCard, options: CreateIdeaOptions = {}): StoredIdeaCard {
    const record = this.records.create({
      type: "idea",
      title: `思路：${ideaTitle(card.hypothesis)}`,
      content: renderIdeaCard(card, "unchecked"),
      // 思路是从文献与讨论里推出来的，不是观察也不是计算结果。
      evidence: "inferred",
      origin: { kind: "session", sessionId: options.sessionId ?? null, ref: null },
      metadata: {
        kind: IDEA_CARD_KIND,
        hypothesis: card.hypothesis,
        critique: card.critique,
        supporting: card.supporting,
        contradicting: card.contradicting,
        openQuestions: card.openQuestions,
        noveltyStatus: "unchecked" satisfies NoveltyStatus,
        noveltyReportRecordId: null,
        checkedAt: null,
        model: options.model ?? null,
        // 整张卡都是推断产物；这两栏尤其不能被后续环节当成「文献说的」。
        inferredFields: ["hypothesis", "critique"],
      },
    });
    this.linkEvidence(record.id, card.supporting, "supports");
    this.linkEvidence(record.id, card.contradicting, "contradicts");
    return this.fromRecord(record)!;
  }

  // 证据边：paper record --supports/contradicts--> idea record。
  // 论文不在库里（key 解析不到）时不建边——校验层已经挡过一次，这里只是不制造悬空边。
  private linkEvidence(ideaRecordId: string, items: IdeaEvidence[], type: "supports" | "contradicts"): void {
    const byKey = libraryKeyIndex(this.library.list()).byKey;
    for (const item of items) {
      if (!item.key) continue;
      const paper = byKey.get(item.key);
      if (!paper?.recordId) continue;
      this.records.link(paper.recordId, ideaRecordId, type);
    }
  }

  get(idOrPrefix: string): StoredIdeaCard | null {
    if (!idOrPrefix.trim()) return null;
    const exact = this.records.get(idOrPrefix);
    if (exact) return this.fromRecord(exact);
    const matches = this.list().filter((c) => c.recordId.startsWith(idOrPrefix));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new IdeaStoreError(`id 前缀 '${idOrPrefix}' 匹配到 ${matches.length} 条 idea，请给更长的前缀`);
    }
    return matches[0]!;
  }

  list(filter: { status?: NoveltyStatus } = {}): StoredIdeaCard[] {
    const cards: StoredIdeaCard[] = [];
    for (const record of this.records.list({ type: "idea" })) {
      const card = this.fromRecord(record);
      if (!card) continue;
      if (filter.status && card.noveltyStatus !== filter.status) continue;
      cards.push(card);
    }
    return cards;
  }

  // novelty check 的回写口：状态 + 报告指针，同时把卡片正文重渲染成一致的内容。
  setNovelty(
    recordId: string,
    status: NoveltyStatus,
    options: { reportRecordId?: string | null; checkedAt?: string } = {},
  ): StoredIdeaCard {
    if (!NOVELTY_STATUSES.includes(status)) throw new IdeaStoreError(`未知 novelty 状态 '${status}'`);
    const card = this.get(recordId);
    if (!card) throw new IdeaStoreError(`idea record '${recordId}' 不存在或不是 idea 卡`);
    const updated = this.records.update(card.recordId, {
      content: renderIdeaCard(card, status),
      metadata: {
        noveltyStatus: status,
        noveltyReportRecordId: options.reportRecordId ?? card.noveltyReportRecordId,
        checkedAt: options.checkedAt ?? new Date().toISOString(),
      },
    });
    return this.fromRecord(updated)!;
  }

  // record → 卡片。**key 一律按当前库重新校验**：库里删了论文，那条证据就不再算数
  // （与 P3 的「卡片 key 按当前库重算」同一条纪律，理由也一样：存量 key 会过期）。
  fromRecord(record: ResearchRecord): StoredIdeaCard | null {
    if (record.type !== "idea") return null;
    const meta = record.metadata as Record<string, unknown>;
    if (meta.kind !== IDEA_CARD_KIND) return null;
    if (typeof meta.hypothesis !== "string") return null;
    const known = new Set(libraryKeyIndex(this.library.list()).keys);
    const supporting = validateEvidenceList(meta.supporting ?? [], "supporting", known);
    const contradicting = validateEvidenceList(meta.contradicting ?? [], "contradicting", known);
    const status = NOVELTY_STATUSES.includes(meta.noveltyStatus as NoveltyStatus)
      ? (meta.noveltyStatus as NoveltyStatus)
      : "unchecked";
    return {
      recordId: record.id,
      createdAt: record.createdAt,
      hypothesis: meta.hypothesis,
      critique: typeof meta.critique === "string" ? meta.critique : "",
      // 校验不过的条目直接丢弃（items 里只留合法的），不把坏数据带进后续环节。
      supporting: supporting.items,
      contradicting: contradicting.items,
      openQuestions: Array.isArray(meta.openQuestions) ? (meta.openQuestions as string[]) : [],
      noveltyStatus: status,
      noveltyReportRecordId:
        typeof meta.noveltyReportRecordId === "string" ? meta.noveltyReportRecordId : null,
      checkedAt: typeof meta.checkedAt === "string" ? meta.checkedAt : null,
      model: typeof meta.model === "string" ? meta.model : null,
    };
  }
}
