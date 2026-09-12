import { For, Show, type JSX } from "solid-js";
import type { CitationFinding, IdeaCard, NoveltyResult, ReadingCard, ReviewResult } from "../lib/types";
import { useWorkspace } from "../state";
import { Badge, Markdown } from "./ui";

// 精读卡 / 综述 / novelty 报告 / Idea 卡的富渲染。
//
// 一条贯穿的原则：**证据的成色要看得见**。
// - 引用是否能回链到库内（Markdown 里两色）
// - 结论是被观察/计算出来的，还是推断的（evidence 徽章）
// - 核验结论是 hard 还是 soft（hard 才是否决，soft 只提示——两者绝不能长一个样）

// V79①：`[@key]` 引用 span 点击 → 跳到证据图对应的 paper record（`ws.selectRecord`
// 只切选中 record，不改 center 视图——与 bottom.tsx 里「跳去看审批产出的 record」
// 同一个既有模式，见 state.tsx `selectRecord`）。key 在库外（没有 record 可跳）时
// `recordIdForKey` 返回 null，直接不动——markdown.ts 那边本来就没给库外引用打
// `data-key`，这里的 null 分支只是双重保险，不依赖那一层没漏。
function jumpToCite(ws: { recordIdForKey: (key: string) => string | null; selectRecord: (id: string | null) => void }, key: string): void {
  const id = ws.recordIdForKey(key);
  if (id) ws.selectRecord(id);
}

