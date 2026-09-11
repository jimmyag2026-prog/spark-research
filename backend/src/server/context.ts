import { join } from "node:path";
import { OrchestratorAgent } from "../agents/orchestrator";
import { configuredDefaultModel, configuredWetBackend } from "../config";
import { ConnectorRegistry } from "../connectors/registry";
import { SparkResearchDaemon } from "../daemon/daemon";
import { CredentialStore } from "../daemon/credentials";
import { ExperimentLoop } from "../experiment/loop";
import type { HttpClient } from "../http/client";
import { LibraryStore } from "../literature/library";
import { LiteratureSearcher } from "../literature/search";
import { LLMRouter } from "../llm/router";
import { UsageStore, usageTrackingLlm } from "../usage/ledger";
import { ProjectManager, ProjectError, type Project } from "../project/manager";
import type { CitationJudge } from "../reviewer/rules";
import { SimulationRegistry } from "../simulation/registry";
import { LabSafetyGate, LabOrchestrator } from "../lab/orchestrator";
import {
  OPENTRONS_LIQUID_HANDLER,
  THERMAL_SHAKER,
  PLATE_READER,
  CENTRIFUGE,
} from "../lab/devices";
import { DEFAULT_WET_BACKEND, wetBackend, type WetLabBackend } from "../lab/wet_backend";
import { WetLabLoop } from "../lab/wet_loop";
import type { ArtifactStore } from "../artifacts/store";
import { ExternalMcpRuntime } from "../extensions/loader";
import { TaskRegistry } from "./tasks";
import { dataDir } from "../config";

// HTTP 层的依赖容器（P7）。
//
// 与各域 CLI 同一套注入口径（`LitCliDeps` / `ExpCliDeps` / `LabCliDeps`）：
// 生产走真实实现，测试注入 fixture/fake，**没有任何一条路径在测试里打真实网络或模型**。
//
// 项目作用域：所有域端点默认作用在「当前项目」上（与 CLI 的 `manager.defaultProject()`
// 完全一致），可用 `?project=<slug>` 覆盖。
export interface ServerDeps {
  // v0.1 既有注入点，保持兼容。
  agent?: OrchestratorAgent;
  connectors?: ConnectorRegistry;
  lab?: LabOrchestrator;
  store?: ArtifactStore;

  // P7 新增。
  projects?: ProjectManager;
  // 工作区根目录（测试用 mkdtemp）；未给则用 ~/.spark-research 或 SPARK_RESEARCH_DATA_DIR。
  root?: string;
  // 前端构建产物目录；未给则用 frontend/workspace/dist。
  frontendDir?: string;
  http?: HttpClient;
  searcher?: LiteratureSearcher;
  credentials?: CredentialStore;
  llm?: Pick<LLMRouter, "call">;
  model?: string;
  judge?: CitationJudge;
  wetBackend?: WetLabBackend;
  platforms?: (project: Project) => SimulationRegistry;
  tasks?: TaskRegistry;
  // 供 SSE 测试关掉心跳定时器。
  sseHeartbeatMs?: number;
}

// 注入的 fake LLM 通常只实现 `call`；orchestrator 还要 `listModels`，这里补齐。
function withListModels(llm: Pick<LLMRouter, "call">): Pick<LLMRouter, "call" | "listModels"> {
  const maybe = llm as Partial<Pick<LLMRouter, "listModels">>;
  if (typeof maybe.listModels === "function") return llm as Pick<LLMRouter, "call" | "listModels">;
  return { call: llm.call, listModels: () => new LLMRouter().listModels() };
}

export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail: unknown = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

// 请求作用域内打开的项目句柄。**必须** dispose，否则 sqlite 句柄会泄漏。
export interface ProjectScope {
  project: Project;
  library(): LibraryStore;
  dryLoop(): ExperimentLoop;
  wetLoop(): WetLabLoop;
  dispose(): void;
}

export class ServerContext {
  readonly deps: ServerDeps;
  readonly projects: ProjectManager;
  readonly tasks: TaskRegistry;
  readonly connectors: ConnectorRegistry;
  readonly lab: LabOrchestrator;
  readonly agent: OrchestratorAgent;
  readonly sseHeartbeatMs: number;

