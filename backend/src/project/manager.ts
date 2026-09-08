import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactStore } from "../artifacts/store";
import { RecordStore } from "./records";
import { assertSlug, isValidSlug, ProjectError, slugify } from "./slug";
import type { ProjectMeta, ProjectPaths, ProjectStatus, WorkspaceState } from "./models";

export const DEFAULT_PROJECT_SLUG = "default";
export const PROJECT_SCHEMA_VERSION = 1;

export { assertSlug, isValidSlug, ProjectError, slugify };

export function defaultWorkspaceRoot(): string {
  return process.env.SPARK_RESEARCH_DATA_DIR ?? join(homedir(), ".spark-research");
}

// 单个项目的句柄：元数据 + 目录布局 + 惰性打开的 records/artifacts 存储。
export class Project {
  readonly slug: string;
  readonly paths: ProjectPaths;

  private metaCache: ProjectMeta;
  private recordStore?: RecordStore;
  private artifactStore?: ArtifactStore;

  constructor(meta: ProjectMeta, paths: ProjectPaths) {
    this.slug = meta.slug;
    this.metaCache = meta;
    this.paths = paths;
  }

  get meta(): ProjectMeta {
    return this.metaCache;
  }

  records(): RecordStore {
    if (!this.recordStore) this.recordStore = new RecordStore(this.paths.recordsDb, this.slug);
    return this.recordStore;
  }

  artifacts(): ArtifactStore {
    if (!this.artifactStore) {
      this.artifactStore = new ArtifactStore(this.paths.artifactsDb, this.paths.artifactsDir, {
        projectSlug: this.slug,
      });
    }
    return this.artifactStore;
  }

  // 关闭已打开的存储句柄，便于测试中做「关闭 → 重开」的持久化往返。
  close(): void {
    this.recordStore?.close();
    this.recordStore = undefined;
    this.artifactStore?.close();
    this.artifactStore = undefined;
  }

  updateMeta(meta: ProjectMeta): void {
    this.metaCache = meta;
  }
}

// Project 管理器（AD-1：Project 是持久层的根，session 挂在 project 下）。
// root 可注入，测试用 mkdtempSync 目录，生产默认 ~/.spark-research。
export class ProjectManager {
  readonly root: string;
  readonly projectsDir: string;
  readonly stateFile: string;

  constructor(root: string = defaultWorkspaceRoot()) {
    this.root = resolve(root);
    this.projectsDir = join(this.root, "projects");
    this.stateFile = join(this.root, "state.json");
    mkdirSync(this.projectsDir, { recursive: true });
  }

  pathsFor(slug: string): ProjectPaths {
    assertSlug(slug);
    const root = join(this.projectsDir, slug);
    return {
      root,
      metaFile: join(root, "project.json"),
      recordsDb: join(root, "records.db"),
      libraryDb: join(root, "library.db"),
      artifactsDir: join(root, "artifacts"),
      artifactsDb: join(root, "artifacts", "artifacts.db"),
      papersDir: join(root, "papers"),
      experimentsDir: join(root, "experiments"),
    };
  }

  exists(slug: string): boolean {
    if (!isValidSlug(slug)) return false;
    return existsSync(this.pathsFor(slug).metaFile);
  }

  create(slug: string, options: { name?: string; description?: string } = {}): Project {
    assertSlug(slug);
    if (this.exists(slug)) throw new ProjectError(`项目 '${slug}' 已存在`);
    const paths = this.pathsFor(slug);
    for (const dir of [paths.root, paths.artifactsDir, paths.papersDir, paths.experimentsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      slug,
      name: options.name ?? slug,
      description: options.description ?? "",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.writeMeta(paths, meta);
    const project = new Project(meta, paths);
    // 立刻建库，保证 `project new` 之后目录结构是完整可用的。
    project.records();
    project.close();
    if (this.readState().currentProject === null) this.setCurrent(slug);
    return this.open(slug);
  }

  open(slug: string): Project {
    assertSlug(slug);
    const paths = this.pathsFor(slug);
    if (!existsSync(paths.metaFile)) throw new ProjectError(`项目 '${slug}' 不存在`);
    return new Project(this.readMeta(paths), paths);
  }

  openOrCreate(slug: string, options: { name?: string; description?: string } = {}): Project {
    return this.exists(slug) ? this.open(slug) : this.create(slug, options);
  }

  list(options: { includeArchived?: boolean } = {}): ProjectMeta[] {
    if (!existsSync(this.projectsDir)) return [];
    const metas: ProjectMeta[] = [];
    for (const entry of readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
      const paths = this.pathsFor(entry.name);
      if (!existsSync(paths.metaFile)) continue;
      try {
        const meta = this.readMeta(paths);
        if (!options.includeArchived && meta.status === "archived") continue;
        metas.push(meta);
      } catch {
        // 损坏的 project.json 不应让整个 list 崩掉，跳过并留待后续修复。
        continue;
      }
    }
    return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug));
  }

