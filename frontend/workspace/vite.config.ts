import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const here = dirname(fileURLToPath(import.meta.url));

// U2（W9-ε）：工作台顶栏要能说出「你连的这个 server 是哪个版本」。判断的另一半是
// **构建这份 UI 时的版本**，所以在构建期把它钉进产物。真源仍是仓库根 package.json
// （与 backend/src/version.ts 同一份），这里只是把它搬进浏览器——前端读不到文件系统。
const UI_VERSION: string = JSON.parse(
  readFileSync(resolve(here, "../../package.json"), "utf8"),
).version;

// 工作台前端（P7）。依赖精简到 SolidJS + Vite：
// 图表、Markdown、证据图都是自己写的轻量实现，没有第三方 UI/图表库。
// 构建产物落 frontend/workspace/dist，由 Hono server 静态托管
//（`spark-research server` 单命令启动的口径）。
export default defineConfig({
  root: here,
  plugins: [solid()],
  define: { __SPARK_UI_VERSION__: JSON.stringify(UI_VERSION) },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    target: "esnext",
    // 本地工具，不需要为老浏览器降级；sourcemap 便于用户自查。
    sourcemap: true,
  },
  server: {
    port: 5173,
    // 开发时把 /api 代到后端，前端热更新与 API 分离。
    proxy: { "/api": "http://127.0.0.1:4321" },
  },
});
