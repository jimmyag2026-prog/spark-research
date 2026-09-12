import { createHash, timingSafeEqual } from "node:crypto";
// 审批动作的**交互终端门**（V19；W5-2 β 从 `lab/cli.ts:150-251` 原样搬出并参数化）。
//
// ── 为什么这层存在（原文保留，来源 lab/cli.ts 的 V19 大注释）─────────────────
//
// AD-9 裁定的推论：`sub_agent.ts` 已经把 `lab_approve`/`lab_simulate` 塞进
// MCP_WITHHELD（子代理走 MCP 工具面拿不到这两个动作），但那只挡住了「默认路径」——
// AD-9 明确指出这不是技术上的绕道：任何能跑 Bash 的 agent（比如写这行字的这条 lane
// 自己）都能直接 `spark-research lab approve <id> --actor "随便编的名字"`，CLI 从不区分
// 「真人在敲键盘」与「脚本在拼参数」。V10 记录的是同一个缺口的另一半：approve 的
// actor 是「谁自称就是谁」——单用户本地场景下诚实，但要让审批审计真的成立，必须先
// 有这条技术防线，不能只喊"不要自动化审批"。
//
// 判据：`process.stdin.isTTY && process.stdout.isTTY`——Node/Bun 对「这个文件描述符
// 连着真终端」的标准探测。管道（`echo yes | lab approve ...`）、重定向、子进程、
// Bash 工具调用全都是 false：piping 一个答案进 stdin 不会让 isTTY 变 true，所以
// 「伪造一次交互」本身就先过不了这一步判定，不需要额外去防「stdin 被脚本控制」这件事。
//
// 两条分支都不静默放行（AD-2/AD-9 同一套纪律：默认拒绝，旁路必须显式且留痕）：
//   ① 交互终端：必须真的在这次调用里读到一行确认——默认从真实 stdin/stdout 读
//      （node:readline），测试注入 `deps.approvalConfirm`。没有 TTY 就没有这条路可走。
//   ② 非交互环境：**默认拒绝**。需要同时满足三样都是显式给出的：
//      - `--ci-bypass-token` 等于环境变量 `<spec.envVar>`
//        （必须由运维/CI 流水线的所有者显式配置——不在这里帮它兜底出任何默认值）；
//      - `--ci-bypass-reason "<理由>"`（人工写清楚为什么这次批准可以不经真人终端）；
//      这不是一条牢不可破的安全边界（拿到 shell 就能读 env），但满足「显式、留痕」的
//      最低要求：没给全就硬失败，不是静默通过；给全了，旁路的事实与理由会被拼进
//      `note`，随 decision record 一起落盘——**在此之前不要声称审批"无法被自动化"**，
//      这条旁路本身就是技术上仍然可以被自动化的部分，只是不再是默认路径，且每一次
//      都可追溯。
//
// ── W5-2 β 搬出来的理由 ────────────────────────────────────────────────────
//
// 算力审批（`spark-research compute approve`）花的是真钱，与湿实验「动物理世界」同构，
// 必须受同一道门约束。**复制一份**是最坏的做法：两份实现会各自漂移，而漂移的方向
// 永远是「新的那份更松」。所以这里把 lab 的实现**原样**搬出来，只把三处随场景变化的
// 字符串（tag / 旁路 env 名 / 被审批对象的称呼）参数化；lab 与 compute 共用同一份代码。
//
// 参数化不许把判据也变成参数：`isTTY` 的判据、两条分支的结构、四种拒绝理由、
// bypassNote 的形状，对所有场景**完全一致**。能变的只有文案里的名词。

export class ApprovalGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalGateError";
  }
}

/**
 * 一个审批场景的文案参数。**只有名词能变**——判据与分支结构对所有场景一致。
 */
export interface ApprovalGateSpec {
  /** 消息前缀标签，用于让用户一眼看出是哪条纪律拦的（如 "V19"）。 */
  tag: string;
  /** 非交互旁路 token 的环境变量名。每个场景一把，不共用。 */
  envVar: string;
  /** 被审批对象的称呼（"实验" / "算力任务"）。 */
  subject: string;
  /** 交互确认提示里那句「为什么必须是人」。 */
  rationale: string;
}

/** 湿实验（AD-6）：`spark-research lab approve/reject`。 */
export const LAB_APPROVAL_GATE: ApprovalGateSpec = {
  tag: "V19",
  envVar: "SPARK_LAB_CI_BYPASS_TOKEN",
  subject: "实验",
  rationale: "这是 AD-6 要求的人工判断",
};

/**
 * 远端算力（CB-5）：`spark-research compute approve/reject`。
 *
 * 旁路 env 名**刻意与 lab 不同**（设计 §1.1.4 最后一行）：配了 CI 能批湿实验的流水线，
 * 不该顺带获得「花钱跑 GPU」的权限。两把钥匙、两扇门。
 */
