import { PermissionManager, PermissionDeniedError } from "./permissions";
import { CredentialStore, credentialStatus } from "./credentials";
import { KernelManager } from "../kernels/manager";
import { ConnectorRegistry } from "../connectors/registry";
import type { ProjectManager } from "../project/manager";

export interface ArtifactStore {
  lookup(args: any): any;
}
export interface LineageStore {
  query(args: any): any;
}
export interface ExecutionLog {
  record(entry: any): void;
}
export interface Connectors {
  mcp: { call(args: any): any };
}
export interface SkillsService {
  manage(args: any): any;
}
export interface LlmService {
  call(args: any): any;
}

export interface DaemonDeps {
  permissions?: PermissionManager;
  kernelManager?: KernelManager;
  artifacts?: ArtifactStore;
  lineage?: LineageStore;
  executionLog?: ExecutionLog;
  connectors?: Connectors;
  skills?: SkillsService;
  llm?: LlmService;
  // AD-2：daemon 是唯一持凭据的进程。
  credentials?: CredentialStore;
  // AD-1：持久层的根；未注入时 daemon 不主动创建目录。
  projects?: ProjectManager;
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

class DefaultHttpConnector {
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

class RealHttpConnector {
  private registry: ConnectorRegistry;
  private builtin = new DefaultHttpConnector();

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
}

export class SparkResearchDaemon {
  readonly permissions: PermissionManager;
  readonly artifacts: ArtifactStore;
  readonly lineage: LineageStore;
  readonly executionLog: ExecutionLog;
  readonly connectors: Connectors;
  readonly skills: SkillsService;
  readonly llm: LlmService;
  readonly kernelManager: KernelManager;
  readonly credentials: CredentialStore;
  readonly projects?: ProjectManager;

  private agents = new Map<string, any>();
  private agentSeq = 0;

  constructor(deps: DaemonDeps = {}) {
    this.permissions = deps.permissions ?? new PermissionManager();
    this.artifacts = deps.artifacts ?? new DefaultArtifacts();
    this.lineage = deps.lineage ?? new DefaultLineage();
    this.executionLog = deps.executionLog ?? new DefaultExecutionLog();
    this.connectors = deps.connectors ?? { mcp: new RealHttpConnector() };
    this.skills = deps.skills ?? new DefaultSkills();
    this.llm = deps.llm ?? new DefaultLLM();
    this.credentials = deps.credentials ?? new CredentialStore();
    this.projects = deps.projects;
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
      case "manage_skills": return this.skills.manage(a);
      case "artifact_lookup": return this.artifacts.lookup(a);
      case "lineage_query": return this.lineage.query(a);
      case "model_call": return this.llm.call(a);
      // AD-2：只回「是否已配置 + 字段名」，凭据本体永远不出 daemon。
      case "credentials": return credentialStatus(this.credentials, a);
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
