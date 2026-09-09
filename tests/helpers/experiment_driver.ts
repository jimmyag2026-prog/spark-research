#!/usr/bin/env bun
// P5 kill 恢复 e2e 的**被杀进程**（不是测试文件，bun test 不会收它）。
//
// 它扮演「编排进程」：建实验 → 提交仿真 → 把 id 打到 stdout → 然后一直挂着，
// 等着被 e2e 用 SIGKILL 干掉。SIGKILL 跑不了任何清理逻辑，所以这是真实的
// 「进程突然没了」——仿真子进程会被 init 收养并继续跑，正是要覆盖的那条恢复路径。
//
// 用法：bun tests/helpers/experiment_driver.ts <workspaceRoot> <slug> <stallSeconds> <title>

import { ProjectManager } from "../../backend/src/project/manager";
import { ExperimentLoop } from "../../backend/src/experiment/loop";
import { SimulationRegistry } from "../../backend/src/simulation/registry";
import { RunStore } from "../../backend/src/simulation/run_store";
import { join } from "node:path";

const [root, slug, stallRaw, titleRaw] = process.argv.slice(2);
if (!root || !slug) {
  console.error("用法: bun experiment_driver.ts <root> <slug> <stallSeconds> [title]");
  process.exit(2);
}

const manager = new ProjectManager(root);
const project = manager.openOrCreate(slug, { name: slug });
const loop = new ExperimentLoop({
  records: project.records(),
  artifacts: project.artifacts(),
  platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
});

const designed = await loop.design({
  title: titleRaw ?? "kill 恢复 e2e",
  platform: "pyref",
  kind: "damped-oscillator",
  params: { steps: 400, sampleInterval: 20, stallSeconds: Number(stallRaw ?? 6) },
  hypothesis: "编排进程被 SIGKILL 之后，仿真任务不受影响，重启能接回来",
});
const started = await loop.dryRun(designed.id);
const runStore = new RunStore(join(project.paths.experimentsDir, "pyref", "runs"));
const simPid = runStore.read(started.runId!)?.pid ?? null;

// 一行 JSON，e2e 读到它就知道可以下手了。
console.log(JSON.stringify({ experimentId: started.id, runId: started.runId, simPid }));

// 故意不退出：等着挨刀。
await new Promise(() => {});
