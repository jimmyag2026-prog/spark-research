import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

// 每次跑 e2e 用一个全新的工作区目录：测试之间零残留，也绝不碰 ~/.spark-research。
const WORKSPACE = process.env.SPARK_E2E_ROOT ?? mkdtempSync(join(tmpdir(), "spark-e2e-"));
const PORT = Number(process.env.SPARK_E2E_PORT ?? 4399);

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  // 全流程 e2e 有先后依赖（建项目 → 入库 → 精读 → 共探 → 干实验 → 湿实验），
  // 所以串行跑，不并行、不重试——重试会掩盖真实的时序问题。
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "zh-CN",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // 服务端跑的是生产 app，只是外部依赖换成 fixture/fake（见 fixture_server.ts）。
    // 前端必须先构建（构建产物不入 git），所以这里连着构建一起做。
    command: `bun run build:web && bun ${join(here, "fixture_server.ts")} ${PORT} ${WORKSPACE}`,
    cwd: repo,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