export function FindingList(props: { findings: CitationFinding[] }): JSX.Element {
  return (
    <Show when={props.findings.length > 0}>
      <ul style={{ margin: "6px 0 0", "padding-left": "18px" }}>
        <For each={props.findings}>
          {(finding) => (
            <li style={{ color: finding.severity === "hard" ? "var(--danger)" : "var(--warn)" }}>
              <Badge tone={finding.severity === "hard" ? "rejected" : "inferred"}>
                {finding.severity === "hard" ? "hard" : "soft"}
              </Badge>{" "}
              {finding.message}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

export function ReadingCardView(props: { card: ReadingCard }): JSX.Element {
  const ws = useWorkspace();
  return (
    <article class="card">
      <div class="card-head">
        <span>精读卡</span>
        <Badge tone="sourced">sourced</Badge>
        <span class="spacer" />
        <span class="mono faint">[@{props.card.bibtexKey}]</span>
      </div>
      <div class="card-body md">
        <h3>研究问题</h3>
        <p>{props.card.researchQuestion}</p>
        <h3>方法</h3>
        <p>{props.card.methods}</p>
        <h3>关键发现</h3>
        <ul>
          <For each={props.card.keyFindings}>{(item) => <li>{item}</li>}</For>
        </ul>
        <h3>局限</h3>
        <ul>
          <For each={props.card.limitations}>{(item) => <li>{item}</li>}</For>
        </ul>
        <h3>
          与本项目的关系 <Badge tone="inferred">inferred</Badge>
        </h3>
        {/* relationToProject 是卡片里唯一的推断字段（P3 口径），不参与引用核验的对照基准。 */}
        <Markdown
          source={props.card.relationToProject}
          knownKeys={ws.knownKeys()}
          onCiteClick={(key) => jumpToCite(ws, key)}
        />
      </div>
    </article>
  );
}

export function ReviewView(props: { result: ReviewResult }): JSX.Element {
  const ws = useWorkspace();
  const hard = () => props.result.citation.findings.filter((f) => f.severity === "hard");
  return (
    <article class="card">
      <div class="card-head">
        <span>综述草稿</span>
        <Badge tone="inferred">inferred</Badge>
        <span class="spacer" />
        <Show
          when={props.result.vetoed}
          fallback={<Badge tone="observed">引用核验通过</Badge>}
        >
          <Badge tone="rejected">Review vetoed · {hard().length} 条 hard finding</Badge>
        </Show>
      </div>
      <div class="card-body">
        <p class="faint" style={{ margin: "0 0 8px", "font-size": "12px" }}>
          基于 {props.result.cardCount} 张精读卡 · 引用 {props.result.draft.citedKeys.length} 条 ·
          artifact {props.result.draft.artifactId?.slice(0, 8) ?? "未入库"}
        </p>
        <Show when={props.result.vetoed}>
          <div class="error-box" role="alert" style={{ "margin-bottom": "10px" }}>
            <strong>草稿不可用于交付</strong>：存在无法回链到项目文献库的引用。
            草稿仍展示在下面，改掉标红的引用后重新生成。
          </div>
        </Show>
        <FindingList findings={props.result.citation.findings} />
        <hr style={{ border: "none", "border-top": "1px solid var(--border)", margin: "10px 0" }} />
        <Markdown
          source={props.result.draft.markdown}
          knownKeys={ws.knownKeys()}
          onCiteClick={(key) => jumpToCite(ws, key)}
        />
      </div>
    </article>
  );
}

export function NoveltyView(props: { result: NoveltyResult }): JSX.Element {
  const ws = useWorkspace();
  return (
    <article class="card">
      <div class="card-head">
        <span>Novelty 报告</span>
        <span class="spacer" />
        <Show
          when={props.result.conclusive}
          fallback={<Badge tone="inferred">未得出可用结论 · 状态维持 unchecked</Badge>}
        >
          <Badge tone={props.result.status.status}>{props.result.status.status}</Badge>
        </Show>
      </div>
      <div class="card-body">
        <Show when={!props.result.conclusive}>
          <div class="empty" style={{ "text-align": "left", "margin-bottom": "10px" }}>
            这次检查没能得出可用结论（见下方评级校验违规）。
            <strong>「查过但没查出来」与「没查过」是两回事</strong>：报告已入库，思路库状态保持 unchecked。
          </div>
        </Show>
        <For each={props.result.assessments}>
          {(assessment) => {
            const claim = props.result.claims.find((c) => c.id === assessment.claimId);
            return (
              <section style={{ "margin-bottom": "12px" }}>
                <div class="row wrap" style={{ "margin-bottom": "4px" }}>
                  <span class="mono faint">{assessment.claimId}</span>
                  <Badge
                    tone={assessment.rating === "novel" ? "checked-novel" : "checked-overlap"}
                    title={
                      assessment.rating !== assessment.declaredRating
                        ? `模型原判 ${assessment.declaredRating}，被确定性校验层校正`
                        : undefined
                    }
                  >
                    {assessment.rating}
                  </Badge>
                  {/* AD-8：模型原判与校正后并列，不能只留一个好看的。 */}
                  <Show when={assessment.rating !== assessment.declaredRating}>
                    <span class="faint" style={{ "font-size": "11.5px" }}>
                      模型原判 {assessment.declaredRating}，已校正
                    </span>
                  </Show>
                </div>
                <p style={{ margin: "0 0 6px" }}>{claim?.statement}</p>
                <For each={assessment.nearestWorks}>
                  {(work) => (
                    <div class="muted" style={{ "font-size": "12px", "margin-left": "8px" }}>
                      最近邻 <span class="cite">[@{work.key}]</span> · 差异：{work.difference}
                    </div>
                  )}
                </For>
                <For each={assessment.violations}>
                  {(violation) => (
                    <div style={{ color: "var(--warn)", "font-size": "12px", "margin-left": "8px" }}>
                      ⚠ {violation.code}：{violation.message}
                    </div>
                  )}
                </For>
              </section>
            );
          }}
        </For>
        <FindingList findings={props.result.citation.findings} />
        <details style={{ "margin-top": "10px" }}>
          <summary class="faint" style={{ cursor: "pointer" }}>
            展开完整报告
          </summary>
          <Markdown
            source={props.result.markdown}
            knownKeys={ws.knownKeys()}
            onCiteClick={(key) => jumpToCite(ws, key)}
          />
        </details>
      </div>
    </article>
  );
}

export function IdeaCardView(props: { card: IdeaCard; onCheck?: () => void; checking?: boolean }): JSX.Element {
  const ws = useWorkspace();
  return (
    <article class="card">
      <div class="card-head">
        <span>Idea 卡</span>
        <Badge tone="inferred">inferred</Badge>
        <span class="spacer" />
        <Badge tone={props.card.noveltyStatus}>{props.card.noveltyStatus}</Badge>
      </div>
      <div class="card-body">
        <p style={{ margin: "0 0 8px", "font-weight": "600" }}>{props.card.hypothesis}</p>
        <Show when={props.card.critique}>
          <Markdown
            source={props.card.critique}
            knownKeys={ws.knownKeys()}
            onCiteClick={(key) => jumpToCite(ws, key)}
          />
        </Show>
        <div class="row wrap" style={{ "align-items": "flex-start", gap: "16px", "margin-top": "10px" }}>
          <div style={{ flex: "1 1 200px" }}>
            <h3 class="section-title" style={{ margin: "0 0 4px" }}>
              支持
            </h3>
            <For each={props.card.supporting} fallback={<span class="faint">—</span>}>
              {(item) => (
                <div style={{ "font-size": "12px" }}>
                  <Show when={item.key} fallback={<Badge tone="inferred">inferred</Badge>}>
                    <span class="cite">[@{item.key}]</span>
                  </Show>{" "}
                  {item.note}
                </div>
              )}
            </For>
          </div>
          <div style={{ flex: "1 1 200px" }}>
            {/* 反面证据至少 1 条是 P4 的硬门：给不出反证的「共探」只是附和。 */}
            <h3 class="section-title" style={{ margin: "0 0 4px" }}>
              反对
            </h3>
            <For each={props.card.contradicting} fallback={<span class="faint">—</span>}>
              {(item) => (
                <div style={{ "font-size": "12px" }}>
                  <Show when={item.key} fallback={<Badge tone="inferred">inferred</Badge>}>
                    <span class="cite">[@{item.key}]</span>
                  </Show>{" "}
                  {item.note}
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={props.card.openQuestions.length > 0}>
          <h3 class="section-title" style={{ margin: "10px 0 4px" }}>
            待验证
          </h3>
          <ul style={{ margin: 0, "padding-left": "18px", "font-size": "12px" }}>
            <For each={props.card.openQuestions}>{(q) => <li>{q}</li>}</For>
          </ul>
        </Show>
        <Show when={props.onCheck}>
          <div class="row" style={{ "margin-top": "12px" }}>
            <button class="btn btn-sm" onClick={() => props.onCheck?.()} disabled={props.checking}>
              {props.checking ? "检查中…" : "跑 Novelty check"}
            </button>
            <Show when={props.card.checkedAt}>
              <span class="faint" style={{ "font-size": "11.5px" }}>
                上次检查 {props.card.checkedAt!.slice(0, 10)}
              </span>
            </Show>
          </div>
        </Show>
      </div>
    </article>
  );
}
