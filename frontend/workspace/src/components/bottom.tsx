import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { api } from "../lib/api";
import type { DryExperiment, StateMachine, SummaryValue, WetExperiment } from "../lib/types";
import { useWorkspace, withBusy } from "../state";
import { Badge, KeyValues, LineChart, Modal, Spinner } from "./ui";

// 底部实验面板：干 / 湿状态机可视化 + approve/reject。
//
// 状态机的节点顺序、停留态、终态全部来自 `/api/experiments/machine` 与 `/api/lab/machine`——
// **前端不再抄一份状态表**。P6 改过一次转移表，如果这里硬编码，改完 UI 就悄悄不对了。

// 从转移表推一条主干路径：从没有入边的状态出发，每次走第一条非自环的边。
// 分支（failed / rejected / iterated）挂在主干旁边单独显示。
function mainPath(machine: StateMachine): string[] {
  const targets = new Set(Object.values(machine.transitions).flat());
  const start = machine.states.find((s) => !targets.has(s)) ?? machine.states[0]!;
  const path: string[] = [];
  let cursor: string | undefined = start;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    const next: string[] = machine.transitions[cursor] ?? [];
    cursor = next.find((s) => !seen.has(s) && s !== "failed" && s !== "rejected" && s !== "iterated");
  }
  return path;
}