export const COMPUTE_APPROVAL_GATE: ApprovalGateSpec = {
  tag: "V19",
  envVar: "SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN",
  subject: "算力任务",
  rationale: "这是 AD-6 同构的人工判断（派发即计费）",
};

export interface ApprovalGateDeps {
  /**
   * 交互终端探测。省略时用真实探测 `process.stdin.isTTY && process.stdout.isTTY`——
   * 测试注入以模拟「真人在一个真实终端里」（Claude Code 的 Bash 工具跑子进程，
   * stdin/stdout 天然不是 tty，落进非交互分支，不需要特意伪装）。
   */
  approvalIsInteractiveTty?: () => boolean;
  /**
   * 交互终端下的确认读取。省略时用 node:readline 从真实 stdin/stdout 读一行。
   * 测试注入一个假实现，返回 Promise<string | null>（null = 没读到任何输入）。
   */
  approvalConfirm?: (prompt: string) => Promise<string | null>;
}

export interface ApprovalGateResult {
  /** 非 null = 走了 CI 旁路，必须并入 decision record 的 note（留痕，见上面的大段注释）。 */
  bypassNote: string | null;
}

export function defaultIsInteractiveTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function defaultApprovalConfirm(prompt: string): Promise<string | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 常量时间比较：先各自 sha256（定长），再 timingSafeEqual——不因长度差异或前缀匹配长度而泄漏时序。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function requireApprovalGate(
  spec: ApprovalGateSpec,
  ref: string,
  action: "approve" | "reject",
  deps: ApprovalGateDeps,
  flags: Record<string, string | true>,
  env: Record<string, string | undefined> = process.env,
): Promise<ApprovalGateResult> {
  const isTty = deps.approvalIsInteractiveTty ? deps.approvalIsInteractiveTty() : defaultIsInteractiveTty();
  const verb = action === "approve" ? "批准" : "拒绝";

  if (isTty) {
    const confirm = deps.approvalConfirm ?? defaultApprovalConfirm;
    const answer = await confirm(
      `[${spec.tag}] 即将${verb}${spec.subject} ${ref}——${spec.rationale}，输入 'yes' 确认：`,
    );
    if ((answer ?? "").trim().toLowerCase() !== "yes") {
      throw new ApprovalGateError(
        `[${spec.tag}] 终端交互没有收到 'yes'（收到 ${JSON.stringify(answer)}）——${verb}已取消。` +
          `批准/拒绝必须来自一次真实的交互确认，不接受静默通过。`,
      );
    }
    return { bypassNote: null };
  }

  // V116（v0.8）：① 比较用常量时间（sha256 后 timingSafeEqual，长度不同也不提前返回）；
  // ② token 可以不走 argv——`--ci-bypass-token-env <VAR>` 从环境变量取值（argv 会进 ps/shell 历史）。
  const tokenEnvName = flagString(flags["ci-bypass-token-env"]);
  const token = tokenEnvName ? env[tokenEnvName] : flagString(flags["ci-bypass-token"]);
  const reason = flagString(flags["ci-bypass-reason"]);
  const expected = env[spec.envVar];

  if (!expected) {
    throw new ApprovalGateError(
      `[${spec.tag}] 当前不是交互终端（process.stdin/stdout 不是 TTY），且未配置环境变量 ` +
        `${spec.envVar}——拒绝${verb}。这是 AD-9 的技术防线：非交互环境` +
        `（脚本/CI/Bash 工具子进程）默认拿不到审批权限，不存在"跑一条命令就能${verb}"的路子。` +
        `真人请在一个真实终端里重跑本命令；CI/自动化场景需要运维显式配置 ` +
        `${spec.envVar}，并在命令行显式传 --ci-bypass-token 与 --ci-bypass-reason。`,
    );
  }
  if (!token || !constantTimeEqual(token, expected)) {
    throw new ApprovalGateError(
      `[${spec.tag}] 非交互终端下${verb}需要 --ci-bypass-token 的值与环境变量 ${spec.envVar} ` +
        `一致——${token ? "两者不匹配。" : "缺少 --ci-bypass-token。"}`,
    );
  }
  if (!reason) {
    throw new ApprovalGateError(
      `[${spec.tag}] 非交互终端的旁路必须显式说明理由：加 --ci-bypass-reason "<为什么这次可以不经真人终端>"` +
        `——旁路要留痕进 decision record，不是静默放行。`,
    );
  }
  return {
    bypassNote: `[${spec.tag} CI 旁路：非交互终端，${spec.envVar} 校验通过] ${reason}`,
  };
}

/** 用户备注 + 旁路留痕拼成同一段 note；两者都空时返回 undefined（不写空字符串）。 */
export function mergeApprovalNote(userNote: string | undefined, bypassNote: string | null): string | undefined {
  const parts = [userNote, bypassNote ?? undefined].filter((p): p is string => Boolean(p && p.length > 0));
  return parts.length > 0 ? parts.join(" ") : undefined;
}
