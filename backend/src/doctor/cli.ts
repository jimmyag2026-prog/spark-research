import { buildDoctorReport, type DoctorOptions, type DoctorReport } from "./index";

export const DOCTOR_HELP = `用法:
  spark-research doctor [--json] [--port <n>]...

  报告环境状态：bun 版本 / Python 解释器 / 三档 Python 依赖（core/science/lab）各自是否
  可用 / 配置了哪些 LLM provider key（只报已配置/未配置，值永不打印）/ 前端产物是否已构建 /
  本机有没有正在跑的 server 实例（版本对不对得上、工作目录还在不在）。
  缺什么就给出可直接复制的修复命令。

  --json         输出机器可读报告（给 agent 脚本化判断）
  --port <n>     额外探这个端口（可重复）。默认探 4321 + config 里的 serverPort；
                 \`spark-research server --port 4399\` 起的实例得在这里说一声才看得见
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

  // V65 残余：可选依赖，不进「依赖分层」——缺失时只是 AMiner 中文拆词兜底退回
  // v0.6 的空格拆词，不是某一整档能力不可用。`report.segmenter` 可选（见 index.ts
  // 字段旁注释），只在真的有这个字段时才渲染这一行。
  if (report.segmenter) {
    out(`  ${mark(report.segmenter.available)} jieba     中文分词（可选，AMiner 拆词兜底用；缺失时退回空格拆词）`);
    if (!report.segmenter.available && report.segmenter.reason) {
      out(`      ${report.segmenter.reason}`);
    }
    out("");
  }

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

  // δ-2（USAGE_LOG U2）：运行实例。这一段的价值全在「探了哪几个端口」也要打出来——
  // 探端口方案看不见非常用端口上的实例，把盲区说清楚，比笼统报一句「没有实例」诚实。
  if (report.runningInstances) {
    const { scannedPorts, instances } = report.runningInstances;
    out(`▎运行实例（探端口 ${scannedPorts.join(" / ")}）`);
    if (instances.length === 0) {
      out(`  · 这几个端口上没有在跑的实例`);
      out(`      注意：探端口只看得见这几个端口。\`spark-research server <别的端口>\` 起的实例这里看不到。`);
    }
    for (const inst of instances) {
      const icon = inst.verdict === "match" ? "✅" : "⚠️ ";
      const label =
        inst.verdict === "match"
          ? `版本一致（v${inst.version}）`
          : inst.verdict === "foreign"
            ? `端口被 ${inst.service ?? "未知服务"} 占着`
            : inst.verdict === "orphan_cwd"
              ? `孤儿实例（v${inst.version}，工作目录已不存在）`
              : `版本不一致（实例 v${inst.version} ≠ 当前 v${report.version}）`;
      out(`  ${icon}:${pad(String(inst.port), 8)}${label}`);
      if (inst.pid !== null) out(`      pid ${inst.pid}${inst.startedAt ? ` · 启动于 ${inst.startedAt}` : ""}`);
      if (inst.command) out(`      ${inst.command}`);
      if (inst.cwd) out(`      cwd ${inst.cwd}${inst.cwdExists === false ? "（已不存在）" : ""}`);
      // δ-2（V162）：前端产物按**实例**报。null = 那个实例没报这个字段（v0.10 之前的
      // 旧构建）——说「不知道」，不说「没构建」。
      if (inst.verdict !== "foreign") {
        if (inst.frontendBuilt === true) out(`      前端产物：已构建（浏览器打开 :${inst.port} 能看到工作台）`);
        else if (inst.frontendBuilt === false) {
          out(`      ❌ 前端产物：这个实例没有（浏览器打开 :${inst.port} 只会看到构建指引页）`);
          out(`         修复：到这个实例的 checkout 里 bun run build:web，然后重起它`);
        } else out(`      前端产物：这个实例没报（v0.10 之前的构建不带 frontendBuilt 字段）——只能自己打开 :${inst.port} 看`);
      }
      if (inst.degraded) out(`      ${inst.degraded}`);
      if (inst.nextStep) out(`      下一步：${inst.nextStep}`);
    }
    out("");
  }

  // δ-2（V162）：这一段回答的是「**当前 checkout** 构建过没有」，不是「浏览器打开
  // 4321 会看到什么」。V162 的现场就是把这两个问题当成了一个：doctor 判 cwd 说「未构建」，
  // 而 4321 上跑的是另一个 checkout 的实例、那边早构建过了。两句都没说谎，回答的却是
  // 两个问题。标题里把口径写死，实例那一档在「运行实例」段里按实例各报各的。
  out("▎前端（当前 checkout）");
  if (report.frontendBuilt) {
    out(`  ✅ 已构建  ${report.frontendDir}`);
  } else {
    out(`  ❌ 未构建  ${report.frontendDir}`);
    out(`      修复：bun run build:web`);
    const others = report.runningInstances?.instances.filter((i) => i.frontendBuilt === true) ?? [];
    if (others.length > 0) {
      out(
        `      注意：:${others.map((i) => i.port).join(" / :")} 上跑着的实例**自己**是有前端产物的——` +
          `浏览器打开那个端口照样有工作台。这一行说的只是当前 checkout。`,
      );
    }
  }
}

export interface DoctorCliDeps extends DoctorOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * δ-2（V160）：`--port <n>`（可重复）。`--port=4399` 也认——两种写法都有人敲，
 * 拒一种只会换来一次「未知参数」然后重敲。端口非法（非整数 / 越界）直接报错，
 * **不静默忽略**：用户敲 `--port abc` 却得到一份「没有实例」的报告，是诊断工具最坏的失败。
 */
export function parseDoctorArgs(args: string[]): { ports: number[]; json: boolean; error: string | null } {
  const ports: number[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    let raw: string | undefined;
    if (arg === "--port") raw = args[++i];
    else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
    else return { ports, json, error: `未知参数: ${arg}` };
    const n = Number(raw);
    if (raw === undefined || !Number.isInteger(n) || n <= 0 || n >= 65536) {
      return { ports, json, error: `--port 需要一个 1-65535 的整数（收到 '${raw ?? "(缺)"}'）` };
    }
    ports.push(n);
  }
  return { ports, json, error: null };
}

export async function runDoctorCommand(args: string[], deps: DoctorCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    out(DOCTOR_HELP);
    return 0;
  }
  const parsed = parseDoctorArgs(args);
  if (parsed.error) {
    err(parsed.error);
    err(DOCTOR_HELP);
    return 1;
  }
  // δ-2（V160）：`--port` 追加进探测清单；已在 deps 里给了 ports（测试注入）就合并。
  const report = await buildDoctorReport({ ...deps, ports: [...(deps.ports ?? []), ...parsed.ports] });
  if (args.includes("--json")) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  renderDoctor(report, out);
  return 0;
}
