import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SparkResearchDaemon } from "../daemon/daemon";
import type { ArtifactStore } from "../artifacts/store";
import { LineageGraph } from "../artifacts/lineage";
import type { ExecutionRecord } from "../artifacts/models";
import { ReviewerAgent } from "../reviewer/agent";
import type { ReviewResult } from "../reviewer/rules";
import { LLMRouter, type CallOptions, type ChatMessage } from "../llm/router";
import {
  buildSubAgentSpec,
  runSubAgent,
  runSubAgentOfType,
  SubAgentFactory,
  type SubAgentDeps,
  type SubAgentType,
} from "./sub_agent";
// 值导入（不是 `import type`）：getToolRunner() 要在运行期真的 `new` 它。这与
// mcp/server.ts → server/app.ts → agents/orchestrator.ts 构成一个模块级循环依赖，
// 但两边都只在**函数体内**（不是模块顶层）用到对方——ESM 的循环 import 只要不在
// 模块初始化阶段互相读对方尚未求值的绑定就没问题，`server/app.ts` 的 `ServerContext`
// 构造函数本来就已经是这个模式（`new OrchestratorAgent(...)` 在方法体里，不在顶层）。
import { McpToolRunner, type McpServerOptions } from "../mcp/server";
// V32：把 W4-d/W5-2-δ 的 `createExternalToolRunner()` 接进 `getToolRunner()`——
// 同样是值导入（工厂函数要在运行期真的调），静态 import 不引入新的模块级循环：
// `extensions/mcp_client.ts` 顶层只 import fs/path/MCP SDK/`llm/types`/`agents/contract`
// （类型只读引用，contract.ts 不 import 回 extensions/** 或 agents/orchestrator.ts）/
// `./types`/`./grants`/`./context`/`./paths`；它对 `../mcp/server` 的依赖是**动态**
// import（见该文件头注释，理由与这里的 `McpToolRunner` 静态导入本身无关——那是
// mcp_client.ts 自己为了不参与 capabilities/index.ts 那个环而做的选择）。
// V45：`emptyExternalMcpAttachment` 是值导入（"这一轮没有外部 MCP"的空句柄），其余三个
// 是**纯类型**（`import type`，编译期擦除）。真正的实现 `ExternalMcpRuntime` 在
// `extensions/loader.ts`，本文件**刻意不 import 它**——orchestrator 只认
// `ExternalMcpProvider` 这个接口，于是 V45 没有给 orchestrator 的模块图添加**任何**
// 新的运行时边（loader.ts 会把 connectors/manifest 等一串东西拖进来）。谁来 new 那个
// 实现，是生产接线点（`index.ts` / `server/context.ts`）的事。
import {
  createExternalToolRunner,
  emptyExternalMcpAttachment,
  type ExternalToolRegistry,
  type ExternalMcpProvider,
  type ExternalMcpAttachment,
  type EvidenceRecordSink,
} from "../extensions/mcp_client";
// V27/V33：prompt 内嵌副本 + 数据目录解析。dataDir() 是仓库既有的单一真源
// （env SPARK_RESEARCH_DATA_DIR > ~/.spark-research），不另起一套。
import { DEFAULT_PROMPT_DIR as PROMPT_DIR, readPromptText } from "./prompts";
import { configuredModel, dataDir } from "../config";
import { UsageStore, usageTrackingLlm } from "../usage/ledger";
import type { KernelExecuteOptions } from "../kernels/manager";
import { BudgetLedger } from "../llm/budget";
import {
  createLiteratureReviewContract,
  describeStop,
  evaluateRound,
  NoProgressGuard,
  RecordStoreEvidenceQuery,
  type ContractReport,
  type ContractStageReport,
  type EvidenceQuery,
  type ResearchContract,
  type StopReason,
} from "./contract";
import {
  runReplanLoop,
  type Observation,
  type Planner,
  type RoundExecutor,
  type RoundLogEntry,
  type RoundOutcome,
  type RoundPlan,
  type RoundPlanItem,
} from "./replan";
import type { Project, ProjectManager } from "../project/manager";
import { LibraryStore } from "../literature/library";
import { CoExploreSession, type GroundingReport } from "../ideation/coexplore";
import type { IdeaCard, StoredIdeaCard } from "../ideation/models";
import { AgentRunLedger } from "./ledger";

// export：F-a 新增的 planner-prompt/TASK_KINDS 同源测试要从外部读这张表，
// 与 plan() 里手写的逐 kind 说明文字做双向比对（防止未来再出现「表里删了，
// prompt 里的说明文字忘了删」——v0.4 的 compute 就是这么活了四个版本）。
export const TASK_KINDS = ["analysis", "code", "connector", "subagent", "skill"] as const;
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
  // F-a：故意不是 TaskKind——见 normalizeTask() 的注释，一个 planner 计划出的、
  // TASK_KINDS 里已经没有的 kind（比如已删掉的 "compute"）必须能流到 executeTask()
  // 的 switch 默认分支显式报错，而不是在这里被悄悄过滤掉、计划里凭空少一个任务。
  kind: string;
  description: string;
  params?: Record<string, unknown>;
}

export interface ExecutionOutcome {
  taskId: string;
  kind: string;
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
  /**
   * P9 的进程内工具运行器（W2-a 的 runSubAgent() 要求调用方传入）。不给就在第一次需要
   * 真子代理工具面时惰性构造一个、复用同一实例（见 `getToolRunner()`）——惰性构造要求
   * `projects` 已注入（子代理的工具要操作跟当前 session 同一个证据图），否则退回旧的
   * 裸 `llm.call` 路径（不静默假装有工具，见 executeTask 的 "subagent" 分支注释）。
   * 测试可以直接注入一个假 `McpToolRunner`，不需要真的起 HTTP app。
   */
  toolRunner?: McpToolRunner;
  /**
   * V32：已连接的外部 MCP 扩展登记表（`extensions/mcp_client.ts` 的
   * `ExternalToolRegistry`）。注入后，`getToolRunner()` 惰性构造工具面时改用
   * `createExternalToolRunner()`——产出的 runner 对 `mcp:<extension>:<tool>` 这类
   * 已注册的外部工具名路由给对应 session，其余工具名原样交给内置的 `McpToolRunner`
   * 逻辑（子类化，不是替换）。**只影响"工具名认不认、调用真正执行"这一层**——
   * 子代理能不能拿到某个 `mcp:` 工具名的授权仍然是 `SubAgentSpec.grants` 白名单说了
   * 算（`agents/toolbus.ts` 的 AD-2 硬规则），本字段不会绕开授权自动放行任何工具。
   * 不给就是 v0.4 原样行为：`getToolRunner()` 构造裸的 `McpToolRunner`，`mcp:` 前缀
   * 的工具名不会被任何人认得（父类的"未知工具"分支兜底）。
   *
   * **已知缺口**（如实记录，见 `docs/devlog/W5-2-d.md`）：谁来"连接真实的外部 MCP
   * 扩展、把它们的 session 注册进这张表"不在本字段的职责内——生产环境该在哪个时刻
   * 建这张表（daemon 启动时？每个 session 各自连一次？）取决于 `daemon/daemon.ts`、
   * `index.ts`、`server/context.ts` 这几个构造 `OrchestratorAgent` 的地方，它们都不在
   * 本 lane 的文件所有权范围内，本 lane 只交付"注入了就能用"这一半。
   */
  externalTools?: ExternalToolRegistry;
  /**
   * V45：外部 MCP 扩展的运行时提供方（生产实现是 `extensions/loader.ts` 的
   * `ExternalMcpRuntime`）。注入之后，**每次 `runResearchLoop()`** 会：
   *   开跑前 `attach()`：发现已装且已 --trust 的 `kind="mcp_client"` 扩展 → 各起一个
   *   子进程 → 注册进 `ExternalToolRegistry` → 把**本 session 所属 project 的
   *   RecordStore** 作为 `recordSink` 绑下去（V31 真正生效的那一刻）；
   *   跑完（含抛异常的路径，走 `finally`）`close()`：把这一轮开的子进程全部收掉。
   *
   * **不注入 = 这条流程整个不存在**，行为与 v0.4 逐字节一致：零 `readdir`、零子进程。
   * 这是惰性策略的第一层——`lit search` 之类的 CLI 根本不构造 orchestrator，
   * 更走不到这里。上面那条"已知缺口"到此为止：`externalTools` 现在有生产调用方了，
   * 就是下面的 `attachExternalMcp()`。
   *
   * 失败隔离：`attach()` 内部逐个扩展隔离，一个连不上只产生一条 `failed` 记录；
   * 就算 provider 整个抛了，`attachExternalMcp()` 也会兜住并退回"这一轮没有外部工具"，
   * **绝不**让一个坏扩展带走整轮 agent 运行。
   */
  externalMcp?: ExternalMcpProvider;
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
  // V27：`readFileSync(join(import.meta.dir, "prompt", filename))` 在单二进制里读的是
  // `/$bunfs/root/prompt/core.txt`，永远 catch → system prompt 静默变成
  // `[prompt missing: core.txt]`（不崩溃，只是降智）。readPromptText 先读真目录、
  // 读不到才用编译期内嵌的副本，源码模式行为不变。
  return readPromptText(PROMPT_DIR, filename) ?? `[prompt missing: ${filename}]`;
}

