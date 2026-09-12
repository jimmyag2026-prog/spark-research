// V27：prompt 的编译期内嵌副本（见 ../agents/prompts.ts）。
import { DEFAULT_PROMPT_DIR, projectBackgroundBlock, readPromptText } from "../agents/prompts";
import { libraryKeyIndex } from "../literature/export";
import type { LibraryPaper, LibraryStore } from "../literature/library";
import { extractJsonObject } from "../literature/reading";
import type { ChatMessage, LLMRouter } from "../llm/router";
import type { RecordStore } from "../project/records";
import { citedKeys, isStrongClaim, parseCitations, splitSentences, stripCode } from "../reviewer/rules";
import { validateIdeaCardPayload, type IdeaCard, type StoredIdeaCard } from "./models";
import { IdeaStore } from "./store";

// Co-explore 会话模式（DESIGN 域 A4）。
//
// 与 P3 精读卡/综述同一套管线纪律：schema 校验是硬门 → 不合格把失败原因回灌重试一次 →
// 仍不合格就抛错，**不落半成品 record**。半成品 idea 卡比没有更糟：它会被 novelty check
// 当成待检验的创新点，把一次无效输出放大成一份煞有介事的报告。
//
// 本模式特有的两条硬门（就是设计里「批判性」三个字的可执行形式）：
//   1. 观点必须有来源：[@key] 只能是库内 key，否则显式 inferred。
//   2. contradicting 至少 1 条：给不出反面证据的「共探」只是附和。

export class CoExploreError extends Error {
  readonly attempts: number;
  readonly validationErrors: string[];
  constructor(message: string, options: { attempts: number; validationErrors?: string[] }) {
    super(`CoExplore: ${message}`);
    this.name = "CoExploreError";
    this.attempts = options.attempts;
    this.validationErrors = options.validationErrors ?? [];
  }
}

export const COEXPLORE_PROMPT_FILE = "coexplore.txt";

// V27：默认 promptDir 在单二进制里是 `/$bunfs/root/../agents/prompt`，读不到 →
// co-explore 的 system prompt 静默变成 `[prompt missing: coexplore.txt]`。
// readPromptText 先读真目录（调用方显式传的 promptDir 依然优先），再落内嵌副本。
export function loadCoExplorePrompt(promptDir = DEFAULT_PROMPT_DIR): string {
  return readPromptText(promptDir, COEXPLORE_PROMPT_FILE) ?? `[prompt missing: ${COEXPLORE_PROMPT_FILE}]`;
}

// ── grounding 检查 ──────────────────────────────────────────────────────────

// 显式推断标记。允许中英文括号与方括号三种写法——模型在中文正文里几乎必然用全角括号。
export const INFERRED_MARKER = /\((inferred|推断)\)|（(inferred|推断)）|\[(inferred|推断)\]/i;

export function isMarkedInferred(sentence: string): boolean {
  return INFERRED_MARKER.test(sentence);
}

export interface GroundingReport {
  citedKeys: string[];
  // 引用了库外 key（伪造引用）——这是硬错误，会触发重试/拒绝。
  unknownKeys: string[];
  // 强断言句既没引用也没标 inferred——soft 提示，不拦，但要如实报出来。
  ungroundedClaims: string[];
}

