import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HttpClient } from "../http/client";
import { sharedRateLimitedHttp } from "../http/ratelimit";
import { PLACEHOLDER_CONTACT_EMAIL, contactEmail, politeHeaders } from "../connectors/politeness";
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
  origin: "arxiv" | "europepmc" | "openalex_best_oa" | "source_pdf_url" | "landing_meta" | "unpaywall";
}

// α-4（v0.10，U51）：U51 那批 8 篇全部标 OA，只拿到 2 篇。真因是两件事，各修一跳：
//   ① `not_a_pdf` ×3：`pdfUrl` 指向**落地页**（handle.net / AOM / IOP 文章页），
//      真 PDF 在一跳之后——绝大多数出版社页面带 `citation_pdf_url` 元标签
//      （Google Scholar 约定）或 `<link rel="alternate" type="application/pdf">`。
//   ② OpenAlex 的 OA 标记偏乐观：全部直链失败后，按 DOI 问一次 Unpaywall
//      （免 key，只要一个联系邮箱），拿它给出的真 OA 副本。
// 纪律不变：**每个候选只试一次，不退避轰炸**；解析出来的一跳同样只试一次。

/** `citation_pdf_url` 元标签（Google Scholar 约定，属性顺序两种都见过）。 */
const CITATION_PDF_META =
  /<meta[^>]+(?:name|property)=["']citation_pdf_url["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']citation_pdf_url["']/i;
/** `<link rel="alternate" type="application/pdf" href="…">`（rel/type/href 顺序不定）。 */
const ALTERNATE_PDF_LINK =
  /<link[^>]*rel=["'][^"']*alternate[^"']*["'][^>]*type=["']application\/pdf["'][^>]*>|<link[^>]*type=["']application\/pdf["'][^>]*rel=["'][^"']*alternate[^"']*["'][^>]*>/i;
const HREF_ATTR = /href=["']([^"']+)["']/i;

/**
 * 从落地页 HTML 里找真 PDF 链接。找不到返回 null（**不猜 URL 拼接**——技能文档里
 * 「不要自己猜 URL」那条纪律保留，只是现在页面自己写明了的那条我们会读）。
 * 相对链接按落地页 URL 解析成绝对链接。
 */