  constructor(deps: ServerDeps = {}) {
    this.deps = deps;
    this.projects = deps.projects ?? new ProjectManager(deps.root);
    // v0.4 W4 收口：给 TaskRegistry 传数据目录，长任务句柄落盘（V11）。
    // 没有它，任务列表只在进程内存里——v0.2.1 的零上下文外部验收就撞上过：
    // 外部 agent 拿到句柄、连接一断句柄即失效，它不知道该重跑还是该等。
    //
    // 目录来源：显式 deps.root（测试助手用 mkdtemp 传的临时目录）> 配置的 dataDir()。
    // **这个顺序很重要**——反过来会让所有用 server_scenario / mcp_scenario 的测试
    // 写进用户真实的 ~/.spark-research（W4-c 在 devlog 里专门警告过这个陷阱）。
    this.tasks = deps.tasks ?? new TaskRegistry({ root: deps.root ?? dataDir() });
    this.connectors =
      deps.connectors ??
      new ConnectorRegistry({ http: deps.http, credentials: this.credentials() }).registerBuiltins();
    this.lab =
      deps.lab ??
      (() => {
        const orchestrator = new LabOrchestrator(new LabSafetyGate());
        orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
        orchestrator.registerDevice(THERMAL_SHAKER);
        orchestrator.registerDevice(PLATE_READER);
        orchestrator.registerDevice(CENTRIFUGE);
        return orchestrator;
      })();
    this.agent =
      deps.agent ??
      (() => {
        const daemon = new SparkResearchDaemon({ projects: this.projects });
        return new OrchestratorAgent(daemon, {
          projects: this.projects,
          ...(deps.llm ? { llm: withListModels(deps.llm) } : {}),
          // V45：HTTP 侧的外部 MCP 接线。构造是零 I/O 的——发现/连接只发生在
          // `/session` 真的驱动一次 agent 运行的时候（`processRequest()`），
          // `/lit/search` 之类的只读端点走不到这里。
          //
          // `pathOptions.root` 跟着 `deps.root` 走，与上面 TaskRegistry 同一条纪律
          // （W4-c 在 devlog 里专门警告过的陷阱）：测试助手用 mkdtemp 传进来的临时
          // 目录必须优先，否则 server_scenario/mcp_scenario 那一大票测试会去扫**用户
          // 真实的** `~/.spark-research/extensions`——那里可能真的装着 mcp_client
          // 扩展，测试就会在开发者的机器上 spawn 真实的外部进程。
          externalMcp: new ExternalMcpRuntime({
            pathOptions: deps.root ? { root: deps.root } : {},
            // 凭据（AD-2）：daemon 持有的那一个 CredentialStore 的引用；取值路径不变
            // （resolveMcpChildEnv → buildExtensionContext 的声明∩授权交集）。
            contextDeps: { credentials: this.credentials() },
          }),
        });
      })();
    this.sseHeartbeatMs = deps.sseHeartbeatMs ?? 15_000;
  }

  credentials(): CredentialStore {
    return this.deps.credentials ?? new CredentialStore({ root: this.deps.root });
  }

  llm(): Pick<LLMRouter, "call"> {
    return this.deps.llm ?? new LLMRouter();
  }

  // A5 blocker②：G-3 的用量台账此前只接了 CLI——HTTP/UI 路径的 LLM 调用完全不入账，
  // 用量面板对着真实花费显示 $0（对「花钱透明」这个卖点是谎报级缺陷）。
  // 所有带项目上下文的 LLM 消费路由一律经这里取 llm，与 CLI 同一份 usage.jsonl。
  // HTTP 面暂无预算参数（UI 无入口，已登记）；先保证计量真实。
  llmFor(project: Project, command: string): Pick<LLMRouter, "call"> {
    return usageTrackingLlm({
      llm: this.llm(),
      store: new UsageStore(join(project.paths.root, "usage.jsonl")),
      command,
    });
  }

  searcher(): LiteratureSearcher {
    if (this.deps.searcher) return this.deps.searcher;
    return new LiteratureSearcher(
      new ConnectorRegistry({ http: this.deps.http, credentials: this.credentials() }).registerBuiltins(),
    );
  }

  wetBackend(): WetLabBackend {
    // 注入 > 用户 config.json > 代码默认（P9 配置面收口）。
    return this.deps.wetBackend ?? wetBackend(configuredWetBackend(DEFAULT_WET_BACKEND));
  }

  // 各 pipeline 用的模型：注入 > 用户 config.json > 各自的内部默认（传 undefined）。
  // G-1（v0.6）：解析逻辑收进 config 层的 configuredDefaultModel（CLI/HTTP 共用一份），
  // 这里原来的 resolveSetting 手写版有个差异：value 为 "" 时会返回 ""，下游把空串当
  // 真模型名传给 router——helper 版把 "" 归一成 undefined。
  model(): string | undefined {
    return this.deps.model ?? configuredDefaultModel();
  }

  simulationRegistry(project: Project): SimulationRegistry {
    if (this.deps.platforms) return this.deps.platforms(project);
    return new SimulationRegistry({ root: project.paths.experimentsDir });
  }

  // 解析 `?project=<slug>`；缺省落到当前项目（与 CLI 的 defaultProject 同口径）。
  openProject(slug?: string | null): ProjectScope {
    let project: Project;
    try {
      project = slug ? this.projects.open(slug) : this.projects.defaultProject();
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(404, error.message);
      throw error;
    }
    let library: LibraryStore | null = null;
    let dry: ExperimentLoop | null = null;
    let wet: WetLabLoop | null = null;
    return {
      project,
      library: () => {
        if (!library) library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
        return library;
      },
      dryLoop: () => {
        if (!dry) {
          dry = new ExperimentLoop({
            records: project.records(),
            artifacts: project.artifacts(),
            platforms: this.simulationRegistry(project),
          });
        }
        return dry;
      },
      wetLoop: () => {
        if (!wet) {
          wet = new WetLabLoop({
            records: project.records(),
            artifacts: project.artifacts(),
            root: join(project.paths.experimentsDir, "wet"),
            backend: this.wetBackend(),
          });
        }
        return wet;
      },
      dispose: () => {
        library?.close();
        library = null;
        project.close();
      },
    };
  }

  // 请求作用域：跑完必关。任何抛错也要关（长任务另有自己的作用域）。
  async withProject<T>(slug: string | null | undefined, fn: (scope: ProjectScope) => T | Promise<T>): Promise<T> {
    const scope = this.openProject(slug);
    try {
      return await fn(scope);
    } finally {
      scope.dispose();
    }
  }
}