// F-a（F-5 的顺手修）：这里曾经用 `if (!TASK_KINDS.includes(kind)) return null`
// 把 kind 不在白名单里的任务直接过滤掉——静默丢弃，计划里少了一个任务，执行日志
// 里没有任何痕迹，跟被清掉的假 compute 服务是同一类问题（LLM 计划出的东西悄悄
// 变成"什么都没发生"，而不是一个看得见的失败）。现在只做「这是不是个像样的任务
// 描述」的形状校验（kind 是非空字符串），真正「这个 kind 认不认」交给 executeTask()
// 的 switch——命中不了任何 case 就落到 default，显式返回 `ok:false` 并写执行日志，
// 计划里也仍然看得见这个任务。见 tests/unit/orchestrator.test.ts 的
// 「未知 task kind 显式失败」用例与其阴性对照。
function normalizeTask(raw: unknown, index: number): PlannedTask | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.kind === "string" && obj.kind.length > 0 ? obj.kind : null;
  if (!kind) return null;
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
  // 惰性构造、跨调用复用的真实工具面（见 getToolRunner()）；测试可以直接注入一个假的。
  private toolRunner?: McpToolRunner;
  // V32：注入了就在惰性构造工具面时改用 createExternalToolRunner()，见 getToolRunner()。
  private externalTools?: ExternalToolRegistry;
  // V45：外部 MCP 的运行时提供方；不注入就整条流程不存在（见 OrchestratorDeps.externalMcp）。
  private externalMcp?: ExternalMcpProvider;
  // toolRunner 是调用方**显式注入**的还是本类惰性构造的。attachExternalMcp() 需要区分：
  // 自己造的那一个可以为了接上新到手的 registry 而丢掉重造，别人注入的不能动
  // （那是调用方指定的工具面，悄悄换掉它会让"注入 toolRunner"这个注入点失效）。
  private readonly toolRunnerInjected: boolean;
  // 一轮 agent 运行（= 一个 attachment 句柄）对应一个带外部工具的 runner。用 WeakMap
  // 而不是实例字段：句柄被丢掉后条目自动消失，且并发的两轮各查各的，互不干扰。
  private readonly runnerByAttachment = new WeakMap<ExternalMcpAttachment, Promise<McpToolRunner>>();

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
    this.toolRunner = deps.toolRunner;
    this.toolRunnerInjected = deps.toolRunner !== undefined;
    this.externalTools = deps.externalTools;
    // 只是记住这个引用——**不**在构造函数里 attach()。惰性策略 L0：构造一个
    // OrchestratorAgent 不该产生任何文件系统扫描，更不该起子进程。
    this.externalMcp = deps.externalMcp;
    // V33：默认值原本是 `join(import.meta.dir, "../../../workspaces")`。在 `bun build --compile`
    // 产物里 `import.meta.dir` 是 `/$bunfs/root`，往上跳三层被 node:path 归一化钉在文件系统
    // 真实的根——结果是 `/workspaces`，而下一行紧接着 `mkdirSync(..., {recursive:true})`。
    // 这不是"读不到文件"，是**往文件系统根目录写**：普通用户跑会因权限崩，用 root 跑会把
    // 会话工作区静默建在 `/workspaces`。改成挂在数据目录下（与 projects/config.json 同一个根），
    // 二进制/源码/npm 三条安装路径下都指向同一个用户可写、可预期的位置。
    this.workspaceRoot = deps.workspaceRoot ?? join(dataDir(), "workspaces");
    mkdirSync(this.workspaceRoot, { recursive: true });
    this.corePrompt = loadPrompt("core.txt");
    this.researchPrompt = loadPrompt("research.txt");
  }

  /**
   * 惰性构造、跨调用复用的真实工具面——W2-b 交接说明第 3 点：「orchestrator 通常已经
   * 持有一个跟当前会话绑定的 Hono app / daemon 实例，McpToolRunner 应该复用那一个，
   * 而不是每次子代理调用都重新构造一份」。本 orchestrator 没有现成的 app，构造一个新的
   * 只在**第一次**真的需要工具面时发生，之后缓存复用；`agent: this` 让新 app 不必再递归
   * 造一个 OrchestratorAgent（`server/context.ts` 没注入 `agent` 时会自己 new 一个）。
   *
   * 返回 `null`（而不是抛错）的唯一情况：既没注入 `toolRunner`，也没注入 `projects`。
   * 后者是有意的降级信号——子代理的工具要操作跟当前 session 同一个证据图，没有 project
   * 就没有真实的证据图可操作，调用方（executeTask 的 subagent 分支 / runResearchLoop）
   * 据此决定退回旧路径或直接报错，而不是悄悄用一个跟当前 session 无关的默认 project。
   *
   * V32：构造分两条路——注入了 `externalTools` 就走 `createExternalToolRunner()`
   * （产出的实例仍然是 `McpToolRunner` 的子类，其余调用方看不出区别），否则原样
   * `new McpToolRunner(...)`。`createExternalToolRunner()` 是 `async` 工厂（内部动态
   * `import("../mcp/server")`，见 mcp_client.ts 文件头注释），所以本方法也改成
   * `async`——两处调用方（executeTask 的 subagent 分支、runResearchLoop）本来就在
   * `async` 函数体内，补一个 `await` 不改变其余逻辑。
   */
  private async getToolRunner(): Promise<McpToolRunner | null> {
    if (this.toolRunner) return this.toolRunner;
    if (!this.projects) return null;
    const baseOptions: McpServerOptions = { projects: this.projects, agent: this };
    this.toolRunner = this.externalTools
      ? await createExternalToolRunner(baseOptions, this.externalTools)
      : new McpToolRunner(baseOptions);
    return this.toolRunner;
  }

  /**
   * V45：一次 agent 运行的外部 MCP「开场」。返回的句柄必须在 `finally` 里 `close()`。
   *
   * 这个方法是**整条流程唯一的触发点**——惰性策略的第二层：没有它被调用，
   * `ExternalMcpRuntime` 不会 readdir，更不会 spawn 任何东西。
   *
   * 三件事，顺序有意义：
   *   1. 没注入 provider → 立刻返回空句柄。**零 I/O**，这是绝大多数调用方（所有测试、
   *      所有没装 mcp_client 扩展的用户走的 CLI 路径）会走到的分支。
   *   2. `attach()` 抛了 → 兜住，退回空句柄。provider 是外部实现（生产的那个自己已经
   *      逐扩展隔离过一层，但接口不保证别的实现也这么老实），"坏扩展不许拖垮整轮"
   *      这条要求在**接口边界**上也得成立，不能只指望实现方守规矩。
   *
   * **不改任何实例状态**（不动 `this.externalTools`、不动 `this.toolRunner`）：一个
   * `OrchestratorAgent` 实例在 HTTP 服务下被多个 session 并发使用，把"这一轮连上了
   * 哪些外部工具"写进实例字段会让并发的两轮互相污染。这一轮的外部工具面通过返回的
   * 句柄逐层传参往下走，见 `runnerFor()`。
   */
  private async attachExternalMcp(sessionId: string, sink?: EvidenceRecordSink): Promise<ExternalMcpAttachment> {
    if (!this.externalMcp) return emptyExternalMcpAttachment();

    let attachment: ExternalMcpAttachment;
    try {
      attachment = await this.externalMcp.attach({ recordSink: sink });
    } catch (error) {
      this.record(
        sessionId,
        "external_mcp",
        "attach-failed",
        `外部 MCP 装配整体失败，本轮不带外部工具继续：${error instanceof Error ? error.message : String(error)}`,
      );
      return emptyExternalMcpAttachment();
    }

    // 失败隔离的「可见记录」那一半：连不上/跳过的扩展逐条进执行日志。
    // （另一半在证据图里——`recordSink` 让**调用**留痕；连接失败还没有调用可留痕，
    //   所以它只能落在这里。这是一个如实记录的不对称，见 devlog。）
    for (const failed of attachment.failed) {
      this.record(sessionId, "external_mcp", "failed", `扩展 "${failed.extension}" 连接失败，已跳过：${failed.reason}`);
    }
    for (const skipped of attachment.skipped) {
      this.record(sessionId, "external_mcp", "skipped", `扩展 "${skipped.extension}" 未装配：${skipped.reason}`);
    }
    if (attachment.connected.length > 0) {
      this.record(sessionId, "external_mcp", "connected", `已连接外部 MCP 扩展：${attachment.connected.join(", ")}`);
    }

    return attachment;
  }

  /**
   * V45 ③ 的落点：这一轮 agent 运行该用哪个工具面。
   *
   * - 这一轮没连上任何外部扩展（绝大多数情况）→ 原样走 `getToolRunner()`，包括它的
   *   跨调用缓存。**没装扩展的用户这条路径与 v0.4 逐字节一致。**
   * - 调用方显式注入了 `toolRunner` → 用它，不替换。注入 toolRunner 的语义是"工具面
   *   由我指定"，为了塞外部工具把它换掉会让这个注入点失效（既有测试就靠它）。
   * - 这一轮有外部扩展 → 现造一个 `createExternalToolRunner()`，把**这一轮自己那张**
   *   registry 闭包进去。按句柄记忆（WeakMap），所以一轮里派多个子代理不会造多个
   *   Hono app；不同轮各自独立，没有共享可变状态可污染。
   */
  private async runnerFor(external: ExternalMcpAttachment): Promise<McpToolRunner | null> {
    if (!external.registry) return this.getToolRunner();
    if (this.toolRunnerInjected && this.toolRunner) return this.toolRunner;
    const cached = this.runnerByAttachment.get(external);
    if (cached) return cached;
    if (!this.projects) return null;
    const pending = createExternalToolRunner({ projects: this.projects, agent: this }, external.registry);
    this.runnerByAttachment.set(external, pending);
    return pending;
  }

  /** 这一轮该额外授权给（非只读）子代理的外部工具名，见 `runResearchLoopWithProject()` 的长注释。 */
  private externalGrantsOf(external: ExternalMcpAttachment): string[] {
    return external.registry?.specs().map((s) => s.name) ?? [];
  }

  /**
   * `SubAgentDeps.llm` 要求 `Pick<LLMRouter, "call" | "capabilitiesFor">`（W2-a 的硬性
   * 依赖：不支持 tool calling 的模型必须走显式降级，见 sub_agent.ts 的 `runDegraded`），
   * 但 `OrchestratorDeps.llm` 的公开类型仍然只承诺 `"call" | "listModels"`——**刻意不
   * 收紧**：narrative_parity.test.ts（不在本 lane 文件所有权内）构造 OrchestratorAgent
   * 用的假 LLM 只实现了这两个方法，收紧类型会让那个文件的 typecheck 当场变红，而我们
   * 不能去改它。这里在运行期适配：有 `capabilitiesFor` 就直接转发，没有就保守假设
   * `toolCalling: true`（真实 LLMRouter 一定有这个方法；没有这个方法的只会是测试假件，
   * 而测试假件只有在同时注入了 `toolRunner`/`projects` 时才会真的走到这条路径——见
   * getToolRunner() 的降级设计，两者结合下这个假设不会被没打算测真 tool loop 的用例踩到）。
   */
  /**
   * V78（v0.7 W7-D0）：chat 路径此前自建 LLMRouter 直调，不进 usage.jsonl 也不进 raw/llm/——
   * 与 CLI/HTTP 口径不一。会话绑定了项目就经 usageTrackingLlm（同一份台账、同一个 raw sink，
   * command=chat）；没绑项目退回裸 llm（没有落点，不假装记了）。
   */
  // V119（v0.8）：聊天式 co-explore / chat 的预算闸——UI「预算 $」透传到这里，按会话记住，
  // 每次 llmFor 都带上（同一次 chat() 内的多次模型调用共用一个闸）。
  private readonly sessionBudget = new Map<string, { budgetUsd?: number; allowUnpriced?: boolean }>();

  private llmFor(sessionId: string | null): Pick<LLMRouter, "call"> {
    const project = sessionId ? this.projectForSession(sessionId) : null;
    if (!project) return this.llm;
    const budget = sessionId ? this.sessionBudget.get(sessionId) : undefined;
    return usageTrackingLlm({
      llm: this.llm,
      store: new UsageStore(join(project.paths.root, "usage.jsonl")),
      command: "chat",
      budgetUsd: budget?.budgetUsd,
      allowUnpriced: budget?.allowUnpriced,
      rawSink: project.raw(),
      project: project.slug,
      sessionId,
    });
  }

  private recordExecution(
    sessionId: string,
    input: { kernelId: string; code: string; result: { status: string; stdout?: string; stderr?: string; timedOut?: boolean } },
  ): void {
    const project = this.projectForSession(sessionId);
    if (!project) return;
    try {
      const artifacts = project.artifacts();
      const cellIndex = artifacts.listExecutionsByFrame(sessionId).length;
      artifacts.saveExecution({
        frame: sessionId,
        cellIndex,
        kernelId: input.kernelId,
        language: "python",
        source: input.code,
        stdout: input.result.stdout ?? "",
        stderr: input.result.stderr ?? "",
        status: input.result.timedOut ? "timeout" : input.result.status,
        filesWritten: [],
        filesRead: [],
        wallTime: null,
        cpuTime: null,
        peakMemory: null,
      });
    } catch {
      // 记账失败不打断 task（与 raw 埋点同口径）；系统性漏记由 execution_records 的导出计数暴露。
    }
  }

  private kernelRawFor(sessionId: string | null): KernelExecuteOptions["raw"] {
    const project = sessionId ? this.projectForSession(sessionId) : null;
    if (!project) return undefined;
    return { sink: project.raw(), project: project.slug, sessionId, command: "chat" };
  }

  /**
   * V78 残余（v0.8 W8-1 β）：子代理 tool loop 此前裸调 `llm.call`——不进 usage.jsonl
   * 也不进 raw/llm/，与 `llmFor()`（chat 主循环，command="chat"）同一处漏记的另一半。
   * 会话绑定了项目就经 usageTrackingLlm（command="chat:subagent"，与主循环的 "chat"
   * 区分开，usage 按 command 聚合时子代理花费单独可见）；没绑项目退回裸 llm——没有
   * 落点，不假装记了（与 llmFor 同口径）。`capabilitiesFor` 的运行期适配逻辑不变
   * （见上方长注释：narrative_parity.test.ts 的假 LLM 只实现两个方法，不能收紧类型）。
   */
  private subAgentLlm(sessionId: string | null): Pick<LLMRouter, "call" | "capabilitiesFor"> {
    const llm = this.llm;
    const withCaps = llm as Partial<Pick<LLMRouter, "capabilitiesFor">>;
    const capabilitiesFor = withCaps.capabilitiesFor
      ? (model: string) => withCaps.capabilitiesFor!(model)
      : () => ({ toolCalling: true, jsonMode: true, streaming: true, usageReported: true });

    const project = sessionId ? this.projectForSession(sessionId) : null;
    if (!project) {
      return { call: (messages, options) => llm.call(messages, options), capabilitiesFor };
    }
    const tracked = usageTrackingLlm({
      llm,
      store: new UsageStore(join(project.paths.root, "usage.jsonl")),
      command: "chat:subagent",
      rawSink: project.raw(),
      project: project.slug,
      sessionId,
    });
    return { call: (messages, options) => tracked.call(messages, options), capabilitiesFor };
  }

  async processRequest(
    userMessage: string,
    sessionId: string,
    options: { onDelta?: (chunk: string) => void } = {},
  ): Promise<OrchestrationResult> {
    this.record(sessionId, "orchestrator", "start", `request received: ${userMessage.slice(0, 80)}`);
    mkdirSync(join(this.workspaceRoot, sessionId), { recursive: true });

    const project = this.projectForSession(sessionId);
    if (project) this.record(sessionId, "project", "bind", `session 归属 project '${project.slug}'`);

    // ── V45：这条才是生产里真正的 agent 运行路径 ────────────────────────────
    //
    // 追查 V45 时发现的第二件事（写进 devlog）：`runResearchLoop()` 本身**也**没有
    // 生产调用方——CLI 的 `chat`/交互模式、HTTP 的 `/session`、SSE 三条路走的全是
    // `chat()` → `processRequest()`。只把外部 MCP 接在研究循环上，等于把一条已建好
    // 的流程接到另一条同样没人走的流程上，V45 会以"接了但仍然没有生产调用方"的形式
    // 复现它自己要解决的那个病。所以两条路都接：这里是生产路径，`runResearchLoop()`
    // 是契约化研究循环。
    //
    // `recordSink` 用 `project?.records()`——session 没绑定 project 时传 undefined：
    // 没有证据图可落，外部调用仍会照常落 `.mcp_calls.jsonl` 审计记录（W4-d 的行为），
    // 不会因为"没有图"而静默不审计。
    const external = await this.attachExternalMcp(sessionId, project?.records());
    try {
      return await this.processRequestWithTools(userMessage, sessionId, project, external, options);
    } finally {
      // 收尾（含中途抛异常的路径）：本轮开的子进程全部收掉，不留孤儿进程。
      await external.close();
    }
  }

  private async processRequestWithTools(
    userMessage: string,
    sessionId: string,
    project: Project | null,
    external: ExternalMcpAttachment,
    options: { onDelta?: (chunk: string) => void } = {},
  ): Promise<OrchestrationResult> {
    const skills = this.identifySkills(userMessage);
    const skillContext = this.loadSkillContext(skills);
    const plan = await this.plan(sessionId, userMessage, skills, skillContext);

    const execution: ExecutionOutcome[] = [];
    for (const task of plan) {
      execution.push(await this.executeTask(sessionId, task, external));
    }

    // onDelta 只接到 summarize()——它是唯一产出「用户最终会看到的正文」的调用点
    // （result.summary 直接就是 chat() 返回的 response）。plan() 产出的是 JSON 任务数组，
    // 把它的增量当"预览文本"流给用户只会看到破碎的 JSON 片段，那不是根治 W2-d 的问题，
    // 是换一种方式制造同一个问题——见 docs/devlog/W3-a.md「onDelta 怎么接」一节。
    let summary = await this.summarize(sessionId, userMessage, plan, execution, options.onDelta);
    let review = await this.reviewSession(sessionId);
    let reviewRounds = 1;

    while (this.hasHardFindings(review) && reviewRounds < this.maxReviewRounds) {
      const hard = review.findings.filter((f) => f.severity === "hard").length;
      this.record(sessionId, "reviewer", "correct", `${hard} hard finding(s); planning corrections`);
      const fixes = this.planCorrections(review);
      for (const fix of fixes) {
        execution.push(await this.executeTask(sessionId, fix, external));
      }
      // 多轮修正场景下 onDelta 会依次收到每一轮 summarize() 的增量，不只是最终一轮——
      // 已知的、如实记录的简化，见 devlog（根治需要一个「本轮作废，重新开始」的边界信号，
      // 那属于 SSE 传输层的事，不在本文件所有权内）。
      summary = await this.summarize(sessionId, userMessage, plan, execution, options.onDelta);
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
    sessionId: string,
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
          `"subagent"=delegate (params.subagent), ` +
          `"skill"=load skill context (params.skill). No markdown, no prose, only JSON. ` +
          `Request: ${userMessage}`,
      },
    ];
    const res = await this.llmFor(sessionId).call(messages, configuredModel(LLMRouter.DEFAULT_MODEL));
    // D-4（战术版）：规划这一步的 LLM 调用失败时，`res.content` 是路由层拼出的错误
    // 文本（例如 "[error] No API key configured..."），不是模型产出的 JSON 计划——
    // 不检查 res.ok 就直接喂给 parsePlan 虽然「碰巧」解析不出方括号数组从而落到
    // defaultPlan()，但这纯属误打误撞：换一种上游错误格式（比如错误文本里恰好带
    // 一对方括号）就会把错误文本当成计划解析。显式检查一次，把这一步的失败记进
    // 执行日志（可见），再统一落到同一个 defaultPlan() 兜底。
    //
    // F-2 收尾（W3-a）：这里原来读 `res.content.slice(0, 200)` 记诊断——AD-13（P11）
    // 把 LlmResponse 做成可辨识联合之后，`ok:false` 分支的 `content` 类型是字面量
    // `""`，`res.content` 恒为空字符串，这一行从那时起就在往执行日志里记一个永远是
    // 空串的"诊断"，真正的原因（`res.error.message`）从没被读过——不是冗余防线，是
    // 一条已经失效但没人发现的防线（D-4 写下它的时候 AD-13 还不存在，那时 content
    // 确实held错误文本）。改读 `res.error.message`，`if (!res.ok)` 分支本身继续保留
    // ——它不是"多余的重复检查"，是 TypeScript 窄化到 `res.error` 存在这条分支的
    // 唯一入口，删了它类型都过不了，且控制流上仍然必须走这条分支才能不把（如今恒为
    // 空串的）`res.content` 当成计划文本喂给 parsePlan()。
    if (!res.ok) {
      this.record(sessionId, "orchestrator", "plan-llm-failed", `planning LLM call failed: ${res.error.message}`);
      return this.defaultPlan();
    }
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

  private async executeTask(
    sessionId: string,
    task: PlannedTask,
    external: ExternalMcpAttachment,
  ): Promise<ExecutionOutcome> {
    try {
      switch (task.kind) {
        case "analysis": {
          const agent = this.subAgents.create("explore");
          const res = await this.llmFor(sessionId).call(
            [{ role: "system", content: agent.prompt }, { role: "user", content: task.description }],
            agent.model,
          );
          // D-4（战术版）：无 key 时 router 返回 ok:false + content 是错误文本
          // （比如 "[error] No API key configured..."）。不检查 res.ok 就把它当
          // explore 的产出放行，review 会把一段错误消息误判成合法的探索结论。
          // F-2 收尾：诊断信息改读 `res.error.message`（原因见 plan() 里同一处改动的
          // 注释——AD-13 之后 `res.content` 在失败分支恒为空串）。
          if (!res.ok) {
            this.record(sessionId, "explore", "llm-failed", res.error.message);
            return {
              taskId: task.id,
              kind: task.kind,
              ok: false,
              output: `[llm call failed, not a model output] ${res.error.message}`,
            };
          }
          this.record(sessionId, "explore", "run", res.content.slice(0, 200));
          return { taskId: task.id, kind: task.kind, ok: true, output: res.content };
        }
        case "code": {
          const code = String(task.params?.code ?? "");
          const kernelId = this.daemon.kernelManager.createKernel("python");
          try {
            const result = await this.daemon.kernelManager.execute(kernelId, code, { raw: this.kernelRawFor(sessionId) });
            // V82（v0.7 W7-D2）：execution_records 此前从没有生产写入方——code task 是 kernel 执行的唯一
            // 生产路径，落在这里。frame = sessionId，cell_index = 本会话第几次执行（按已有条数递增）。
            // raw/kernel 行在 execute() 内先落、拿不到这个 id（executionRecordId 仍 null），两边靠
            // contentHash 对得上；接线成「先落 execution_record 再喂 raw」留给后续。
            this.recordExecution(sessionId, { kernelId, code, result });
            const output = result.result ?? result.stdout ?? result.error ?? "";
            this.record(sessionId, "python", "execute", `${task.id}: ${result.status}`);
            return { taskId: task.id, kind: task.kind, ok: result.status === "ok", output: String(output) };
          } finally {
            // D-5：只销毁这一次 code task 自己创建的内核（按 id），不能用无参 dispose()——
            // 那会摧毁 KernelManager 里当前存在的**所有**内核，并发会话里先跑完的
            // 请求会把另一个还在执行中的内核一起杀掉。
            this.daemon.kernelManager.dispose(kernelId);
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
        case "subagent": {
          const type = (task.params?.subagent ?? "execute") as SubAgentType;
          // V45 ③：连上了外部扩展就拿到带外部工具路由的 runner，否则原样走既有缓存。
          const runner = await this.runnerFor(external);
          if (runner) {
            // W3-a 接线：走 W2-a 的真 tool loop（buildSubAgentSpec + runSubAgent），
            // 不再是裸 `llm.call` 零工具的旧路径——explore 真能检索，execute 真能跑
            // 工具。旧路径只在没有真实工具面（没注入 projects/toolRunner）时才退回，
            // 见下方 else 分支与 getToolRunner() 的注释。
            // 外部工具名进 grants（口径与 runResearchLoopWithProject() 里那段长注释同源：
            // 用户 --trust 过才连得上、名字带 mcp: 前缀不撞车、只读子代理不给）。
            const externalGrants = this.externalGrantsOf(external);
            const base = buildSubAgentSpec(type);
            const spec =
              externalGrants.length > 0 && !base.readOnly
                ? buildSubAgentSpec(type, { grants: [...base.grants, ...externalGrants] })
                : base;
            // 收口(W5-3)：**把外部工具的 spec 也喂给模型**。
            // γ 已经把执行链路接通（runner 能路由、grants 里也有这些名字），
            // 但 `AgentToolBus.specs()` 原本只返回 MCP_TOOLS 的子集——
            // **模型从没被告知这些工具存在，自然永远不会调它们**。
            // 这一行是「调用链路已打通」与「agent 能自主使用外部工具」之间的差距。
            const result = await runSubAgent(spec, task.description, {
              llm: this.subAgentLlm(sessionId),
              runner,
              externalSpecs: external?.registry?.specs(),
            });
            this.record(
              sessionId,
              spec.type,
              "run",
              `stopReason=${result.stopReason} toolCalls=${result.toolCalls.length}`,
            );
            if (result.stopReason === "error") {
              return {
                taskId: task.id,
                kind: task.kind,
                ok: false,
                output: `[llm call failed, not a model output] ${result.error ?? "(no error message)"}`,
              };
            }
            // stopReason !== "done"（budget/timeout/denied）如实标注：子代理没跑完
            // 不等于产出可用，不能冒充成功——与 sub_agent.ts「宁可报预算内没做完，
            // 不假装完成」同一条纪律在 processRequest 这一层的落实。
            const note = result.stopReason === "done" ? "" : `[子代理未完成，stopReason=${result.stopReason}] `;
            return {
              taskId: task.id,
              kind: task.kind,
              ok: result.stopReason === "done",
              output: `${note}${result.finalText}`,
            };
          }
          // 没有真实工具面（没注入 projects/toolRunner）：退回旧路径，裸 `llm.call`，
          // 零工具——不静默假装有工具，只是老老实实做它一直在做的事。
          const agent = this.subAgents.create(type);
          const res = await this.llmFor(sessionId).call(
            [{ role: "system", content: agent.prompt }, { role: "user", content: task.description }],
            agent.model,
          );
          // D-4（战术版）：与 analysis 分支同一处漏洞（本 lane 委托的三处之外顺带发现的
          // 第四处调用点，同一个模式，见 docs/devlog/P10-b.md）。
          // F-2 收尾：诊断信息改读 `res.error.message`（理由同 plan() 处的注释）。
          if (!res.ok) {
            this.record(sessionId, agent.type, "llm-failed", res.error.message);
            return {
              taskId: task.id,
              kind: task.kind,
              ok: false,
              output: `[llm call failed, not a model output] ${res.error.message}`,
            };
          }
          this.record(sessionId, agent.type, "run", res.content.slice(0, 200));
          return { taskId: task.id, kind: task.kind, ok: true, output: res.content };
        }
        case "skill": {
          const name = String(task.params?.skill ?? "");
          this.record(sessionId, "skill", name, "context loaded");
          return { taskId: task.id, kind: task.kind, ok: true, output: this.skillContextFor(name) };
        }
        default: {
          const kind = String(task.kind);
          // 与其他分支一样把这次失败写进执行日志（可见），不只是塞进返回值里——
          // 否则「计划里有一个任务，没人在执行日志里看到它被拒绝」本身又是一种
          // 静默：调用方不读 execution 数组细节的话，这个任务就像没发生过一样。
          this.record(sessionId, "orchestrator", "unknown-kind", `task ${task.id} kind='${kind}' not in TASK_KINDS`);
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
    sessionId: string,
    userMessage: string,
    plan: PlannedTask[],
    execution: ExecutionOutcome[],
    onDelta?: (chunk: string) => void,
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
    // W3-a：这是唯一产出「用户最终会看到的正文」的 LLM 调用点，所以 onDelta 接在这里
    // ——根治 W2-d 留下的设计问题（session.ts 曾经不得不为"预览流"单独发一次裸调用，
    // 因为 processRequest 没有 onDelta 的口子；见 docs/devlog/W3-a.md）。
    const options: CallOptions = { model: configuredModel(LLMRouter.DEFAULT_MODEL), ...(onDelta ? { onDelta } : {}) };
    const res = await this.llmFor(sessionId).call(messages, options);
    // D-4（战术版）：这是三处委托里最要紧的一处——summarize() 的返回值**就是**
    // 用户最终看到的 `OrchestrationResult.summary`，也是 reviewer 读的正文。
    // 之前不检查 res.ok，router 的错误文本（"[error] No API key configured..."）会
    // 原样冒充成分析结论被 review 放行。现在失败时既不把 res.content 塞进 summary
        // （"summary 不得包含错误文本"——错误文本本身可能含误导性描述，不该出现在
    // 面向用户的产出里），也不静默吞掉——具体错误进执行日志供排查，summary 只留一句
    // 结构化、无法被误读成模型产出的失败说明。
    // F-2 收尾：诊断信息改读 `res.error.message`（理由同 plan() 处的注释——这里尤其
    // 要紧，这条日志曾经是排查"为什么摘要生成失败"的唯一线索，AD-13 之后它一直在
    // 记一个空字符串，排查者等于什么都没拿到）。
    if (!res.ok) {
      this.record(sessionId, "orchestrator", "summarize-llm-failed", res.error.message);
      // V119：预算闸拒绝不是"配置/网络"问题——把闸消息（含下一步）原样带给用户，别让人去查 key。
      if (res.error.kind === "budget") {
        return `[orchestrator] 本次调用被预算闸拒绝，未生成结果摘要。${res.error.message}`;
      }
      return "[orchestrator] LLM 调用失败，未能生成结果摘要（这是调用失败，不是模型产出）。请检查 LLM 配置（API key / 网络）后重试。";
    }
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
    // v0.4 W3 收口：接上 findings 持久化（W1-b 的状态机 + W3-c 的 fingerprint 与写入逻辑）。
    // 此前 ReviewerAgent 从不传 options.findings——能力做好了、测试覆盖了，
    // 但真实 chat() 会话里 findings 永远不落库（W3-c devlog §7 如实报告过）。
    // ReviewerAgent 本身不知道自己跑在哪个 project 下（构造参数不带 project 身份），
    // 这层身份必须由调用方补上，所以接线点只能在这里。
    const project = this.projectForSession(sessionId);
    const reviewer = new ReviewerAgent(
      store,
      execs,
      this.graph,
      project ? { findings: { store: project.findings(), project: project.slug, session: sessionId } } : {},
    );
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
        llm: this.llmFor(req.sessionId),
        library,
        records: project.records(),
        model: req.model,
        projectContext: project.meta.description || undefined,
        promptDir: PROMPT_DIR,
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
    // W3-a：权威调用本身的流式增量出口——只在 mode !== "coexplore" 时生效
    // （CoExploreSession 的 prompt/grounding 装配在 ideation/coexplore.ts，不在本
    // 文件所有权内，本 lane 没有替它接 onDelta；见 docs/devlog/W3-a.md）。
    onDelta?: (chunk: string) => void;
    /** V119：本次 chat 的预算闸（会话绑定了项目才生效；不给 = 只记账不设闸）。 */
    budgetUsd?: number;
    allowUnpriced?: boolean;
  }): Promise<{ response: string; review?: ReviewResult; ideaRecordId?: string | null }> {
    if (req.budgetUsd !== undefined || req.allowUnpriced !== undefined) {
      this.sessionBudget.set(req.sessionId, { budgetUsd: req.budgetUsd, allowUnpriced: req.allowUnpriced });
    } else {
      this.sessionBudget.delete(req.sessionId);
    }
    if (req.mode === "coexplore") {
      const result = await this.coexplore(req);
      return {
        response: `[coexplore ${req.sessionId}]\n${result.response}`,
        ideaRecordId: result.stored?.recordId ?? null,
      };
    }
    const result = await this.processRequest(req.message, req.sessionId, { onDelta: req.onDelta });
    return {
      response: `[session ${req.sessionId}]\n${result.summary}`,
      review: result.review,
    };
  }

  // ── 研究循环（v0.4 P13 波次 W3-a）：把「单发管线」变成「真 agent 循环」───────────
  //
  // 与上面 processRequest() 的 P1-P3 规划/执行/review 循环是**两条并列的机制**，
  // 不是互相替换：processRequest() 处理的是任意 task-kind 混合的一次性请求 +
  // reviewer 硬 finding 的事后修正；这里实现的是 DEVELOPMENT_PLAN_v0.4.md §4.3.2
  // 的观察反馈循环——面向一个**契约化的研究目标**（当前只有 `literature-review`
  // 一种契约，见 contract.ts），反复派出真子代理、把结构化 observation 回流进下一轮
  // planner，直到 contract.ts 的三条并行停机条件之一触发。
  //
  // 需要 project（RecordStore 就是它的证据图）——AD-10「完成判定问图不问模型」在
  // 没有图的地方无法成立，所以没有绑定 project 时直接报错，不悄悄退化成"问模型"。
  async runResearchLoop(
    sessionId: string,
    goal: string,
    options: ResearchLoopOptions = {},
  ): Promise<ResearchLoopResult> {
    const project = this.projectForSession(sessionId);
    if (!project) {
      throw new Error(
        `session '${sessionId}' 未绑定 project——研究循环的完成判定（AD-10）依赖证据图` +
          `（RecordStore），没有 project 就没有图。请先通过 ProjectManager 绑定 project` +
          `（processRequest()/chat() 走 projectForSession() 的同一套绑定逻辑），再调用 runResearchLoop()。`,
      );
    }
    this.record(sessionId, "research", "start", `goal: ${goal.slice(0, 120)}`);

    // ── V45：这一轮 agent 运行的外部 MCP 生命周期 ──────────────────────────────
    //
    // ④ 绑定：`recordSink` 就是**本 session 所属 project 的证据图**。V31 从"机制建好了
    //    但没有生产调用方"变成"生产里真的会落"就是这一行——从这里往下，子代理每调
    //    一次外部 MCP 工具，这个项目的证据图里就多一条 `external_tool_call` observation
    //    （成功/失败/超时/未知工具四个分支都落，见 mcp_client.ts 的 `record()`）。
    //    它是**审计**不是**进展**：`agents/contract.ts` 把这个 kind 排除出证据集合，
    //    所以它不会让 `NoProgressGuard` 永远看到"有新增"——P12 那次 `agent_run` 事故
    //    （停止条件被静默废掉、测试却全绿）的教训在这里不许重演，这条排除**不许动**。
    //
    // ⑤ 收尾：`finally`，不是正常返回路径。研究循环中途抛异常（planner 炸了、
    //    contract 抛了、预算守卫抛了…）同样必须把子进程收掉，否则一次失败的 agent run
    //    会在机器上留下一串没人收的孤儿进程。
    const external = await this.attachExternalMcp(sessionId, project.records());
    try {
      return await this.runResearchLoopWithProject(sessionId, goal, project, external, options);
    } finally {
      await external.close();
    }
  }

  private async runResearchLoopWithProject(
    sessionId: string,
    goal: string,
    project: Project,
    external: ExternalMcpAttachment,
    options: ResearchLoopOptions,
  ): Promise<ResearchLoopResult> {
    const q: EvidenceQuery = new RecordStoreEvidenceQuery(project.records());
    const contract: ResearchContract = (options.contract ?? createLiteratureReviewContract)(q);
    const guard = new NoProgressGuard(q.snapshot(), options.noProgressThreshold ?? 2);
    const maxRounds = options.maxRounds ?? DEFAULT_RESEARCH_MAX_ROUNDS;

    // V45 ③：这一轮如果连上了外部扩展，拿到的是把那张 registry 闭包进去的 runner。
    const runner = await this.runnerFor(external);
    if (!runner) {
      throw new Error(
        `session '${sessionId}' 绑定了 project '${project.slug}'，但未能构造 McpToolRunner` +
          `（这不应该发生——runnerFor()/getToolRunner() 只在没有 projects 时才返回 null）。`,
      );
    }
    const sessionBudget = new BudgetLedger(options.budget ?? {});

    const planner: Planner = async ({ report, lastObservations, round }) =>
      this.planResearchRound(sessionId, goal, report, lastObservations, round);

    // v0.4 W3 收口：帧级记账（W3-b 的 AgentRunLedger）。W3-a 与 W3-b 并行开发，
    // W3-a 不知道 ledger.ts 存在，于是它落地后没有生产调用方——本版第三个
    // 「建好但没人喂」。这里接上：每个子代理运行落一条 agent_run record，
    // 父子关系用 derives_from 边（本轮所有子代理挂在同一个 session 根 run 下）。
    // 拿不到 project 时静默跳过记账，不影响研究循环本身。
    const ledger = this.projectForSession(sessionId)?.records();
    const runLedger = ledger ? new AgentRunLedger({ records: ledger }) : null;
    const rootRun = runLedger?.record({
      agent: "orchestrator",
      model: configuredModel(LLMRouter.DEFAULT_MODEL),
      provider: "orchestrator",
      systemPrompt: this.corePrompt,
      prompt: goal,
      toolCalls: 0,
      stopReason: "done",
    });

    // V45 ③ 的下游：已连上的外部工具名（`mcp:<扩展>:<工具>`）要进子代理的 grants 白名单，
    // 否则 `AgentToolBus` 会以 `not_granted` 结构性拒绝——"连上了但一个都调不动"。
    //
    // 授权口径（明确的取舍，不是顺手放行）：能出现在这张表里的扩展，用户都已经
    // 显式 `--trust` 过它的 `mcp.json`（TOFU，指纹变了要重新确认）——"启动这个外部
    // 命令"这件事本身就是用户批准的。工具名带 `mcp:` 前缀，不可能与内置工具名撞车，
    // 也不会顶替任何内置工具。`AgentToolBus` 的预算与审计两层照旧对它生效。
    //
    // 但**只给非只读子代理**：`review` 类子代理 `readOnly: true`，`sub_agent.ts` 的
    // `assertReadOnlyGrants()` 会对不在只读白名单里的工具名直接抛错拒绝构造。外部工具
    // 的副作用我们一无所知，把它当只读工具塞进去既过不了那道断言、本身也是错的判断。
    const externalGrants = this.externalGrantsOf(external);

    const execute: RoundExecutor = async (plan) => {
      const outcomes: RoundOutcome[] = [];
      for (const item of plan) {
        const deps: SubAgentDeps = { llm: this.subAgentLlm(sessionId), runner, parentBudget: sessionBudget };
        const spec = buildSubAgentSpec(item.subagentType);
        const overrides =
          externalGrants.length > 0 && !spec.readOnly ? { grants: [...spec.grants, ...externalGrants] } : undefined;
        const result = await runSubAgentOfType(item.subagentType, item.task, deps, overrides);
        // usage 直接透传子代理的实测值——AgentRunLedger 不重算 token/价格，只记账落图。
        // 拿不到 usage 时传 undefined，落成 UNKNOWN_USAGE（costUsd:null），**不是 0**。
        runLedger?.record({
          agent: item.subagentType,
          // SubAgentResult 不带 model/provider（W2-a 的形状）——用该类子代理的配置模型，
          // provider 留 "subagent"：真实 provider 在 LlmResponse 里，但子代理没把它透出来。
          // 这是已知的精度损失，比编造一个具体 provider 名诚实。
          model: spec.model,
          provider: "subagent",
          systemPrompt: item.subagentType,
          prompt: item.task,
          usage: result.usage,
          toolCalls: result.toolCalls.length,
          stopReason: result.stopReason,
          parentRunId: rootRun?.id,
        });
        outcomes.push({ item, result });
      }
      return outcomes;
    };

    const loopResult = await runReplanLoop({
      goal,
      contract,
      q,
      guard,
      planner,
      execute,
      maxRounds,
      budgetExceeded: () => sessionBudget.snapshot().exceeded.length > 0,
      onRound: (entry) => {
        const hits = entry.observations.reduce((n, o) => n + o.newRecordIds.length, 0);
        this.record(
          sessionId,
          "research",
          `round-${entry.round}`,
          `派出 ${entry.plan.length} 个子代理任务，新增证据 ${hits} 条，` +
            `evaluation.stopReason=${entry.evaluation.stopReason ?? "(继续)"}`,
        );
      },
    });

    // 收尾日志：优先用最后一轮真实算出的 noProgress 状态（大多数情况下就是它触发了
    // 停机，或者它证明了循环是因为 done/budget 而不是 no_progress 停下）；只有安全阀
    // （maxRounds 命中、rounds 里最后一条的 evaluation.stopReason 仍是 null）时才没有
    // 现成的——这种情况下不重新 tick() 一次（那会多算一轮、污染 guard 的内部计数),
    // 直接给一个"未触发"的占位状态，describeStop() 在 stopReason==="budget" 分支
    // 根本不读 noProgress 字段，所以占位值不影响文案。
    const lastRound = loopResult.rounds[loopResult.rounds.length - 1];
    const noProgressForLog = lastRound?.evaluation.noProgress ?? {
      streak: 0,
      triggered: false,
      addedRecordCount: 0,
      addedRecordIds: [],
    };
    // describeStop() 本身只认得 "done"/"no_progress" 两种文案分支（"budget" 落到它的
    // 兜底 `return evaluation.report.summary`，不会显式提到"budget"三个字——那是
    // contract.ts 的既有实现，本 lane 只读复用，不改它）。这里在日志文案里显式前缀
    // 一下 stopReason，确保"跑了 25 轮还没做完"这件事不会被淹没在一句听起来像是
    // 中性总结的 report.summary 里。
    const stopText = describeStop(contract.id, {
      report: loopResult.finalReport,
      noProgress: noProgressForLog,
      stopReason: loopResult.stopReason,
    });
    this.record(sessionId, "research", "stop", `stopReason=${loopResult.stopReason}. ${stopText}`);

    return {
      sessionId,
      projectSlug: project.slug,
      goal,
      contractId: contract.id,
      stopReason: loopResult.stopReason,
      rounds: loopResult.rounds.length,
      report: loopResult.finalReport,
      observations: loopResult.rounds.flatMap((r) => r.observations),
      log: loopResult.rounds,
    };
  }

  // ── planner：LLM 决定下一轮派哪些子代理、干什么 ─────────────────────────────────
  //
  // 输入是 contract.evaluate(q) 的未完成 stage（"现在还缺什么证据"）与上一轮的结构化
  // observation（"上一轮做了什么、拿到了什么、卡在哪"）——两者都是可以直接喂给模型
  // 决策的字段化数据，不是一句被腰斩的话。解析失败/调用失败都有确定性兜底
  // （defaultResearchPlan），不会让循环卡死在"planner 说不出话"上。
  private async planResearchRound(
    sessionId: string,
    goal: string,
    report: ContractReport,
    lastObservations: Observation[],
    round: number,
  ): Promise<RoundPlan> {
    if (report.incomplete.length === 0) return []; // 防御性：evaluateRound() 应该已经在上一轮就停了
    const stagesText = report.incomplete.map((s) => `- ${s.id}（${s.description}）：${s.reason}`).join("\n");
    const obsText =
      lastObservations.length === 0
        ? "（第一轮，尚无观察）"
        : lastObservations
            .map((o) => {
              const bits = [
                `stopReason=${o.stopReason}`,
                `新增证据 ${o.newRecordIds.length} 条（${JSON.stringify(o.newRecordCountByType)}）`,
              ];
              if (o.deniedCount > 0) bits.push(`被拒 ${o.deniedCount} 次（${o.deniedReasons.join(",")}）`);
              if (o.failedToolCount > 0) bits.push(`工具执行失败 ${o.failedToolCount} 次`);
              if (o.errorMessage) bits.push(`错误：${o.errorMessage}`);
              return `- [${o.subagentType}] ${bits.join("；")}`;
            })
            .join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: `${this.corePrompt}\n\n${this.researchPrompt}` },
      {
        role: "user",
        content:
          `研究目标：${goal}\n这是第 ${round + 1} 轮。\n\n` +
          `契约未完成的 stage：\n${stagesText}\n\n` +
          `上一轮的观察（结构化）：\n${obsText}\n\n` +
          `请给出这一轮要派出的子代理任务，只回复 JSON 数组，每项 {"id","subagent","task"}。` +
          `"subagent" 必须是以下之一：${SUB_AGENT_TYPES.join(", ")}。` +
          `"task" 是给该子代理的具体指令，要结合上面未完成的 stage 与观察来定，不要重复已经成功` +
          `拿到证据的动作。No markdown, no prose, only JSON.`,
      },
    ];
    const res = await this.llmFor(sessionId).call(messages, configuredModel(LLMRouter.DEFAULT_MODEL));
    if (!res.ok) {
      this.record(sessionId, "research", "plan-llm-failed", `第 ${round + 1} 轮 planner 调用失败：${res.error.message}`);
      return this.defaultResearchPlan(report.incomplete, round);
    }
    return this.parseResearchPlan(res.content, round) ?? this.defaultResearchPlan(report.incomplete, round);
  }

  private parseResearchPlan(content: string, round: number): RoundPlan | null {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return null;
    let data: unknown;
    try {
      data = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(data)) return null;
    const items: RoundPlan = [];
    data.forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return;
      const obj = raw as Record<string, unknown>;
      const subagent = obj.subagent as SubAgentType;
      if (!SUB_AGENT_TYPES.includes(subagent)) return;
      const task = typeof obj.task === "string" ? obj.task : typeof obj.description === "string" ? obj.description : null;
      if (!task) return;
      items.push({
        id: typeof obj.id === "string" ? obj.id : `r${round + 1}_${i + 1}`,
        subagentType: subagent,
        task,
      });
    });
    return items.length > 0 ? items : null;
  }

  // 确定性兜底：把第一个未完成的 stage 映射到一个"多半能推进它"的子代理类型。
  // 不追求聪明，追求循环不卡死——真正的智能决策交给上面 LLM 驱动的 planner。
  private defaultResearchPlan(incomplete: ContractStageReport[], round: number): RoundPlan {
    const stageToType: Partial<Record<string, SubAgentType>> = {
      searched: "explore",
      read_cards: "literature",
      citations_verified: "review",
    };
    const stage = incomplete[0];
    if (!stage) return [];
    return [
      {
        id: `r${round + 1}_1`,
        subagentType: stageToType[stage.id] ?? "explore",
        task: `推进未完成的 stage '${stage.id}'（${stage.description}）：${stage.reason}`,
      },
    ];
  }
}

