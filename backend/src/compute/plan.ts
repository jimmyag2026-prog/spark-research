// C1 · 被审批的对象本体（CB-1，设计 §1.1.3 / §2.2）。
//
// plan 是**人看着点头的那张纸**。所以这里的每一条校验都在回答同一个问题：
// 「人批准的，和最后真正跑的，是不是同一件事」。
//   · command 是 argv 而不是 shell 字符串——被审批的东西不该再经过一次 shell 展开
//   · digest 排除 workspaceRoot（绝对路径不改变「跑什么」）
//   · estimate 进 digest——价格表变了就该重新批
//   · approvalRequired 是派生值（L-3），调用方不能传

import { createHash } from "node:crypto";
import { canonicalJson } from "../simulation/platform";
import { redactSecrets } from "../llm/types";
import type { AdapterCapabilities, TargetRef } from "./target";

export interface UploadEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface CostEstimate {
  unit: "computeSeconds";
  /** timeoutMinutes * 60 —— **上界**，不是预测。 */
  quantity: number;
  /** 查不到 = null，**绝不 0**（0 会被读成「这次真的免费」）。 */
  unitPriceUsd: number | null;
  upperBoundUsd: number | null;
  /** 定价页 URL。 */
  source: string | null;
  /** ISO date。 */
  verifiedDate: string | null;
}

export interface ComputePlan {
  schemaVersion: 1;
  /** sha256(canonicalJson(plan 去掉 digest 与 workspaceRoot))。 */
  digest: string;
  target: TargetRef;
  purpose: string;
  /** argv；拒绝 shell 字符串。 */
  command: string[];
  cwd: "/workspace";
  /** validatePlan 拒绝密钥样 key / value。 */
  env: Record<string, string>;
  image: { base: string; pip: string[]; pipLock: { digest: string; requirements: string } | null } | null;
  /** 符号名；值永不进 plan/job。 */
  secretRefs: string[];
  resources: { gpu: string | null; cpus: number; memoryGb: number; timeoutMinutes: number };
  network: "none" | "unrestricted";
  uploads: UploadEntry[];
  uploadBytes: number;
  /** glob */
  outputs: string[];
  /** 派生（L-3）。 */
  approvalRequired: boolean;
  estimate: CostEstimate;
  /** 明文警告：这次运行用谁的账户、上界多少钱。 */
  warning: string;
  /** 绝对路径；**排除在 digest 外**。 */
  workspaceRoot: string;
}

export type PlanInput = Omit<
  ComputePlan,
  "digest" | "approvalRequired" | "estimate" | "warning" | "uploadBytes" | "schemaVersion" | "cwd"
>;

export type PricingLookup = (
  target: TargetRef,
  gpu: string | null,
) => Omit<CostEstimate, "unit" | "quantity" | "upperBoundUsd">;

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export const MAX_TIMEOUT_MINUTES = 1440;

