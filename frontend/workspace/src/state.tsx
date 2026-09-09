import {
  createContext,
  createResource,
  createSignal,
  useContext,
  type Accessor,
  type JSX,
  type Resource,
} from "solid-js";
import { createStore } from "solid-js/store";
import { api } from "./lib/api";
import type {
  DryExperiment,
  IdeaCard,
  LibraryPaper,
  ProjectMeta,
  ProjectSummary,
  ReadingCard,
  ResearchRecord,
  StateMachine,
  WetExperiment,
} from "./lib/types";

// 工作台状态。
//
// 口径：**服务端是唯一真源**，前端不维护影子副本。所有列表都是 createResource，
// 动作跑完就 refetch 对应资源，不去手工往本地数组里塞一条「乐观更新」——
// 那正是「UI 显示的和 record 里存的不一样」的来源，而这个产品的卖点就是证据可信。

export type CenterView =
  | { kind: "session" }
  | { kind: "papers" }
  | { kind: "cards" }
  | { kind: "ideas" }
  | { kind: "artifacts" };

export interface StreamMessage {
  id: number;
  role: "user" | "agent" | "system" | "error";
  mode: "chat" | "coexplore";
  text: string;
  at: string;
  // 富渲染附件：综述 / novelty 报告 / idea 卡。
  attachment?: { kind: "review" | "novelty" | "idea" | "reading"; payload: unknown };
  pending?: boolean;
}

export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

interface WorkspaceValue {
  project: Resource<ProjectSummary>;
  projects: Resource<{ projects: ProjectMeta[]; current: string | null }>;
  slug: Accessor<string | undefined>;
  refetchProject: () => void;

  records: Resource<{ records: ResearchRecord[]; total: number }>;
  papers: Resource<{ papers: LibraryPaper[]; citations: number }>;
  cards: Resource<{ cards: ReadingCard[] }>;
  ideas: Resource<{ ideas: IdeaCard[] }>;
  dry: Resource<{ experiments: DryExperiment[] }>;
  wet: Resource<{ experiments: WetExperiment[] }>;
  artifacts: Resource<{ artifacts: Array<{ id: string; filename: string; createdAt: string; version: number }> }>;
  dryMachine: Resource<StateMachine>;
  wetMachine: Resource<StateMachine>;

  // 一次动作可能同时影响 record 时间线与某个域列表，所以给一个「全刷」。
  refreshAll: () => void;
  refreshDomain: (domain: "papers" | "cards" | "ideas" | "dry" | "wet" | "artifacts") => void;

  view: Accessor<CenterView>;
  setView: (view: CenterView) => void;
  selectedRecord: Accessor<string | null>;
  selectRecord: (id: string | null) => void;
  selectedExperiment: Accessor<{ mode: "dry" | "wet"; id: string } | null>;
  selectExperiment: (value: { mode: "dry" | "wet"; id: string } | null) => void;

  messages: StreamMessage[];
  pushMessage: (message: Omit<StreamMessage, "id" | "at">) => number;
  updateMessage: (id: number, patch: Partial<StreamMessage>) => void;

  toasts: Toast[];
  notify: (message: string, kind?: "info" | "error") => void;

  // 库内 bibtex key 白名单：Markdown 渲染据此把库外引用标红。
  knownKeys: Accessor<Set<string>>;

  busy: Accessor<string | null>;
  setBusy: (label: string | null) => void;
}

const WorkspaceContext = createContext<WorkspaceValue>();

