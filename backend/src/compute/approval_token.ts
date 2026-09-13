// V135（v0.8.1 Gate H-2）：HTTP 层的一次性审批令牌，compute 域的版本。
//
// 背景（BACKLOG V135）：`POST /api/compute/jobs/:id/approve` 与 `/reject` 此前只要
// body 里 `actor` 是个非空字符串就放行——本机任意进程 curl 一下就能伪造一条「已批准」
// 或「已拒绝」的记录，与 `lab approve`/`lab reject`（V95/V136，见 `../lab/approval_token.ts`）
// 早就补上的一次性令牌门不对称。dispatch 本身仍然只在 CLI TTY 面（AD-14 纵深，花钱动作
// 未直通），这条补的是「审批记录本身不该能被伪造」。
//
// 设计与 lab 侧完全同构（**故意不合并成一份共享模块**——见下方说明）：
// `spark-research compute token <jobId>` 走与 `compute approve` 相同的交互终端门
// （`COMPUTE_APPROVAL_GATE`，`../approval/gate.ts`），门后 `issue()` 生成一枚 32 字节
// 随机令牌，落盘只存 sha256。HTTP 侧 `approve`/`reject` 用 `consume()` 校验并单次消费：
// hash 对得上、没过期、没被用过 → 标 used 并放行；否则一律 403。
//
// **为什么不抽共享模块**：`lab/approval_token.ts` 已经被 lab 的 CLI/HTTP/并发测试
// （`tests/concurrency/lab_token_once.test.ts` 等）依赖了一整条链路；这里只是把同一份
// 逻辑复制一份、把子目录从 `lab` 换成 `compute`、把字段名从 `experimentId` 换成
// `jobId`，风险比抽一个双方都要改的共享层更低——两边逻辑高度重合但不是「同一件事的
// 两种写法」，各自独立演化更安全（compute 未来可能要按 target 分不同 TTL，lab 不需要）。
//
// 存储：`projects/<slug>/compute/approval_tokens.json`（0600），每条记录
// `{ jobId, tokenHash, issuedAt, expiresAt, used, usedAt? }`。**不存原始令牌**。
// 读-改-写全程持一把同目录锁文件，与 lab 侧同一套思路（`wx` 独占创建 + 过期回收）。

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

export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 分钟，与 lab 侧同一个默认值

export class ApprovalTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalTokenError";
  }
}

interface ApprovalTokenRecord {
  jobId: string;
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
  jobId: string;
  issuedAt: string;
  expiresAt: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

function computeDir(projectRoot: string): string {
  return join(projectRoot, "compute");
}

function tokenFilePath(projectRoot: string): string {
  return join(computeDir(projectRoot), "approval_tokens.json");
}

function lockFilePath(projectRoot: string): string {
  return `${tokenFilePath(projectRoot)}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
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
  mkdirSync(computeDir(projectRoot), { recursive: true });
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
        /* busy-wait：与 lab 侧同一条纪律的忙等重试，跨度极短 */
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

function writeTokenFile(projectRoot: string, data: TokenFile): void {
  mkdirSync(computeDir(projectRoot), { recursive: true });
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
    // 非 POSIX 权限模型下 chmod 可能不被支持；tmp 创建时已是 0o600，失败不影响功能。
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
 * 签发一枚一次性审批令牌，绑定到具体的 `jobId`。10 分钟内有效，未被消费前可以被
 * `consume()` 兑现恰好一次。**原始令牌只在这次返回里出现一次**。
 */
export function issue(projectRoot: string, jobId: string): IssuedApprovalToken {
  acquireLock(projectRoot);
  try {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + APPROVAL_TOKEN_TTL_MS).toISOString();
    const data = readTokenFile(projectRoot);
    data.tokens.push({ jobId, tokenHash: sha256(token), issuedAt, expiresAt, used: false });
    writeTokenFile(projectRoot, data);
    return { token, jobId, issuedAt, expiresAt };
  } finally {
    releaseLock(projectRoot);
  }
}

/**
 * 兑现一枚令牌：hash 对得上、绑定的 jobId 一致、没过期、没被用过 → 标 used 并返回；
 * 任何一条不满足都抛 `ApprovalTokenError`（HTTP 层映射到 403）。全程持锁：并发
 * consume 同一枚令牌，保证恰好一次成功。
 */
export function consume(projectRoot: string, jobId: string, token: string): void {
  if (typeof token !== "string" || token.trim() === "") {
    throw new ApprovalTokenError("approvalToken 缺失——在终端跑 `spark-research compute token <jobId>` 获取一次性令牌。");
  }
  acquireLock(projectRoot);
  try {
    const data = readTokenFile(projectRoot);
    const tokenHash = sha256(token);
    const now = Date.now();

    const boundToThisJob = data.tokens.filter((t) => t.jobId === jobId && hashesEqual(t.tokenHash, tokenHash));
    if (boundToThisJob.length === 0) {
      throw new ApprovalTokenError(`令牌无效——在终端跑 \`spark-research compute token ${jobId}\` 获取一次性令牌。`);
    }
    const match = boundToThisJob[0]!;
    if (match.used) {
      throw new ApprovalTokenError(
        `令牌已被使用过（一次性）——在终端跑 \`spark-research compute token ${jobId}\` 获取新的一次性令牌。`,
      );
    }
    if (Date.parse(match.expiresAt) < now) {
      throw new ApprovalTokenError(
        `令牌已过期（10 分钟有效期）——在终端跑 \`spark-research compute token ${jobId}\` 获取新的一次性令牌。`,
      );
    }
    match.used = true;
    match.usedAt = new Date(now).toISOString();
    writeTokenFile(projectRoot, data);
  } finally {
    releaseLock(projectRoot);
  }
}
