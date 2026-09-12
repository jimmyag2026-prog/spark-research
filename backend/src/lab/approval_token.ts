// V95（W8-1 ε）：HTTP 层的一次性审批令牌。
//
// 背景（BACKLOG V95）：`POST /api/lab/experiments/:id/approve` 此前只要 body 里
// `actor` 是个非空字符串就放行——本机任意进程 curl 一下就能走完 design→approve→execute，
// CLI 的 V19 交互终端门（`backend/src/approval/gate.ts`）在 HTTP 面被整段绕开。
// compute 域已经把 dispatch 撤出 HTTP（AD-14 纵深），lab 没对齐，这是补齐。
//
// 设计（与任务书一致，未改设计）：CLI 侧 `spark-research lab token <experiment-id>`
// 走**与 `lab approve` 完全同一套**交互终端门（`requireApprovalGate`，见 cli.ts），
// 门后调用这里的 `issue()` 生成一枚 32 字节随机令牌，落盘只存它的 sha256——原始令牌
// 只在这一次 CLI 调用里打印一次，不会再出现在任何日志/记录里。HTTP 侧
// `/approve`、`/simulate` 等触发执行的路由用 `consume()` 校验并**单次消费**它：
// hash 对得上、没过期、没被用过 → 标 used 并放行；否则一律 403。
//
// 单次消费覆盖 approve 与 simulate **各自独立**——同一枚令牌只能兑现一次，approve
// 用掉之后 simulate 必须另外 `lab token` 一枚（这正是任务书 e2e 场景要验的：
// 带令牌 approve → 200，再用同一枚令牌 simulate → 403）。
//
// 存储：`projects/<slug>/lab/approval_tokens.json`（0600），每条记录
// `{ experimentId, tokenHash, issuedAt, expiresAt, used, usedAt? }`。**不存原始令牌**——
// 文件泄露也拿不到可用的令牌（只有 hash）。读-改-写全程持一把同目录锁文件（`.lock`，
// `wx` 独占创建 + 过期回收，与 `project/manager.ts` 的 state.json 锁同一套思路，但
// **刻意不 import 那份实现**：manager.ts 的锁是私有方法，且 P7 e2e 的 Playwright 测试
// 进程跑在纯 Node 下——这个文件只依赖 node:fs/crypto/path，不牵连 `server/*` 那条
// 只有 Bun 运行时才装得全的依赖链（workbench.spec.ts 顶部注释记录过这个坑：直接
// import server 侧模块会在 Playwright 收集阶段就报 `Cannot find package 'bun'`）。
// 写盘用 tmp + rename（同目录内原子替换），与 V96 的 state.json 写法同一条纪律。

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 分钟（任务书明定）

export class ApprovalTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalTokenError";
  }
}

interface ApprovalTokenRecord {
  experimentId: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  used: boolean;
  usedAt?: string;
}

interface TokenFile {
  tokens: ApprovalTokenRecord[];
}

export interface IssuedApprovalToken {
  /** 原始令牌，只在这一次返回里出现——调用方（CLI）打印一次后不得再持有。 */
  token: string;
  experimentId: string;
  issuedAt: string;
  expiresAt: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

function labDir(projectRoot: string): string {
  return join(projectRoot, "lab");
}

function tokenFilePath(projectRoot: string): string {
  return join(labDir(projectRoot), "approval_tokens.json");
}

function lockFilePath(projectRoot: string): string {
  return `${tokenFilePath(projectRoot)}.lock`;
}

// pid 存活探测：与 `server/tasks.ts` 的 `isProcessAlive` 判据相同（`kill(pid, 0)`），
// 但**不 import 那个模块**——见文件顶部注释，避免把 Bun-only 依赖链带进 Playwright/Node
// 侧也可能 import 这个文件的场景。
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM"; // 存在但没权限信号，也算活着
  }
}

function reclaimStaleLock(lockFile: string): boolean {
  let payload: { pid?: number; acquiredAtMs?: number } | null;
  try {
    payload = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    return false;
  }
  const pid = payload?.pid;
  const acquiredAtMs = payload?.acquiredAtMs;
  if (typeof pid !== "number" || typeof acquiredAtMs !== "number") return false;
  if (Date.now() - acquiredAtMs <= LOCK_STALE_MS) return false;
  if (isProcessAlive(pid)) return false;
  try {
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

function acquireLock(projectRoot: string): void {
  mkdirSync(labDir(projectRoot), { recursive: true });
  const lockFile = lockFilePath(projectRoot);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (reclaimStaleLock(lockFile)) continue;
      if (Date.now() > deadline) {
        throw new ApprovalTokenError(`approval_tokens.json 锁获取超时（>${LOCK_ACQUIRE_TIMEOUT_MS}ms）：${lockFile}`);
      }
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) {
        /* busy-wait：与 manager.ts 同一条纪律的忙等重试，跨度极短 */
      }
    }
  }
}

