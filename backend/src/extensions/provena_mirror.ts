/**
 * 把子代理的每次工具调用自动记进 Provena 账本（`provena mcp` 以 mcp_client 扩展装上时）。
 *
 * 为什么要这个：接入后真实运行显示，「要不要调 record_step」仍然是模型自己的选择——
 * 有的轮次它就是不记。证据层不能依赖模型记得记账：ToolBus 已经对每次调用落一条审计，
 * 这里把同一条审计镜像成 Provena 的一个 step（工具名、参数摘要、成败），签名、加密、
 * 可证明。Provena 自己的工具（mcp:provena:*）不再镜像，避免自我递归。
 *
 * 只认名为 `provena` 的扩展；没装就是空操作（与接线前逐字节同行为）。
 */
import type { ExternalMcpAttachment } from "./mcp_client";
import type { ToolAuditEntry } from "../agents/toolbus";

export const PROVENA_EXTENSION = "provena";

export class ProvenaMirror {
  private readonly pending = new Set<Promise<unknown>>();
  private recorded = 0;
  private failed = 0;

  constructor(private readonly external: ExternalMcpAttachment | undefined) {}

  get active(): boolean {
    return Boolean(this.external?.registry?.get(PROVENA_EXTENSION));
  }

  /** ToolBus 审计回调：同步返回，记账异步进行（收尾时 flush）。 */
  readonly sink = (entry: ToolAuditEntry): void => {
    if (!this.active || entry.tool.startsWith(`mcp:${PROVENA_EXTENSION}:`) || entry.denied) return;
    const args: Record<string, unknown> = {
      tool: entry.tool,
      args: { summary: entry.argsSummary, durationMs: entry.durationMs },
      exit_code: entry.ok ? 0 : 1,
    };
    if (!entry.ok) args.error = "tool call failed (Spark ToolBus audit)";
    this.send(args);
  };

  /**
   * 编排层的一个任务执行完（skill / connector / code / analysis / subagent）：同样记一步。
   * 文献检索这类走 skill 执行器的任务不经过子代理的 ToolBus，只靠 sink 会漏记。
   * 输出截断后进 Provena 的密封 trace（不进公开 body）。
   */
  recordTask(task: { id: string; kind: string; description: string; params?: Record<string, unknown> },
    outcome: { ok: boolean; output?: string }): void {
    if (!this.active) return;
    const name = String(task.params?.skill ?? task.params?.tool ?? task.kind);
    this.send({
      tool: `spark:${task.kind}:${name}`,
      args: { task: task.id, description: task.description.slice(0, 500) },
      result: { output: (outcome.output ?? "").slice(0, 4000) },
      exit_code: outcome.ok ? 0 : 1,
      ...(outcome.ok ? {} : { error: (outcome.output ?? "task failed").slice(0, 500) }),
    });
  }

  private send(args: Record<string, unknown>): void {
    const call = this.external!.registry!.call(`mcp:${PROVENA_EXTENSION}:record_step`, args)
      .then((outcome: { ok: boolean }) => {
        if (outcome.ok) this.recorded++;
        else this.failed++;
      })
      .catch(() => { this.failed++; })
      .finally(() => this.pending.delete(call));
    this.pending.add(call);
  }

  /** 等所有镜像调用落完（在外部子进程关闭之前调用）。 */
  async flush(): Promise<{ recorded: number; failed: number }> {
    await Promise.allSettled([...this.pending]);
    return { recorded: this.recorded, failed: this.failed };
  }
}
