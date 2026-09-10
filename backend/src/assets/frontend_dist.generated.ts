// 由 scripts/gen-frontend-embed.ts 生成/还原——**勿手改**。
//
// 入库版本恒为 null 存根（构建产物不入 git，AD-7 前端纪律）。
// `bun run build` 的流程是：build:web → 本文件被写成真实资产清单 → bun 编译
// （清单内容随之进二进制）→ 本文件还原回此存根。所以：
//   · 源码模式：FRONTEND_DIST === null，server 从 frontend/workspace/dist 目录托管
//   · 单二进制：FRONTEND_DIST 是完整的 dist 文件树，运行期经 materializeAssetTree
//     解包到磁盘后托管——源码/二进制走同一条托管代码路径（V28 教训：不搞模式分叉）
import type { AssetTree } from "./embedded";

export const FRONTEND_DIST: AssetTree | null = null;
