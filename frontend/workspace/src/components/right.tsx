import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { api } from "../lib/api";
import type { RecordEdge, RecordType, ResearchRecord } from "../lib/types";
import { useWorkspace } from "../state";
import { Async, Badge, Markdown } from "./ui";

// 右栏：record 时间线（类型/时间过滤）+ 证据子图 + 产物浏览。

const TYPE_LABEL: Record<RecordType, string> = {
  idea: "思路",
  decision: "决策",
  experiment: "实验",
  observation: "观察",
  reading: "精读",
  conclusion: "结论",
  paper: "文献",
  artifact: "产物",
};

const WINDOWS = [
  { id: "all", label: "全部", hours: null },
  { id: "1h", label: "1 小时", hours: 1 },
  { id: "24h", label: "24 小时", hours: 24 },
  { id: "7d", label: "7 天", hours: 24 * 7 },
] as const;

// 力导向布局太重，也不稳定。这里用确定性的环形布局：
// 根在圆心，其余按边的方向分内外两环——同一张图每次打开长得一样，截图能对照。
function GraphView(props: { rootId: string; nodes: ResearchRecord[]; edges: RecordEdge[] }): JSX.Element {
  const layout = createMemo(() => {
    const size = 260;
    const center = size / 2;
    const others = props.nodes.filter((n) => n.id !== props.rootId);
    const positions = new Map<string, { x: number; y: number; record: ResearchRecord }>();
    const root = props.nodes.find((n) => n.id === props.rootId);
    if (root) positions.set(root.id, { x: center, y: center, record: root });
    others.forEach((node, index) => {
      const ring = index < 8 ? 0 : 1;
      const perRing = ring === 0 ? Math.min(others.length, 8) : Math.max(others.length - 8, 1);
      const offset = ring === 0 ? index : index - 8;
      const angle = (offset / perRing) * Math.PI * 2 - Math.PI / 2;
      const radius = ring === 0 ? 74 : 112;
      positions.set(node.id, {
        x: center + Math.cos(angle) * radius,
        y: center + Math.sin(angle) * radius,
        record: node,
      });
    });
    return { size, positions };
  });

  return (
    <svg
      class="graph"
      viewBox={`0 0 ${layout().size} ${layout().size}`}
      role="img"
      aria-label={`证据子图：${props.nodes.length} 个节点，${props.edges.length} 条边`}
    >
      <For each={props.edges}>
        {(edge) => {
          const from = layout().positions.get(edge.sourceId);
          const to = layout().positions.get(edge.targetId);
          return (
            <Show when={from && to}>
              <line
                class="graph-edge"
                data-type={edge.type}
                x1={from!.x}
                y1={from!.y}
                x2={to!.x}
                y2={to!.y}
              >
                <title>{`${edge.type}`}</title>
              </line>
            </Show>
          );
        }}
      </For>
      <For each={[...layout().positions.values()]}>
        {(node) => (
          <g class="graph-node" data-root={node.record.id === props.rootId}>
            <circle cx={node.x} cy={node.y} r={node.record.id === props.rootId ? 7 : 5}>
              <title>{`${TYPE_LABEL[node.record.type]} · ${node.record.title || node.record.id.slice(0, 8)}`}</title>
            </circle>
            <text x={node.x + 8} y={node.y + 3}>
              {TYPE_LABEL[node.record.type]}
            </text>
          </g>
        )}
      </For>
    </svg>
  );
}