export function WorkspaceProvider(props: { children: JSX.Element }): JSX.Element {
  const [projects, projectsCtl] = createResource(() => api.projects.list(true));
  const [project, projectCtl] = createResource(async () => (await api.projects.current()).project);
  const slug = () => project()?.slug;

  // 所有域资源都以 slug 为 source：切项目 → 自动全部重取，不用手工级联。
  const [records, recordsCtl] = createResource(slug, (s) => api.records.list(s, { limit: 200 }));
  const [papers, papersCtl] = createResource(slug, (s) => api.lit.papers(s));
  const [cards, cardsCtl] = createResource(slug, (s) => api.lit.cards(s));
  const [ideas, ideasCtl] = createResource(slug, (s) => api.ideas.list(s));
  const [dry, dryCtl] = createResource(slug, (s) => api.experiments.list(s));
  const [wet, wetCtl] = createResource(slug, (s) => api.lab.list(s));
  const [artifacts, artifactsCtl] = createResource(slug, (s) => api.artifacts.list(s));
  const [dryMachine] = createResource(() => api.experiments.machine());
  const [wetMachine] = createResource(() => api.lab.machine());

  const [view, setView] = createSignal<CenterView>({ kind: "session" });
  const [selectedRecord, selectRecord] = createSignal<string | null>(null);
  const [selectedExperiment, selectExperiment] = createSignal<{ mode: "dry" | "wet"; id: string } | null>(
    null,
  );
  const [busy, setBusy] = createSignal<string | null>(null);

  const [messages, setMessages] = createStore<StreamMessage[]>([]);
  const [toasts, setToasts] = createStore<Toast[]>([]);
  let seq = 0;

  const pushMessage: WorkspaceValue["pushMessage"] = (message) => {
    const id = ++seq;
    setMessages(messages.length, { ...message, id, at: new Date().toISOString() });
    return id;
  };

  const updateMessage: WorkspaceValue["updateMessage"] = (id, patch) => {
    const index = messages.findIndex((m) => m.id === id);
    if (index >= 0) setMessages(index, patch);
  };

  const notify: WorkspaceValue["notify"] = (message, kind = "info") => {
    const id = ++seq;
    setToasts(toasts.length, { id, kind, message });
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === "error" ? 8000 : 3500);
  };

  const refreshDomain: WorkspaceValue["refreshDomain"] = (domain) => {
    const map = {
      papers: papersCtl,
      cards: cardsCtl,
      ideas: ideasCtl,
      dry: dryCtl,
      wet: wetCtl,
      artifacts: artifactsCtl,
    };
    void map[domain].refetch();
    // 任何域动作都会往证据图里写东西，时间线与计数跟着刷。
    void recordsCtl.refetch();
    void projectCtl.refetch();
  };

  const refreshAll = () => {
    void projectsCtl.refetch();
    void projectCtl.refetch();
    void recordsCtl.refetch();
    void papersCtl.refetch();
    void cardsCtl.refetch();
    void ideasCtl.refetch();
    void dryCtl.refetch();
    void wetCtl.refetch();
    void artifactsCtl.refetch();
  };

  const knownKeys = () =>
    new Set((papers()?.papers ?? []).map((p) => p.bibtexKey).filter((k): k is string => Boolean(k)));

  const value: WorkspaceValue = {
    project,
    projects,
    slug,
    refetchProject: () => {
      void projectCtl.refetch();
      void projectsCtl.refetch();
    },
    records,
    papers,
    cards,
    ideas,
    dry,
    wet,
    artifacts,
    dryMachine,
    wetMachine,
    refreshAll,
    refreshDomain,
    view,
    setView,
    selectedRecord,
    selectRecord,
    selectedExperiment,
    selectExperiment,
    messages,
    pushMessage,
    updateMessage,
    toasts,
    notify,
    knownKeys,
    busy,
    setBusy,
  };

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return value;
}

// 统一的动作包装：跑之前置忙、失败弹 toast、无论成败都解除忙态。
// 每个按钮各写一遍 try/catch 的结果一定是漏几个 finally，界面卡在「运行中」。
export async function withBusy<T>(
  ws: WorkspaceValue,
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  ws.setBusy(label);
  try {
    return await fn();
  } catch (error) {
    ws.notify(error instanceof Error ? error.message : String(error), "error");
    return undefined;
  } finally {
    ws.setBusy(null);
  }
}
