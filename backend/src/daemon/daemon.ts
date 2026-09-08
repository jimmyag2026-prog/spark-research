import { PermissionManager, PermissionDeniedError } from "./permissions";
import { KernelManager } from "../kernels/manager";
import { ConnectorRegistry } from "../connectors/registry";

export interface ArtifactStore {
  lookup(args: any): any;
}
export interface LineageStore {
  query(args: any): any;
}
export interface ExecutionLog {
  record(entry: any): void;
}
export interface ComputeService {
  submit(args: any): any;
  getFrames(args: any): any;
  libraries(args: any): any;
}
export interface Connectors {
  mcp: { call(args: any): any };
}
export interface SkillsService {
  manage(args: any): any;
}
export interface LlmService {
  call(args: any): any;
  credentials(args: any): any;
}

export interface DaemonDeps {
  permissions?: PermissionManager;
  kernelManager?: KernelManager;
  artifacts?: ArtifactStore;
  lineage?: LineageStore;
  executionLog?: ExecutionLog;
  compute?: ComputeService;
  connectors?: Connectors;
  skills?: SkillsService;
  llm?: LlmService;
}

class DefaultArtifacts implements ArtifactStore {
  private store = new Map<string, any>();

  lookup(args: any) {
    const name = args?.name ?? args?.id;
    return this.store.has(name)
      ? { found: true, name, artifact: this.store.get(name) }
      : { found: false, name };
  }
}

class DefaultLineage implements LineageStore {
  query(args: any) {
    return { nodes: [], edges: [], query: args ?? {} };
  }
}

class DefaultExecutionLog implements ExecutionLog {
  entries: any[] = [];

  record(entry: any) {
    this.entries.push(entry);
  }
}

class DefaultCompute implements ComputeService {
  private seq = 0;
  private jobs = new Map<string, any>();

  submit(args: any) {
    const id = `job_${++this.seq}`;
    const job = { id, status: "queued", spec: args ?? {}, createdAt: new Date().toISOString() };
    this.jobs.set(id, job);
    return job;
  }

  getFrames(args: any) {
    return { frames: [], filter: args ?? {} };
  }

  libraries() {
    return { libraries: ["numpy", "pandas", "matplotlib", "scipy", "rdkit"] };
  }
}

class DefaultMCPConnector {
  private servers = new Map<string, Record<string, (a: any) => any>>([
    ["math", {
      add: (a: any) => (a.a ?? 0) + (a.b ?? 0),
      mul: (a: any) => (a.a ?? 0) * (a.b ?? 0),
    }],
  ]);

  call(args: any) {
    const server = args?.server;
    const tool = args?.tool;
    const fn = this.servers.get(server)?.[tool];
    if (!fn) return { ok: false, error: `unknown mcp tool '${server}.${tool}'` };
    return { ok: true, server, tool, result: fn(args?.args ?? {}) };
  }
}

class RealMCPConnector {
  private registry: ConnectorRegistry;
  private builtin = new DefaultMCPConnector();

  constructor(registry?: ConnectorRegistry) {
    this.registry = registry ?? new ConnectorRegistry().registerBuiltins();
  }

  async call(args: any) {
    const server = args?.server;
    const tool = args?.tool;
    const params = args?.args ?? {};
    try {
      if (this.registry.get(server)) {
        const result = await this.registry.call(server, tool, params);
        return { ok: true, server, tool, result };
      }
    } catch (err) {
      return { ok: false, server, tool, error: (err as Error).message };
    }
    return this.builtin.call(args);
  }
}

class DefaultSkills implements SkillsService {
  manage(args: any) {
    return { ok: true, action: args?.action ?? "list", skills: [] };
  }
}

class DefaultLLM implements LlmService {
  call(args: any) {
    return { ok: true, model: args?.model ?? "default", output: `[mock] ${args?.prompt ?? ""}` };
  }

  credentials(args: any) {
    return { ok: true, scopes: args?.scopes ?? [] };
  }
}

export class SparkResearchDaemon {
  readonly permissions: PermissionManager;
  readonly artifacts: ArtifactStore;
  readonly lineage: LineageStore;
  readonly executionLog: ExecutionLog;
  readonly compute: ComputeService;
  readonly connectors: Connectors;
  readonly skills: SkillsService;
  readonly llm: LlmService;
  readonly kernelManager: KernelManager;

  private agents = new Map<string, any>();
  private agentSeq = 0;

  constructor(deps: DaemonDeps = {}) {
    this.permissions = deps.permissions ?? new PermissionManager();
    this.artifacts = deps.artifacts ?? new DefaultArtifacts();
    this.lineage = deps.lineage ?? new DefaultLineage();
    this.executionLog = deps.executionLog ?? new DefaultExecutionLog();
    this.compute = deps.compute ?? new DefaultCompute();
    this.connectors = deps.connectors ?? { mcp: new RealMCPConnector() };
    this.skills = deps.skills ?? new DefaultSkills();
    this.llm = deps.llm ?? new DefaultLLM();
    this.kernelManager = deps.kernelManager ?? new KernelManager();
    this.kernelManager.setDaemon(this);
  }

  async handleKernelCall(kernelId: string, method: string, args?: any): Promise<any> {
    const kernelType = this.kernelManager.getKernelType(kernelId);
    const permitSet = this.permissions.getPermitSet(kernelType);
    if (!permitSet.includes(method)) {
      throw new PermissionDeniedError(kernelId, kernelType, method);
    }
    this.executionLog.record({ ts: new Date().toISOString(), kernelId, kernelType, method, args });
    return this.dispatch(method, args);
  }

  dispatch(method: string, args?: any): any {
    const a = args ?? {};
    switch (method) {
      case "mcp_call": return this.connectors.mcp.call(a);
      case "create_agent": return this.handleCreateAgent(a);
      case "delegate_task": return this.handleDelegateTask(a);
      case "query_frames": return this.compute.getFrames(a);
      case "manage_skills": return this.skills.manage(a);
      case "compute_submit": return this.compute.submit(a);
      case "artifact_lookup": return this.artifacts.lookup(a);
      case "lineage_query": return this.lineage.query(a);
      case "model_call": return this.llm.call(a);
      case "credentials": return this.llm.credentials(a);
      case "analytic_libraries": return this.compute.libraries(a);
      default: throw new Error(`Daemon: unknown method '${method}'`);
    }
  }

  private handleCreateAgent(config: any) {
    const id = `agent_${++this.agentSeq}`;
    const agent = {
      id,
      name: config?.name ?? `agent_${id}`,
      model: config?.model ?? "default",
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    this.agents.set(id, agent);
    return agent;
  }

  private handleDelegateTask(spec: any) {
    const id = `task_${++this.agentSeq}`;
    return { id, agentId: spec?.agent ?? null, spec, status: "queued" };
  }
}
