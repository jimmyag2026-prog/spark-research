// G-2（v0.6）：前端 dist → 内嵌清单的生成/还原。
//
// 用法：
//   bun scripts/gen-frontend-embed.ts --embed    构建前：把 frontend/workspace/dist
//                                                写成 backend/src/assets/frontend_dist.generated.ts
//   bun scripts/gen-frontend-embed.ts --restore  构建后：还原为入库的 null 存根
//
// 规则：
// - dist 缺 index.html → 硬失败（宁可编不出二进制，也不产出一个没有 UI 的「成品」
//   ——V27 家族的教训是静默缺资产比报错糟得多）
// - *.map 不嵌（358K 的 sourcemap 对产物用户没用，白胖二进制）
// - 生成文件与存根都以本脚本为唯一写入者；两种内容都带「勿手改」头

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "frontend/workspace/dist");
const TARGET = join(ROOT, "backend/src/assets/frontend_dist.generated.ts");

const STUB = `// 由 scripts/gen-frontend-embed.ts 生成/还原——**勿手改**。
//
// 入库版本恒为 null 存根（构建产物不入 git，AD-7 前端纪律）。
// \`bun run build\` 的流程是：build:web → 本文件被写成真实资产清单 → bun 编译
// （清单内容随之进二进制）→ 本文件还原回此存根。所以：
//   · 源码模式：FRONTEND_DIST === null，server 从 frontend/workspace/dist 目录托管
//   · 单二进制：FRONTEND_DIST 是完整的 dist 文件树，运行期经 materializeAssetTree
//     解包到磁盘后托管——源码/二进制走同一条托管代码路径（V28 教训：不搞模式分叉）
import type { AssetTree } from "./embedded";

export const FRONTEND_DIST: AssetTree | null = null;
`;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const mode = process.argv[2];
if (mode === "--restore") {
  writeFileSync(TARGET, STUB, "utf8");
  console.log(`✅ 已还原存根: ${relative(ROOT, TARGET)}`);
} else if (mode === "--embed") {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error(`❌ ${relative(ROOT, DIST)}/index.html 不存在——先跑 bun run build:web。`);
    console.error("   拒绝生成空清单：没有 UI 的二进制不该被静默编出来。");
    process.exit(1);
  }
  const files = walk(DIST).filter((f) => !f.endsWith(".map"));
  const tree: Record<string, string> = {};
  for (const file of files) {
    tree[relative(DIST, file).split("\\").join("/")] = readFileSync(file, "utf8");
  }
  const body =
    `// 由 scripts/gen-frontend-embed.ts --embed 生成——**构建期临时文件，勿手改勿提交**。\n` +
    `// 构建结束会被 --restore 还原为 null 存根；如果你在 git diff 里看到本文件非存根，\n` +
    `// 说明某次构建中断了还原，跑一次 bun scripts/gen-frontend-embed.ts --restore。\n` +
    `import type { AssetTree } from "./embedded";\n\n` +
    `export const FRONTEND_DIST: AssetTree | null = ${JSON.stringify(tree)};\n`;
  writeFileSync(TARGET, body, "utf8");
  const kb = Math.round(body.length / 1024);
  console.log(`✅ 已生成内嵌清单: ${files.length} 个文件, ${kb}KB → ${relative(ROOT, TARGET)}`);
} else {
  console.error("用法: bun scripts/gen-frontend-embed.ts --embed | --restore");
  process.exit(1);
}
