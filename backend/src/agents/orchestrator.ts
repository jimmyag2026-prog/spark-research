import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SparkResearchDaemon } from "../daemon/daemon";
import type { ArtifactStore } from "../artifacts/store";
import { LineageGraph } from "../artifacts/lineage";
import type { ExecutionRecord } from "../artifacts/models";
import { ReviewerAgent } from "../reviewer/agent";
import type { ReviewResult } from "../reviewer/rules";
import { LLMRouter, type ChatMessage } from "../llm/router";
import { SubAgentFactory, type SubAgentType } from "./sub_agent";
import type { Project, ProjectManager } from "../project/manager";
import { LibraryStore } from "../literature/library";
import { CoExploreSession, type GroundingReport } from "../ideation/coexplore";
import type { IdeaCard, StoredIdeaCard } from "../ideation/models";

const TASK_KINDS = ["analysis", "code", "connector", "compute", "subagent", "skill"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// 会话模式（P4）：chat = P1-P3 的规划/执行/review 循环；coexplore = 思路共探。
export const SESSION_MODES = ["chat", "coexplore"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export interface CoExploreSessionResult {
  sessionId: string;
  projectSlug: string | null;
  // 批判性讨论正文（就是给用户看的回复）。
  response: string;
  card: IdeaCard | null;
  stored: StoredIdeaCard | null;
  grounding: GroundingReport | null;
}

export interface PlannedTask {
  id: string;
  kind: TaskKind;
  description: string;
  params?: Record<string, unknown>;
}

export interface ExecutionOutcome {
  taskId: string;
  kind: TaskKind;
  ok: boolean;
  output: string;
}

export interface OrchestrationResult {
  sessionId: string;
  // AD-1：session 归属的 project slug；未接入 ProjectManager 时为 null。
  projectSlug: string | null;
  skills: string[];
  plan: PlannedTask[];
  execution: ExecutionOutcome[];
  summary: string;
  review: ReviewResult;
  reviewRounds: number;
}

export interface ReviewerAdapter {
  review(sessionId: string): Promise<ReviewResult>;
}

export interface OrchestratorDeps {
  llm?: Pick<LLMRouter, "call" | "listModels">;
  subAgents?: SubAgentFactory;
  store?: ArtifactStore;
  executionLog?: ExecutionRecord[];
  graph?: LineageGraph;
  reviewer?: ReviewerAdapter;
  maxReviewRounds?: number;
  workspaceRoot?: string;
  // 注入后 session 会归属到真实 project（找不到绑定时落到默认项目）。
  projects?: ProjectManager;
}

// skills 目录尚无正式实现，这里用内置目录作为 MVP stub；后续 skill 模块落地后替换。
interface SkillDef {
  name: string;
  context: string;
  keywords: string[];
}

const SKILL_CATALOG: SkillDef[] = [
  {
    name: "literature",
    context:
      "Query PubMed, arXiv, CNKI, WanFang via the literature connectors. Return sourced evidence with citation identifiers.",
    keywords: ["literature", "paper", "pubmed", "arxiv", "cnki", "wanfang", "引用", "文献", "论文"],
  },
  {
    name: "protein",
    context:
      "Query UniProt, PDB, AlphaFold via the protein connectors. Return structures and annotations as sourced evidence.",
    keywords: ["protein", "uniprot", "pdb", "alphafold", "蛋白", "蛋白质结构"],
  },
  {
    name: "genomics",
    context:
      "Query Ensembl, NCBI, CNCB via the genomics connectors for gene and genome data as sourced evidence.",
    keywords: ["gene", "genome", "ncbi", "ensembl", "基因", "基因组", "序列"],
  },
  {
    name: "chemistry",
    context:
      "Query ChEMBL, PubChem via the chemistry connectors for compounds and bioactivity as sourced evidence.",
    keywords: ["compound", "molecule", "chembl", "pubchem", "分子", "化学", "药物"],
  },
  {
    name: "compute",
    context:
      "Run numerical analysis in the python kernel or via the compute service. Report computed evidence traceable to a cell.",
    keywords: ["compute", "simulate", "fit", "统计", "计算", "模拟", "拟合", "数值", "分析数据"],
  },
  {
    name: "lab",
    context:
      "Drive lab devices through the lab protocol layer with the safety gate enabled. Record observed device readings.",
    keywords: ["lab", "experiment", "dry-wet", "仪器", "实验", "湿实验", "反应", "合成"],
  },
  {
    name: "ideation",
    context:
      "Co-explore a research idea Socratically against the project library, then check its novelty. " +
      "Every claim carries a [@key] citation to a library paper or an explicit (inferred) marker. " +
      "Produces idea cards and novelty reports as records in the evidence graph.",
    keywords: ["idea", "hypothesis", "novelty", "co-explore", "思路", "假设", "新颖", "创新点"],
  },
];

function loadPrompt(filename: string): string {
  try {
    return readFileSync(join(import.meta.dir, "prompt", filename), "utf8");
  } catch {
    return `[prompt missing: ${filename}]`;
  }
}

function normalizeTask(raw: unknown, index: number): PlannedTask | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind as TaskKind;
  if (!TASK_KINDS.includes(kind)) return null;
  const description = typeof obj.description === "string" ? obj.description : `task ${index + 1}`;
  const params = obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : {};
  return { id: typeof obj.id === "string" ? obj.id : `t_${index + 1}`, kind, description, params };
}

export class OrchestratorAgent {
  readonly daemon: SparkResearchDaemon;
  readonly workspaceRoot: string;

  private llm: Pick<LLMRouter, "call" | "listModels">;
  private subAgents: SubAgentFactory;
  private store?: ArtifactStore;
  private executionLog: ExecutionRecord[];
  private graph: LineageGraph;
  private reviewer?: ReviewerAdapter;
  private maxReviewRounds: number;
  private corePrompt: string;
  private researchPrompt: string;
  private projects?: ProjectManager;
  private projectCache = new Map<string, Project>();
  private seq = 0;

  constructor(daemon: SparkResearchDaemon, deps: OrchestratorDeps = {}) {
    this.daemon = daemon;
    this.llm = deps.llm ?? new LLMRouter();
    this.subAgents = deps.subAgents ?? new SubAgentFactory();
    this.store = deps.store;
    this.executionLog = deps.executionLog ?? [];
    this.graph = deps.graph ?? new LineageGraph();
    this.reviewer = deps.reviewer;
    this.maxReviewRounds = deps.maxReviewRounds ?? 3;
    this.projects = deps.projects;
    this.workspaceRoot = deps.workspaceRoot ?? join(import.meta.dir, "../../../workspaces");
    mkdirSync(this.workspaceRoot, { recursive: true });
    this.corePrompt = loadPrompt("core.txt");
    this.researchPrompt = loadPrompt("research.txt");
  }

  async processRequest(userMessage: string, sessionId: string): Promise<OrchestrationResult> {
    this.record(sessionId, "orchestrator", "start", `request received: ${userMessage.slice(0, 80)}`);
    mkdirSync(join(this.workspaceRoot, sessionId), { recursive: true });

    const project = this.projectForSession(sessionId);
    if (project) this.record(sessionId, "project", "bind", `session 归属 project '${project.slug}'`);

    const skills = this.identifySkills(userMessage);
    const skillContext = this.loadSkillContext(skills);
    const plan = await this.plan(userMessage, skills, skillContext);

    const execution: ExecutionOutcome[] = [];
    for (const task of plan) {
      execution.push(await this.executeTask(sessionId, task));
    }

    let summary = await this.summarize(userMessage, plan, execution);
    let review = await this.reviewSession(sessionId);
    let reviewRounds = 1;

    while (this.hasHardFindings(review) && reviewRounds < this.maxReviewRounds) {
      const hard = review.findings.filter((f) => f.severity === "hard").length;
      this.record(sessionId, "reviewer", "correct", `${hard} hard finding(s); planning corrections`);
      const fixes = this.planCorrections(review);
      for (const fix of fixes) {
        execution.push(await this.executeTask(sessionId, fix));
      }
      summary = await this.summarize(userMessage, plan, execution);
      review = await this.reviewSession(sessionId);
      reviewRounds++;
    }

    this.record(
      sessionId,
      "orchestrator",
      "done",
      review.approved ? "review approved" : "review vetoed",
    );

    return {
      sessionId,
      projectSlug: project?.slug ?? null,
      skills,
      plan,
      execution,
      summary,
      review,
      reviewRounds,
    };
  }

  sessionWorkspace(sessionId: string): string {
    return join(this.workspaceRoot, sessionId);
  }

  // AD-1：session 归属 project；已绑定用绑定的，未绑定落到默认项目并写回绑定。
  projectForSession(sessionId: string): Project | null {
    if (!this.projects) return null;
    const cached = this.projectCache.get(sessionId);
    if (cached) return cached;
    const project = this.projects.projectForSession(sessionId);
    this.projectCache.set(sessionId, project);
    return project;
  }

  private identifySkills(message: string): string[] {
    const low = message.toLowerCase();
    const found: string[] = [];
    for (const skill of SKILL_CATALOG) {
      if (skill.keywords.some((k) => low.includes(k.toLowerCase()))) found.push(skill.name);
    }
    return found;
  }

  private loadSkillContext(skills: string[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const name of skills) {
      const def = SKILL_CATALOG.find((s) => s.name === name);
      map[name] = def?.context ?? "";
    }
    return map;
  }

  private skillContextFor(name: string): string {
    return SKILL_CATALOG.find((s) => s.name === name)?.context ?? "";
  }

  private async plan(
    userMessage: string,
    skills: string[],
    skillContext: Record<string, string>,
  ): Promise<PlannedTask[]> {
    const context = skills.map((s) => `- ${s}: ${skillContext[s]}`).join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: `${this.corePrompt}\n\n${this.researchPrompt}` },
      {
        role: "user",
        content:
          `Available skills for this request:\n${context}\n\n` +
          `Define a research_contract and reply with ONLY a JSON array of tasks. ` +
          `Each task: {"id","kind","description","params"}. ` +
          `"kind" MUST be one of: ${TASK_KINDS.join(",")}. ` +
          `"analysis"=reasoning, "code"=run python (params.code), ` +
          `"connector"=query a database (params.server, params.tool, params.args), ` +
          `"compute"=submit compute job, "subagent"=delegate (params.subagent), ` +
          `"skill"=load skill context (params.skill). No markdown, no prose, only JSON. ` +
          `Request: ${userMessage}`,
      },
    ];
    const res = await this.llm.call(messages, LLMRouter.DEFAULT_MODEL);
    return this.parsePlan(res.content) ?? this.defaultPlan();
  }

  private parsePlan(content: string): PlannedTask[] | null {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return null;
    let data: unknown;
    try {
      data = JSON.parse(match[0]);
    } catch {
      return null;
    }
    const list = Array.isArray(data) ? data : (data as { tasks?: unknown })?.tasks;
    if (!Array.isArray(list)) return null;
    const tasks = list.map(normalizeTask).filter((t): t is PlannedTask => t !== null);
    return tasks.length > 0 ? tasks : null;
  }

  private defaultPlan(): PlannedTask[] {
    return [{ id: "t1", kind: "analysis", description: "explore and analyze the request" }];
  }

  private async executeTask(sessionId: string, task: PlannedTask): Promise<ExecutionOutcome> {
    try {
      switch (task.kind) {
        case "analysis": {
          const agent = this.subAgents.create("explore");
          const res = await this.llm.call(
            [{ role: "system", content: agent.prompt }, { role: "user", content: task.description }],
            agent.model,
          );
          this.record(sessionId, "explore", "run", res.content.slice(0, 200));
          return { taskId: task.id, kind: task.kind, ok: true, output: res.content };
        }
        case "code": {
          const code = String(task.params?.code ?? "");
          const kernelId = this.daemon.kernelManager.createKernel("python");
          try {
            const result = await this.daemon.kernelManager.execute(kernelId, code);
            const output = result.result ?? result.stdout ?? result.error ?? "";
            this.record(sessionId, "python", "execute", `${task.id}: ${result.status}`);
            return { taskId: task.id, kind: task.kind, ok: result.status === "ok", output: String(output) };
          } finally {
            this.daemon.kernelManager.dispose();
          }
        }
        case "connector": {
          try {
            const res = await this.daemon.dispatch("mcp_call", {
              server: String(task.params?.server ?? "pubmed"),
              tool: String(task.params?.tool ?? "search"),
              args: task.params?.args ?? {},
            });
            this.record(sessionId, "connector", "call", JSON.stringify(res).slice(0, 200));
            return { taskId: task.id, kind: task.kind, ok: true, output: JSON.stringify(res) };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.record(sessionId, "connector", "error", msg);
            return { taskId: task.id, kind: task.kind, ok: false, output: `[connector error: ${msg}]` };
          }
        }
        case "compute": {
          try {
            const job = await this.daemon.compute.submit(task.params ?? {});
            this.record(sessionId, "compute", "submit", job.id);
            return { taskId: task.id, kind: task.kind, ok: true, output: JSON.stringify(job) };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.record(sessionId, "compute", "error", msg);
            return { taskId: task.id, kind: task.kind, ok: false, output: `[compute error: ${msg}]` };
          }
        }
        case "subagent": {
          const type = (task.params?.subagent ?? "execute") as SubAgentType;
          const agent = this.subAgents.create(type);
          const res = await this.llm.call(
            [{ role: "system", content: agent.prompt }, { role: "user", content: task.description }],
            agent.model,
          );
          this.record(sessionId, agent.type, "run", res.content.slice(0, 200));
          return { taskId: task.id, kind: task.kind, ok: true, output: res.content };
        }
        case "skill": {
          const name = String(task.params?.skill ?? "");
          this.record(sessionId, "skill", name, "context loaded");
          return { taskId: task.id, kind: task.kind, ok: true, output: this.skillContextFor(name) };
        }
        default: {
          const kind = String(task.kind) as string;
          return { taskId: task.id, kind: task.kind, ok: false, output: `unknown task kind: ${kind}` };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record(sessionId, task.kind, "error", message);
      return { taskId: task.id, kind: task.kind, ok: false, output: message };
    }
  }

  private async summarize(
    userMessage: string,
    plan: PlannedTask[],
    execution: ExecutionOutcome[],
  ): Promise<string> {
    const exec = execution
      .map((e) => `- [${e.kind}] ${e.taskId}: ${e.ok ? "ok" : "failed"} — ${e.output.slice(0, 200)}`)
      .join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `${this.corePrompt}\n\n` +
          "Synthesize the observable execution records into a result summary with evidence labels.",
      },
      {
        role: "user",
        content:
          `Request: ${userMessage}\nPlan:\n${plan.map((p) => `- ${p.kind}: ${p.description}`).join("\n")}` +
          `\nExecution log:\n${exec}`,
      },
    ];
    const res = await this.llm.call(messages, LLMRouter.DEFAULT_MODEL);
    return res.content;
  }

  private async reviewSession(sessionId: string): Promise<ReviewResult> {
    if (this.reviewer) return this.reviewer.review(sessionId);
    // 没有显式注入 store 时，退到 session 所属 project 的 artifact 存储（AD-1）。
    const store = this.store ?? this.projectForSession(sessionId)?.artifacts();
    if (!store) {
      this.record(sessionId, "reviewer", "skip", "no artifact store attached; review bypassed");
      return { approved: true, findings: [] };
    }
    const execs = this.executionLog.length > 0 ? this.executionLog : store.listExecutionsByFrame(sessionId);
    const reviewer = new ReviewerAgent(store, execs, this.graph);
    const result = await reviewer.review(sessionId);
    this.record(
      sessionId,
      "reviewer",
      "run",
      `${result.findings.length} finding(s), approved=${result.approved}`,
    );
    return result;
  }

  private planCorrections(review: ReviewResult): PlannedTask[] {
    const hard = review.findings.filter((f) => f.severity === "hard");
    const fixes: PlannedTask[] = [];
    if (hard.length === 0) {
      fixes.push({
        id: `fix_${++this.seq}`,
        kind: "analysis",
        description: "re-verify artifacts for remaining findings",
      });
      return fixes;
    }
    for (const f of hard) {
      fixes.push({
        id: `fix_${++this.seq}`,
        kind: "analysis",
        description: `address hard finding: ${f.message}`,
        params: { finding: f },
      });
    }
    return fixes;
  }

  private hasHardFindings(review: ReviewResult): boolean {
    return review.findings.some((f) => f.severity === "hard");
  }

  private record(sessionId: string, actor: string, action: string, message: string): void {
    this.daemon.executionLog.record({ ts: new Date().toISOString(), sessionId, actor, action, message });
  }

  // ── Co-explore 会话模式（P4，DESIGN 域 A4）──────────────────────────────────
  //
  // 与默认 chat 是**并列**的会话模式，不是它的一个分支：co-explore 不做规划/执行/review 循环，
  // 它只做一件事——围绕用户的思路做有文献支撑的批判性探讨，并产出结构化 Idea 卡。
  // 默认路径（mode 缺省 = "chat"）的行为与 P1-P3 完全一致。
  async coexplore(req: {
    sessionId: string;
    message: string;
    model?: string;
    // false = 只讨论不落库（多轮共探的中间轮）。
    persist?: boolean;
  }): Promise<CoExploreSessionResult> {
    this.record(req.sessionId, "coexplore", "start", req.message.slice(0, 80));
    const project = this.projectForSession(req.sessionId);
    if (!project) {
      // 没有 ProjectManager 就没有文献库，也就没有 grounding 的对象。
      // 如实说明而不是退化成一次没有证据的闲聊。
      return {
        sessionId: req.sessionId,
        projectSlug: null,
        response:
          "[coexplore] 当前会话没有绑定项目，无法读取项目文献库；" +
          "co-explore 的观点必须能回链到库内论文，请先 spark-research project new 建立项目。",
        card: null,
        stored: null,
        grounding: null,
      };
    }

    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    try {
      const session = new CoExploreSession({
        llm: this.llm,
        library,
        records: project.records(),
        model: req.model,
        projectContext: project.meta.description || undefined,
        promptDir: join(import.meta.dir, "prompt"),
      });
      const turn = await session.turn(req.message, { sessionId: req.sessionId });
      const stored =
        req.persist === false ? null : session.save(turn.card, { sessionId: req.sessionId, model: turn.model });
      this.record(
        req.sessionId,
        "coexplore",
        "card",
        stored ? `idea record ${stored.recordId}` : "候选卡（未落库）",
      );
      return {
        sessionId: req.sessionId,
        projectSlug: project.slug,
        response: turn.card.critique,
        card: turn.card,
        stored,
        grounding: turn.grounding,
      };
    } finally {
      library.close();
    }
  }

  async chat(req: {
    sessionId: string;
    message: string;
    model?: string;
    // 会话模式。缺省 = "chat"，行为与 P1-P3 完全一致。
    mode?: SessionMode;
  }): Promise<{ response: string; review?: ReviewResult; ideaRecordId?: string | null }> {
    if (req.mode === "coexplore") {
      const result = await this.coexplore(req);
      return {
        response: `[coexplore ${req.sessionId}]\n${result.response}`,
        ideaRecordId: result.stored?.recordId ?? null,
      };
    }
    const result = await this.processRequest(req.message, req.sessionId);
    return {
      response: `[session ${req.sessionId}]\n${result.summary}`,
      review: result.review,
    };
  }
}
