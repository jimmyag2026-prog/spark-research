import { ConclusionReviewer, type ConclusionAssessment } from "../conclusion/reviewer";
import { ConclusionStore } from "../conclusion/store";
import type { ConclusionCard } from "../conclusion/models";
import type { LibraryPaper } from "../literature/library";
import { libraryKeyIndex } from "../literature/export";
import type { ProjectMeta, RecordEdge, ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
import { RECONCILIATION_WORDING, type ReconciliationMode } from "../reviewer/conclusion_rules";

// 研究报告导出（DESIGN 域 C2 + P8-gate G7）：证据图 → Markdown。
//
// 三条不可让步的口径：
//  1. **报告是证据图的投影，不是重新讲一遍故事。** 每一条陈述都带 record id，
//     读者能拿 id 回到 `spark-research conclusion show` / `/api/records/:id` 核对原始记录。
//     正文由代码渲染，不经过模型——让模型写报告等于让它有机会改掉数据。
//  2. **结论区受 review 门槛约束（G1）。** 只有 `approved` 的结论卡进「结论」，
//     `pending`/`vetoed` 一律进「待验证」，并附上它为什么没过。
//  3. **能力位照实说（G4）。** 证据来自非确定性平台就写「区间/趋势对账」，
//     来自模拟执行就在结论行里挂 `[模拟]` 标记——报告不许比结论卡更乐观。

export interface ReportSectionCounts {
  papers: number;
  readings: number;
  ideas: number;
  dryExperiments: number;
  wetExperiments: number;
  observations: number;
  approvedConclusions: number;
  unverifiedConclusions: number;
  decisions: number;
}

export interface ReportConclusionEntry {
  card: ConclusionCard;
  assessment: ConclusionAssessment;
  reconciliation: ReconciliationMode;
  simulated: boolean;
}

export interface ResearchReport {
  project: string;
  title: string;
  generatedAt: string;
  markdown: string;
  counts: ReportSectionCounts;
  approved: ReportConclusionEntry[];
  unverified: ReportConclusionEntry[];
  // 报告正文里出现过的全部 record id（附录索引的真源）。
  recordIds: string[];
}

export interface BuildReportInput {
  meta: ProjectMeta;
  records: RecordStore;
  // 有文献库就渲染参考文献区；没有就跳过（报告不因为缺文献库而失败）。
  papers?: LibraryPaper[];
  reviewer?: ConclusionReviewer;
  generatedAt?: string;
  // 把 record 的 markdown 正文整段嵌进报告（默认只摘要）。
  verbose?: boolean;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// record 引用的统一写法：`[record a1b2c3d4]`。前端/CLI 都按这个形态回链。
function ref(id: string): string {
  return `\`${shortId(id)}\`（record \`${id}\`）`;
}

function metaOf(record: ResearchRecord): Record<string, unknown> {
  return record.metadata as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function firstParagraph(text: string, max = 240): string {
  const body = text
    .split("\n")
    .filter((line) => !line.startsWith("#") && !line.startsWith("- record:") && line.trim().length > 0);
  const joined = body.join(" ").trim();
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

function edgeTargets(edges: { outgoing: RecordEdge[]; incoming: RecordEdge[] }, type: string): string[] {
  return [
    ...edges.outgoing.filter((e) => e.type === type).map((e) => e.targetId),
    ...edges.incoming.filter((e) => e.type === type).map((e) => e.sourceId),
  ];
}

export function buildReport(input: BuildReportInput): ResearchReport {
  const { meta, records } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const reviewer = input.reviewer ?? new ConclusionReviewer(records);
  const conclusionStore = reviewer.store ?? new ConclusionStore(records);

  const all = records.list();
  const byType = <T extends ResearchRecord["type"]>(type: T) => all.filter((r) => r.type === type);
  const papersRecords = byType("paper");
  const readings = byType("reading");
  const ideas = byType("idea");
  const observations = byType("observation");
  const decisions = byType("decision");
  const experiments = byType("experiment");
  const dry = experiments.filter((r) => metaOf(r).mode !== "wet");
  const wet = experiments.filter((r) => metaOf(r).mode === "wet");

  const cards = conclusionStore.list();
  const entries: ReportConclusionEntry[] = cards.map((card) => {
    const assessment = reviewer.assess(card);
    return {
      card,
      assessment,
      reconciliation: assessment.reconciliation,
      simulated: assessment.resolved.some((r) => r.ok && r.simulated),
    };
  });
  // 门槛在这里生效：**只看卡上已落的 review 状态**，不拿「现在跑一遍会通过」当通过。
  // 没评审过就是没评审过——报告不替评审人按通过键。
  const approved = entries.filter((e) => e.card.review.state === "approved");
  const unverified = entries.filter((e) => e.card.review.state !== "approved");

  const keyIndex = input.papers ? libraryKeyIndex(input.papers) : null;
  const recordIds = new Set<string>();
  const lines: string[] = [];
  const track = (id: string) => {
    recordIds.add(id);
    return id;
  };

  lines.push(`# 研究报告 · ${meta.name}`);
  lines.push("");
  lines.push(`> 项目 \`${meta.slug}\` · 生成于 ${generatedAt}`);
  lines.push(">");
  lines.push(
    `> 本报告由证据图导出，正文全部由代码渲染而非模型撰写。每条结论都带 record id，` +
      `可用 \`spark-research conclusion show <id>\` 或 \`GET /api/records/<id>\` 回到原始记录核对。`,
  );
  lines.push("");

  // ── 一、问题 ───────────────────────────────────────────────────────────────
  lines.push("## 一、问题");
  lines.push("");
  lines.push(meta.description?.trim() || "（项目未填写描述——`spark-research project new` 时的 `--description`）");
  lines.push("");
  const openQuestions = ideas.flatMap((record) => {
    const q = metaOf(record).openQuestions;
    return Array.isArray(q) ? (q as string[]).map((text) => ({ text, from: record.id })) : [];
  });
  if (openQuestions.length > 0) {
    lines.push("待回答的问题（来自思路卡）：");
    lines.push("");
    for (const item of openQuestions) lines.push(`- ${item.text} — 来自 ${ref(track(item.from))}`);
    lines.push("");
  }
  lines.push(
    `文献基础：库内论文 ${papersRecords.length} 篇，精读卡 ${readings.length} 张。`,
  );
  lines.push("");

  // ── 二、思路 ───────────────────────────────────────────────────────────────
  lines.push("## 二、思路");
  lines.push("");
  if (ideas.length === 0) {
    lines.push("（暂无 idea 卡）");
    lines.push("");
  }
  for (const record of ideas) {
    const m = metaOf(record);
    lines.push(`### ${record.title}`);
    lines.push("");
    lines.push(`- record：${ref(track(record.id))}`);
    lines.push(`- 假设：${str(m.hypothesis) ?? firstParagraph(record.content)}`);
    lines.push(`- novelty：**${str(m.noveltyStatus) ?? "unchecked"}**`);
    const reportId = str(m.noveltyReportRecordId);
    if (reportId) lines.push(`- novelty 报告：${ref(track(reportId))}`);
    const edges = records.edgesOf(record.id);
    const supporting = edgeTargets(edges, "supports");
    const contradicting = edgeTargets(edges, "contradicts");
    if (supporting.length > 0) {
      lines.push(`- 支持文献：${supporting.map((id) => paperLabel(id, records, keyIndex, track)).join("、")}`);
    }
    if (contradicting.length > 0) {
      lines.push(`- 反对文献：${contradicting.map((id) => paperLabel(id, records, keyIndex, track)).join("、")}`);
    }
    lines.push("");
    if (input.verbose) {
      lines.push(record.content);
      lines.push("");
    }
  }

  // ── 三、实验 ───────────────────────────────────────────────────────────────
  lines.push("## 三、实验");
  lines.push("");
  if (experiments.length === 0) {
    lines.push("（暂无实验）");
    lines.push("");
  }
  for (const record of [...dry, ...wet]) {
    const m = metaOf(record);
    const isWet = m.mode === "wet";
    lines.push(`### ${record.title}`);
    lines.push("");
    lines.push(`- record：${ref(track(record.id))}`);
    lines.push(`- 类型：${isWet ? "湿实验" : "干实验"} · 状态 **${str(m.state) ?? "unknown"}**`);
    if (isWet) {
      lines.push(`- 执行后端：${str(m.backend) ?? "unknown"}${str(m.backend) === "physical_device" ? "" : "（模拟）"}`);
      const approval = m.approval as { actor?: string; at?: string; protocolHash?: string } | null;
      if (approval?.actor) {
        lines.push(`- 人工批准：${approval.actor} @ ${approval.at ?? "?"}（协议 hash \`${approval.protocolHash ?? "?"}\`）`);
      }
    } else {
      lines.push(`- 平台：${str(m.platform) ?? "?"} / ${str(m.simKind) ?? "?"}`);
      if (str(m.runId)) lines.push(`- run：\`${str(m.runId)}\``);
    }
    if (str(m.hypothesis)) lines.push(`- 假设：${str(m.hypothesis)}`);
    const summary = m.summary as Record<string, unknown> | null;
    if (summary && Object.keys(summary).length > 0) {
      lines.push(`- 结果摘要：${Object.entries(summary).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}`);
    }
    const obsId = str(m.observationId);
    if (obsId) {
      const observation = records.get(obsId);
      lines.push(`- 观察：${ref(track(obsId))}${observation ? ` — ${firstParagraph(observation.content, 160)}` : ""}`);
      if (observation && metaOf(observation).simulated === true) {
        lines.push(`  - ⚠️ 读数来自模拟执行，非真实实验数据`);
      }
      if (observation && metaOf(observation).deterministic === false) {
        lines.push(`  - ℹ️ 平台非确定性：同参数重跑只保证落在同一区间/趋势，不逐位一致`);
      }
    }
    lines.push("");
    if (input.verbose) {
      lines.push(record.content);
      lines.push("");
    }
  }

  // ── 四、结论（只有 approved 进这里）────────────────────────────────────────
  lines.push("## 四、结论");
  lines.push("");
  lines.push(
    `> 本区只收录 review **approved** 的结论卡（DESIGN 域 E2）。` +
      `未评审或被否决的结论在下一节「待验证」。`,
  );
  lines.push("");
  if (approved.length === 0) {
    lines.push("（暂无通过评审的结论）");
    lines.push("");
  }
  for (const entry of approved) {
    lines.push(...renderConclusionEntry(entry, records, track));
  }

  // ── 五、待验证 ─────────────────────────────────────────────────────────────
  lines.push("## 五、待验证");
  lines.push("");
  if (unverified.length === 0) {
    lines.push("（没有待验证的结论）");
    lines.push("");
  }
  for (const entry of unverified) {
    const state = entry.card.review.state;
    lines.push(`### ${entry.card.title}`);
    lines.push("");
    lines.push(`- record：${ref(track(entry.card.recordId))}`);
    lines.push(`- review：**${state === "pending" ? "pending（尚未评审）" : "vetoed（已否决）"}**`);
    lines.push(`- 主张：${entry.card.claim}`);
    if (entry.card.review.reason) lines.push(`- 人工否决理由：${entry.card.review.reason}`);
    const blocking = entry.assessment.findings.filter((f) => f.severity === "hard");
    if (blocking.length > 0) {
      lines.push(`- 阻塞项（${blocking.length} 条 hard finding）：`);
      for (const f of blocking) lines.push(`  - \`${f.rule ?? "unknown"}\` ${f.message}`);
    } else if (state === "pending") {
      lines.push(`- 检查器当前无 hard finding——跑一次 \`spark-research conclusion review ${shortId(entry.card.recordId)}\` 即可进入结论区`);
    }
    lines.push("");
  }

  // ── 附录 ───────────────────────────────────────────────────────────────────
  // S10（W5-3 δ 外部验收发现）：这张表只索引「正文（问题/思路/实验/结论/待验证）
  // 点名引用过」的 record，不是项目全部 record 的目录——没被任何思路卡链接的论文、
  // 没被任何结论引用的精读卡，都不会出现在这里，即便下面的统计行写着「论文 N·精读卡 N」。
  // 这是刻意的语义（附录 A = 正文引用回链索引，不是全量目录），但空表 + 非零统计会让
  // 读者以为报告坏了——所以无论表是否为空，都先把这句话钉在前面，并指去能看全量的命令。
  lines.push("## 附录 A · 证据索引");
  lines.push("");
  lines.push(
    "> 本表只索引正文里点名引用过的 record，不是项目全部 record 的目录——" +
      "要看项目里的全部 record（含未被引用的论文/精读卡/artifact），用 `spark-research report records`；" +
      "查单条详情（含入边/出边）用 `spark-research report show <recordId>`。",
  );
  lines.push("");
  if (recordIds.size === 0) {
    lines.push("（正文暂无点名引用的证据——上面各节还没有 record 落进叙事里，不代表证据图是空的。）");
    lines.push("");
  } else {
    lines.push("| record | 类型 | 证据标签 | 标题 |");
    lines.push("|--------|------|---------|------|");
    for (const id of recordIds) {
      const record = records.get(id);
      if (!record) continue;
      lines.push(`| \`${id}\` | ${record.type} | ${record.evidence} | ${record.title.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }

  if (keyIndex && input.papers && input.papers.length > 0) {
    lines.push("## 附录 B · 参考文献");
    lines.push("");
    input.papers.forEach((paper, i) => {
      const key = keyIndex.keys[i]!;
      const authors = paper.authors.map((a) => a.name).slice(0, 3).join(", ");
      lines.push(
        `- [@${key}] ${paper.title}. ${authors}${paper.authors.length > 3 ? " et al." : ""}. ` +
          `${paper.year ?? "n.d."}${paper.venue ? `. ${paper.venue}` : ""}${paper.doi ? `. doi:${paper.doi}` : ""}`,
      );
    });
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `统计：论文 ${papersRecords.length} · 精读卡 ${readings.length} · 思路 ${ideas.length} · ` +
      `干实验 ${dry.length} · 湿实验 ${wet.length} · 观察 ${observations.length} · ` +
      `结论 ${approved.length} 通过 / ${unverified.length} 待验证 · 决策 ${decisions.length}`,
  );

  return {
    project: meta.slug,
    title: `研究报告 · ${meta.name}`,
    generatedAt,
    markdown: `${lines.join("\n")}\n`,
    counts: {
      papers: papersRecords.length,
      readings: readings.length,
      ideas: ideas.length,
      dryExperiments: dry.length,
      wetExperiments: wet.length,
      observations: observations.length,
      approvedConclusions: approved.length,
      unverifiedConclusions: unverified.length,
      decisions: decisions.length,
    },
    approved,
    unverified,
    recordIds: [...recordIds],
  };
}

function renderConclusionEntry(
  entry: ReportConclusionEntry,
  records: RecordStore,
  track: (id: string) => string,
): string[] {
  const lines: string[] = [];
  const { card } = entry;
  lines.push(`### ${card.title}${entry.simulated ? " `[模拟数据]`" : ""}`);
  lines.push("");
  lines.push(`- record：${ref(track(card.recordId))}`);
  lines.push(`- 主张：${card.claim}`);
  lines.push(
    `- 评审：approved by ${card.review.actor ?? "(未记名)"}` +
      `${card.review.actorSource ? `（${card.review.actorSource}）` : ""} @ ${card.review.at ?? "?"}` +
      `${card.review.decisionRecordId ? ` · decision ${ref(track(card.review.decisionRecordId))}` : ""}`,
  );
  if (card.confidence) lines.push(`- confidence：${card.confidence}`);
  lines.push(`- 可复现性口径：${RECONCILIATION_WORDING[entry.reconciliation]}`);
  lines.push(`- 证据：`);
  for (const item of entry.assessment.resolved) {
    const record = item.record;
    const tags: string[] = [];
    if (item.simulated) tags.push("模拟执行");
    if (item.deterministic === false) tags.push("非确定性平台");
    if (item.deterministic === true) tags.push("确定性平台");
    lines.push(
      `  - ${ref(track(item.id))}${tags.length > 0 ? ` \`[${tags.join(" · ")}]\`` : ""}` +
        `${record ? ` — ${firstParagraph(record.content, 160)}` : " — ⚠️ 该证据在本项目里找不到"}`,
    );
  }
  if (entry.simulated) {
    lines.push(
      `- ⚠️ 本结论的证据含模拟执行读数：模拟器验证的是协议在协议引擎里是否合法，不验证生物学。`,
    );
  }
  lines.push(`- 局限：${card.limitations ?? "（未填写）"}`);
  const softs = entry.assessment.findings.filter((f) => f.severity === "soft");
  if (softs.length > 0) {
    lines.push(`- 评审提示（soft，不否决）：`);
    for (const f of softs) lines.push(`  - ${f.message}`);
  }
  lines.push("");
  return lines;
}

function paperLabel(
  id: string,
  records: RecordStore,
  keyIndex: ReturnType<typeof libraryKeyIndex> | null,
  track: (id: string) => string,
): string {
  const record = records.get(id);
  if (!record) return `\`${shortId(id)}\`（已失效）`;
  track(id);
  const paperId = str(metaOf(record).libraryPaperId);
  const key = paperId && keyIndex ? keyIndex.byId.get(paperId) : undefined;
  return key ? `[@${key}]（${ref(id)}）` : `${record.title}（${ref(id)}）`;
}
