import { existsSync } from "node:fs";
import { materializeAsset } from "../assets/embedded";
import { resolvePython } from "../simulation/platform";
import PDF_TEXT_PY from "./pdf_text.py" with { type: "text" };

// V66：PDF 全文抽取的 TS 侧。走 V27 验证过的组合修法：脚本内容静态 import 进二进制、
// 运行期解包到真实路径再 spawn（外部 python 读不了 /$bunfs 虚拟路径）。
//
// 失败语义：**永远不抛**——返回 ok:false + 可读 reason。上游（精读卡）据此降级回
// 摘要模式并把降级原因显式写进卡片元数据；抽不出全文不是错误，是要如实标注的事实。

export interface PdfTextResult {
  ok: boolean;
  text?: string;
  pages?: number;
  truncated?: boolean;
  reason?: string;
}

export async function extractPdfText(
  pdfPath: string,
  options: { maxChars?: number; python?: string; timeoutMs?: number } = {},
): Promise<PdfTextResult> {
  const maxChars = options.maxChars ?? 40_000;
  if (!existsSync(pdfPath)) return { ok: false, reason: `PDF 文件不存在: ${pdfPath}` };
  const script = materializeAsset("literature", "pdf_text.py", PDF_TEXT_PY);
  const python = options.python ?? resolvePython();
  try {
    const proc = Bun.spawn([python, script, pdfPath, String(maxChars)], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 60_000,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const line = stdout.trim().split("\n").pop() ?? "";
    try {
      const parsed = JSON.parse(line) as { ok: boolean; text?: string; pages?: number; truncated?: boolean; error?: string };
      if (parsed.ok && typeof parsed.text === "string") {
        return { ok: true, text: parsed.text, pages: parsed.pages, truncated: parsed.truncated };
      }
      return { ok: false, reason: parsed.error ?? "抽取脚本报告失败但未给原因" };
    } catch {
      return { ok: false, reason: `抽取脚本输出不可解析（exit=${proc.exitCode}）：${(stderr || stdout).slice(0, 200)}` };
    }
  } catch (error) {
    return { ok: false, reason: `python 进程启动失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}