// 复用 P3 的引用解析与强断言识别（reviewer/rules.ts），不另起一套口径。
export function groundingCheck(text: string, knownKeys: Iterable<string>): GroundingReport {
  const known = new Set(knownKeys);
  const keys = citedKeys(text);
  const cited = new Set(parseCitations(text).map((c) => `${c.sentenceIndex}`));
  const ungrounded: string[] = [];
  splitSentences(stripCode(text)).forEach((sentence, index) => {
    if (!isStrongClaim(sentence)) return;
    if (cited.has(String(index)) || /\[@[A-Za-z0-9]/.test(sentence)) return;
    if (isMarkedInferred(sentence)) return;
    ungrounded.push(sentence);
  });
  return {
    citedKeys: keys,
    unknownKeys: keys.filter((k) => !known.has(k)),
    ungroundedClaims: ungrounded,
  };
}

// ── prompt ──────────────────────────────────────────────────────────────────

function paperLine(paper: LibraryPaper, key: string): string {
  const author = paper.authors[0]?.name ?? "作者未知";
  const bits = [author, paper.year ?? "n.d.", paper.venue ?? "未知 venue"].join(", ");
  const gist = paper.abstract ? ` — ${paper.abstract.replace(/\s+/g, " ").slice(0, 220)}` : "";
  return `- [@${key}] ${paper.title} (${bits})${gist}`;
}

export function buildCoExplorePrompt(
  message: string,
  papers: LibraryPaper[],
  keyOf: (paperId: string) => string,
  projectContext?: string,
): string {
  const whitelist =
    papers.length > 0
      ? papers.map((p) => paperLine(p, keyOf(p.id))).join("\n")
      : "（项目文献库为空。你没有任何可引用的 key —— 所有观点都必须标 (inferred)，" +
        "并且第一件事应该是告诉用户：先跑 spark-research lit search --add 把相关文献入库，" +
        "否则这次共探没有证据基础。）";
  const block = projectBackgroundBlock(projectContext);
  return [
    block || "（本项目未填写描述）",
    "",
    `可用引用 key 白名单（项目文献库，共 ${papers.length} 篇；白名单之外一律不许引）：`,
    whitelist,
    "",
    "用户的思路 / 问题：",
    message.trim(),
  ].join("\n");
}

// V89：hypothesis 归一化，供 `save()` 的去重判据用。抹掉大小写、全/半角空白、
// 中英文常见标点——只是为了识别「同一句话」，不是语义相似度判断，故意保守。
const NORMALIZE_PUNCTUATION = /[\s　，。！？、,.!?;:；：""''「」『』（）()\-—_]+/g;

export function normalizeHypothesis(text: string): string {
  return text.toLowerCase().replace(NORMALIZE_PUNCTUATION, "");
}

// ── 会话 ────────────────────────────────────────────────────────────────────

export interface CoExploreDeps {
  llm: Pick<LLMRouter, "call">;
  library: LibraryStore;
  records?: RecordStore;
  model?: string;
  projectContext?: string;
  promptDir?: string;
}

export interface CoExploreTurnResult {
  card: IdeaCard;
  grounding: GroundingReport;
  attempts: number;
  model: string | null;
  // 追加了本轮问答的历史，可直接喂给下一轮（多轮共探）。
  history: ChatMessage[];
}

export interface CoExploreOptions {
  history?: ChatMessage[];
  sessionId?: string | null;
}

export class CoExploreSession {
  constructor(private deps: CoExploreDeps) {}

  private knownKeys(): string[] {
    return libraryKeyIndex(this.deps.library.list()).keys;
  }

  // 一轮共探：批判性讨论 + 结构化 idea 卡（未落库）。
  async turn(message: string, options: CoExploreOptions = {}): Promise<CoExploreTurnResult> {
    if (!message.trim()) throw new CoExploreError("用户消息为空，没有可探讨的思路", { attempts: 0 });
    const papers = this.deps.library.list();
    const index = libraryKeyIndex(papers);
    const known = index.keys;
    const system = loadCoExplorePrompt(this.deps.promptDir);
    const userPrompt = buildCoExplorePrompt(
      message,
      papers,
      (id) => index.byId.get(id) ?? id,
      this.deps.projectContext,
    );
    const history = options.history ?? [];

    let lastErrors: string[] = [];
    let lastRaw = "";
    let lastFailure: "call" | "schema" = "schema";

    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: userPrompt },
      ];
      if (attempt === 2) {
        messages.push({
          role: "user",
          content:
            "上一次输出不符合 idea 卡的输出契约，请只重新输出修正后的 JSON 对象。校验失败原因：\n" +
            lastErrors.map((e) => `- ${e}`).join("\n"),
        });
      }

      const response = this.deps.model
        ? await this.deps.llm.call(messages, this.deps.model)
        : await this.deps.llm.call(messages);
      if (!response.ok) {
        lastErrors = [`模型调用失败: ${response.error?.message ?? "未知原因"}`];
        lastFailure = "call";
        continue;
      }
      lastRaw = response.content;

      const validation = validateIdeaCardPayload(extractJsonObject(response.content), { knownKeys: known });
      if (!validation.ok) {
        lastErrors = validation.errors;
        lastFailure = "schema";
        continue;
      }
      const card = validation.fields!;
      // critique 正文里的引用同样只能指向库内 key（结构化字段过了不代表正文过了）。
      const grounding = groundingCheck(card.critique, known);
      if (grounding.unknownKeys.length > 0) {
        lastErrors = [
          `讨论正文引用了库外 key: ${grounding.unknownKeys.map((k) => `[@${k}]`).join(", ")}；` +
            "只能引用白名单里的 key，或把该观点标成 (inferred)",
        ];
        lastFailure = "schema";
        continue;
      }

      return {
        card,
        grounding,
        attempts: attempt,
        model: response.model,
        history: [...history, { role: "user", content: userPrompt }, { role: "assistant", content: card.critique }],
      };
    }

    const reason = lastFailure === "call" ? "模型两次都没能返回内容" : "重试 1 次后输出仍不合契约";
    throw new CoExploreError(
      `idea 卡生成失败（${reason}）: ${lastErrors.join("; ")}` +
        (lastFailure === "schema" && lastRaw ? `\n原始输出（截断 300 字）: ${lastRaw.slice(0, 300)}` : ""),
      { attempts: 2, validationErrors: lastErrors },
    );
  }

  // 落库：idea record + supports/contradicts 边。
  //
  // V89（review A6 Low）：co-explore 有时会把同一个 hypothesis 存成两张几乎一样的 Idea 卡
  // （重试 / 双击 / 同一条消息在一个会话里被重复提交）。读遍 coexplore.ts 之后判定：
  // 当前代码没有任何「一次生成故意产两张卡（主/备假设）」的机制——`turn()` 每次调用只
  // 产一张卡，`explore()`/HTTP `/api/ideas` 每次请求也只 `save()` 一次。所以两张雷同卡
  // 不是设计意图，是**重复记录**；对策是去重，不是加 `role: primary|alternate` 的 UI 语义
  // （models.ts/store.ts 不在本 lane 足迹内，也没有证据支持这个语义真的存在）。
  //
  // 去重范围刻意收窄到**同一个 sessionId 内**，不是整个项目的思路库：
  //   - 真正会触发这条 bug 的场景（网络重试、UI 双击、同一轮对话里客户端把同一条消息
  //     发了两次）天然共享同一个 sessionId——同一次交互，同一个会话。
  //   - 两个不相干的会话（甚至同一用户不同时间）各自独立聊到同一个假设，是两条
  //     真实发生过的思路，不该被硬合并成一条——那是另一种编造信息（假装其中一次
  //     交互没发生过）。
  //   - `sessionId` 缺省（CLI 非交互单次调用、多数单测没有会话概念）时完全不做这个
  //     比对，维持老行为：每次 save 都是新记录。这不是偷懒——没有 sessionId 就没有
  //     「同一次交互」这个锚点，瞎猜等于制造新的假阳性。
  // 去重判据：`hypothesis` 归一化（大小写、全半角空白、常见中英文标点都抹掉）后逐字
  // 相同。只比 hypothesis 不比 critique——同一个假设，讨论正文允许因为重试而略有出入，
  // 但「这是同一条思路」不该因为措辞不同就被判成两条。
  save(card: IdeaCard, options: { sessionId?: string | null; model?: string | null } = {}): StoredIdeaCard {
    if (!this.deps.records) {
      throw new CoExploreError("没有注入 RecordStore，idea 卡无处落库", { attempts: 0 });
    }
    const store = new IdeaStore(this.deps.records, this.deps.library);
    if (options.sessionId) {
      const normalized = normalizeHypothesis(card.hypothesis);
      const duplicate = this.deps.records
        .list({ type: "idea", sessionId: options.sessionId })
        .map((record) => store.fromRecord(record))
        .find(
          (existing): existing is StoredIdeaCard =>
            existing !== null && normalizeHypothesis(existing.hypothesis) === normalized,
        );
      if (duplicate) return duplicate;
    }
    return store.create(card, {
      sessionId: options.sessionId ?? null,
      model: options.model ?? null,
    });
  }

  // 一步到位：单条消息 → 讨论 → 卡片 → 落库（CLI 的 `idea new -m` 走这条）。
  async explore(
    message: string,
    options: CoExploreOptions = {},
  ): Promise<CoExploreTurnResult & { stored: StoredIdeaCard }> {
    const result = await this.turn(message, options);
    const stored = this.save(result.card, { sessionId: options.sessionId ?? null, model: result.model });
    return { ...result, stored };
  }
}