// 密钥样 env key：与 redactSecrets（llm/types.ts:111-116）同源的模式。
// env 里出现这类 key 一律拒——密钥只能走 secretRefs（符号名）。
const SECRET_ENV_KEY = /(api[_-]?key|secret|token|password|passwd|credential|authorization|private[_-]?key|session[_-]?id)/i;
const ENV_KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_REF_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHELL_METACHAR = /[|&;<>()$`\\"'\n*?~]/;
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]);
const HEX64 = /^[0-9a-f]{64}$/;

/** L-3：approvalRequired 是派生值，不是入参。 */
export function derivedApprovalRequired(
  input: Pick<ComputePlan, "network" | "secretRefs">,
  caps: AdapterCapabilities,
): boolean {
  return caps.billable || input.network !== "none" || input.secretRefs.length > 0;
}

/**
 * digest 排除 `workspaceRoot`：同一份工作换个绝对路径，跑的还是同一件事，
 * 不该让人重批一遍（与 protocolHash 不含时间戳同一思想）。
 * 其余**全部**进 digest，**包括 estimate**——价格表变了就该重新批。
 */
export function planDigest(plan: Omit<ComputePlan, "digest">): string {
  const { workspaceRoot: _ignored, ...rest } = plan;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function estimateFor(
  target: TargetRef,
  resources: ComputePlan["resources"],
  pricing: PricingLookup,
): CostEstimate {
  const quantity = resources.timeoutMinutes * 60;
  const looked = pricing(target, resources.gpu);
  const unitPriceUsd = looked.unitPriceUsd;
  // 查不到单价 → upperBound 也是 null。**绝不填 0**（PRICING 纪律，registry.ts:19-37）。
  const upperBoundUsd = unitPriceUsd === null ? null : Number((unitPriceUsd * quantity).toFixed(6));
  return {
    unit: "computeSeconds",
    quantity,
    unitPriceUsd,
    upperBoundUsd,
    source: looked.source,
    verifiedDate: looked.verifiedDate,
  };
}

export function planWarning(target: TargetRef, estimate: CostEstimate, billable: boolean): string {
  const where = target.kind === "local" ? "本机" : `你的 ${target.kind} 账户`;
  const money = billable
    ? estimate.upperBoundUsd === null
      ? "**查不到单价，花费上界未知**（不要把「未知」读成「免费」）"
      : `花费上界约 $${estimate.upperBoundUsd}（${estimate.quantity} 计算秒 × $${estimate.unitPriceUsd}/秒，` +
        `来源 ${estimate.source}，核实于 ${estimate.verifiedDate}）`
    : "不产生账单（本地执行）";
  return `此运行使用 ${where} 的资源；${money}。`;
}

export function buildPlan(input: PlanInput, caps: AdapterCapabilities, pricing: PricingLookup): ComputePlan {
  const uploadBytes = input.uploads.reduce((sum, u) => sum + u.size, 0);
  const estimate = estimateFor(input.target, input.resources, pricing);
  const approvalRequired = derivedApprovalRequired(input, caps);
  const withoutDigest: Omit<ComputePlan, "digest"> = {
    schemaVersion: 1,
    target: input.target,
    purpose: input.purpose,
    command: [...input.command],
    cwd: "/workspace",
    env: { ...input.env },
    image: input.image,
    secretRefs: [...input.secretRefs],
    resources: { ...input.resources },
    network: input.network,
    uploads: input.uploads.map((u) => ({ ...u })),
    uploadBytes,
    outputs: [...input.outputs],
    approvalRequired,
    estimate,
    warning: planWarning(input.target, estimate, caps.billable),
    workspaceRoot: input.workspaceRoot,
  };
  const plan: ComputePlan = { ...withoutDigest, digest: planDigest(withoutDigest) };
  validatePlan(plan, caps);
  return plan;
}

/** 派发前会**再跑一次**：plan 是从磁盘读回来的，读回来的东西一律不信任。 */
export function validatePlan(plan: ComputePlan, caps: AdapterCapabilities): void {
  if (plan.schemaVersion !== 1) {
    throw new PlanValidationError(`不认识的 plan schemaVersion=${String(plan.schemaVersion)}`);
  }
  if (!plan.purpose.trim()) {
    throw new PlanValidationError("plan.purpose 不能为空：审批面上人得知道这是要干什么");
  }
  if (plan.cwd !== "/workspace") {
    throw new PlanValidationError(`plan.cwd 只能是 '/workspace'，收到 '${plan.cwd}'`);
  }

  // ── command：argv，不是 shell 字符串 ────────────────────────────────────
  if (!Array.isArray(plan.command) || plan.command.length === 0) {
    throw new PlanValidationError("plan.command 必须是非空 argv 数组");
  }
  for (const arg of plan.command) {
    if (typeof arg !== "string" || arg === "") {
      throw new PlanValidationError("plan.command 的每一项都必须是非空字符串");
    }
  }
  const argv0 = plan.command[0]!.split("/").pop()!;
  if (SHELL_INTERPRETERS.has(argv0) && plan.command.some((a) => /^-[a-z]*c$/i.test(a))) {
    throw new PlanValidationError(
      `plan.command 不能是 '${argv0} -c <字符串>'：被审批的命令不该再经过一次 shell 展开（设计 §1.1.3 ①）`,
    );
  }
  if (plan.command.length === 1 && SHELL_METACHAR.test(plan.command[0]!)) {
    throw new PlanValidationError(
      `plan.command 看起来是一整条 shell 字符串（'${plan.command[0]!.slice(0, 40)}'）——请拆成 argv 数组`,
    );
  }

  // ── env：只允许非密钥 ───────────────────────────────────────────────────
  for (const [key, value] of Object.entries(plan.env)) {
    if (!ENV_KEY_SHAPE.test(key)) {
      throw new PlanValidationError(`plan.env 的 key '${key}' 不是合法的环境变量名`);
    }
    if (SECRET_ENV_KEY.test(key)) {
      throw new PlanValidationError(
        `plan.env 的 key '${key}' 看起来是凭据——密钥只能走 secretRefs（符号名），值永远不进 plan`,
      );
    }
    if (typeof value !== "string") {
      throw new PlanValidationError(`plan.env['${key}'] 必须是字符串`);
    }
    if (redactSecrets(value) !== value) {
      throw new PlanValidationError(`plan.env['${key}'] 的值命中凭据模式——密钥只能走 secretRefs`);
    }
  }

  // ── secretRefs ─────────────────────────────────────────────────────────
  for (const ref of plan.secretRefs) {
    if (!SECRET_REF_SHAPE.test(ref)) {
      throw new PlanValidationError(`secretRef '${ref}' 不是合法的符号名`);
    }
  }
  if (plan.secretRefs.length > 0 && !caps.secretRefs) {
    throw new PlanValidationError(`target '${plan.target.kind}' 不支持 secretRefs`);
  }
  if (new Set(plan.secretRefs).size !== plan.secretRefs.length) {
    throw new PlanValidationError("secretRefs 有重复项");
  }

  // ── 资源与网络 ─────────────────────────────────────────────────────────
  if (!caps.network.includes(plan.network)) {
    throw new PlanValidationError(
      `target '${plan.target.kind}' 不支持 network='${plan.network}'（支持：${caps.network.join(" / ")}）`,
    );
  }
  const r = plan.resources;
  if (!Number.isInteger(r.cpus) || r.cpus < 1) throw new PlanValidationError("resources.cpus 必须是 ≥1 的整数");
  if (!(r.memoryGb > 0)) throw new PlanValidationError("resources.memoryGb 必须 > 0");
  if (!Number.isInteger(r.timeoutMinutes) || r.timeoutMinutes < 1 || r.timeoutMinutes > MAX_TIMEOUT_MINUTES) {
    throw new PlanValidationError(`resources.timeoutMinutes 必须是 1..${MAX_TIMEOUT_MINUTES} 的整数`);
  }
  if (r.gpu !== null && !caps.gpus.includes(r.gpu)) {
    throw new PlanValidationError(
      `target '${plan.target.kind}' 不提供 GPU '${r.gpu}'（可选：${caps.gpus.length ? caps.gpus.join(" / ") : "无"}）`,
    );
  }

  // ── uploads ────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of plan.uploads) {
    if (typeof entry.path !== "string" || entry.path === "") {
      throw new PlanValidationError("upload 条目缺 path");
    }
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      throw new PlanValidationError(`upload 路径 '${entry.path}' 必须是工作区内的相对路径`);
    }
    if (seen.has(entry.path)) throw new PlanValidationError(`upload 路径重复：'${entry.path}'`);
    seen.add(entry.path);
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new PlanValidationError(`upload '${entry.path}' 的 size 不合法`);
    }
    if (!HEX64.test(entry.sha256)) {
      throw new PlanValidationError(`upload '${entry.path}' 的 sha256 不是 64 位十六进制`);
    }
    bytes += entry.size;
  }
  if (bytes !== plan.uploadBytes) {
    throw new PlanValidationError(`plan.uploadBytes=${plan.uploadBytes} 与逐条相加 ${bytes} 对不上`);
  }
  if (plan.uploads.length > caps.uploadLimits.count) {
    throw new PlanValidationError(
      `上传文件数 ${plan.uploads.length} 超过上限 ${caps.uploadLimits.count}`,
    );
  }
  if (plan.uploadBytes > caps.uploadLimits.bytes) {
    throw new PlanValidationError(`上传总字节 ${plan.uploadBytes} 超过上限 ${caps.uploadLimits.bytes}`);
  }

  // ── outputs ────────────────────────────────────────────────────────────
  for (const glob of plan.outputs) {
    if (typeof glob !== "string" || glob === "") throw new PlanValidationError("outputs 里有空 glob");
    if (glob.startsWith("/") || glob.split("/").includes("..")) {
      throw new PlanValidationError(`output glob '${glob}' 必须是工作区内的相对路径`);
    }
  }

  // ── L-3：approvalRequired 必须等于派生值 ────────────────────────────────
  const derived = derivedApprovalRequired(plan, caps);
  if (plan.approvalRequired !== derived) {
    throw new PlanValidationError(
      `plan.approvalRequired=${plan.approvalRequired} 与派生值 ${derived} 不符——` +
        `这是派生字段（billable=${caps.billable} / network='${plan.network}' / ` +
        `secretRefs=${plan.secretRefs.length}），调用方不能自己传（L-3）`,
    );
  }

  // ── estimate：PRICING 纪律 ─────────────────────────────────────────────
  const e = plan.estimate;
  if (e.unit !== "computeSeconds") throw new PlanValidationError("estimate.unit 只能是 computeSeconds");
  if (e.quantity !== r.timeoutMinutes * 60) {
    throw new PlanValidationError(`estimate.quantity 必须等于 timeoutMinutes*60=${r.timeoutMinutes * 60}`);
  }
  if (e.unitPriceUsd === 0) {
    throw new PlanValidationError("estimate.unitPriceUsd 不许填 0——查不到就写 null（PRICING 纪律）");
  }
  if (e.unitPriceUsd === null) {
    if (e.upperBoundUsd !== null) {
      throw new PlanValidationError("查不到单价时 upperBoundUsd 必须也是 null");
    }
  } else {
    if (!(e.unitPriceUsd > 0)) throw new PlanValidationError("estimate.unitPriceUsd 必须 > 0 或为 null");
    if (!e.source || !e.verifiedDate) {
      throw new PlanValidationError("有单价就必须带 source（定价页 URL）与 verifiedDate（核实日期）");
    }
    if (e.upperBoundUsd === null) throw new PlanValidationError("有单价却没有 upperBoundUsd");
  }
  if (!plan.warning.trim()) throw new PlanValidationError("plan.warning 不能为空");

  // ── digest 自洽 ────────────────────────────────────────────────────────
  const { digest, ...rest } = plan;
  const recomputed = planDigest(rest);
  if (digest !== recomputed) {
    throw new PlanValidationError(
      `plan.digest 与内容对不上（存档 ${digest.slice(0, 12)}，重算 ${recomputed.slice(0, 12)}）——plan 被改过`,
    );
  }
}