function RecordDetail(props: { id: string }): JSX.Element {
  const ws = useWorkspace();
  const [detail] = createResource(
    () => [props.id, ws.slug()] as const,
    ([id, slug]) => api.records.get(id, slug),
  );
  const [graph] = createResource(
    () => [props.id, ws.slug()] as const,
    ([id, slug]) => api.records.graph(id, 2, slug),
  );

  return (
    <div class="section">
      <Async state={{ loading: detail.loading, error: detail.error, data: detail() }}>
        {(data) => (
          <div class="col">
            <div class="row wrap">
              <Badge tone={data.record.type}>{TYPE_LABEL[data.record.type]}</Badge>
              {/* 证据成色是这个产品的核心，永远显示，不折叠。 */}
              <Badge tone={data.record.evidence}>{data.record.evidence}</Badge>
              <span class="mono faint">{data.record.id.slice(0, 8)}</span>
            </div>
            <div style={{ "font-weight": "600" }}>{data.record.title || "（无标题）"}</div>
            <div class="faint" style={{ "font-size": "11.5px" }}>
              {data.record.createdAt.replace("T", " ").slice(0, 19)} · 来源 {data.record.origin.kind}
            </div>

            <details open>
              <summary class="faint" style={{ cursor: "pointer" }}>
                正文
              </summary>
              <div style={{ "max-height": "260px", overflow: "auto" }}>
                <Markdown source={data.record.content} knownKeys={ws.knownKeys()} />
              </div>
            </details>

            <Show when={data.artifact}>
              {(artifact) => (
                <details>
                  <summary class="faint" style={{ cursor: "pointer" }}>
                    产物 {artifact().filename}
                  </summary>
                  <pre class="mono" style={{ "max-height": "200px", overflow: "auto", margin: "6px 0 0" }}>
                    {artifact().content.slice(0, 8000)}
                  </pre>
                </details>
              )}
            </Show>

            <div>
              <h3 class="section-title">证据子图</h3>
              <Async state={{ loading: graph.loading, error: graph.error, data: graph() }}>
                {(g) => (
                  <>
                    <GraphView rootId={g.rootId} nodes={g.nodes} edges={g.edges} />
                    <div class="faint" style={{ "font-size": "11.5px", "margin-top": "4px" }}>
                      {g.nodes.length} 节点 · {g.edges.length} 边 · 深度 {g.depth}
                    </div>
                    <div class="col" style={{ gap: "2px", "margin-top": "6px" }}>
                      <For each={[...data.outgoing, ...data.incoming]}>
                        {(edge) => {
                          const outgoing = edge.sourceId === data.record.id;
                          const otherId = outgoing ? edge.targetId : edge.sourceId;
                          const other = g.nodes.find((n) => n.id === otherId);
                          return (
                            <button
                              class="nav-item"
                              style={{ "font-size": "11.5px" }}
                              onClick={() => ws.selectRecord(otherId)}
                            >
                              <span class="mono">{outgoing ? "→" : "←"}</span>
                              <span>{edge.type}</span>
                              <span class="nav-count">
                                {other ? TYPE_LABEL[other.type] : otherId.slice(0, 8)}
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </>
                )}
              </Async>
            </div>
          </div>
        )}
      </Async>
    </div>
  );
}

export function RightPanel(): JSX.Element {
  const ws = useWorkspace();
  const [types, setTypes] = createSignal<RecordType[]>([]);
  const [windowId, setWindowId] = createSignal<(typeof WINDOWS)[number]["id"]>("all");

  const since = () => {
    const hours = WINDOWS.find((w) => w.id === windowId())?.hours;
    return hours ? new Date(Date.now() - hours * 3600_000).toISOString() : undefined;
  };

  // 过滤在**客户端**做，是因为时间线一次已经取回本项目最近 200 条；
  // 数据量再大就该改成把 type/since 透给 /api/records（端点已经支持）。
  const filtered = createMemo(() => {
    const all = ws.records()?.records ?? [];
    const selected = types();
    const from = since();
    return all
      .filter((r) => (selected.length === 0 ? true : selected.includes(r.type)))
      .filter((r) => (from ? r.createdAt >= from : true))
      .slice()
      .reverse();
  });

  const toggleType = (type: RecordType) => {
    setTypes((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type],
    );
  };

  return (
    <aside class="right" aria-label="证据时间线">
      <div class="section">
        <h2 class="section-title">
          时间线
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" onClick={() => ws.refreshAll()} title="刷新">
            ↻
          </button>
        </h2>
        <div class="filters" role="group" aria-label="按类型过滤">
          <For each={Object.keys(TYPE_LABEL) as RecordType[]}>
            {(type) => (
              <button
                class="chip"
                aria-pressed={types().includes(type)}
                onClick={() => toggleType(type)}
              >
                {TYPE_LABEL[type]}
              </button>
            )}
          </For>
        </div>
        <div class="filters" role="group" aria-label="按时间过滤" style={{ "margin-top": "6px" }}>
          <For each={WINDOWS}>
            {(w) => (
              <button
                class="chip"
                aria-pressed={windowId() === w.id}
                onClick={() => setWindowId(w.id)}
              >
                {w.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="section" style={{ flex: "1 1 auto", "overflow-y": "auto" }}>
        <Async
          state={{ loading: ws.records.loading, error: ws.records.error, data: ws.records() }}
          onRetry={() => ws.refreshAll()}
        >
          {(data) => (
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="empty">
                  {data.records.length === 0
                    ? "还没有 record。做点什么就会有。"
                    : "当前过滤条件下没有 record。"}
                </div>
              }
            >
              <ul class="timeline">
                <For each={filtered()}>
                  {(record) => (
                    <li class="tl-item" data-selected={ws.selectedRecord() === record.id}>
                      <button
                        class="tl-btn"
                        onClick={() =>
                          ws.selectRecord(ws.selectedRecord() === record.id ? null : record.id)
                        }
                      >
                        <span class="row" style={{ gap: "5px" }}>
                          <Badge tone={record.type}>{TYPE_LABEL[record.type]}</Badge>
                          <Badge tone={record.evidence}>{record.evidence}</Badge>
                          <span class="faint" style={{ "font-size": "11px" }}>
                            {record.createdAt.slice(11, 16)}
                          </span>
                        </span>
                        <span class="tl-title">{record.title || record.content.slice(0, 60) || "（无标题）"}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <div class="faint" style={{ "font-size": "11.5px", "margin-top": "6px" }}>
                显示 {filtered().length} / 共 {data.total} 条
              </div>
            </Show>
          )}
        </Async>
      </div>

      <Show when={ws.selectedRecord()}>{(id) => <RecordDetail id={id()} />}</Show>
    </aside>
  );
}
