import { buildDoctorReport, type DoctorOptions, type DoctorReport } from "./index";

export const DOCTOR_HELP = `用法:
  spark-research doctor [--json]

  报告环境状态：bun 版本 / Python 解释器 / 三档 Python 依赖（core/science/lab）各自是否
  可用 / 配置了哪些 LLM provider key（只报已配置/未配置，值永不打印）/ 前端产物是否已构建。
  缺什么就给出可直接复制的修复命令。

  --json    输出机器可读报告（给 agent 脚本化判断）
`;

function mark(ok: boolean): string {
  return ok ? "✅" : "❌";
}

function width(text: string): number {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return n;
}

function pad(text: string, target: number): string {
  return text + " ".repeat(Math.max(1, target - width(text)));
}

export function renderDoctor(report: DoctorReport, out: (line: string) => void): void {
  out(`Spark Research v${report.version} · doctor（${report.timestamp}）`);
  out("");

  out("▎运行时");
  out(`  bun     ${report.bunVersion}（${report.platform}）`);
  if (report.python.ok) {
    out(`  ✅ python  ${report.python.path}（${report.python.version}）`);
  } else {
    out(`  ❌ python  ${report.python.path}`);
    out(`      ${report.python.error ?? "解释器不可用"}`);
    out(`      修复：uv venv --python 3.12 .venv   # 或安装系统 Python 3.10+ 并加入 PATH`);
  }
  out(`  数据目录  ${report.dataDir}`);
  out("");

  out("▎依赖分层（core 零依赖 · science=openmm · lab=opentrons）");
  for (const tier of report.tiers) {
    out(`  ${mark(tier.available)} ${pad(tier.label, 10)}${tier.summary}`);
    if (!tier.available && tier.reason) {
      out(`      ${tier.reason}`);
    }
  }
  out("");

  out(`▎LLM Provider Key（${report.providers.length}，只报已配置/未配置，值永不打印）`);
  for (const p of report.providers) {
    out(`  ${p.configured ? "🔑" : "·"} ${pad(p.id, 12)}${p.envVar}${p.configured ? "" : "（未配置）"}`);
  }
  if (!report.providers.some((p) => p.configured)) {
    out(`      未配置任何 provider key。修复：spark-research auth`);
  }
  out("");

  out("▎前端");
  if (report.frontendBuilt) {
    out(`  ✅ 已构建  ${report.frontendDir}`);
  } else {
    out(`  ❌ 未构建  ${report.frontendDir}`);
    out(`      修复：bun run build:web`);
  }
}

export interface DoctorCliDeps extends DoctorOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runDoctorCommand(args: string[], deps: DoctorCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    out(DOCTOR_HELP);
    return 0;
  }
  const unknown = args.filter((a) => a !== "--json");
  if (unknown.length > 0) {
    err(`未知参数: ${unknown.join(", ")}`);
    err(DOCTOR_HELP);
    return 1;
  }
  const report = await buildDoctorReport(deps);
  if (args.includes("--json")) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  renderDoctor(report, out);
  return 0;
}