  archive(slug: string): ProjectMeta {
    return this.setStatus(slug, "archived");
  }

  unarchive(slug: string): ProjectMeta {
    return this.setStatus(slug, "active");
  }

  // 默认项目：CLI/会话找不到归属时的兜底，按需创建。
  defaultProject(): Project {
    const current = this.readState().currentProject;
    if (current && this.exists(current)) return this.open(current);
    return this.openOrCreate(DEFAULT_PROJECT_SLUG, { name: "默认项目" });
  }

  setCurrent(slug: string): void {
    assertSlug(slug);
    if (!this.exists(slug)) throw new ProjectError(`项目 '${slug}' 不存在`);
    const state = this.readState();
    state.currentProject = slug;
    this.writeState(state);
  }

  currentSlug(): string | null {
    const current = this.readState().currentProject;
    return current && this.exists(current) ? current : null;
  }

  bindSession(sessionId: string, slug: string): void {
    assertSlug(slug);
    if (!this.exists(slug)) throw new ProjectError(`项目 '${slug}' 不存在`);
    const state = this.readState();
    state.sessions[sessionId] = slug;
    this.writeState(state);
  }

  sessionProjectSlug(sessionId: string): string | null {
    const slug = this.readState().sessions[sessionId];
    return slug && this.exists(slug) ? slug : null;
  }

  // session 归属解析：已绑定且项目仍在 → 用它；否则落到默认项目并绑定（AD-1）。
  projectForSession(sessionId: string): Project {
    const bound = this.sessionProjectSlug(sessionId);
    if (bound) return this.open(bound);
    const project = this.defaultProject();
    this.bindSession(sessionId, project.slug);
    return project;
  }

  // 把自由字符串的 project 字段解析成真实 project slug；解析不出来返回 null（旧数据不炸）。
  resolveRef(raw: string): string | null {
    if (this.exists(raw)) return raw;
    const slug = slugify(raw);
    return slug && this.exists(slug) ? slug : null;
  }

  readState(): WorkspaceState {
    if (!existsSync(this.stateFile)) return { currentProject: null, sessions: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<WorkspaceState>;
      return {
        currentProject: parsed.currentProject ?? null,
        sessions: parsed.sessions ?? {},
      };
    } catch {
      return { currentProject: null, sessions: {} };
    }
  }

  private writeState(state: WorkspaceState): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2) + "\n");
  }

  private setStatus(slug: string, status: ProjectStatus): ProjectMeta {
    const paths = this.pathsFor(slug);
    if (!existsSync(paths.metaFile)) throw new ProjectError(`项目 '${slug}' 不存在`);
    const meta = { ...this.readMeta(paths), status, updatedAt: new Date().toISOString() };
    this.writeMeta(paths, meta);
    if (status === "archived" && this.readState().currentProject === slug) {
      const state = this.readState();
      state.currentProject = null;
      this.writeState(state);
    }
    return meta;
  }

  // 老版本 project.json 可能缺字段，读时补默认值。
  private readMeta(paths: ProjectPaths): ProjectMeta {
    const meta = JSON.parse(readFileSync(paths.metaFile, "utf8")) as Partial<ProjectMeta>;
    return {
      ...meta,
      schemaVersion: meta.schemaVersion ?? PROJECT_SCHEMA_VERSION,
      slug: meta.slug ?? "",
      name: meta.name ?? meta.slug ?? "",
      description: meta.description ?? "",
      status: meta.status ?? "active",
      createdAt: meta.createdAt ?? new Date(0).toISOString(),
      updatedAt: meta.updatedAt ?? new Date(0).toISOString(),
    };
  }

  private writeMeta(paths: ProjectPaths, meta: ProjectMeta): void {
    writeFileSync(paths.metaFile, JSON.stringify(meta, null, 2) + "\n");
  }
}