function StateMachineView(props: { machine: StateMachine; current: string; history: string[] }): JSX.Element {
  const path = createMemo(() => mainPath(props.machine));
  const visited = createMemo(() => new Set(props.history));
  const offPath = createMemo(() => props.machine.states.filter((s) => !path().includes(s)));

  return (
    <div>
      <div class="machine" role="img" aria-label={`状态机，当前状态 ${props.current}`}>
        <For each={path()}>
          {(state, index) => (
            <>
              <Show when={index() > 0}>
                <span class="node-sep" aria-hidden="true">
                  ▸
                </span>
              </Show>
              <span
                class="node"
                data-current={state === props.current}
                data-done={state !== props.current && visited().has(state)}
                data-awaiting={state === props.machine.awaiting}
                data-terminal={props.machine.terminal.includes(state)}
                title={
                  state === props.machine.awaiting
                    ? "停留态：安全门通过 ≠ 可以执行，必须人工 approve（AD-6）"
                    : undefined
                }
              >
                {state}
                <Show when={state === props.machine.awaiting}> ⏸</Show>
              </span>
            </>
          )}
        </For>
      </div>
      <Show when={offPath().length > 0}>
        <div class="machine" style={{ "padding-top": "0" }}>
          <span class="faint" style={{ "font-size": "11px" }}>
            旁支
          </span>
          <For each={offPath()}>
            {(state) => (
              <span
                class="node"
                data-current={state === props.current}
                data-done={state !== props.current && visited().has(state)}
                data-terminal={props.machine.terminal.includes(state)}
              >
                {state}
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function summaryPoints(summary: Record<string, SummaryValue> | null): number[] {
  if (!summary) return [];
  // 摘要里形如 energy_0 / energy_1 … 的序列画成曲线；没有就不画。
  const series = Object.entries(summary)
    .filter(([key, value]) => /_(\d+)$/.test(key) && typeof value === "number")
    .sort((a, b) => Number(a[0].match(/_(\d+)$/)![1]) - Number(b[0].match(/_(\d+)$/)![1]));
  return series.map(([, value]) => value as number);
}

function ApprovalDialog(props: {
  experiment: WetExperiment;
  action: "approve" | "reject";
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const ws = useWorkspace();
  const [actor, setActor] = createSignal(localStorage.getItem("spark-actor") ?? "");
  const [note, setNote] = createSignal("");

  const submit = async () => {
    if (!actor().trim()) return;
    if (props.action === "reject" && !note().trim()) return;
    // 记住署名只是省打字；每次仍然要用户确认——审批不能变成一路回车。
    localStorage.setItem("spark-actor", actor().trim());
    const result = await withBusy(ws, props.action === "approve" ? "批准中" : "拒绝中", () =>
      props.action === "approve"
        ? api.lab.approve(props.experiment.id, { actor: actor().trim(), note: note().trim() || undefined }, ws.slug())
        : api.lab.reject(props.experiment.id, { actor: actor().trim(), reason: note().trim() }, ws.slug()),
    );
    if (!result) return;
    ws.notify(
      `${props.action === "approve" ? "已批准" : "已拒绝"} · decision record ${result.decisionId.slice(0, 8)}`,
    );
    ws.refreshDomain("wet");
    props.onDone();
  };

  const disabled = () =>
    !actor().trim() || (props.action === "reject" && !note().trim()) || ws.busy() !== null;

  return (
    <Modal
      title={props.action === "approve" ? "批准执行湿实验（AD-6）" : "拒绝执行湿实验"}
      onClose={props.onClose}
      footer={
        <>
          <button class="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            class={props.action === "approve" ? "btn btn-primary" : "btn btn-danger"}
            onClick={submit}
            disabled={disabled()}
          >
            {props.action === "approve" ? "确认批准" : "确认拒绝"}
          </button>
        </>
      }
    >
      <div class="muted">
        <strong>{props.experiment.title}</strong>
        <div class="mono faint">协议 hash {props.experiment.protocolHash}</div>
      </div>

      <div>
        <h3 class="section-title">这一版的步骤（{props.experiment.compiledSteps.length} 步）</h3>
        <ol style={{ margin: 0, "padding-left": "20px", "max-height": "150px", overflow: "auto", "font-size": "12px" }}>
          <For each={props.experiment.compiledSteps}>
            {(step) => (
              <li>
                {step.action}
                <Show when={step.execution === "manual"}>
                  {" "}
                  <Badge tone="inferred">离机手工</Badge>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </div>

      <div>
        <h3 class="section-title">安全门结论</h3>
        <For each={props.experiment.safetyChecks}>
          {(check) => (
            <div style={{ "font-size": "12px" }}>
              {check.passed ? "✅" : "❌"} {check.check}
              <Show when={check.detail}>
                <span class="faint"> — {check.detail}</span>
              </Show>
            </div>
          )}
        </For>
        <p class="faint" style={{ margin: "6px 0 0", "font-size": "11.5px" }}>
          安全门通过是必要非充分条件。这一步批的是<strong>物理世界的操作</strong>。
        </p>
      </div>

      <label class="col" style={{ gap: "4px" }}>
        <span class="faint">
          审批人（必填）—— 会记进 decision record，用于审计
        </span>
        <input
          class="input"
          value={actor()}
          placeholder="你的名字"
          onInput={(e) => setActor(e.currentTarget.value)}
        />
      </label>
      <label class="col" style={{ gap: "4px" }}>
        <span class="faint">{props.action === "approve" ? "备注（可选）" : "拒绝理由（必填）"}</span>
        <textarea class="textarea" value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
      </label>
    </Modal>
  );
}

function DryDetail(props: { experiment: DryExperiment }): JSX.Element {
  const ws = useWorkspace();
  const machine = () => ws.dryMachine();
  const points = createMemo(() => summaryPoints(props.experiment.summary));

  const run = async () => {
    const task = await withBusy(ws, "运行干实验", () =>
      api.experiments.run(props.experiment.id, {}, ws.slug(), (m) => ws.setBusy(m)),
    );
    if (!task) return;
    if (task.state === "failed") ws.notify(task.error?.message ?? "仿真失败", "error");
    else ws.notify("干实验闭环完成");
    ws.refreshDomain("dry");
  };

  const [claim, setClaim] = createSignal("");
  const conclude = async () => {
    const text = claim().trim();
    if (!text) return;
    const done = await withBusy(ws, "写入结论卡", () =>
      api.experiments.conclude(props.experiment.id, { claim: text }, ws.slug()),
    );
    if (!done) return;
    setClaim("");
    ws.notify("结论卡已生成（review pending）——去「结论」页评审");
    ws.refreshDomain("dry");
    ws.refreshDomain("conclusions");
  };

  return (
    <div class="col">
      <Show when={machine()}>
        {(m) => (
          <StateMachineView
            machine={m()}
            current={props.experiment.state}
            history={props.experiment.history.map((h) => h.to)}
          />
        )}
      </Show>
      <div class="row wrap">
        <button
          class="btn btn-primary btn-sm"
          onClick={run}
          disabled={ws.busy() !== null || !["design", "failed"].includes(props.experiment.state)}
        >
          运行闭环
        </button>
        <Show when={props.experiment.lastError}>
          <span style={{ color: "var(--danger)", "font-size": "12px" }}>{props.experiment.lastError}</span>
        </Show>
      </div>
      {/* 结论卡一律 review=pending 落地（域 E2）——这里只负责写下主张，不给自己发通过证。 */}
      <Show when={props.experiment.state === "analyze"}>
        <div class="row wrap">
          <input
            class="input"
            style={{ flex: "1 1 240px" }}
            placeholder="结论（claim）"
            value={claim()}
            onInput={(e) => setClaim(e.currentTarget.value)}
          />
          <button class="btn btn-sm" onClick={conclude} disabled={ws.busy() !== null || !claim().trim()}>
            得出结论
          </button>
        </div>
      </Show>
      <KeyValues
        entries={[
          ["平台", `${props.experiment.platform}/${props.experiment.simKind}`],
          ["参数", JSON.stringify(props.experiment.params)],
          ["假设", props.experiment.hypothesis],
          ["run", props.experiment.runId],
          ["observation", props.experiment.observationId?.slice(0, 8)],
          ["conclusion", props.experiment.conclusionId ? `${props.experiment.conclusionId.slice(0, 8)}（review pending）` : null],
        ]}
      />
      <Show when={props.experiment.summary}>
        {(summary) => (
          <div>
            <h3 class="section-title">摘要</h3>
            <KeyValues entries={Object.entries(summary())} />
            <Show when={points().length > 1}>
              <LineChart points={points()} label="能量曲线" />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

function WetDetail(props: { experiment: WetExperiment }): JSX.Element {
  const ws = useWorkspace();
  const [dialog, setDialog] = createSignal<"approve" | "reject" | null>(null);
  const machine = () => ws.wetMachine();

  const simulate = async () => {
    const task = await withBusy(ws, "执行湿实验", () =>
      api.lab.simulate(props.experiment.id, {}, ws.slug(), (m) => ws.setBusy(m)),
    );
    if (!task) return;
    if (task.state === "failed") ws.notify(task.error?.message ?? "执行失败", "error");
    else ws.notify("湿实验执行完成，已产出 observation");
    ws.refreshDomain("wet");
  };

  return (
    <div class="col">
      <Show when={machine()}>
        {(m) => (
          <StateMachineView
            machine={m()}
            current={props.experiment.state}
            history={props.experiment.history.map((h) => h.to)}
          />
        )}
      </Show>

      <Show when={props.experiment.state === "awaiting_approval"}>
        <div
          class="row wrap"
          style={{
            padding: "8px 10px",
            "border-radius": "var(--radius)",
            background: "var(--warn-soft)",
            border: "1px solid var(--warn)",
          }}
        >
          <span style={{ color: "var(--warn)" }}>
            ⏸ 安全门通过 ≠ 可以执行。这一步需要具名的人工确认（AD-6）。
          </span>
          <span class="spacer" />
          <button class="btn btn-sm btn-primary" onClick={() => setDialog("approve")}>
            批准执行…
          </button>
          <button class="btn btn-sm btn-danger" onClick={() => setDialog("reject")}>
            拒绝…
          </button>
        </div>
      </Show>

      <Show when={props.experiment.approval}>
        {(approval) => (
          <div class="row wrap" style={{ "font-size": "12px" }}>
            <Badge tone="observed">已批准</Badge>
            <span>
              {approval().actor} @ {approval().at.replace("T", " ").slice(0, 19)}
            </span>
            <button class="btn btn-sm btn-ghost" onClick={() => ws.selectRecord(approval().decisionRecordId)}>
              查看 decision record →
            </button>
          </div>
        )}
      </Show>
      <Show when={props.experiment.rejection}>
        {(rejection) => (
          <div class="row wrap" style={{ "font-size": "12px" }}>
            <Badge tone="rejected">已拒绝</Badge>
            <span>
              {rejection().actor}：{rejection().reason}
            </span>
            <button class="btn btn-sm btn-ghost" onClick={() => ws.selectRecord(rejection().decisionRecordId)}>
              查看 decision record →
            </button>
          </div>
        )}
      </Show>

      <div class="row wrap">
        <button
          class="btn btn-sm btn-primary"
          onClick={simulate}
          disabled={ws.busy() !== null || props.experiment.state !== "approved"}
          title={
            props.experiment.state !== "approved"
              ? props.experiment.state === "executing"
                ? "已在执行中（执行权已被原子声明，approval 已消费）"
                : "必须先经人工 approve 才能执行"
              : undefined
          }
        >
          执行（模拟器）
        </button>
        <Show when={props.experiment.lastError}>
          <span style={{ color: "var(--danger)", "font-size": "12px" }}>{props.experiment.lastError}</span>
        </Show>
      </div>

      <KeyValues
        entries={[
          ["后端", props.experiment.backend],
          ["机型", `${props.experiment.robotType ?? "—"} · API ${props.experiment.apiLevel ?? "—"}`],
          ["协议 hash", props.experiment.protocolHash],
          ["run", props.experiment.runId],
          ["run log", props.experiment.runLogEntryCount],
          ["observation", props.experiment.observationId?.slice(0, 8)],
        ]}
      />

      <Show when={props.experiment.compileWarnings.length > 0}>
        <div>
          <h3 class="section-title">编译提示</h3>
          <For each={props.experiment.compileWarnings}>
            {(warning) => (
              <div style={{ color: "var(--warn)", "font-size": "12px" }}>⚠ {warning}</div>
            )}
          </For>
        </div>
      </Show>

      <div>
        <h3 class="section-title">步骤（{props.experiment.compiledSteps.length}）</h3>
        <ul class="runlog">
          <For each={props.experiment.compiledSteps}>
            {(step, index) => (
              <li>
                <span class="mono faint">{String(index() + 1).padStart(2, "0")}</span>
                <span style={{ flex: "1" }}>{step.action}</span>
                {/* Opentrons 上没有的硬件不假装有：这些步骤编译成注释，标 manual。 */}
                <Show when={step.execution === "manual"}>
                  <Badge tone="inferred">离机手工</Badge>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>

      <Show when={props.experiment.summary}>
        {(summary) => (
          <div>
            <h3 class="section-title">run log 摘要</h3>
            <KeyValues entries={Object.entries(summary())} />
          </div>
        )}
      </Show>

      <Show when={dialog()}>
        {(action) => (
          <ApprovalDialog
            experiment={props.experiment}
            action={action()}
            onClose={() => setDialog(null)}
            onDone={() => setDialog(null)}
          />
        )}
      </Show>
    </div>
  );
}

function NewWetForm(props: { onDone: () => void }): JSX.Element {
  const ws = useWorkspace();
  const [text, setText] = createSignal("");
  const [title, setTitle] = createSignal("");

  const compile = async () => {
    if (!text().trim()) return;
    const result = await withBusy(ws, "编译协议", () =>
      api.lab.compile({ naturalLanguage: text().trim(), title: title().trim() || undefined }, ws.slug()),
    );
    if (!result) return;
    ws.notify("编译完成，停在 awaiting_approval —— 需要人工批准");
    ws.refreshDomain("wet");
    ws.selectExperiment({ mode: "wet", id: result.experiment.id });
    props.onDone();
  };

  return (
    <div class="col">
      <input
        class="input"
        placeholder="标题（可选）"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <textarea
        class="textarea"
        placeholder="自然语言协议，例如：取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="row">
        <button class="btn btn-primary btn-sm" onClick={compile} disabled={ws.busy() !== null || !text().trim()}>
          编译 + 过安全门
        </button>
        <span class="faint" style={{ "font-size": "11.5px" }}>
          编译后会停在 awaiting_approval，不会自动执行。
        </span>
      </div>
    </div>
  );
}

function NewDryForm(props: { onDone: () => void }): JSX.Element {
  const ws = useWorkspace();
  const [title, setTitle] = createSignal("");
  const [params, setParams] = createSignal("steps=2000, sampleInterval=50");

  const create = async () => {
    if (!title().trim()) return;
    const parsed: Record<string, unknown> = {};
    for (const part of params().split(",")) {
      const [key, raw] = part.split("=").map((s) => s?.trim());
      if (!key || raw === undefined) continue;
      parsed[key] = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
    const result = await withBusy(ws, "建实验", () =>
      api.experiments.create({ title: title().trim(), params: parsed }, ws.slug()),
    );
    if (!result) return;
    ws.notify("干实验已建档");
    ws.refreshDomain("dry");
    ws.selectExperiment({ mode: "dry", id: result.experiment.id });
    props.onDone();
  };

  return (
    <div class="col">
      <input
        class="input"
        placeholder="实验标题"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <input
        class="input mono"
        placeholder="参数 k=v，逗号分隔"
        value={params()}
        onInput={(e) => setParams(e.currentTarget.value)}
      />
      <div class="row">
        <button class="btn btn-primary btn-sm" onClick={create} disabled={ws.busy() !== null || !title().trim()}>
          建档
        </button>
        <span class="faint" style={{ "font-size": "11.5px" }}>
          参数不合法会在建档阶段就被拒，不留半成品。
        </span>
      </div>
    </div>
  );
}

export function BottomPanel(): JSX.Element {
  const ws = useWorkspace();
  const [tab, setTab] = createSignal<"dry" | "wet">("wet");
  const [creating, setCreating] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);

  const selected = createMemo(() => {
    const target = ws.selectedExperiment();
    if (!target) return null;
    if (target.mode === "dry") {
      const found = ws.dry()?.experiments.find((e) => e.id === target.id);
      return found ? ({ mode: "dry", experiment: found } as const) : null;
    }
    const found = ws.wet()?.experiments.find((e) => e.id === target.id);
    return found ? ({ mode: "wet", experiment: found } as const) : null;
  });

  // 有实验停在等审批时，面板标题上必须有个抓眼的提示——它是整个流程里唯一「在等人」的地方。
  const awaiting = createMemo(
    () => ws.wet()?.experiments.filter((e) => e.state === "awaiting_approval").length ?? 0,
  );

  const list = () => (tab() === "dry" ? ws.dry()?.experiments ?? [] : ws.wet()?.experiments ?? []);

  return (
    <section class="bottom" aria-label="实验面板">
      <div class="section">
        <div class="row">
          <h2 class="section-title" style={{ margin: 0 }}>
            实验面板
          </h2>
          <Show when={awaiting() > 0}>
            <Badge tone="awaiting_approval">{awaiting()} 个待审批</Badge>
          </Show>
          <div class="tabs" role="tablist" aria-label="实验类型">
            <button class="tab" role="tab" aria-selected={tab() === "dry"} onClick={() => setTab("dry")}>
              干实验 {ws.dry()?.experiments.length ?? 0}
            </button>
            <button class="tab" role="tab" aria-selected={tab() === "wet"} onClick={() => setTab("wet")}>
              湿实验 {ws.wet()?.experiments.length ?? 0}
            </button>
          </div>
          <button class="btn btn-sm" onClick={() => setCreating((v) => !v)}>
            {creating() ? "收起" : "＋ 新建"}
          </button>
          <span class="spacer" />
          <Show when={ws.busy()}>
            <Spinner label={ws.busy()!} />
          </Show>
          <button
            class="btn btn-sm btn-ghost"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed()}
          >
            {collapsed() ? "展开 ▲" : "收起 ▼"}
          </button>
        </div>

        <Show when={!collapsed()}>
          <Show when={creating()}>
            <div style={{ "margin-top": "10px" }}>
              <Show when={tab() === "wet"} fallback={<NewDryForm onDone={() => setCreating(false)} />}>
                <NewWetForm onDone={() => setCreating(false)} />
              </Show>
            </div>
          </Show>

          <div class="exp-grid" style={{ "margin-top": "10px" }}>
            <div class="exp-list">
              <Show
                when={list().length > 0}
                fallback={<div class="empty">还没有{tab() === "dry" ? "干" : "湿"}实验。</div>}
              >
                <For each={list()}>
                  {(experiment) => (
                    <button
                      class="nav-item"
                      aria-current={ws.selectedExperiment()?.id === experiment.id}
                      onClick={() => ws.selectExperiment({ mode: tab(), id: experiment.id })}
                    >
                      <Badge tone={experiment.state}>{experiment.state}</Badge>
                      <span class="tl-title">{experiment.title}</span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <div>
              <Show
                when={selected()}
                fallback={<div class="empty">选一条实验查看状态机与操作。</div>}
              >
                {(target) => (
                  <Show
                    when={target().mode === "wet"}
                    fallback={<DryDetail experiment={target().experiment as DryExperiment} />}
                  >
                    <WetDetail experiment={target().experiment as WetExperiment} />
                  </Show>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}
