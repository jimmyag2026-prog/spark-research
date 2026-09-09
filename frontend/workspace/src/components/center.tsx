import { For, Show, createSignal, type JSX } from "solid-js";
import { api, streamChat } from "../lib/api";
import type { NoveltyResult, ReviewResult, TaskSnapshot } from "../lib/types";
import { useWorkspace, withBusy } from "../state";
import { IdeaCardView, NoveltyView, ReadingCardView, ReviewView } from "./cards";
import { Async, Badge, Markdown, Spinner } from "./ui";

// 中栏：会话流（chat / coexplore，SSE 渲染）+ 各类富渲染视图。

const SESSION_ID = `web_${Date.now()}`;

function SessionStream(): JSX.Element {
  const ws = useWorkspace();
  const [mode, setMode] = createSignal<"chat" | "coexplore">("chat");
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
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

    try {
      await streamChat(
        { sessionId: SESSION_ID, message: text, mode: mode() },
        {
          onProgress: (data) => ws.updateMessage(placeholder, { text: data.message, pending: true }),
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
                  <Show when={!message.pending} fallback={<Spinner label={message.text || "思考中…"} />}>
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
    const task = await withBusy(ws, "生成精读卡", () => api.lit.read({ all: true }, ws.slug(), setProgress));
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

  const runReview = async () => {
    const task = await withBusy(ws, "生成综述", () => api.lit.review({}, ws.slug(), setProgress));
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

  const check = async (recordId: string) => {
    setChecking(recordId);
    const task: TaskSnapshot | undefined = await withBusy(ws, "Novelty check", () =>
      api.ideas.check(recordId, ws.slug(), setProgress),
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
  const [content, setContent] = createSignal<{ filename: string; body: string } | null>(null);

  const open = async (id: string, filename: string) => {
    const result = await withBusy(ws, "读取产物", () => api.artifacts.get(id, ws.slug()));
    if (result) setContent({ filename, body: result.artifact.content });
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
                when={file().filename.endsWith(".md")}
                fallback={
                  <pre class="md" style={{ margin: 0 }}>
                    <code>{file().body.slice(0, 20000)}</code>
                  </pre>
                }
              >
                <Markdown source={file().body} knownKeys={ws.knownKeys()} />
              </Show>
            </div>
          </article>
        )}
      </Show>
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
      <Show when={ws.view().kind === "artifacts"}>
        <ArtifactsView />
      </Show>
    </main>
  );
}
