import { createHash } from "node:crypto";
import DEPICT_PY from "./depict.py" with { type: "text" };
import { materializeAssetTree } from "../assets/embedded";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store";
import type { RecordStore } from "../project/records";
import { resolvePython } from "../simulation/platform";

// C5-② SMILES → 2D 结构图（DEVELOPMENT_PLAN_v0.5_MODULES.md §1.3 / §2.9）。
//
// 子进程而不是 PythonKernel（异议 X-5）：一次 depict 是 100ms 级的无状态调用，不需要
// 常驻 kernel；走 daemon 会把 ControlRepl/permit 一并拖进来——仿真层已经为同样的理由
// 做过这个判断（simulation/platform.ts:23-31）。这里直接复用它的 resolvePython()，
// 不重开一份口径。

export interface DepictInput {
  smiles: string;
  name?: string;
  width?: number;
  height?: number;
}

export interface DepictResult {
  ok: true;
  svg: string;
  canonicalSmiles: string;
  formula: string;
  molWeight: number;
  rdkitVersion: string;
  artifactId: string;
  recordId: string;
  path: string;
}

export type DepictErrorKind = "invalid_smiles" | "rdkit_unavailable" | "timeout" | "bad_output";

export interface DepictFailure {
  ok: false;
  error: { kind: DepictErrorKind; message: string };
}

export interface DepictDeps {
  artifacts: ArtifactStore;
  records: RecordStore;
  python?: string;
  timeoutMs?: number;
  projectSlug: string;
  sessionId?: string | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// **发布前外部验收（HIGH-3）**：这里原来是 `join(import.meta.dir, "depict.py")`——
// 在 `bun build --compile` 的产物里 `import.meta.dir` 是 `/$bunfs/root`，
// 外部 python 打不开那个虚拟路径：
//     ❌ [bad_output] depict.py 没有输出任何内容（exit=2）：
//        python3: can't open file '/$bunfs/root/depict.py': [Errno 2] No such file or directory
//
// 这是 V27 家族的**遗漏**：W5-1 ε 修了 10 处资产，但 chem 是 W5-1 γ 在同一波并行交付的，
// 两条 lane 谁也没覆盖到对方的新文件。后果比一般 ENOENT 更糟——
// `--help` / `capabilities` / MCP `tools/list` / `llms.txt` **四处都声称它可用**，
// 按本项目的价值观「声称有、实际用不了，比没有更糟」。
//
// 修法与 ε 的四处 `.py` 一致：静态 import 文本 → 运行期解包到真实临时文件 → spawn 真实路径。
// `depict.py` 只 import 标准库与 rdkit，没有同包依赖，所以是单文件树的退化情形。
function scriptPath(): string {
  return join(materializeAssetTree("chem-depict", { "depict.py": DEPICT_PY }), "depict.py");
}

// 安全校验（第二道防线）：depict.py 已经在生成端保证了这些性质（§1.3.1），这里保证
// 「即便某天 depict.py 被改坏，也不让不安全的 SVG 流进 artifact store / 前端 <img>」。
export function assertSafeSvg(svg: string): void {
  if (!svg.startsWith("<svg")) {
    throw new Error("SVG 校验失败：不是以 <svg 开头（可能是空输出，或被 XML 声明/其它内容污染）");
  }
  if (/<script[\s>]/i.test(svg)) {
    throw new Error("SVG 校验失败：含 <script>，拒绝落库");
  }
  if (/\son\w+\s*=/i.test(svg)) {
    throw new Error("SVG 校验失败：含 on* 事件属性，拒绝落库");
  }
  if (/<foreignObject[\s>]/i.test(svg)) {
    throw new Error("SVG 校验失败：含 <foreignObject>，拒绝落库");
  }
}

function sanitizeName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, 64) || "molecule";
}

// 没给 --name 时的默认文件名：canonical SMILES 的短 hash，而不是固定字符串——
// 这样重复 depict 同一个分子会稳定落到同一个 filename（ArtifactStore.save() 按
// filename 版本递增，见 artifacts/store.ts:184-186），不同分子各自成一条 lineage。
function defaultName(canonicalSmiles: string): string {
  const hash = createHash("sha256").update(canonicalSmiles).digest("hex").slice(0, 10);
  return `mol_${hash}`;
}

