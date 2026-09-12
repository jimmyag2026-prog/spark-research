import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRawSink } from "../../backend/src/raw";

// V121（R5 P1-4 真因）：connector 原始响应体是整段 inline 的，一行可以超过 64KB。
// 旧 readTail 固定 64KB 窗口且不区分「完整行/残行」——窗口整个落在那一行内部时返回残行，
// JSON.parse 抛错被 catch 吞成 `last = null`，下一条就写出 `prevHash: null`，链在这里断开。
// 实测 R5 四个项目的全部 4 处断链，前一行都是 68–70KB，无一例外。
// 阴性对照（已验红）：把 readTail 改回「无换行也返回残行」+ readLastHash 解析失败吞成 null → 第一条红。

function sinkAt() {
  const root = mkdtempSync(join(tmpdir(), "v121-"));
  return { root, sink: new JsonlRawSink(root, { project: "p" }) };
}

const connectorPayload = (connector: string, bodyText: string) => ({
  connector,
  request: { url: "https://example.test/search" },
  response: { status: 200, body: bodyText },
});

describe("V121 · raw 链对超大单行（>64KB）保持完整", () => {
  test("一行 70KB 的 connector 响应之后继续 append → prevHash 接得上，verify 全绿", () => {
    const { sink } = sinkAt();
    const first = sink.append({ kind: "connector", provenanceClass: "upstream", payload: connectorPayload("pubmed", "x") });
    const huge = sink.append({
      kind: "connector",
      provenanceClass: "upstream",
      payload: connectorPayload("pubmed", "y".repeat(70 * 1024)),
    });
    const third = sink.append({ kind: "connector", provenanceClass: "upstream", payload: connectorPayload("pubmed", "z") });

    expect(huge.prevHash).toBe(first.hash);
    // 这一条就是旧实现写成 null 的那条。
    expect(third.prevHash).toBe(huge.hash);
    const v = sink.verify("connector");
    expect(v.ok).toBe(true);
    expect(v.lines).toBe(3);
  });

  test("连续多条超大行（每条都 >64KB）链仍完整", () => {
    const { sink } = sinkAt();
    let prev: string | null = null;
    for (let i = 0; i < 4; i++) {
      const e = sink.append({
        kind: "connector",
        provenanceClass: "upstream",
        payload: connectorPayload("crossref", `${i}`.repeat(66 * 1024)),
      });
      expect(e.prevHash).toBe(prev);
      prev = e.hash;
    }
    expect(sink.verify("connector").ok).toBe(true);
  });

  test("最后一行损坏（被手工改坏）→ 拒绝在其后追加并说明理由，不伪造链头", () => {
    const { root, sink } = sinkAt();
    sink.append({ kind: "connector", provenanceClass: "upstream", payload: connectorPayload("pubmed", "a") });
    const file = readFileSync;
    void file;
    // 找到刚写的文件并把最后一行改坏
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const day = new Date().toISOString().slice(0, 10);
    const target = join(root, "connector", "pubmed", `${day}.jsonl`);
    writeFileSync(target, "{ this is not json\n", "utf8");
    expect(() =>
      sink.append({ kind: "connector", provenanceClass: "upstream", payload: connectorPayload("pubmed", "b") }),
    ).toThrow(/无法解析/);
  });
});
