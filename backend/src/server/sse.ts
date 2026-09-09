// 极简 SSE 工具（P7）。不引第三方依赖：一个 ReadableStream + text/event-stream 就够。
//
// 口径：每个事件都带 `event:` 名与 JSON `data:`，客户端用 `addEventListener` 分流；
// 心跳走注释行（`: ping`），既保活又不会被当成事件。

export interface SseSender {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

export interface SseOptions {
  // 心跳间隔；0 = 不发心跳（测试里用 0，避免定时器拖住进程）。
  heartbeatMs?: number;
  signal?: AbortSignal;
}

export function sseResponse(
  setup: (sender: SseSender) => void | (() => void),
  options: SseOptions = {},
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | void;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const sender: SseSender = {
        get closed() {
          return closed;
        },
        send(event, data) {
          write(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
        },
        comment(text) {
          write(`: ${text}\n\n`);
        },
        close() {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (typeof cleanup === "function") cleanup();
          try {
            controller.close();
          } catch {
            // 已被对端关闭。
          }
        },
      };

      const interval = options.heartbeatMs ?? 0;
      if (interval > 0) {
        heartbeat = setInterval(() => {
          if (closed) return;
          sender.comment("ping");
        }, interval);
      }
      options.signal?.addEventListener("abort", () => sender.close());
      cleanup = setup(sender);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (typeof cleanup === "function") cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 反向代理（如果有人放一层）不缓冲。
      "X-Accel-Buffering": "no",
    },
  });
}