function releaseLock(projectRoot: string): void {
  try {
    unlinkSync(lockFilePath(projectRoot));
  } catch {
    // 理论上不该发生（锁是本次调用自己创建的）；不掩盖上面业务逻辑可能抛出的真实错误。
  }
}

function readTokenFile(projectRoot: string): TokenFile {
  const file = tokenFilePath(projectRoot);
  if (!existsSync(file)) return { tokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TokenFile>;
    return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch {
    return { tokens: [] };
  }
}

// 原子写（V96 同一条纪律）：tmp 文件 → fsync → 同目录 rename。0600：这份文件只存
// hash，但仍然是审批凭证的账本，不给其他本机用户读的理由。
function writeTokenFile(projectRoot: string, data: TokenFile): void {
  mkdirSync(labDir(projectRoot), { recursive: true });
  const file = tokenFilePath(projectRoot);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 非 POSIX 权限模型（极少数环境）下 chmod 可能不被支持；rename 后的文件已经是
    // tmp 创建时 0o600 的产物，这里失败不影响功能，只是双保险没生效。
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 签发一枚一次性审批令牌，绑定到具体的 `experimentId`。10 分钟内有效，
 * 未被消费前可以被 `consume()` 兑现恰好一次。**原始令牌只在这次返回里出现一次**——
 * 调用方（`lab/cli.ts` 的 `lab token` 子命令）打印给人看之后不再持有它。
 */
export function issue(projectRoot: string, experimentId: string): IssuedApprovalToken {
  acquireLock(projectRoot);
  try {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + APPROVAL_TOKEN_TTL_MS).toISOString();
    const data = readTokenFile(projectRoot);
    data.tokens.push({ experimentId, tokenHash: sha256(token), issuedAt, expiresAt, used: false });
    writeTokenFile(projectRoot, data);
    return { token, experimentId, issuedAt, expiresAt };
  } finally {
    releaseLock(projectRoot);
  }
}

/**
 * 兑现一枚令牌：hash 对得上、绑定的 experimentId 一致、没过期、没被用过 → 标 used
 * 并返回；任何一条不满足都抛 `ApprovalTokenError`（HTTP 层映射到 403）。
 * 全程持锁：并发 consume 同一枚令牌，保证恰好一次成功（见
 * `tests/concurrency/lab_token_once.test.ts`）。
 */
export function consume(projectRoot: string, experimentId: string, token: string): void {
  if (typeof token !== "string" || token.trim() === "") {
    throw new ApprovalTokenError(
      "approvalToken 缺失——在终端跑 `spark-research lab token <experiment-id>` 获取一次性令牌。",
    );
  }
  acquireLock(projectRoot);
  try {
    const data = readTokenFile(projectRoot);
    const tokenHash = sha256(token);
    const now = Date.now();

    const boundToThisExperiment = data.tokens.filter(
      (t) => t.experimentId === experimentId && hashesEqual(t.tokenHash, tokenHash),
    );
    if (boundToThisExperiment.length === 0) {
      throw new ApprovalTokenError(
        `令牌无效——在终端跑 \`spark-research lab token ${experimentId}\` 获取一次性令牌。`,
      );
    }
    // 同一枚令牌只会被 issue 一次（32 字节随机数碰撞概率可忽略），这里取第一条即可。
    const match = boundToThisExperiment[0]!;
    if (match.used) {
      throw new ApprovalTokenError(
        `令牌已被使用过（一次性）——在终端跑 \`spark-research lab token ${experimentId}\` 获取新的一次性令牌。`,
      );
    }
    if (Date.parse(match.expiresAt) < now) {
      throw new ApprovalTokenError(
        `令牌已过期（10 分钟有效期）——在终端跑 \`spark-research lab token ${experimentId}\` 获取新的一次性令牌。`,
      );
    }
    match.used = true;
    match.usedAt = new Date(now).toISOString();
    writeTokenFile(projectRoot, data);
  } finally {
    releaseLock(projectRoot);
  }
}