interface RawDepictOutput {
  ok: boolean;
  svg?: string;
  canonicalSmiles?: string;
  formula?: string;
  molWeight?: number;
  rdkitVersion?: string;
  error?: { kind: DepictErrorKind; message: string };
}

async function runDepictScript(
  smiles: string,
  width: number | undefined,
  height: number | undefined,
  python: string,
  timeoutMs: number,
): Promise<DepictFailure["error"] | RawDepictOutput> {
  const proc = Bun.spawn([python, scriptPath()], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ smiles, width, height }));
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    return { kind: "timeout", message: `depict.py 超时（${timeoutMs}ms）未返回，已终止子进程` };
  }

  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) {
    return {
      kind: "bad_output",
      message: `depict.py 没有输出任何内容（exit=${exitCode}）：${stderr.trim().slice(-400) || "无 stderr"}`,
    };
  }

  try {
    return JSON.parse(lastLine) as RawDepictOutput;
  } catch {
    return {
      kind: "bad_output",
      message: `depict.py 输出不是合法 JSON（exit=${exitCode}）：${lastLine.slice(0, 400)}`,
    };
  }
}

export async function depictSmiles(input: DepictInput, deps: DepictDeps): Promise<DepictResult | DepictFailure> {
  const smiles = input.smiles?.trim();
  if (!smiles) {
    return { ok: false, error: { kind: "invalid_smiles", message: "smiles 不能为空" } };
  }

  const python = deps.python ?? resolvePython();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const raw = await runDepictScript(smiles, input.width, input.height, python, timeoutMs);
  if ("kind" in raw) {
    // 非法输入 / rdkit 缺失 / 超时 / 坏输出：全部原路返回，不落任何 artifact/record。
    return { ok: false, error: raw };
  }
  if (!raw.ok) {
    const error = raw.error ?? { kind: "bad_output" as const, message: "depict.py 报告失败但没有给出 error 字段" };
    return { ok: false, error };
  }

  const { svg, canonicalSmiles, formula, molWeight, rdkitVersion } = raw;
  if (
    typeof svg !== "string" ||
    typeof canonicalSmiles !== "string" ||
    typeof formula !== "string" ||
    typeof molWeight !== "number" ||
    typeof rdkitVersion !== "string"
  ) {
    return { ok: false, error: { kind: "bad_output", message: "depict.py 返回体缺字段（ok:true 但形状不对）" } };
  }

  try {
    assertSafeSvg(svg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: "bad_output", message } };
  }

  const filename = `${sanitizeName(input.name ?? defaultName(canonicalSmiles))}.svg`;
  const scratchDir = mkdtempSync(join(tmpdir(), "spark-chem-"));
  const scratchPath = join(scratchDir, filename);
  try {
    writeFileSync(scratchPath, svg, "utf8");

    const provenance =
      `# chem depict · rdkit ${rdkitVersion}\n` +
      `# SMILES（输入）: ${smiles}\n` +
      `# SMILES（canonical）: ${canonicalSmiles}\n` +
      `# formula: ${formula}  molWeight: ${molWeight}\n`;

    const saved = deps.artifacts.save(
      scratchPath,
      provenance,
      [{ kind: "write", file: filename, role: "tool", content: `rdkit depict ${canonicalSmiles}` }],
      deps.sessionId ? { sessionId: deps.sessionId } : null,
      deps.projectSlug,
    );

    const record = deps.records.createFromArtifact(saved, {
      evidence: "computed",
      metadata: { kind: "chem_depiction", smiles, canonicalSmiles, formula, molWeight, rdkitVersion },
    });

    return {
      ok: true,
      svg,
      canonicalSmiles,
      formula,
      molWeight,
      rdkitVersion,
      artifactId: saved.id,
      recordId: record.id,
      path: saved.storagePath,
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
