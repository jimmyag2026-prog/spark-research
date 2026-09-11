import type { RecordStore } from "../project/records";
import {
  CONCLUSION_CARD_KIND,
  parseConclusionCard,
  renderConclusionCard,
  type ConclusionCard,
  type ConclusionMode,
  type ConclusionReviewStamp,
  type ConclusionReviewState,
} from "./models";

// 结论卡的读写口（DESIGN 域 E2）。
//
// **不**是第二个创建入口：干/湿实验闭环的 `conclude()` 仍然是结论卡的主要来源，
// 这里的 `create()` 只服务于「不挂在实验上的结论」（例如纯文献推导的结论卡）。
// 两条路径落的 metadata 形状由 `parseConclusionCard` 统一读回，不存在两套口径。

export class ConclusionStoreError extends Error {
  constructor(message: string) {
    super(`ConclusionStore: ${message}`);
    this.name = "ConclusionStoreError";
  }
}

export interface CreateConclusionInput {
  claim: string;
  title?: string;
  limitations?: string | null;
  confidence?: string | null;
  evidenceIds?: string[];
  experimentId?: string | null;
  mode?: ConclusionMode;
  sessionId?: string | null;
}

export class ConclusionStore {
  constructor(private records: RecordStore) {}

  create(input: CreateConclusionInput): ConclusionCard {
    const claim = input.claim.trim();
    if (!claim) throw new ConclusionStoreError("claim 不能为空");
    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    const record = this.records.create({
      type: "conclusion",
      provenanceClass: "user_authored",
      title: input.title?.trim() || `结论：${claim.slice(0, 40)}`,
      content: claim,
      // 结论是从证据推出来的，不是观察本身。
      evidence: "inferred",
      origin: { kind: "session", sessionId: input.sessionId ?? null, ref: input.experimentId ?? null },
      metadata: {
        kind: CONCLUSION_CARD_KIND,
        claim,
        limitations: input.limitations ?? null,
        confidence: input.confidence ?? null,
        evidenceIds,
        experimentId: input.experimentId ?? null,
        mode: input.mode ?? (input.experimentId ? "dry" : "manual"),
        // 新卡一律 pending：不给自己发通过证。
        review: "pending",
      },
    });
    // 证据边：conclusion --derives_from--> observation（与两条实验闭环同方向）。
    for (const id of evidenceIds) {
      if (this.records.get(id)) this.records.link(record.id, id, "derives_from");
    }
    return parseConclusionCard(this.records.get(record.id)!)!;
  }

  list(filter: { review?: ConclusionReviewState } = {}): ConclusionCard[] {
    const cards: ConclusionCard[] = [];
    for (const record of this.records.list({ type: "conclusion" })) {
      const card = parseConclusionCard(record);
      if (!card) continue;
      if (filter.review && card.review.state !== filter.review) continue;
      cards.push(card);
    }
    return cards;
  }

  get(idOrPrefix: string): ConclusionCard | null {
    if (!idOrPrefix.trim()) return null;
    const exact = this.records.get(idOrPrefix);
    if (exact) return parseConclusionCard(exact);
    const matches = this.list().filter((c) => c.recordId.startsWith(idOrPrefix));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new ConclusionStoreError(
        `id 前缀 '${idOrPrefix}' 匹配到 ${matches.length} 条结论卡，请给更长的前缀`,
      );
    }
    return matches[0]!;
  }

  // review 状态的唯一写入口。正文同步重渲染，保证「读 record 正文」与「读 metadata」
  // 看到的是同一件事（与 IdeaStore.setNovelty 同一条纪律）。
  setReview(recordId: string, review: ConclusionReviewStamp): ConclusionCard {
    const card = this.get(recordId);
    if (!card) throw new ConclusionStoreError(`结论卡 '${recordId}' 不存在`);
    const next: ConclusionCard = { ...card, review };
    const updated = this.records.update(card.recordId, {
      content: renderConclusionCard(next),
      metadata: { review },
    });
    return parseConclusionCard(updated)!;
  }
}
