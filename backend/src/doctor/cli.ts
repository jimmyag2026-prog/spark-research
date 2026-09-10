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
    // F-c：打包限制（BACKLOG V27）跟真没装依赖不是一回事，图标也得分开——
    // ❌ 意味着"装一下就好"，这里如果照样打 ❌ 会跟 reason 里已经澄清的话自相矛盾。
    const icon = tier.packagingLimitation ? "⚠️ " : `${mark(tier.available)} `;
    out(`  ${icon}${pad(tier.label, 10)}${tier.summary}`);
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

  // 收口(W5-2)：算力执行地。三种状态用三个不同的记号，**刻意不把「未配置」画成 ❌**——
  // 未配置是"差一把钥匙"，不可用是"这条路现在走不通"，两者该做的事完全不同。
  out(`▎算力执行地（${report.computeTargets.length}）`);
  for (const t of report.computeTargets) {
    const mark = t.availability === "available" ? "✅" : t.availability === "needs_credential" ? "🔑" : "·";
    out(`  ${mark} ${pad(t.kind, 12)}${t.availability}${t.isDefault ? "（默认）" : ""}`);
    if (t.reason) out(`      ${t.reason}`);
    // S7（外部验收）：setupHint 是多行的（「为什么 → 是什么机制 → 该做什么」三段），
    // 原来整段拼成一行输出，把 doctor 里最重要的那几句话变成了全屏最难读的一坨。
    if (t.setupHint) for (const line of t.setupHint.split("\n")) out(`      ${line}`);
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
