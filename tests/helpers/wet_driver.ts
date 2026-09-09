#!/usr/bin/env bun
// P10-d · D-10 崩溃恢复 e2e 的**被杀进程**（不是测试文件，bun test 不会收它）。
//
// 扮演编排进程：design → compile → safety_check → approve，然后发起 execute()。
// execute() 内部会先做一次同步的 CAS 写（approved → executing），把 approval
// **一次性消费**掉——这一步落盘之后（也只有落盘之后）才会真的进入"调用后端执行"阶段。
// 所以握手 JSON 打印出来的时候，approved → executing 这次转移已经在磁盘上了，
// 哪怕这个进程紧接着被 SIGKILL，DB 里也已经是「正在执行、approval 已消费」的状态——
// 这正是要覆盖的崩溃现场：编排进程死了，执行声明留在半路，approval 回不来了。
//
// 用的后端故意永不 resolve：不需要真的等它跑完，只需要「真的被同步声明为 executing」
// 这一刻发生过，然后立刻死给你看。
//
// 用法：bun tests/helpers/wet_driver.ts <workspaceRoot> <slug>

import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import type { OpentronsProgram } from "../../backend/src/lab/opentrons_protocol";
import type { WetExecuteOptions, WetLabBackend, WetRunResult } from "../../backend/src/lab/wet_backend";

class HangingBackend implements WetLabBackend {
  readonly id = "mock_devices";
  readonly description = "driver 专用：execute() 永不返回，模拟真机执行中途整个编排进程消失";
  async available() {
    return { ok: true, reason: null, detail: {} };
  }
  execute(_program: OpentronsProgram, _options: WetExecuteOptions): Promise<WetRunResult> {
    return new Promise(() => {});
  }
}

const [root, slug] = process.argv.slice(2);
if (!root || !slug) {
  console.error("用法: bun wet_driver.ts <root> <slug>");
  process.exit(2);
}

const manager = new ProjectManager(root);
const project = manager.openOrCreate(slug, { name: slug });
const loop = new WetLabLoop({
  records: project.records(),
  artifacts: project.artifacts(),
  root: join(project.paths.experimentsDir, "wet"),
  backend: new HangingBackend(),
});

const designed = loop.design({
  title: "崩溃恢复 e2e",
  naturalLanguage: "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD",
});
loop.compile(designed.id);
loop.safetyCheck(designed.id);
const { view: approved, decisionId } = loop.approve(designed.id, { actor: "driver" });

// 故意不 await：execute() 的同步部分（状态检查 + hash 复核 + CAS 声明执行权）
// 跑完这一行语句就已经落盘——JS 单线程下，这个调用表达式求值完毕之前，
// 它内部的同步代码必然已经全部跑完（异步函数只在第一个 await 处才让出控制权）。
void loop.execute(approved.id).catch(() => {});

console.log(JSON.stringify({ experimentId: approved.id, decisionId }));

// 故意不退出：等着挨刀。
await new Promise(() => {});
