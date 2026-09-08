import { createApp, type ServerDeps } from "./app";

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
