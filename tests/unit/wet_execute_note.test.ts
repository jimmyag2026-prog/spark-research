import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import { ProjectManager, type Project } from "../../backend/src/project/manager";

// V144 · `WetLabLoop.execute(options)` 声明了 `note?: string` 但函数体从未读它
// （闸门 I-3 盘点抓到）。修法：note 落进 execute 产生的 collect 态 meta（`executionNote`），
// analyze() 在没有自己的 note 时回落读取它——最终这条 note 必须出现在 observation 正文/metadata 里。
//
// 本文件只测这一条新增管线；状态机/approve gate 的全量回归在 wet_loop.test.ts。

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";

function newWorkspace(): { project: Project } {
  const root = mkdtempSync(join(tmpdir(), "wet-note-test-"));
  const manager = new ProjectManager(root);
  const project = manager.create("p6");
  return { project };
}

function loopFor(project: Project): WetLabLoop {
  return new WetLabLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    root: join(project.paths.experimentsDir, "wet"),
    backend: new MockDeviceBackend(),
  });
}

async function upToExecuted(loop: WetLabLoop, note?: string) {
  const view = loop.design({ title: "OD 测定", naturalLanguage: PROTOCOL_A });
  loop.compile(view.id);
  const waiting = loop.safetyCheck(view.id).view;
  loop.approve(waiting.id, { actor: "张三" });
  return loop.execute(waiting.id, note !== undefined ? { note } : {});
}

describe("V144 · execute(options.note) 落进 observation", () => {
  test("execute 给了 note，analyze 不给自己的 note → observation 正文/metadata 都带上 execute 的 note", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const collected = await upToExecuted(loop, "本轮用了新批次试剂");
    expect(collected.executionNote).toBe("本轮用了新批次试剂");

    const analyzed = loop.analyze(collected.id);
    const observation = project.records().get(analyzed.observationId!)!;
    expect(observation.content).toContain("本轮用了新批次试剂");
    expect((observation.metadata as { note: string | null }).note).toBe("本轮用了新批次试剂");
    project.close();
  });

  test("analyze 自己也给了 note → analyze 的 note 优先，execute 的 note 不覆盖它", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const collected = await upToExecuted(loop, "execute 备注");
    const analyzed = loop.analyze(collected.id, { note: "analyze 备注" });
    const observation = project.records().get(analyzed.observationId!)!;
    expect(observation.content).toContain("analyze 备注");
    expect(observation.content).not.toContain("execute 备注");
    project.close();
  });

  test("execute 不给 note → executionNote 为 null，observation 不带 note 段落", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const collected = await upToExecuted(loop);
    expect(collected.executionNote).toBeNull();
    const analyzed = loop.analyze(collected.id);
    const observation = project.records().get(analyzed.observationId!)!;
    expect((observation.metadata as { note: string | null }).note).toBeNull();
    project.close();
  });
});
