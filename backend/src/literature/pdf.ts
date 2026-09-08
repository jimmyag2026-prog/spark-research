import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultHttp, type HttpClient } from "../http/client";
import { politeHeaders } from "../connectors/politeness";
import type { LibraryPaper, LibraryStore } from "./library";
import { titleKey, type Paper } from "./models";

// PDF 下载管线（DESIGN 域 A2）：解析 OA 直链 → 下载到 papers/ → 记 checksum。
//
// 纪律（来自「bioRxiv 403 自救」的既有经验）：
//   - 拿不到就明确标注不可得原因（unavailable + reason），**不重试轰炸**：
//     每个候选直链最多试一次，403/404 直接记原因换下一个候选，全部失败即收手。
//   - 只下 OA 直链，不做绕墙。

export type PdfFailureReason =
  | "no_oa_link"
  | "http_403"
  | "http_404"
  | "http_error"
  | "not_a_pdf"
  | "network_error";

export interface PdfCandidate {
  url: string;
  // 直链是怎么推导出来的，便于 devlog / 排障。
  origin: "arxiv" | "europepmc" | "openalex_best_oa" | "source_pdf_url";
}

export interface PdfDownloadResult {
  paperId: string;
  ok: boolean;
  path?: string;
  checksum?: string;
  bytes?: number;
  url?: string;
  origin?: PdfCandidate["origin"];
  reason?: PdfFailureReason;
  // 人读的说明，用于 CLI 输出与库内 pdf_reason 字段。
  message?: string;
  attempts: Array<{ url: string; status: number | null; outcome: string }>;
}

// 从统一 Paper 模型推导所有可尝试的 OA PDF 直链，按成功率排序。
export function pdfCandidates(paper: Paper): PdfCandidate[] {
  const candidates: PdfCandidate[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined, origin: PdfCandidate["origin"]) => {
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ url: trimmed, origin });
  };

  // arXiv：由 id 直接拼 /pdf/ 路径，最稳的一条路。
  const arxivId = paper.ids.arxiv;
  if (arxivId) push(`https://arxiv.org/pdf/${arxivId.replace(/^arxiv:/i, "")}`, "arxiv");

  // Europe PMC：OA 子集的 PMCID 有稳定的 fullTextUrl / 后备直链。
  const pmcid = paper.ids.pmcid;
  if (pmcid && paper.isOpenAccess !== false) {
    const normalized = pmcid.startsWith("PMC") ? pmcid : `PMC${pmcid}`;
    push(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${normalized}/fullTextPdf`,
      "europepmc",
    );
  }

  // 归一化时带下来的直链：OpenAlex best_oa_location.pdf_url / S2 openAccessPdf / EuropePMC fullTextUrlList。
  push(paper.pdfUrl, paper.pdfUrl?.includes("arxiv.org") ? "arxiv" : "openalex_best_oa");

  return candidates;
}

function isPdf(bytes: Uint8Array, contentType: string | undefined): boolean {
  // magic bytes 优先：不少源的 content-type 是 application/octet-stream。
  const magic = new TextDecoder().decode(bytes.slice(0, 5));
  if (magic.startsWith("%PDF")) return true;
  return (contentType ?? "").toLowerCase().includes("pdf");
}

// 文件名：<第一作者姓><年份>-<标题首词>-<id 前 8 位>.pdf，可读且不会撞名。
export function pdfFilename(paper: LibraryPaper): string {
  const surname = paper.authors[0]?.name.split(/[\s,]+/).filter(Boolean).pop() ?? "unknown";
  const firstWord = titleKey(paper.title).split(" ")[0] ?? "paper";
  const slug = `${surname}${paper.year ?? ""}-${firstWord}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "paper"}-${paper.id.slice(0, 8)}.pdf`;
}

export interface PdfDownloaderOptions {
  http?: HttpClient;
  // 落盘目录，通常是 Project.paths.papersDir。
  papersDir: string;
  library: LibraryStore;
}

export class PdfDownloader {
  private http: HttpClient;
  private papersDir: string;
  private library: LibraryStore;

  constructor(options: PdfDownloaderOptions) {
    this.http = options.http ?? defaultHttp;
    this.papersDir = options.papersDir;
    this.library = options.library;
  }

  async download(paperId: string): Promise<PdfDownloadResult> {
    const paper = this.library.get(paperId);
    if (!paper) throw new Error(`论文 '${paperId}' 不在库中`);

    const attempts: PdfDownloadResult["attempts"] = [];
    const candidates = pdfCandidates(paper);
    if (candidates.length === 0) {
      return this.fail(paper, "no_oa_link", "未找到开放获取（OA）PDF 直链", attempts);
    }

    let lastReason: PdfFailureReason = "no_oa_link";
    let lastMessage = "未找到可下载的 OA PDF";

    for (const candidate of candidates) {
      // 每个候选只试一次：不做退避重试，避免对 OA 服务器造成轰炸。
      let status: number | null = null;
      try {
        const response = await this.http.request(candidate.url, {
          headers: { ...politeHeaders(), Accept: "application/pdf,*/*" },
        });
        status = response.status;
        if (!response.ok) {
          lastReason = status === 403 ? "http_403" : status === 404 ? "http_404" : "http_error";
          lastMessage =
            status === 403
              ? `${candidate.url} 返回 403（该源拒绝程序化下载，需人工获取）`
              : `${candidate.url} 返回 HTTP ${status}`;
          attempts.push({ url: candidate.url, status, outcome: lastReason });
          continue;
        }
        const bytes = await response.bytes();
        if (!isPdf(bytes, response.headers["content-type"])) {
          lastReason = "not_a_pdf";
          lastMessage = `${candidate.url} 返回的不是 PDF（可能是登录页或落地页）`;
          attempts.push({ url: candidate.url, status, outcome: lastReason });
          continue;
        }

        mkdirSync(this.papersDir, { recursive: true });
        const filename = pdfFilename(paper);
        const path = join(this.papersDir, filename);
        writeFileSync(path, bytes);
        const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        this.library.update(paper.id, {
          pdfPath: path,
          pdfStatus: "downloaded",
          pdfReason: null,
          checksum,
        });
        attempts.push({ url: candidate.url, status, outcome: "ok" });
        return {
          paperId: paper.id,
          ok: true,
          path,
          checksum,
          bytes: bytes.byteLength,
          url: candidate.url,
          origin: candidate.origin,
          attempts,
        };
      } catch (error) {
        lastReason = "network_error";
        lastMessage = `${candidate.url} 请求失败：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        attempts.push({ url: candidate.url, status, outcome: lastReason });
      }
    }

    return this.fail(paper, lastReason, lastMessage, attempts);
  }

  // 批量下载：串行执行，避免并发打同一个 OA 服务器。
  async downloadMany(paperIds: string[]): Promise<PdfDownloadResult[]> {
    const results: PdfDownloadResult[] = [];
    for (const id of paperIds) results.push(await this.download(id));
    return results;
  }

  private fail(
    paper: LibraryPaper,
    reason: PdfFailureReason,
    message: string,
    attempts: PdfDownloadResult["attempts"],
  ): PdfDownloadResult {
    // 不可得原因写回库里：下次不必重试，人也能看到到底卡在哪。
    this.library.update(paper.id, { pdfStatus: "unavailable", pdfReason: `${reason}: ${message}` });
    return { paperId: paper.id, ok: false, reason, message, attempts };
  }
}
