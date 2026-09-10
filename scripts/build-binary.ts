// G-2（v0.6）：单二进制构建编排。
//
// 顺序：build:web → 前端清单 --embed → bun 编译 → **finally --restore**。
// restore 放 finally：编译失败也不能把生成的清单留在工作区（它 8 万行、非入库内容，
// 留下会污染 git status 与下一次 tsc）。
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function run(label: string, cmd: string[]): void {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`❌ ${label} 失败（exit=${res.status}）`);
    process.exit(res.status ?? 1);
  }
}

run("build:web", ["bun", "run", "build:web"]);
run("embed", ["bun", "scripts/gen-frontend-embed.ts", "--embed"]);
try {
  run("compile", [
    "bun",
    "build",
    "backend/src/index.ts",
    "--compile",
    "--outfile",
    "dist/spark-research",
  ]);
} finally {
  const restore = spawnSync("bun", ["scripts/gen-frontend-embed.ts", "--restore"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (restore.status !== 0) {
    console.error("❌ 存根还原失败——手动跑: bun scripts/gen-frontend-embed.ts --restore");
    process.exitCode = 1;
  }
}
console.log("✅ dist/spark-research 构建完成（前端已内嵌）");
