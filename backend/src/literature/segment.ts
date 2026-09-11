import { materializeAsset } from "../assets/embedded";
import { resolvePython } from "../simulation/platform";
import SEGMENT_PY from "./segment.py" with { type: "text" };

// V65 残余：中文分词（jieba）可选依赖。与 `pdf_text.ts`（pypdf）同一形状——脚本内容
// 静态 import 进二进制、运行期经 `materializeAsset` 解包到真实路径再 spawn（编译产物里
// `import.meta.dir` 是 `/$bunfs/` 虚拟路径，外部 python 读不到，见 pdf_text.ts 顶部注释 /
// BACKLOG V27 / docs/devlog/F-c.md）。stdin 传原始查询文本，避免中文经 argv 传参时的
// shell/编码坑（`chem/depict.ts` 传 JSON payload走的也是这条路）。
//
// 失败语义：**永远不抛**——`terms: null` + `reason`。上游（`search.ts` 的 AMiner 拆词
// 兜底）据此退回 v0.6 的空格拆词行为，不是错误，是要如实标注的降级。

export interface SegmentResult {
  terms: string[] | null;
  reason?: string;
}

export async function segmentQuery(
  text: string,
  options: { python?: string; timeoutMs?: number } = {},
): Promise<SegmentResult> {
  const script = materializeAsset("literature", "segment.py", SEGMENT_PY);
  const python = options.python ?? resolvePython();
  try {
    const proc = Bun.spawn([python, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 15_000,
    });
    proc.stdin.write(text);
    proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const line = stdout.trim().split("\n").pop() ?? "";
    try {
      const parsed = JSON.parse(line) as { terms?: string[] | null; reason?: string };
      if (Array.isArray(parsed.terms) && parsed.terms.length > 0) {
        return { terms: parsed.terms };
      }
      return { terms: null, reason: parsed.reason ?? "分词脚本报告失败但未给原因" };
    } catch {
      return {
        terms: null,
        reason: `分词脚本输出不可解析（exit=${proc.exitCode}）：${(stderr || stdout).slice(0, 200)}`,
      };
    }
  } catch (error) {
    return { terms: null, reason: `python 进程启动失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// `doctor` 探测用：只问「这个解释器 import 得到 jieba 吗」，走同一个真实探测路径
// （真跑一次 `segmentQuery`，不是另起一套 `-c "import jieba"` 判断——两处各判一次
// 就是本轮反复修的那种病，`doctor/index.ts` 顶部注释也是这个原则：science/lab 复用
// 各自模块自己的 `.available()`，这里复用 `segmentQuery` 本身）。
export async function probeSegmenter(python?: string): Promise<{ ok: boolean; reason: string | null }> {
  const result = await segmentQuery("分词探测占位文本", { python });
  if (result.terms && result.terms.length > 0) return { ok: true, reason: null };
  return { ok: false, reason: result.reason ?? "分词器不可用" };
}
