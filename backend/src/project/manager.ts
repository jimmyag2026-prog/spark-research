import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactStore } from "../artifacts/store";
import { RecordStore } from "./records";
import { JsonlRawSink, type RawSink } from "../raw";
import { assertSlug, isValidSlug, ProjectError, slugify } from "./slug";
import type { ProjectMeta, ProjectPaths, ProjectStatus, WorkspaceState } from "./models";
import { FindingsStore } from "../reviewer/findings_store";
// W7-C1（V64 根治）：过期锁回收的死活判据——W7-C2 在 server/tasks.ts 已经写过同一件事
// （`kill(pid, 0)` 存在性核验），这里直接复用导出，不再写第二份（V46 形状，任务书明文
// 禁止）。两个模块互不依赖对方别的东西，只借这一个纯函数。
import { isProcessAlive } from "../server/tasks";

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
  private findingsStore?: FindingsStore;
  private rawSink?: RawSink;

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

  /**
   * v0.4 W3 收口：findings 状态机的存储（W1-b 交付）。
   * 与 records.db 同级的独立 db——W1-b 刻意不与 RecordStore 共表共连接。
   */
  findings(): FindingsStore {
    this.findingsStore ??= new FindingsStore(join(this.paths.root, "findings.db"));
    return this.findingsStore;
  }

  /**
   * v0.7 W7-D0 · L0 原始层（AD-15）：本项目的 connector/llm/kernel/device 原始记录。
   * 只追加不改；证据图（records）是它之上的派生层。
   */
  raw(): RawSink {
    this.rawSink ??= new JsonlRawSink(this.paths.rawDir, { project: this.slug });
    return this.rawSink;
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

// W7-C1（V64 根治）：全局指针无锁——R1 两个并发零上下文会话各自 read-modify-write
// state.json，后写的那个把先写的那个的改动整个覆盖掉（不是「写坏了」，是「读的时候
// 对方还没写完，写的时候把对方那次改动读丢了」，经典 lost update）。落锁文件
// `state.json.lock`：O_EXCL 创建即独占，内容写 pid + 时间戳；正常路径用完立即删除；
// 持锁方如果自己崩了（没机会删），锁文件会一直挡路——所以要有过期回收：超过
// STALE_MS 且 pid 已经不在了，判定持锁者已死，谁先抢到删除权谁就能继续建自己的锁
// （删除本身也可能竞争，删的时候吞掉 ENOENT，交给下一轮 retry 收敛）。
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_RETRY_MS = 15;
// 生产环境读-改-写这几行 JSON 应该是毫秒级的；给一个远高于正常耗时的硬顶，
// 避免真正死锁（比如回收逻辑本身有 bug）时调用方永远卡死而不是报错。
const STATE_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

interface StateLockPayload {
  pid: number;
  acquiredAtMs: number;
}

// Project 管理器（AD-1：Project 是持久层的根，session 挂在 project 下）。
// root 可注入，测试用 mkdtempSync 目录，生产默认 ~/.spark-research。
export class ProjectManager {
  readonly root: string;
  readonly projectsDir: string;
  readonly stateFile: string;
  private readonly stateLockFile: string;

  constructor(root: string = defaultWorkspaceRoot()) {
    this.root = resolve(root);
    this.projectsDir = join(this.root, "projects");
    this.stateFile = join(this.root, "state.json");
    this.stateLockFile = `${this.stateFile}.lock`;
    mkdirSync(this.projectsDir, { recursive: true });
  }

  // 独占持锁：O_EXCL 创建成功即拿到锁；创建失败（EEXIST）时先看能不能把对方的锁
  // 判定成过期死锁并回收，回收成功立刻重试，回收不了则短暂忙等后重试。
  // 忙等用 `Bun.sleepSync`（阻塞当前线程）而不是 async/await——`ProjectManager`
  // 全类都是同步 API（历史形状，改成 async 会把 `--project` 单点 `openProjectResolved`
  // 之外一整圈同步调用方都牵连），锁必须原地跟这套同步调用形状对齐。
  private acquireStateLock(): void {
    const deadline = Date.now() + STATE_LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(this.stateLockFile, "wx");
        try {
          const payload: StateLockPayload = { pid: process.pid, acquiredAtMs: Date.now() };
          writeSync(fd, JSON.stringify(payload));
        } finally {
          closeSync(fd);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        if (this.reclaimStaleStateLock()) continue; // 回收成功，立刻重试，不必等一轮忙等。
        if (Date.now() > deadline) {
          throw new ProjectError(
            `state.json 锁获取超时（>${STATE_LOCK_ACQUIRE_TIMEOUT_MS}ms）：${this.stateLockFile}`,
          );
        }
        Bun.sleepSync(STATE_LOCK_RETRY_MS);
      }
    }
  }

  // 过期回收：锁文件内容读不出 pid/时间戳（损坏或对方正在写入的过渡态）一律不回收，
  // 留给下一轮重试；没过期（时间没到 STALE_MS）不回收；过期了但 pid 还活着——保守
  // 不抢，可能只是持锁方在做一次异常慢的写（真正卡死会在 STALE_MS 之后被下一次
  // 检查按「pid 已死」回收，或者触发调用方的整体超时）。只有「过期 + pid 已死」
  // 才真正判定为死锁并删除。
  private reclaimStaleStateLock(): boolean {
    let payload: Partial<StateLockPayload> | null;
    try {
      payload = JSON.parse(readFileSync(this.stateLockFile, "utf8"));
    } catch {
      return false;
    }
    const pid = payload?.pid;
    const acquiredAtMs = payload?.acquiredAtMs;
    if (typeof pid !== "number" || typeof acquiredAtMs !== "number") return false;
    if (Date.now() - acquiredAtMs <= STATE_LOCK_STALE_MS) return false;
    if (isProcessAlive(pid)) return false;
    try {
      unlinkSync(this.stateLockFile);
      return true;
    } catch (error) {
      // 别的进程已经先一步回收了：视为「回收成功」，下一轮重试即可。
      return (error as NodeJS.ErrnoException)?.code === "ENOENT";
    }
  }

  private releaseStateLock(): void {
    try {
      unlinkSync(this.stateLockFile);
    } catch {
      // 理论上不该发生（锁是本次调用自己创建的）；不因为释放失败而掩盖上面业务逻辑
      // 可能抛出的真实错误——finally 块里调用，原错误始终优先冒泡。
    }
  }

  // state.json 的读-改-写全部经这个口子：拿锁 → 回调内部自己 readState()/writeState()
  // （必须在锁内重新读，不能用调用方在锁外缓存的旧快照——那正是 lost update 的成因）→
  // 释放锁。回调允许什么都不写（纯读一致性场景），但目前所有调用点都是写。
  private stateLockDepth = 0;

  private withStateLock<T>(fn: () => T): T {
    this.acquireStateLock();
    this.stateLockDepth += 1;
    try {
      return fn();
    } finally {
      this.stateLockDepth -= 1;
      this.releaseStateLock();
    }
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
      rawDir: join(root, "raw"),
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
    for (const dir of [paths.root, paths.artifactsDir, paths.papersDir, paths.experimentsDir, paths.rawDir]) {
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
    this.withStateLock(() => {
      const state = this.readState();
      state.currentProject = slug;
      this.writeState(state);
    });
  }

  currentSlug(): string | null {
    const current = this.readState().currentProject;
    return current && this.exists(current) ? current : null;
  }

  bindSession(sessionId: string, slug: string): void {
    assertSlug(slug);
    if (!this.exists(slug)) throw new ProjectError(`项目 '${slug}' 不存在`);
    this.withStateLock(() => {
      const state = this.readState();
      state.sessions[sessionId] = slug;
      this.writeState(state);
    });
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

  // V96（v0.8 G-5）：原子写。裸 `writeFileSync(state.json)` 是「先截断再写」——进程在两步之间被
  // kill，state.json 就是空文件/半个 JSON，下次 readState() 只能回退到空状态（currentProject
  // 丢失、所有 session 绑定丢失）。改成同目录写临时文件 → fsync → rename：rename 在同一文件系统
  // 内是原子的，读者看到的永远是旧的完整内容或新的完整内容，绝不会是中间态。
  // 必须在 withStateLock 临界区内调用（读-改-写的锁与写本身同一临界区），锁外调用直接抛。
  private writeState(state: WorkspaceState): void {
    if (this.stateLockDepth <= 0) {
      throw new ProjectError("writeState 必须在 withStateLock 临界区内调用（V96）");
    }
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(state, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.stateFile);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // 临时文件清不掉不掩盖 rename 的真实错误。
      }
      throw error;
    }
  }

  private setStatus(slug: string, status: ProjectStatus): ProjectMeta {
    const paths = this.pathsFor(slug);
    if (!existsSync(paths.metaFile)) throw new ProjectError(`项目 '${slug}' 不存在`);
    const meta = { ...this.readMeta(paths), status, updatedAt: new Date().toISOString() };
    this.writeMeta(paths, meta);
    if (status === "archived") {
      this.withStateLock(() => {
        const state = this.readState();
        if (state.currentProject === slug) {
          state.currentProject = null;
          this.writeState(state);
        }
      });
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

// R2-P0（V64 防线补全）→ W7-C1（V64 根治）：`--project` 显式覆盖起初只是防线，这里把
// 它扩成完整四档解析顺序，**单点**实现，所有 CLI 的必经点：
//   1. `--project`（projectFlag，显式最高优先级——用户当场敲的，覆盖一切）
//   2. env `SPARK_RESEARCH_PROJECT`（进程级显式声明，次优先）
//   3. `state.json.sessions[sessionId]`（会话绑定；sessionId 优先取调用方显式传入的
//      `sessionId` 参数，其次落 env `SPARK_RESEARCH_SESSION`——见下方「sessionId 来源」
//      的如实交代）
//   4. 全局 `currentProject`（`manager.defaultProject()`：存在则用，不存在则按需建 default）
//
// sessionId 来源的如实交代（任务书 W7-C1 明文要求）：CLI 现在产生 session id 的唯一
// 地方是 `index.ts` 的 `cli_${Date.now()}` / `oneshot_${Date.now()}`——只在单次
// `orch.chat()` 调用内部有效，从不传给这里的十几个 `openProjectResolved` 调用点
// （它们各自在 `literature/cli.ts`、`experiment/cli.ts` 等文件里现建 `ProjectManager`
// 直接调用，`index.ts` 是禁止改动的收口文件，没有通道把那个临时 id 传进来）。
// 所以这十几个既有调用点的四档解析在「没有 --project/env 时」实际只能落到第 4 档
// 或第 3 档里 env 版本——`sessionId` 参数留给测试与未来接线显式传入；生产路径唯一能
// 跨越「`project use` 与随后一条独立进程命令」共享身份的载体，是调用方自己钉的
// env `SPARK_RESEARCH_SESSION`（`project/cli.ts` 的 `project use` 走的就是这条）。
export function openProjectResolved(
  manager: ProjectManager,
  projectFlag: string | undefined,
  sessionId?: string,
): Project {
  if (projectFlag) return manager.open(projectFlag);
  const envProject = process.env.SPARK_RESEARCH_PROJECT;
  if (envProject) return manager.open(envProject);
  const sid = sessionId ?? process.env.SPARK_RESEARCH_SESSION;
  if (sid) {
    const bound = manager.sessionProjectSlug(sid);
    if (bound) return manager.open(bound);
  }
  return manager.defaultProject();
}
