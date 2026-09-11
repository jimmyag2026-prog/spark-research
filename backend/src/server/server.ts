import { createApp, type ServerDeps } from "./app";

// Bun 允许的最大 idleTimeout（秒）。导出供测试断言——这个值退回默认 10 秒时，
// UI 的 Idea 生成会静默变成永久挂起（A5 实测），必须有测试钉住。
export const SERVER_IDLE_TIMEOUT_S = 255;

export interface StartedServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop(): Promise<void>;
}

export function startServer(port = 4321, deps: ServerDeps = {}): StartedServer {
  const app = createApp(deps);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: app.fetch,
    // A5 blocker①：Bun.serve 默认 10 秒请求超时——co-explore/精读这类同步 LLM 路由
    // 一超时连接就被掐，前端永久挂起而后端其实算完了。255 是 Bun 的上限；
    // 更长的活本就该走任务路由（tasks 面板可查），这里只兜住单轮 LLM 调用。
    idleTimeout: SERVER_IDLE_TIMEOUT_S,
  });
  const actualPort = server.port ?? 0;
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`Spark Research server listening at ${url}`);
  console.log("Press Ctrl+C to stop");
  return {
    server,
    port: actualPort,
    stop: () => server.stop(true),
  };
}
