import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const here = dirname(fileURLToPath(import.meta.url));

// 工作台前端（P7）。依赖精简到 SolidJS + Vite：
// 图表、Markdown、证据图都是自己写的轻量实现，没有第三方 UI/图表库。
// 构建产物落 frontend/workspace/dist，由 Hono server 静态托管
//（`spark-research server` 单命令启动的口径）。
export default defineConfig({
  root: here,
  plugins: [solid()],
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
