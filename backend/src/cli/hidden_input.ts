// V115（v0.8）：凭据录入不回显。`spark-research auth` 之前用 readline.question 读 API key，
// 终端会把 key 原样回显到屏幕（并进 scrollback / 录屏 / 共享终端）。这里在 TTY 下切 raw mode
// 逐字读、不回显（退格可用，Ctrl+C 退出）；非 TTY（管道）本来就不回显，按行读即可。
import type { ReadStream, WriteStream } from "node:tty";

export interface HiddenInputStreams {
  input: Pick<ReadStream, "on" | "off" | "isTTY"> & {
    setRawMode?: (mode: boolean) => unknown;
    isRaw?: boolean;
    resume?: () => unknown;
  };
  output: Pick<WriteStream, "write">;
  /** Ctrl+C 的出口（默认 process.exit(130)）；测试注入。 */
  onInterrupt?: () => void;
}

const CTRL_C = "\u0003";
const DEL = "\u007f";

export function readHidden(prompt: string, streams: HiddenInputStreams): Promise<string> {
  const { input, output } = streams;
  return new Promise((resolve) => {
    output.write(prompt);
    const isTty = Boolean(input.isTTY) && typeof input.setRawMode === "function";
    const wasRaw = Boolean(input.isRaw);
    if (isTty) input.setRawMode!(true);
    input.resume?.();
    let buf = "";
    const restore = () => {
      input.off("data", onData);
      if (isTty) input.setRawMode!(wasRaw);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\n" || ch === "\r") {
          restore();
          output.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === CTRL_C) {
          restore();
          output.write("\n");
          (streams.onInterrupt ?? (() => process.exit(130)))();
          return;
        }
        if (ch === DEL || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    input.on("data", onData);
  });
}
