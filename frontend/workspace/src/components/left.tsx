import { For, Show, createSignal, type JSX } from "solid-js";
import { api } from "../lib/api";
import { useWorkspace, withBusy, type CenterView } from "../state";
import { Modal, Spinner } from "./ui";

// 左栏：项目切换器 + 导航树。
// 导航项上的计数直接来自 /api/projects/current 的 counts——不在前端另算一遍，
// 否则「界面上写 3 篇、库里其实 4 篇」这种偏差会悄悄出现。

function NavItem(props: {
  label: string;
  count?: number;
  view: CenterView["kind"];
  onSelect: () => void;
  current: boolean;
}): JSX.Element {
  return (
    <button class="nav-item" aria-current={props.current} onClick={props.onSelect}>
      <span>{props.label}</span>
      <Show when={props.count !== undefined}>
        <span class="nav-count">{props.count}</span>
      </Show>
    </button>
  );
}

function NewProjectDialog(props: { onClose: () => void }): JSX.Element {
  const ws = useWorkspace();
  const [slug, setSlug] = createSignal("");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");

  const submit = async () => {
    if (!slug().trim()) return;
    const created = await withBusy(ws, "建项目", () =>
      api.projects.create({
        slug: slug().trim(),
        name: name().trim() || undefined,
        description: description().trim() || undefined,
      }),
    );
    if (!created) return;
    ws.notify(`项目 ${created.project.slug} 已创建`);
    ws.refreshAll();
    props.onClose();
  };

  return (
    <Modal
      title="新建项目"
      onClose={props.onClose}
      footer={
        <>
          <button class="btn" onClick={props.onClose}>
            取消
          </button>
          <button class="btn btn-primary" onClick={submit} disabled={!slug().trim() || ws.busy() !== null}>
            创建
          </button>
        </>
      }
    >
      <label class="col" style={{ gap: "4px" }}>
        <span class="faint">标识（slug，小写字母/数字/连字符）</span>
        <input
          class="input"
          value={slug()}
          placeholder="protein-folding"
          onInput={(e) => setSlug(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <label class="col" style={{ gap: "4px" }}>
        <span class="faint">名称（可选）</span>
        <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="col" style={{ gap: "4px" }}>
        <span class="faint">研究问题 / 描述（可选，会作为共探与精读的项目上下文）</span>
        <textarea
          class="textarea"
          value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
    </Modal>
  );
}

export function LeftPanel(): JSX.Element {
  const ws = useWorkspace();
  const [dialog, setDialog] = createSignal(false);
  const counts = () => ws.project()?.counts;

  const switchProject = async (slug: string) => {
    if (slug === ws.slug()) return;
    const opened = await withBusy(ws, "切换项目", () => api.projects.open(slug));
    if (!opened) return;
    ws.selectRecord(null);
    ws.selectExperiment(null);
    ws.refreshAll();
  };

  return (
    <nav class="left" aria-label="项目与导航">
      <div class="section">
        <h2 class="section-title">项目</h2>
        <Show when={ws.projects()} fallback={<Spinner />}>
          {(list) => (
            <div class="col" style={{ gap: "6px" }}>
              <label class="sr-only" for="project-select">
                选择项目
              </label>
              <select
                id="project-select"
                class="select"
                value={ws.slug() ?? ""}
                onChange={(e) => switchProject(e.currentTarget.value)}
              >
                <For each={list().projects}>
                  {(item) => (
                    // V90：只显示 name 时，`data import` 产物如果和原项目重名（常见——
                    // import 默认沿用来源项目的 dcat.title）在下拉框里长得一模一样，
                    // 选错项目不会有任何提示。带上 slug——它是真正的唯一标识，import
                    // 产物哪怕撞名，slug 也不会撞（ProjectManager 建项目时 slug 唯一）。
                    <option value={item.slug}>
                      {item.name} ({item.slug})
                      {item.status === "archived" ? "（已归档）" : ""}
                    </option>
                  )}
                </For>
              </select>
              <button class="btn btn-sm" onClick={() => setDialog(true)}>
                ＋ 新建项目
              </button>
            </div>
          )}
        </Show>
        <Show when={ws.project()?.description}>
          <p class="muted" style={{ margin: "8px 0 0", "font-size": "12px" }}>
            {ws.project()!.description}
          </p>
        </Show>
      </div>

      <div class="section">
        <h2 class="section-title">工作区</h2>
        <div class="col" style={{ gap: "1px" }}>
          <NavItem
            label="会话"
            view="session"
            current={ws.view().kind === "session"}
            onSelect={() => ws.setView({ kind: "session" })}
          />
          <NavItem
            label="文献库"
            count={counts()?.papers}
            view="papers"
            current={ws.view().kind === "papers"}
            onSelect={() => ws.setView({ kind: "papers" })}
          />
          <NavItem
            label="精读卡"
            count={ws.cards()?.cards.length}
            view="cards"
            current={ws.view().kind === "cards"}
            onSelect={() => ws.setView({ kind: "cards" })}
          />
          <NavItem
            label="思路库"
            count={counts()?.ideas}
            view="ideas"
            current={ws.view().kind === "ideas"}
            onSelect={() => ws.setView({ kind: "ideas" })}
          />
          <NavItem
            label="结论"
            count={ws.conclusions()?.total}
            view="conclusions"
            current={ws.view().kind === "conclusions"}
            onSelect={() => ws.setView({ kind: "conclusions" })}
          />
          <NavItem
            label="产物"
            count={ws.artifacts()?.artifacts.length}
            view="artifacts"
            current={ws.view().kind === "artifacts"}
            onSelect={() => ws.setView({ kind: "artifacts" })}
          />
        </div>
      </div>

      {/* W6-1 β：长任务进度 / 算力只读 / 用量——CLI 已有、UI 补齐的三个面板。
          record/证据图浏览沿用右栏时间线，不在这里重复一个导航项。 */}
      <div class="section">
        <h2 class="section-title">运维</h2>
        <div class="col" style={{ gap: "1px" }}>
          <NavItem
            label="任务"
            view="tasks"
            current={ws.view().kind === "tasks"}
            onSelect={() => ws.setView({ kind: "tasks" })}
          />
          <NavItem
            label="算力"
            view="compute"
            current={ws.view().kind === "compute"}
            onSelect={() => ws.setView({ kind: "compute" })}
          />
          <NavItem
            label="用量"
            view="usage"
            current={ws.view().kind === "usage"}
            onSelect={() => ws.setView({ kind: "usage" })}
          />
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">实验</h2>
        <dl class="kv">
          <dt>干实验</dt>
          <dd>{counts()?.dryExperiments ?? 0}</dd>
          <dt>湿实验</dt>
          <dd>{counts()?.wetExperiments ?? 0}</dd>
          <dt>record</dt>
          <dd>{counts()?.records ?? 0}</dd>
        </dl>
        <p class="faint" style={{ margin: "8px 0 0", "font-size": "11.5px" }}>
          实验面板在页面底部。
        </p>
      </div>

      <Show when={dialog()}>
        <NewProjectDialog onClose={() => setDialog(false)} />
      </Show>
    </nav>
  );
}
