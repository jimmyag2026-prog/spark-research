import { buildCapabilities, type CapabilityManifest, type CapabilityOptions } from "./index";

export const CAPABILITIES_HELP = `用法:
  spark-research capabilities [--json] [--probe]

  --json    输出机器可读清单（给 agent：schema + 可用性状态，一次调用 introspect 整个工作台）
  --probe   真去探测本地仿真平台与湿实验后端装没装（慢几秒，但结果是真的）

不带 --json 时输出人看的表格。两种输出来自**同一份**从注册表生成的数据。
`;

export interface CapabilitiesCliDeps extends CapabilityOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function mark(availability: string): string {
  switch (availability) {
    case "available":
      return "✅";
    case "needs_credential":
      return "🔑";
    case "placeholder":
      return "🚧";
    case "unavailable":
      return "❌";
    default:
      return "·";
  }
}

function width(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return n;
}

function pad(text: string, target: number): string {
  return text + " ".repeat(Math.max(1, target - width(text)));
}

function clip(text: string, max: number): string {
  let n = 0;
  let out = "";
  for (const ch of text) {
    const w = ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
    if (n + w > max) return out + "…";
    out += ch;
    n += w;
  }
  return out;
}

export function renderCapabilities(manifest: CapabilityManifest, out: (line: string) => void): void {
  out(`Spark Research v${manifest.version} 能力清单${manifest.probed ? "（已探测本地环境）" : "（未探测本地环境，加 --probe）"}`);
  out("");

  out(`▎数据源 Connector（${manifest.connectors.length}）`);
  for (const domain of [...new Set(manifest.connectors.map((c) => c.domain))]) {
    const group = manifest.connectors.filter((c) => c.domain === domain);
    out(`  ${domain}`);
    for (const c of group) {
      const note = c.reason ?? c.caveat ?? "";
      out(`    ${mark(c.availability)} ${pad(c.id, 18)}${pad(clip(c.description, 46), 48)}${clip(note, 40)}`);
    }
  }
  out("");

  out(`▎干实验平台 SimulationPlatform（${manifest.simulationPlatforms.length}）`);
  for (const p of manifest.simulationPlatforms) {
    out(
      `  ${mark(p.availability)} ${pad(p.id, 12)}${pad(p.isDefault ? "默认" : "", 6)}` +
        `${pad(`deterministic=${p.deterministic}`, 22)}kinds: ${p.kinds.join(", ")}`,
    );
    if (p.reason) out(`      ${clip(p.reason, 92)}`);
  }
  out("");

  out(`▎湿实验后端 WetLabBackend（${manifest.wetBackends.length}）`);
  for (const b of manifest.wetBackends) {
    out(`  ${mark(b.availability)} ${pad(b.id, 22)}${pad(b.isDefault ? "默认" : "", 6)}${clip(b.description, 60)}`);
    if (b.reason) out(`      ${clip(b.reason, 92)}`);
  }
  out("");

  out(`▎技能 Skill（${manifest.skills.length}）`);
  for (const s of manifest.skills) {
    out(`  · ${pad(s.name, 20)}${pad(`域 ${s.domain}`, 8)}触发: ${clip(s.triggers.join(" / "), 56)}`);
  }
  out("");

  out(`▎规则 Rule（${manifest.rules.length}）`);
  for (const kind of ["safety", "citation", "conclusion", "novelty-rating"] as const) {
    const group = manifest.rules.filter((r) => r.kind === kind);
    if (group.length === 0) continue;
    out(`  ${kind}`);
    for (const r of group) out(`    · ${pad(r.id, 30)}${pad(r.severity, 22)}${clip(r.description, 44)}`);
  }
  out("");

  out(`▎MCP 工具（暴露 ${manifest.mcp.tools.length} / 刻意不暴露 ${manifest.mcp.withheld.length}）`);
  out(`  暴露：${manifest.mcp.tools.map((t) => t.name).join(", ")}`);
  for (const w of manifest.mcp.withheld) {
    out(`  🚫 ${pad(w.name, 20)}${clip(w.reason, 74)}`);
    out(`     人来做：${w.humanAction}`);
  }
  out("");

  out("▎证据图");
  out(`  record 类型: ${manifest.recordTypes.join(", ")}`);
  out(`  边类型:      ${manifest.edgeTypes.join(", ")}`);
  out(`  证据标签:    ${manifest.evidenceLabels.join(", ")}`);
  out("");

  out("▎配置（详情与影响：spark-research config list）");
  for (const c of manifest.config) {
    const shown = c.secret ? (c.source === "unset" ? "（未设置）" : "（已设置）") : (c.value ?? "—");
    out(`  · ${pad(c.key, 22)}${pad(String(shown), 34)}${c.source}`);
  }
  out("");

  out(`▎LLM Provider（${manifest.providers.length}，选模型前可 introspect 能力位）`);
  for (const p of manifest.providers) {
    const caps = p.capabilities;
    const capsStr =
      `tool=${caps.toolCalling ? "✓" : "✗"} json=${caps.jsonMode ? "✓" : "✗"} ` +
      `stream=${caps.streaming ? "✓" : "✗"} usage=${caps.usageReported ? "✓" : "✗"}`;
    out(`  ${p.configured ? "🔑" : "·"} ${pad(p.id, 12)}${pad(capsStr, 40)}${p.models.length} 个已知模型名`);
  }
  const le = manifest.localEndpoint;
  const leCaps =
    `tool=${le.capabilities.toolCalling ? "✓" : "✗"} json=${le.capabilities.jsonMode ? "✓" : "✗"} ` +
    `stream=${le.capabilities.streaming ? "✓" : "✗"} usage=${le.capabilities.usageReported ? "✓" : "✗"}`;
  out(
    `  ${le.configured ? "🔑" : "·"} ${pad(`本地端点(${le.modelPrefix})`, 12)}${pad(leCaps, 40)}` +
      `baseUrl 见 ${le.baseUrlEnvVar}`,
  );
}

export async function runCapabilitiesCommand(args: string[], deps: CapabilitiesCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    out(CAPABILITIES_HELP);
    return 0;
  }
  const unknown = args.filter((a) => !["--json", "--probe"].includes(a));
  if (unknown.length > 0) {
    err(`未知参数: ${unknown.join(", ")}`);
    err(CAPABILITIES_HELP);
    return 1;
  }
  const manifest = await buildCapabilities({
    probe: args.includes("--probe"),
    root: deps.root,
    env: deps.env,
    connectors: deps.connectors,
    credentials: deps.credentials,
    skillsRoot: deps.skillsRoot,
    simulationRoot: deps.simulationRoot,
  });
  if (args.includes("--json")) {
    out(JSON.stringify(manifest, null, 2));
    return 0;
  }
  renderCapabilities(manifest, out);
  return 0;
}
