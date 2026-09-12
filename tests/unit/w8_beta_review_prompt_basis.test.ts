import { describe, expect, test } from "bun:test";
import { buildReviewPrompt } from "../../backend/src/literature/review";
import type { StoredReadingCard } from "../../backend/src/literature/reading";

// V98 收口：综述草稿 prompt 也按 basis 标注材料级别（lane β 只做到了 judge 输入 cardBaselineText）。
function card(over: Partial<StoredReadingCard>): StoredReadingCard {
  return {
    recordId: "r", paperId: "p", bibtexKey: "k", title: "T", researchQuestion: "q", methods: "m",
    keyFindings: ["f"], limitations: [], relationToProject: "r", createdAt: "t",
    ...over,
  } as StoredReadingCard;
}

describe("V98 · buildReviewPrompt 按 basis 标注", () => {
  test("fulltext → 「依据: 全文」；abstract → 「依据: 仅摘要（原因）」并提醒只引摘要结论；无 basis（老卡）→ 不加行", () => {
    const p = buildReviewPrompt([
      card({ bibtexKey: "a", basis: "fulltext" }),
      card({ bibtexKey: "b", basis: "abstract", basisReason: "无 OA PDF" }),
      card({ bibtexKey: "c" }),
    ]);
    expect(p).toContain("### [@a] T\n依据: 全文");
    expect(p).toContain("### [@b] T\n依据: 仅摘要（无 OA PDF）");
    expect(p).toContain("### [@c] T\n研究问题:");
  });
});
