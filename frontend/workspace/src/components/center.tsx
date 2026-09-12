import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { api, streamChat } from "../lib/api";
import type {
  ApiCallAgg,
  ComputeJobView,
  ConclusionCard,
  NoveltyResult,
  ReviewResult,
  TaskSnapshot,
  UsageAgg,
} from "../lib/types";
import { useWorkspace, withBusy } from "../state";
import { IdeaCardView, NoveltyView, ReadingCardView, ReviewView } from "./cards";
import { Async, Badge, BudgetInput, KeyValues, Markdown, parseBudgetInput, Spinner } from "./ui";

// 中栏：会话流（chat / coexplore，SSE 渲染）+ 各类富渲染视图。

const SESSION_ID = `web_${Date.now()}`;

function SessionStream(): JSX.Element {
  const ws = useWorkspace();
  const [mode, setMode] = createSignal<"chat" | "coexplore">("chat");
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  // V119：聊天/共探也是花钱操作，给一个与精读/综述同款的预算入口。
  const [chatBudget, setChatBudget] = createSignal("");
  let scroller: HTMLDivElement | undefined;

  const scrollToEnd = () => queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));

  const send = async () => {
    const text = draft().trim();
    if (!text || sending()) return;
    setDraft("");
    setSending(true);
    ws.pushMessage({ role: "user", mode: mode(), text });
    const placeholder = ws.pushMessage({ role: "agent", mode: mode(), text: "", pending: true });
    scrollToEnd();

    // SSE 流式（W2-d 起，W3 收口改为权威流）：`delta` 逐块到达的是**权威答案本身**
    // 在生成中的增量——不再是「另一次裸模型调用的预览、稍后被整体替换」。
    // 所以这里累加即可，`result` 到达时文本通常已经完整（仍以 result 为准做最终定稿，
    // 因为 review 修正轮可能改写 summary）。
    // 没有任何 delta 到达也完全正常（没配 provider / fake LLM 不支持流式），
    // 界面退化回「思考中…」占位，行为不变。
    let streamed = "";
    try {
      await streamChat(
        // V119：聊天/共探也有预算入口（与精读/综述/novelty 同一个 BudgetInput）。
        { sessionId: SESSION_ID, message: text, mode: mode(), budgetUsd: parseBudgetInput(chatBudget()) },
        {
          onDelta: (data) => {
            streamed += data.chunk;
            ws.updateMessage(placeholder, { text: streamed, pending: true });
            scrollToEnd();
          },
          onProgress: (data) => {
            // 只有还没收到任何增量时才用生命周期文案占位，避免覆盖正在流入的正文。
            if (!streamed) ws.updateMessage(placeholder, { text: data.message, pending: true });
          },
          onResult: (data) => {
            ws.updateMessage(placeholder, { text: data.response, pending: false });
            // co-explore 落了卡就把思路库与时间线刷一下。
            if (data.ideaRecordId) ws.refreshDomain("ideas");
            else ws.refreshDomain("artifacts");
          },
          onError: (data) => {
            ws.updateMessage(placeholder, { role: "error", text: data.message, pending: false });
          },
        },
      );
    } finally {
      setSending(false);
      scrollToEnd();
    }
  };

  return (
    <>
      <div class="stream" ref={scroller} aria-live="polite" aria-label="会话流">
        <Show
          when={ws.messages.length > 0}
          fallback={
            <div class="empty" style={{ margin: "auto", "max-width": "460px" }}>
              <div style={{ "font-weight": "600", "margin-bottom": "6px" }}>开始一次研究会话</div>
              <div class="faint" style={{ "font-size": "12px" }}>
                <strong>chat</strong> 走规划 / 执行 / review 循环；
                <strong>co-explore</strong> 做有文献支撑的批判性共探，产出 Idea 卡。
                <br />
                co-explore 需要项目文献库里有论文，否则所有观点只能标 inferred。
              </div>
            </div>
          }
        >
          <For each={ws.messages}>
            {(message) => (
              <div class={`msg msg-${message.role}`}>
                <div class="msg-head">
                  <span>{message.role === "user" ? "你" : message.role === "error" ? "出错" : "research agent"}</span>
                  <Badge tone={message.mode === "coexplore" ? "computed" : undefined}>{message.mode}</Badge>
                  <span>{message.at.slice(11, 19)}</span>
                </div>
                <div class="msg-body">
                  {/* P14 预览流（W2-d）：pending 且已经有文字 = 预览片段正在逐块到达，
                      直接按 markdown 渲染增长的文字，spinner 只当一个"未定稿"提示条；
                      pending 且还没文字 = 老的"思考中…"占位（没有预览流时的原行为）。 */}
                  <Show when={message.pending}>
                    <Spinner label={message.text ? "预览生成中…" : "思考中…"} />
                  </Show>
                  <Show when={message.text}>
                    <Markdown source={message.text} knownKeys={ws.knownKeys()} />
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="composer">
        <div class="row">
          <div class="tabs" role="tablist" aria-label="会话模式">
            <button
              class="tab"
              role="tab"
              aria-selected={mode() === "chat"}
              onClick={() => setMode("chat")}
            >
              chat
            </button>
            <button
              class="tab"
              role="tab"
              aria-selected={mode() === "coexplore"}
              onClick={() => setMode("coexplore")}
            >
              co-explore
            </button>
          </div>
          <span class="spacer" />
          <Show when={ws.busy()}>
            <Spinner label={ws.busy()!} />
          </Show>
        </div>
        <div class="row" style={{ "align-items": "flex-end" }}>
          <label class="sr-only" for="composer-input">
            消息
          </label>
          <textarea
            id="composer-input"
            class="textarea"
            placeholder={
              mode() === "coexplore" ? "说说你的思路，我来找反面证据…" : "描述你要做的研究任务…"
            }
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <BudgetInput id="chat-budget" value={chatBudget()} onInput={setChatBudget} />
          <button class="btn btn-primary" onClick={send} disabled={sending() || !draft().trim()}>
            {sending() ? "发送中…" : "发送"}
          </button>
        </div>
        <div class="faint" style={{ "font-size": "11.5px" }}>
          ⌘/Ctrl + Enter 发送
        </div>
      </div>
    </>
  );
}

function PapersView(): JSX.Element {
  const ws = useWorkspace();
  const [query, setQuery] = createSignal("");
  const [progress, setProgress] = createSignal("");
  // V79③：精读卡生成花模型钱，UI 此前没有预算入口——填了就按 --budget-usd 同一条闸走，
  // 不填（空字符串 → undefined）就是老行为（只计量、不设闸）。
  const [readBudget, setReadBudget] = createSignal("");

  const search = async () => {
    const q = query().trim();
    if (!q) return;
    const task = await withBusy(ws, "文献检索", () =>
      api.lit.search({ query: q, add: true }, ws.slug(), setProgress),
    );
    setProgress("");
    if (!task) return;
    if (task.state === "failed") {
      ws.notify(task.error?.message ?? "检索失败", "error");
      return;
    }
    const added = (task.result as { added: { added: number; merged: number } | null }).added;
    ws.notify(added ? `入库 ${added.added} 篇新增 / ${added.merged} 篇合并` : "检索完成");
    ws.refreshDomain("papers");
  };

  const readAll = async () => {
    const budgetUsd = parseBudgetInput(readBudget());
    const task = await withBusy(ws, "生成精读卡", () =>
      api.lit.read({ all: true, budgetUsd }, ws.slug(), setProgress),
    );
    setProgress("");
    if (!task) return;
    if (task.state === "failed") {
      ws.notify(task.error?.message ?? "精读卡生成失败", "error");
      return;
    }
    const result = task.result as { cards: unknown[]; failures: unknown[] };
    ws.notify(`生成 ${result.cards.length} 张精读卡，失败 ${result.failures.length} 篇`);
    ws.refreshDomain("cards");
  };

  return (
    <div class="stream">
      <div class="row wrap">
        <label class="sr-only" for="lit-query">
          检索词
        </label>
        <input
          id="lit-query"
          class="input"
          style={{ flex: "1 1 240px" }}
          placeholder="跨源检索并入库，例如 protein structure prediction"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button class="btn btn-primary" onClick={search} disabled={ws.busy() !== null || !query().trim()}>
          检索并入库
        </button>
        <button class="btn" onClick={readAll} disabled={ws.busy() !== null}>
          全部生成精读卡
        </button>
        <BudgetInput id="lit-read-budget" value={readBudget()} onInput={setReadBudget} />
        <a class="btn" href={api.lit.exportUrl("bibtex", ws.slug())} download="library.bib">
          导出 BibTeX
        </a>
      </div>
      <Show when={progress()}>
        <Spinner label={progress()} />
      </Show>

      <Async
        state={{ loading: ws.papers.loading, error: ws.papers.error, data: ws.papers() }}
        isEmpty={(data) => data.papers.length === 0}
        empty={{ title: "文献库还是空的", hint: "先跑一次检索并入库。" }}
      >
        {(data) => (
          <div class="table-scroll">
            <table class="md" style={{ width: "100%", "border-collapse": "collapse" }}>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>年份</th>
                  <th>key</th>
                  <th>阅读</th>
                  <th>PDF</th>
                </tr>
              </thead>
              <tbody>
                <For each={data.papers}>
                  {(paper) => (
                    <tr>
                      <td>{paper.title}</td>
                      <td>{paper.year ?? "—"}</td>
                      <td class="mono">{paper.bibtexKey ?? "—"}</td>
                      <td>{paper.readingStatus}</td>
                      <td>{paper.pdfStatus === "downloaded" ? "✓" : paper.pdfStatus === "unavailable" ? "✗" : "—"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </div>
  );
}

function CardsView(): JSX.Element {
  const ws = useWorkspace();
  const [review, setReview] = createSignal<ReviewResult | null>(null);
  const [progress, setProgress] = createSignal("");
  const [reviewBudget, setReviewBudget] = createSignal("");

  const runReview = async () => {
    const budgetUsd = parseBudgetInput(reviewBudget());
    const task = await withBusy(ws, "生成综述", () => api.lit.review({ budgetUsd }, ws.slug(), setProgress));
    setProgress("");
    if (!task) return;
    if (task.state === "failed") {
      ws.notify(task.error?.message ?? "综述生成失败", "error");
      return;
    }
    setReview(task.result as ReviewResult);
    ws.refreshDomain("artifacts");
  };

  return (
    <div class="stream">
      <div class="row">
        <button class="btn btn-primary" onClick={runReview} disabled={ws.busy() !== null}>
          由精读卡生成综述
        </button>
        <BudgetInput id="lit-review-budget" value={reviewBudget()} onInput={setReviewBudget} />
        <Show when={progress()}>
          <Spinner label={progress()} />
        </Show>
      </div>
      <Show when={review()}>{(result) => <ReviewView result={result()} />}</Show>
      <Async
        state={{ loading: ws.cards.loading, error: ws.cards.error, data: ws.cards() }}
        isEmpty={(data) => data.cards.length === 0}
        empty={{ title: "还没有精读卡", hint: "在文献库页对入库论文批量生成。" }}
      >
        {(data) => <For each={data.cards}>{(card) => <ReadingCardView card={card} />}</For>}
      </Async>
    </div>
  );
}

function IdeasView(): JSX.Element {
  const ws = useWorkspace();
  const [novelty, setNovelty] = createSignal<NoveltyResult | null>(null);
  const [checking, setChecking] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal("");
  // V79③：一张全局预算输入，套用到这个面板里任意一次 novelty check（每张 idea 卡自己
  // 的「跑 Novelty check」按钮都读这一个值）——不是每张卡各配一个输入框，卡片数量不定，
  // 一个共享输入更贴近「我这次愿意花多少钱」这句话本身的粒度。
  const [checkBudget, setCheckBudget] = createSignal("");

  const check = async (recordId: string) => {
    setChecking(recordId);
    const budgetUsd = parseBudgetInput(checkBudget());
    const task: TaskSnapshot | undefined = await withBusy(ws, "Novelty check", () =>
      api.ideas.check(recordId, ws.slug(), setProgress, { budgetUsd }),
    );
    setChecking(null);
    setProgress("");
    if (!task) return;
    if (task.state === "failed") {
      ws.notify(task.error?.message ?? "novelty check 失败", "error");
      return;
    }
    setNovelty(task.result as NoveltyResult);
    ws.refreshDomain("ideas");
  };

  return (
    <div class="stream">
      <div class="row">
        <BudgetInput id="idea-check-budget" value={checkBudget()} onInput={setCheckBudget} />
      </div>
      <Show when={progress()}>
        <Spinner label={progress()} />
      </Show>
      <Show when={novelty()}>{(result) => <NoveltyView result={result()} />}</Show>
      <Async
        state={{ loading: ws.ideas.loading, error: ws.ideas.error, data: ws.ideas() }}
        isEmpty={(data) => data.ideas.length === 0}
        empty={{ title: "思路库是空的", hint: "在会话里切到 co-explore 模式聊出一张 Idea 卡。" }}
      >
        {(data) => (
          <For each={data.ideas}>
            {(card) => (
              <IdeaCardView
                card={card}
                checking={checking() === card.recordId}
                onCheck={() => check(card.recordId)}
              />
            )}
          </For>
        )}
      </Async>
    </div>
  );
}

function ArtifactsView(): JSX.Element {
  const ws = useWorkspace();
  const [content, setContent] = createSignal<{ filename: string; body: string; contentType: string } | null>(null);

  const open = async (id: string, filename: string) => {
    const result = await withBusy(ws, "读取产物", () => api.artifacts.get(id, ws.slug()));
    if (result) setContent({ filename, body: result.artifact.content, contentType: result.artifact.contentType });
  };

  return (
    <div class="stream">
      <Async
        state={{ loading: ws.artifacts.loading, error: ws.artifacts.error, data: ws.artifacts() }}
        isEmpty={(data) => data.artifacts.length === 0}
        empty={{ title: "还没有产物", hint: "跑一次实验或生成一份综述就会有。" }}
      >
        {(data) => (
          <div class="col" style={{ gap: "2px" }}>
            <For each={data.artifacts}>
              {(artifact) => (
                <button class="nav-item" onClick={() => open(artifact.id, artifact.filename)}>
                  <span class="mono">{artifact.filename}</span>
                  <span class="nav-count">v{artifact.version}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </Async>
      <Show when={content()}>
        {(file) => (
          <article class="card">
            <div class="card-head">
              <span class="mono">{file().filename}</span>
              <span class="spacer" />
              <button class="btn btn-sm btn-ghost" onClick={() => setContent(null)}>
                关闭
              </button>
            </div>
            <div class="card-body">
              <Show
                when={file().contentType === "image/svg+xml"}
                fallback={
                  <Show
                    when={file().filename.endsWith(".md")}
                    fallback={
                      <pre class="md" style={{ margin: 0 }}>
                        <code>{file().body.slice(0, 20000)}</code>
                      </pre>
                    }
                  >
                    <Markdown source={file().body} knownKeys={ws.knownKeys()} />
                  </Show>
                }
              >
                {/* data: URI + <img>（不 innerHTML）：SVG 里即便混入 <script> 也不会执行——
                    后端 assertSafeSvg 已校验过一道，这是第二道（AD-7：不引入前端依赖）。 */}
                <img
                  src={"data:image/svg+xml;utf8," + encodeURIComponent(file().body)}
                  alt={file().filename}
                  style={{ "max-width": "100%" }}
                />
              </Show>
            </div>
          </article>
        )}
      </Show>
    </div>
  );
}

// 结论卡与 review 门槛（DESIGN 域 E2 · P8-gate G1）。
//
// 两条 UI 纪律：
//  1. **不替人签名。** 评审要在输入框里填评审人——HTTP 层不接受环境变量兜底（AD-6），
//     前端也不许拿 localStorage 里的什么东西默默顶上。
//  2. **只显示服务端给的状态。** 「现在跑一遍会通过」（assessment.wouldApprove）与
//     「已经通过」（review.state）在界面上是两件不同的事，颜色与文案都不一样。
function ConclusionsView(): JSX.Element {
  const ws = useWorkspace();
  const [actor, setActor] = createSignal("");
  const [open, setOpen] = createSignal<string | null>(null);

  const review = async (card: ConclusionCard, veto?: string) => {
    const who = actor().trim();
    if (!who) {
      ws.notify("请先填写评审人：评审是一个人对一条结论负责，不能匿名", "error");
      return;
    }
    const result = await withBusy(ws, "结论评审", () =>
      api.conclusions.review(card.recordId, { actor: who, ...(veto ? { veto } : {}) }, ws.slug()),
    );
    if (!result) return;
    ws.notify(
      result.approved
        ? `已通过：${card.title}`
        : `已否决：${card.title}（${result.findings.filter((f) => f.severity === "hard").length} 条 hard finding）`,
      result.approved ? "info" : "error",
    );
    ws.refreshDomain("conclusions");
  };

  const tone = (state: ConclusionCard["review"]["state"]) =>
    state === "approved" ? "observed" : state === "vetoed" ? "error" : "inferred";

  return (
    <div class="stream">
      <div class="row wrap">
        <label class="sr-only" for="review-actor">
          评审人
        </label>
        <input
          id="review-actor"
          class="input"
          style={{ flex: "0 1 200px" }}
          placeholder="评审人（记名，必填）"
          value={actor()}
          onInput={(e) => setActor(e.currentTarget.value)}
        />
        <a class="btn" href={api.report.markdownUrl(ws.slug())} download="">
          导出研究报告
        </a>
        <span class="faint" style={{ "font-size": "11.5px" }}>
          只有 approved 的结论进报告「结论」区，pending / vetoed 进「待验证」区。
        </span>
      </div>

      <Async
        state={{ loading: ws.conclusions.loading, error: ws.conclusions.error, data: ws.conclusions() }}
        isEmpty={(data) => data.conclusions.length === 0}
        // V79②：结论卡是实验 conclude 的产物，review 面板天生要求「先有一个跑完的实验」——
        // 这条前置条件此前只体现在这个空态的一句 hint 里，容易被当成「没写清楚」（外部
        // 验收 A5 记的原话）。把 hint 改成先说前置条件、再给下一步动作，两句话都在，
        // 不是空白也不是报错。
        empty={{
          title: "还没有结论卡：先跑一个实验",
          hint: "结论 review 面板要求项目里至少有一条已 conclude 的实验——干实验或湿实验都行。跑完 conclude 后结论卡会自动出现在这里，再来评审。",
        }}
      >
        {(data) => (
          <For each={data.conclusions}>
            {(card) => (
              <article class="card">
                <div class="card-head">
                  <Badge tone={tone(card.review.state)}>{card.review.state}</Badge>
                  <strong>{card.title}</strong>
                  <span class="spacer" />
                  <span class="mono faint" style={{ "font-size": "11px" }}>
                    {card.recordId.slice(0, 8)}
                  </span>
                </div>
                <div class="card-body">
                  <p style={{ margin: "0 0 6px" }}>{card.claim}</p>
                  <p class="faint" style={{ margin: "0 0 6px", "font-size": "12px" }}>
                    证据 {card.evidenceIds.length} 条 · {card.mode}
                    <Show when={card.review.at}>
                      {" · 评审 "}
                      {card.review.actor ?? "(未记名)"} @ {card.review.at} · {card.review.hardCount} hard /{" "}
                      {card.review.softCount} soft
                    </Show>
                  </p>
                  <Show when={card.limitations}>
                    <p class="faint" style={{ margin: "0 0 6px", "font-size": "12px" }}>
                      局限：{card.limitations}
                    </p>
                  </Show>
                  <Show when={card.review.reason}>
                    <p class="faint" style={{ margin: "0 0 6px", "font-size": "12px" }}>
                      人工否决理由：{card.review.reason}
                    </p>
                  </Show>
                  <Show when={card.review.findings.length > 0}>
                    <ul class="md" style={{ margin: "0 0 6px", "padding-left": "18px", "font-size": "12px" }}>
                      <For each={card.review.findings}>
                        {(f) => (
                          <li>
                            <span class="mono">
                              [{f.severity}] {f.rule}
                            </span>{" "}
                            {f.message}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <div class="row wrap">
                    <button class="btn btn-sm btn-primary" onClick={() => review(card)} disabled={ws.busy() !== null}>
                      跑评审
                    </button>
                    <button
                      class="btn btn-sm"
                      onClick={() => setOpen(open() === card.recordId ? null : card.recordId)}
                    >
                      {open() === card.recordId ? "取消人工否决" : "人工否决"}
                    </button>
                    <Show when={open() === card.recordId}>
                      <input
                        class="input"
                        style={{ flex: "1 1 200px" }}
                        placeholder="否决理由（必填）"
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const reason = e.currentTarget.value.trim();
                          if (!reason) return;
                          setOpen(null);
                          void review(card, reason);
                        }}
                      />
                    </Show>
                  </div>
                </div>
              </article>
            )}
          </For>
        )}
      </Async>
    </div>
  );
}

// W6-1 β · 面板①/③ 共用：长任务状态与算力 execution 状态的展示色阶。
//
// 刻意**不**往 ui.tsx 的 `BADGE_TONE` 表里加新键——`tests/unit/narrative_parity.test.ts`
// 的 AD-12 门禁会扫那张表，凡是「看起来像状态」的键都必须能在后端的实验状态机
// （WET_EXPERIMENT_STATES ∪ EXPERIMENT_STATES）并集里查到，任务/算力状态不在那两套
// 状态机里，加进去就是制造一条假阳性、拖着门禁一起改（narrative_parity.test.ts 不在
// 本 lane 的文件所有权内）。这里改用「复用既有色阶键，展示文案仍是真实状态名」的写法：
// `<Badge>` 的 children 永远是后端给的原始状态字符串，`tone` 只借一个视觉上匹配的
// 既有类别，不产生新的「状态名」语义。
function taskTone(state: TaskSnapshot["state"]): string {
  if (state === "failed") return "failed";
  if (state === "running") return "executing";
  if (state === "succeeded") return "concluded";
  return "unchecked"; // pending
}

function computeTone(execution: string): string {
  if (execution === "awaiting_approval") return "awaiting_approval";
  if (execution === "approved") return "approved";
  if (execution === "rejected") return "rejected";
  if (execution === "running" || execution === "queued" || execution === "starting") return "executing";
  if (execution === "succeeded") return "concluded";
  if (execution === "failed" || execution === "timed_out" || execution === "cancelled" || execution === "interrupted") {
    return "failed";
  }
  return "unchecked"; // planned
}

// W6-1 β · 面板①：长任务进度（CLI 对齐 `lit tasks`）。
//
// 数据来自 `GET /api/tasks`——任务快照落盘在 `<项目>/tasks/`（server/tasks.ts），
// 不是前端状态：刷新整个页面、甚至重启服务进程，只要落盘还在，这里就还看得到同样的东西。
// 运行中的任务（pending/running）定时轮询；全部落定就停表，不空转。

const TASK_KIND_LABEL: Record<string, string> = {
  "lit.search": "文献检索",
  "lit.add": "文献入库",
  "lit.pdf": "PDF 下载",
  "lit.read": "精读卡生成",
  "lit.review": "综述生成",
  "idea.coexplore": "co-explore",
  "idea.novelty": "novelty check",
  "exp.run": "干实验闭环",
  "lab.simulate": "湿实验执行",
};

function TaskRow(props: { task: TaskSnapshot }): JSX.Element {
  const pct = createMemo(() => {
    const p = props.task.progress;
    if (!p || !p.total) return null;
    return Math.min(100, Math.round((p.done / p.total) * 100));
  });

  return (
    <article class="card" data-testid="task-row">
      <div class="card-head">
        <span>{TASK_KIND_LABEL[props.task.kind] ?? props.task.kind}</span>
        <Badge tone={taskTone(props.task.state)}>{props.task.state}</Badge>
        {/* recovered：进程重启后从磁盘恢复、但本进程没有真实执行体在跑它——
            「查过没查出来」与「没查过」是两回事，这里同理，不能把它画成与真在跑的任务一样。 */}
        <Show when={props.task.recovered}>
          <Badge tone="inferred" title="进程重启后从磁盘恢复；本进程没有真实执行体在跑它，未必仍在真的运行">
            recovered
          </Badge>
        </Show>
        <span class="spacer" />
        <span class="mono faint" style={{ "font-size": "11px" }}>
          {props.task.id.slice(0, 8)}
        </span>
      </div>
      <div class="card-body">
        <Show when={props.task.progress}>
          {(p) => (
            <Show
              when={pct() !== null}
              fallback={<span class="faint">{p().message ?? `${p().done} 步`}</span>}
            >
              <div class="progress-track">
                <div class="progress-fill" style={{ width: `${pct()}%` }} />
              </div>
              <div class="faint" style={{ "font-size": "11px", "margin-top": "2px" }}>
                {p().done} / {p().total}
                {p().message ? ` · ${p().message}` : ""}
              </div>
            </Show>
          )}
        </Show>
        <Show when={props.task.state === "failed"}>
          <div class="error-box" role="alert" style={{ "margin-top": "6px" }}>
            {props.task.error?.message ?? "任务失败，未附带错误信息"}
          </div>
        </Show>
        <div class="faint" style={{ "font-size": "11px", "margin-top": "6px" }}>
          创建 {props.task.createdAt.replace("T", " ").slice(0, 19)}
          <Show when={props.task.finishedAt}>
            {" "}
            · 完成 {props.task.finishedAt!.replace("T", " ").slice(0, 19)}
          </Show>
        </div>
      </div>
    </article>
  );
}

function TasksView(): JSX.Element {
  const ws = useWorkspace();
  const [tick, setTick] = createSignal(0);
  const [tasks, { refetch }] = createResource(
    () => [ws.slug(), tick()] as const,
    ([slug]) => api.tasks.list(slug, 50),
  );

  // 只要列表里还有 pending/running 就每 2 秒刷一次；全部落定就停表，不空转 poll。
  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const list = tasks()?.tasks ?? [];
    const active = list.some((t) => t.state === "pending" || t.state === "running");
    if (active && timer === undefined) {
      timer = setInterval(() => setTick((n) => n + 1), 2000);
    } else if (!active && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  });
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer);
  });

  return (
    <div class="stream">
      <div class="row">
        <button class="btn btn-sm btn-ghost" onClick={() => void refetch()}>
          ↻ 刷新
        </button>
        <span class="faint" style={{ "font-size": "11.5px" }}>
          运行中的任务每 2 秒自动刷新；任务快照落盘在项目 <span class="mono">tasks/</span>{" "}
          目录，刷新整个页面后仍能看到（不是前端状态）。
        </span>
      </div>
      <Async
        state={{ loading: tasks.loading, error: tasks.error, data: tasks() }}
        onRetry={() => void refetch()}
        isEmpty={(data) => data.tasks.length === 0}
        empty={{ title: "还没有长任务", hint: "跑一次检索、精读卡、综述、novelty check 或实验闭环就会出现在这里。" }}
      >
        {(data) => (
          <div class="col" style={{ gap: "8px" }}>
            <For each={data.tasks}>{(task) => <TaskRow task={task} />}</For>
          </div>
        )}
      </Async>
    </div>
  );
}

// W6-1 β · 面板③：算力（只读，CLI 对齐 `compute list` / `compute status`）。
//
// **这个面板刻意不放任何派发/审批按钮**——不是漏做，是 V47 裁定：HTTP 面上没有
// dispatch 路由（server/routes/compute.ts 顶部注释：MCP 是 HTTP 的一次投影，HTTP
// 开的口子等于给外部 agent 多一条路），派发与审批只在有真实交互终端的地方发起
// （`spark-research compute run` / `compute approve`）。`api.compute` 客户端本身
// 也没有暴露这两个方法，UI 组件从代码层面就没有调用它们的手段。
function ComputeView(): JSX.Element {
  const ws = useWorkspace();
  const [selected, setSelected] = createSignal<string | null>(null);
  const [jobs] = createResource(ws.slug, (s) => api.compute.jobs(s));
  const [detail] = createResource(
    () => (selected() ? ([selected()!, ws.slug()] as const) : null),
    ([id, slug]) => api.compute.job(id, slug),
  );

  const jobLabel = (job: ComputeJobView) => `${job.plan.purpose} · ${job.target.kind}`;

  // 单独取一份 job 出来算 entries：避免在 JSX 里反复调用 `d()`——每次调用在 TS 看来
  // 都是一次新的、可能返回不同结果的函数调用，链式访问 `d().job.approval.actor` 这类
  // 深层可选字段时窄化不过去，会被判成「可能是 null」。
  const jobEntries = (job: ComputeJobView): Array<[string, unknown]> => [
    ["目的", job.plan.purpose],
    ["执行地", job.target.kind],
    ["execution", job.lifecycle.execution],
    ["delivery", job.lifecycle.delivery],
    ["resource", job.lifecycle.resource],
    ["命令", JSON.stringify(job.plan.command)],
    [
      "资源",
      `gpu=${job.plan.resources.gpu ?? "—"} · cpus=${job.plan.resources.cpus} · ` +
        `mem=${job.plan.resources.memoryGb}GB · timeout=${job.plan.resources.timeoutMinutes}min`,
    ],
    [
      "预估上限",
      job.plan.estimate.upperBoundUsd !== null
        ? `$${job.plan.estimate.upperBoundUsd}`
        : "查不到单价（不是免费，只是未知）",
    ],
    ["实际花费", job.actualCostUsd !== null ? `$${job.actualCostUsd}` : job.finishedAt ? "查不到单价" : null],
    ["批准", job.approval ? `${job.approval.actor} @ ${job.approval.at}` : null],
    ["拒绝", job.rejection ? `${job.rejection.actor}：${job.rejection.reason}` : null],
    ["exit", job.exitCode],
    ["message", job.message],
    ["创建", job.createdAt.replace("T", " ").slice(0, 19)],
  ];

  return (
    <div class="stream">
      <div
        class="row wrap"
        data-testid="compute-cli-only-note"
        style={{
          padding: "8px 10px",
          "border-radius": "var(--radius)",
          background: "var(--warn-soft)",
          border: "1px solid var(--warn)",
          color: "var(--warn)",
        }}
      >
        <span>
          派发与审批仅 CLI（安全设计，非缺功能）——这个面板只读；执行用{" "}
          <span class="mono">spark-research compute run &lt;jobId&gt;</span>，审批用{" "}
          <span class="mono">spark-research compute approve &lt;jobId&gt;</span>，
          都需要在有真实交互终端的地方发起。
        </span>
      </div>

      <Async
        state={{ loading: jobs.loading, error: jobs.error, data: jobs() }}
        isEmpty={(data) => data.jobs.length === 0}
        empty={{ title: "还没有算力任务", hint: "CLI 跑一次 spark-research compute plan 会出现在这里。" }}
      >
        {(data) => (
          <div class="col" style={{ gap: "2px" }}>
            <For each={data.jobs}>
              {(job) => (
                <button
                  class="nav-item"
                  aria-current={selected() === job.jobId}
                  onClick={() => setSelected(job.jobId)}
                >
                  <Badge tone={computeTone(job.lifecycle.execution)}>{job.lifecycle.execution}</Badge>
                  <span class="tl-title">{jobLabel(job)}</span>
                  <span class="nav-count mono">{job.jobId.slice(0, 8)}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </Async>

      <Show when={detail()}>
        {(d) => (
          <article class="card">
            <div class="card-head">
              <span class="mono">{d().job.jobId.slice(0, 8)}</span>
              <Badge tone={computeTone(d().job.lifecycle.execution)}>{d().job.lifecycle.execution}</Badge>
              <span class="spacer" />
              <button class="btn btn-sm btn-ghost" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
            <div class="card-body">
              <KeyValues entries={jobEntries(d().job)} />
            </div>
          </article>
        )}
      </Show>
    </div>
  );
}

// W6-1 β · 面板④：用量（CLI 对齐 `usage` / `usage api`）。
//
// **只消费后端算好的数字，前端不做任何成本算术**——两处算同一数字是 V37 的形状。
// unknownCostCalls>0 时的示警文案照抄 CLI 口径（backend/src/cli/usage.ts）：
// 「总花费无法确定报出」。

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

function UsageAggTable(props: { title: string; rows: Record<string, UsageAgg> }): JSX.Element {
  const names = () => Object.keys(props.rows);
  return (
    <div>
      <h3 class="section-title">{props.title}</h3>
      <Show when={names().length > 0} fallback={<span class="faint">（无记录）</span>}>
        <div class="table-scroll">
          <table class="md" style={{ width: "100%", "border-collapse": "collapse" }}>
            <thead>
              <tr>
                <th>名称</th>
                <th>调用</th>
                <th>已知花费（下界）</th>
                <th>未知成本调用</th>
              </tr>
            </thead>
            <tbody>
              <For each={names()}>
                {(name) => (
                  <tr>
                    <td class="mono">{name}</td>
                    <td>{props.rows[name]!.calls}</td>
                    <td>{fmtUsd(props.rows[name]!.knownCostUsd)}</td>
                    <td>{props.rows[name]!.unknownCostCalls}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

function ApiAggTable(props: { title: string; rows: Record<string, ApiCallAgg> }): JSX.Element {
  const names = () => Object.keys(props.rows);
  return (
    <div>
      <h3 class="section-title">{props.title}</h3>
      <Show when={names().length > 0} fallback={<span class="faint">（无记录）</span>}>
        <div class="table-scroll">
          <table class="md" style={{ width: "100%", "border-collapse": "collapse" }}>
            <thead>
              <tr>
                <th>名称</th>
                <th>调用</th>
                <th>429</th>
                <th>401</th>
                <th>其他非 2xx</th>
                <th>平均延迟</th>
                <th>最大延迟</th>
              </tr>
            </thead>
            <tbody>
              <For each={names()}>
                {(name) => (
                  <tr data-testid="connector-health-row">
                    <td class="mono">{name}</td>
                    <td>{props.rows[name]!.calls}</td>
                    <td>{props.rows[name]!.count429}</td>
                    <td>{props.rows[name]!.count401}</td>
                    <td>{props.rows[name]!.otherNon2xx}</td>
                    <td>{Math.round(props.rows[name]!.avgLatencyMs)}ms</td>
                    <td>{Math.round(props.rows[name]!.maxLatencyMs)}ms</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

function UsageView(): JSX.Element {
  const ws = useWorkspace();
  const [usage, { refetch: refetchUsage }] = createResource(ws.slug, (s) => api.usage.get(s));
  const [apiUsage, { refetch: refetchApi }] = createResource(() => api.usage.apiCalls());

  return (
    <div class="stream">
      <div class="row">
        <button
          class="btn btn-sm btn-ghost"
          onClick={() => {
            void refetchUsage();
            void refetchApi();
          }}
        >
          ↻ 刷新
        </button>
      </div>

      <Async
        state={{ loading: usage.loading, error: usage.error, data: usage() }}
        isEmpty={(data) => data.calls === 0}
        empty={{ title: "还没有 LLM 用量记录", hint: "lit read / lit review / idea new / idea check 的调用会自动入账。" }}
      >
        {(data) => (
          <article class="card" data-testid="llm-usage-card">
            <div class="card-head">
              <span>LLM 用量 · 项目 {data.project}</span>
            </div>
            <div class="card-body">
              <p style={{ margin: "0 0 6px" }}>
                调用 {data.calls} 次 · 输入 {data.inputTokens} tokens · 输出 {data.outputTokens} tokens
              </p>
              <p style={{ margin: "0 0 6px" }} data-testid="known-cost-usd">
                已知花费（下界）{fmtUsd(data.knownCostUsd)}
              </p>
              {/* 口径照抄 CLI（backend/src/cli/usage.ts）：未知成本绝不当 0，
                  有未知就不能报确定总数，只报已知下界。 */}
              <Show when={data.unknownCostCalls > 0}>
                <div class="error-box" role="alert" data-testid="unknown-cost-warning">
                  ⚠️ 其中 {data.unknownCostCalls} 次调用成本未知（拿不到 usage 或查不到单价）——
                  总花费无法确定报出，上面的数只是下界。
                </div>
              </Show>
              <UsageAggTable title="按命令" rows={data.byCommand} />
              <UsageAggTable title="按模型" rows={data.byModel} />
              <Show when={data.corruptLines > 0}>
                <p class="faint" style={{ margin: "8px 0 0", "font-size": "11.5px" }}>
                  ⚠️ 台账文件有 {data.corruptLines} 行无法解析（文件可能被手工改过），以上统计不含这些行。
                </p>
              </Show>
            </div>
          </article>
        )}
      </Async>

      <Async
        state={{ loading: apiUsage.loading, error: apiUsage.error, data: apiUsage() }}
        isEmpty={(data) => data.calls === 0}
        empty={{ title: "还没有 connector 调用记录", hint: "任意 connector 发起的 HTTP 请求都会自动入账。" }}
      >
        {(data) => (
          <article class="card">
            <div class="card-head">
              <span>connector 健康度（全局，不分项目）</span>
            </div>
            <div class="card-body">
              <p style={{ margin: "0 0 6px" }}>
                调用 {data.calls} 次 · 429×{data.count429} · 401×{data.count401} · 其他非2xx×{data.otherNon2xx} ·
                平均延迟 {Math.round(data.avgLatencyMs)}ms · 最大延迟 {Math.round(data.maxLatencyMs)}ms
              </p>
              <ApiAggTable title="按 connector" rows={data.byConnector} />
              <ApiAggTable title="按 host" rows={data.byHost} />
              <Show when={data.corruptLines > 0}>
                <p class="faint" style={{ margin: "8px 0 0", "font-size": "11.5px" }}>
                  ⚠️ 台账文件有 {data.corruptLines} 行无法解析（文件可能被手工改过），以上统计不含这些行。
                </p>
              </Show>
            </div>
          </article>
        )}
      </Async>
    </div>
  );
}

export function CenterPanel(): JSX.Element {
  const ws = useWorkspace();
  return (
    <main class="center" aria-label="工作区主视图">
      <Show when={ws.view().kind === "session"}>
        <SessionStream />
      </Show>
      <Show when={ws.view().kind === "papers"}>
        <PapersView />
      </Show>
      <Show when={ws.view().kind === "cards"}>
        <CardsView />
      </Show>
      <Show when={ws.view().kind === "ideas"}>
        <IdeasView />
      </Show>
      <Show when={ws.view().kind === "conclusions"}>
        <ConclusionsView />
      </Show>
      <Show when={ws.view().kind === "artifacts"}>
        <ArtifactsView />
      </Show>
      <Show when={ws.view().kind === "tasks"}>
        <TasksView />
      </Show>
      <Show when={ws.view().kind === "compute"}>
        <ComputeView />
      </Show>
      <Show when={ws.view().kind === "usage"}>
        <UsageView />
      </Show>
    </main>
  );
}