export function pdfLinkFromLandingPage(html: string, baseUrl: string): string | null {
  const meta = html.match(CITATION_PDF_META);
  const fromMeta = meta?.[1] ?? meta?.[2];
  const link = html.match(ALTERNATE_PDF_LINK)?.[0];
  const fromLink = link ? link.match(HREF_ATTR)?.[1] : undefined;
  const raw = (fromMeta ?? fromLink)?.trim();
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Unpaywall v2 的响应里我们需要的形状（其余字段不关心）。 */
interface UnpaywallResponse {
  best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null;
  oa_locations?: Array<{ url_for_pdf?: string | null; url?: string | null }> | null;
}

/** 从 Unpaywall 响应里抽出可下载的 PDF 直链（best 优先，其次任意一个有 url_for_pdf 的）。 */
export function unpaywallPdfUrl(payload: unknown): string | null {
  const body = payload as UnpaywallResponse | null;
  const best = body?.best_oa_location?.url_for_pdf;
  if (typeof best === "string" && best.trim()) return best.trim();
  for (const loc of body?.oa_locations ?? []) {
    if (typeof loc?.url_for_pdf === "string" && loc.url_for_pdf.trim()) return loc.url_for_pdf.trim();
  }
  return null;
}

export function unpaywallUrl(doi: string, email: string): string {
  return `https://api.unpaywall.org/v2/${encodeURIComponent(doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""))}?email=${encodeURIComponent(email)}`;
}

export interface PdfDownloadResult {
  paperId: string;
  ok: boolean;
  path?: string;
  checksum?: string;
  bytes?: number;
  url?: string;
  origin?: PdfCandidate["origin"];
  /**
   * α-4：这条 OA 判断是谁给的。`openalex(optimistic)` = 只有 OpenAlex 的 OA 标记支持
   * 它——U51 实测这个标记偏乐观（8 篇标 OA 只下到 2 篇），下游报告里不许把它当
   * 「确认可得」。拿到 PDF 后是真源（arxiv / europepmc / landing_meta / unpaywall）。
   */
  oaSource?: string;
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

  // Europe PMC：OA 子集用 europepmc.org/articles/<PMCID>?pdf=render。
  // 注意 REST 的 .../rest/<PMCID>/fullTextPdf 已实测返回 404（见 P2 devlog 真实网络验证），
  // 不要改回那个形式。
  const pmcid = paper.ids.pmcid;
  if (pmcid && paper.isOpenAccess !== false) {
    const normalized = pmcid.startsWith("PMC") ? pmcid : `PMC${pmcid}`;
    push(`https://europepmc.org/articles/${normalized}?pdf=render`, "europepmc");
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
  /**
   * α-4：Unpaywall 兜底用的联系邮箱（免 key，但必须带 email）。不给就按
   * `connectors/politeness.ts` 的 contactEmail() 取——未配置时那是占位邮箱，
   * 此时**不发 Unpaywall 请求**（拿占位邮箱去敲免费接口是失礼，也会被限）。
   */
  contactEmail?: string;
  /** α-4：关掉 Unpaywall 兜底（阴性对照 / 离线跑）。默认开。 */
  unpaywall?: boolean;
}

export class PdfDownloader {
  private http: HttpClient;
  private papersDir: string;
  private library: LibraryStore;
  private contactEmail: string;
  private unpaywallOn: boolean;

  constructor(options: PdfDownloaderOptions) {
    // α-5：PDF 直链默认也走**共享**限速器——arxiv.org（PDF）与 export.arxiv.org
    // （检索）在 HOST_BUCKET_GROUPS 里归到同一个桶键，共用实例才真的共用一个桶。
    // 显式注入 http 的测试/fixture 路径不受影响。
    this.http = options.http ?? sharedRateLimitedHttp();
    this.papersDir = options.papersDir;
    this.library = options.library;
    this.contactEmail = options.contactEmail ?? contactEmail();
    this.unpaywallOn = options.unpaywall !== false;
  }

  async download(paperId: string): Promise<PdfDownloadResult> {
    const paper = this.library.get(paperId);
    if (!paper) throw new Error(`论文 '${paperId}' 不在库中`);

    const attempts: PdfDownloadResult["attempts"] = [];
    const candidates = pdfCandidates(paper);
    // α-4：候选为空不再等于「就此收手」——DOI 还能问一次 Unpaywall。
    if (candidates.length === 0 && !this.canAskUnpaywall(paper)) {
      return this.fail(paper, "no_oa_link", "未找到开放获取（OA）PDF 直链", attempts);
    }

    let lastReason: PdfFailureReason = "no_oa_link";
    let lastMessage = "未找到可下载的 OA PDF";
    // 落地页解析出来的一跳：排在所有原始候选之后（先把稳的试完），每条同样只试一次。
    const derived: PdfCandidate[] = [];
    const seen = new Set(candidates.map((c) => c.url));

    const tryOne = async (candidate: PdfCandidate, allowLandingHop: boolean): Promise<PdfDownloadResult | null> => {
      let status: number | null = null;
      try {
        const response = await this.http.request(candidate.url, {
          headers: { ...politeHeaders({ contactEmail: this.contactEmail }), Accept: "application/pdf,*/*" },
        });
        status = response.status;
        if (!response.ok) {
          lastReason = status === 403 ? "http_403" : status === 404 ? "http_404" : "http_error";
          lastMessage =
            status === 403
              ? `${candidate.url} 返回 403（该源拒绝程序化下载，需人工获取）`
              : `${candidate.url} 返回 HTTP ${status}`;
          attempts.push({ url: candidate.url, status, outcome: lastReason });
          return null;
        }
        const bytes = await response.bytes();
        if (!isPdf(bytes, response.headers["content-type"])) {
          lastReason = "not_a_pdf";
          lastMessage = `${candidate.url} 返回的不是 PDF（可能是登录页或落地页）`;
          attempts.push({ url: candidate.url, status, outcome: lastReason });
          // ① α-4 第一跳：落地页里读 citation_pdf_url / <link rel=alternate type=pdf>。
          //    只对**原始候选**做，派生出来的那一跳不再派生（不许无限跳）。
          if (allowLandingHop) {
            const html = new TextDecoder().decode(bytes.slice(0, 200_000));
            const next = pdfLinkFromLandingPage(html, candidate.url);
            if (next && !seen.has(next)) {
              seen.add(next);
              derived.push({ url: next, origin: "landing_meta" });
            }
          }
          return null;
        }
        return this.save(paper, bytes, candidate, attempts, status);
      } catch (error) {
        lastReason = "network_error";
        lastMessage = `${candidate.url} 请求失败：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        attempts.push({ url: candidate.url, status, outcome: lastReason });
        return null;
      }
    };

    for (const candidate of candidates) {
      const saved = await tryOne(candidate, true);
      if (saved) return saved;
    }
    // 落地页派生出来的一跳（可能为空）。
    for (const candidate of derived) {
      const saved = await tryOne(candidate, false);
      if (saved) return saved;
    }

    // ② α-4 第二跳：全部直链失败 → 按 DOI 问一次 Unpaywall（免 key，但必须带真邮箱）。
    const fromUnpaywall = await this.unpaywallCandidate(paper, attempts);
    if (fromUnpaywall) {
      // R7 U64：Unpaywall 回的 url_for_pdf 常与已经 403 / not_a_pdf 的直链逐字节相同——同一 URL 不再敲第二次，留痕。
      const alreadyTried = attempts.some((a) => a.url === fromUnpaywall.url) || seen.has(fromUnpaywall.url);
      if (alreadyTried) {
        attempts.push({ url: fromUnpaywall.url, status: null, outcome: "skipped: unpaywall 给的直链与已失败的候选相同" });
      } else {
        const saved = await tryOne(fromUnpaywall, false);
        if (saved) return saved;
      }
    }

    return this.fail(paper, lastReason, lastMessage, attempts);
  }

  /** 有 DOI、兜底没被关掉、且邮箱不是占位符——三条都满足才值得敲 Unpaywall。 */
  private canAskUnpaywall(paper: LibraryPaper): boolean {
    return this.unpaywallOn && Boolean(paper.doi) && this.contactEmail !== PLACEHOLDER_CONTACT_EMAIL;
  }

  private async unpaywallCandidate(
    paper: LibraryPaper,
    attempts: PdfDownloadResult["attempts"],
  ): Promise<PdfCandidate | null> {
    if (!this.canAskUnpaywall(paper)) {
      if (this.unpaywallOn && paper.doi && this.contactEmail === PLACEHOLDER_CONTACT_EMAIL) {
        // 静默降级必须留痕：否则「为什么没走兜底」永远查不出来。
        attempts.push({ url: "unpaywall", status: null, outcome: "skipped: contactEmail 未配置（占位邮箱不发请求）" });
      }
      return null;
    }
    const url = unpaywallUrl(paper.doi!, this.contactEmail);
    try {
      const response = await this.http.request(url, {
        headers: { ...politeHeaders({ contactEmail: this.contactEmail }), Accept: "application/json" },
      });
      if (!response.ok) {
        attempts.push({ url, status: response.status, outcome: `unpaywall_http_${response.status}` });
        return null;
      }
      const pdfUrl = unpaywallPdfUrl(JSON.parse(new TextDecoder().decode(await response.bytes())));
      attempts.push({ url, status: response.status, outcome: pdfUrl ? "unpaywall_hit" : "unpaywall_no_oa" });
      return pdfUrl ? { url: pdfUrl, origin: "unpaywall" } : null;
    } catch (error) {
      attempts.push({ url, status: null, outcome: `unpaywall_error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
      return null;
    }
  }

  private save(
    paper: LibraryPaper,
    bytes: Uint8Array,
    candidate: PdfCandidate,
    attempts: PdfDownloadResult["attempts"],
    status: number | null,
  ): PdfDownloadResult {
    mkdirSync(this.papersDir, { recursive: true });
    const path = join(this.papersDir, pdfFilename(paper));
    writeFileSync(path, bytes);
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.library.update(paper.id, { pdfPath: path, pdfStatus: "downloaded", pdfReason: null, checksum });
    attempts.push({ url: candidate.url, status, outcome: "ok" });
    return {
      paperId: paper.id,
      ok: true,
      path,
      checksum,
      bytes: bytes.byteLength,
      url: candidate.url,
      origin: candidate.origin,
      oaSource: candidate.origin,
      attempts,
    };
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
    // α-4：没拿到 PDF 时，「这篇是 OA」这个说法目前只有 OpenAlex 的标记支持——
    // U51 实测它偏乐观，所以显式标 optimistic，下游不许把它当「确认可得」。
    const oaSource = paper.isOpenAccess ? "openalex(optimistic)" : undefined;
    return { paperId: paper.id, ok: false, reason, message, oaSource, attempts };
  }
}
