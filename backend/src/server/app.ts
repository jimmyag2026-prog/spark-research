import { Hono } from "hono";
import { file } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { OrchestratorAgent } from "../agents/orchestrator";
import { KimiScienceDaemon } from "../daemon/daemon";
import { ArtifactStore } from "../artifacts/store";
import { ConnectorRegistry } from "../connectors/registry";
import { LabSafetyGate, LabOrchestrator } from "../lab/orchestrator";
import { ProtocolCompiler, validateProtocol } from "../lab/protocol";
import type { Protocol } from "../lab/protocol";
import {
  OPENTRONS_LIQUID_HANDLER,
  THERMAL_SHAKER,
  PLATE_READER,
  CENTRIFUGE,
} from "../lab/devices";
import type {
  ArtifactListResponse,
  ChatRequest,
  ChatResponse,
  LineageResponse,
} from "./types";

export interface ServerDeps {
  agent?: OrchestratorAgent;
  connectors?: ConnectorRegistry;
  lab?: LabOrchestrator;
  store?: ArtifactStore;
}

const FRONTEND_DIR = join(import.meta.dir, "../../../frontend/workspace");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safeResolve(base: string, rel: string): string {
  const clean = rel.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  const resolved = join(base, clean);
  return resolved.startsWith(base) ? resolved : base;
}

function serveFile(relative: string): Response {
  const path = safeResolve(FRONTEND_DIR, relative);
  if (!existsSync(path)) {
    return new Response("Not Found", { status: 404 });
  }
  const mime = MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(file(path), { headers: { "Content-Type": mime } });
}

function resolveStore(explicit?: ArtifactStore): () => ArtifactStore | undefined {
  let cached: ArtifactStore | undefined = explicit;
  return () => {
    if (cached) return cached;
    try {
      const base = process.env.KIMI_SCIENCE_DATA_DIR ?? join(homedir(), ".kimi-science");
      mkdirSync(base, { recursive: true });
      cached = new ArtifactStore(join(base, "artifacts.db"), join(base, "artifacts"));
    } catch {
      cached = undefined;
    }
    return cached;
  };
}

export function createApp(deps: ServerDeps = {}): Hono {
  const app = new Hono();
  const agent = deps.agent ?? new OrchestratorAgent(new KimiScienceDaemon());
  const connectors = deps.connectors ?? new ConnectorRegistry().registerBuiltins();
  const lab =
    deps.lab ??
    (() => {
      const o = new LabOrchestrator(new LabSafetyGate());
      o.registerDevice(OPENTRONS_LIQUID_HANDLER);
      o.registerDevice(THERMAL_SHAKER);
      o.registerDevice(PLATE_READER);
      o.registerDevice(CENTRIFUGE);
      return o;
    })();
  const compiler = new ProtocolCompiler();
  const safetyGate = new LabSafetyGate();
  const store = resolveStore(deps.store);

  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "kimi-science", version: "0.1.0" }),
  );

  app.get("/", () => serveFile("index.html"));

  app.get("/workspace/*", (c) => serveFile(c.req.path.replace(/^\/workspace\//, "")));

  app.get("/api/connectors", (c) => c.json({ connectors: connectors.listAll() }));

  app.post("/api/chat", async (c) => {
    const req = await c.req.json<ChatRequest>();
    const result = await agent.chat(req);
    return c.json(result satisfies ChatResponse);
  });

  app.get("/api/artifacts/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const artifacts = store()?.listBySession(sessionId) ?? [];
    return c.json({ artifacts } satisfies ArtifactListResponse);
  });

  app.get("/api/lineage/:versionId", (c) => {
    const versionId = c.req.param("versionId");
    const graph =
      store()?.getLineageGraph(versionId) ?? { versionId, nodes: [], edges: [] };
    return c.json({ graph } satisfies LineageResponse);
  });

  app.get("/api/lab/devices", (c) => c.json({ devices: lab.listDevices() }));

  app.post("/api/lab/protocol", async (c) => {
    const body = await c.req.json<{ name?: string; text?: string }>();
    const text = body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return c.json({ error: "missing required field: text" }, 400);
    }
    const protocol = compiler.compile(text, { name: body.name });
    const validation = validateProtocol(protocol);
    const safety = safetyGate.checkProtocol(protocol);
    const compiled: Protocol = { ...protocol, safetyChecks: safety.checks };
    return c.json({
      protocol: compiled,
      valid: validation.valid && safety.passed,
      validation,
      safety,
    });
  });

  return app;
}
