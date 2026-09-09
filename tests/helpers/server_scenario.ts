import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { LibraryStore, paperFrom } from "../../backend/src/literature/library";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { startServer, type StartedServer } from "../../backend/src/server/server";
import type { ServerDeps } from "../../backend/src/server/context";
import type { TaskSnapshot } from "../../backend/src/server/tasks";

// P7 HTTP 层测试脚手架。
//
// 纪律（与 P2-P6 各域测试一致）：
//   - 工作区根目录用 mkdtemp，绝不碰 ~/.spark-research；
//   - LLM / 网络一律注入 fake / fixture，**没有一条测试路径打真实服务**；
//   - 湿实验后端注入 mock（验的是 HTTP 语义与 approve gate，不是 opentrons 装没装）；
//   - SSE 心跳关掉（heartbeatMs=0），否则定时器会拖住 bun test 退出。

export interface ServerFixture {
  server: StartedServer;
  base: string;
  root: string;
  manager: ProjectManager;
  project: Project;
  stop(): Promise<void>;
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  post<T = unknown>(path: string, body?: unknown): Promise<{ status: number; body: T }>;
  patch<T = unknown>(path: string, body?: unknown): Promise<{ status: number; body: T }>;
  text(path: string): Promise<{ status: number; body: string }>;
  // 提交长任务并等它落定（`await: true`），返回任务快照。
  run(path: string, body?: Record<string, unknown>): Promise<{ status: number; task: TaskSnapshot }>;
}

export interface ServerFixtureOptions extends Omit<ServerDeps, "root" | "projects"> {
  slug?: string;
  name?: string;
  description?: string;
  // 不建项目（用于测「还没有项目」的空态）。
  skipProject?: boolean;
}

export function makeServer(options: ServerFixtureOptions = {}): ServerFixture {
  const { slug = "p7", name, description, skipProject, ...deps } = options;
  const root = mkdtempSync(join(tmpdir(), "spark-p7-"));
  const manager = new ProjectManager(root);
  const created = skipProject
    ? manager.defaultProject()
    : manager.create(slug, { name: name ?? "P7 测试项目", description: description ?? "" });
  const actualSlug = created.slug;
  created.close();

  const server = startServer(0, {
    root,
    projects: manager,
    wetBackend: deps.wetBackend ?? new MockDeviceBackend(),
    sseHeartbeatMs: 0,
    ...deps,
  });
  const base = `http://127.0.0.1:${server.port}`;

  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应（导出的 bibtex、静态页）保留原文。
    }
    return { status: res.status, body: parsed as never };
  };

  return {
    server,
    base,
    root,
    manager,
    project: manager.open(actualSlug),
    stop: () => server.stop(),
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    patch: (path, body) => request("PATCH", path, body ?? {}),
    text: async (path) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.text() };
    },
    run: async (path, body = {}) => {
      const res = await request("POST", path, { ...body, await: true });
      return { status: res.status, task: (res.body as { task: TaskSnapshot }).task };
    },
  };
}

// 往项目文献库塞 n 篇确定性论文（title/author/year 固定 → bibtex key 固定）。
export function seedLibrary(project: Project, n = 3): { ids: string[]; titles: string[] } {
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  const surnames = ["Jumper", "Baek", "Lin", "Vaswani", "Senior"];
  const ids: string[] = [];
  const titles: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const title = `Paper ${i + 1} on protein structure prediction`;
      const added = library.add(
        paperFrom({
          title,
          authors: [{ name: `Alice ${surnames[i % surnames.length]}` }],
          year: 2020 + (i % 5),
          venue: "Nature",
          doi: `10.1000/p7.${i + 1}`,
          abstract: `Abstract of paper ${i + 1}: a method for protein structure prediction.`,
          sources: ["openalex"],
        }),
      );
      ids.push(added.paper.id);
      titles.push(title);
    }
  } finally {
    library.close();
  }
  return { ids, titles };
}