// 与 sub_agent.ts 的 `SubAgentType` 联合类型手工保持同步（5 个值，联合类型改动会在
// buildSubAgentSpec()/runSubAgentOfType() 的调用点触发编译错误，属于低风险手工表）。
const SUB_AGENT_TYPES: readonly SubAgentType[] = ["explore", "execute", "review", "lab", "literature"];

// 安全阀，独立于 contract 的三条停机条件之外——与 sub_agent.ts 的 DEFAULT_MAX_ROUNDS
// 同一类考量，命中时 runReplanLoop() 报 "budget"。
const DEFAULT_RESEARCH_MAX_ROUNDS = 25;

export interface ResearchLoopOptions {
  maxRounds?: number;
  noProgressThreshold?: number;
  budget?: ConstructorParameters<typeof BudgetLedger>[0];
  /** 可插拔契约；默认 literature-review（contract.ts 目前唯一的真实契约）。 */
  contract?: (q: EvidenceQuery) => ResearchContract;
}

export interface ResearchLoopResult {
  sessionId: string;
  projectSlug: string;
  goal: string;
  contractId: string;
  stopReason: StopReason;
  rounds: number;
  report: ContractReport;
  /** 全部轮次的 observation 展平后的列表，便于调用方直接查看（也可以从 `log` 按轮次读）。 */
  observations: Observation[];
  log: RoundLogEntry[];
}
