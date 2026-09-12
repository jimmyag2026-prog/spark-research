import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readHidden } from "../../backend/src/cli/hidden_input";

// V115：`spark-research auth` 录 key 不回显。
const DEL = "\u007f";
const CTRL_C = "\u0003";

function fakeStreams(tty: boolean) {
  const input = new EventEmitter() as EventEmitter & { isTTY: boolean; isRaw: boolean; setRawMode: (m: boolean) => void; rawCalls: boolean[] };
  input.isTTY = tty;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (m: boolean) => {
    input.rawCalls.push(m);
    input.isRaw = m;
  };
  const written: string[] = [];
  const output = { write: (s: string) => (written.push(s), true) };
  return { input, output, written };
}

describe("V115 · readHidden", () => {
  test("TTY：切 raw 逐字读、退格生效、回车结束，输出里绝不出现输入内容，结束后 raw 复原", async () => {
    const { input, output, written } = fakeStreams(true);
    const p = readHidden("输入 KEY: ", { input: input as never, output });
    input.emit("data", "sk-ab");
    input.emit("data", DEL);
    input.emit("data", "c\r");
    expect(await p).toBe("sk-ac");
    expect(written.join("")).not.toContain("sk-");
    expect(written.join("")).toBe("输入 KEY: \n");
    expect(input.rawCalls).toEqual([true, false]);
  });

  test("非 TTY（管道）：不碰 raw mode，按行读", async () => {
    const { input, output } = fakeStreams(false);
    const p = readHidden("> ", { input: input as never, output });
    input.emit("data", Buffer.from("piped-key\n"));
    expect(await p).toBe("piped-key");
    expect(input.rawCalls).toEqual([]);
  });

  test("Ctrl+C → 复原 raw 并走 onInterrupt，不 resolve 半截输入", async () => {
    const { input, output } = fakeStreams(true);
    let interrupted = false;
    let resolved = false;
    void readHidden("> ", { input: input as never, output, onInterrupt: () => (interrupted = true) }).then(() => (resolved = true));
    input.emit("data", "ab" + CTRL_C);
    await new Promise((r) => setTimeout(r, 5));
    expect(interrupted).toBe(true);
    expect(resolved).toBe(false);
    expect(input.rawCalls).toEqual([true, false]);
  });
});
