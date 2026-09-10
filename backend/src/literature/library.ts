import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
// V27：同 project/records.ts —— schema 走静态 import，编译期进二进制。
// 这一处坏掉的表现是 `lit search --add` 网络检索全跑完、最后落库时才 ENOENT。
import SCHEMA_SQL from "./schema.sql" with { type: "text" };
import type { RecordStore } from "../project/records";
import { canMerge, mergePapers } from "./dedupe";
import { emptyPaper, titleKey, type LiteratureSource, type Paper, type PaperAuthor, type PaperSourceIds } from "./models";

// Project Library（DESIGN 域 A2）：论文元数据 + 标签 + 阅读状态 + 笔记 + PDF 路径 + checksum，
// 外加库内互引边。入库时自动创建 record（type: paper）接进 P1 的证据图。

export const READING_STATUSES = ["unread", "reading", "read", "skimmed"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const PDF_STATUSES = ["absent", "downloaded", "unavailable"] as const;
export type PdfStatus = (typeof PDF_STATUSES)[number];

export class LibraryError extends Error {
  constructor(message: string) {
    super(`Library: ${message}`);
    this.name = "LibraryError";
  }
}

export interface LibraryPaper extends Paper {
  id: string;
  tags: string[];
  readingStatus: ReadingStatus;
  notes: string;
  pdfPath: string | null;
  pdfStatus: PdfStatus;
  pdfReason: string | null;
  checksum: string | null;
  recordId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryFilter {
  tag?: string;
  readingStatus?: ReadingStatus;
  pdfStatus?: PdfStatus;
  // 标题 / 摘要的子串过滤（大小写不敏感）。
  q?: string;
  limit?: number;
}

export interface AddPaperOptions {
  tags?: string[];
  readingStatus?: ReadingStatus;
  notes?: string;
  sessionId?: string | null;
}

export interface AddPaperResult {
  paper: LibraryPaper;
  // true = 命中已有条目并做了字段合并，false = 新建。
  merged: boolean;
}

export interface LibraryCitation {
  sourceId: string;
  targetId: string;
  origin: string;
  createdAt: string;
}

interface PaperRow {
  id: string;
  doi: string | null;
  title: string;
  title_key: string;
  authors: string;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  url: string | null;
  pdf_url: string | null;
  source_ids: string;
  sources: string;
  cited_by_count: number | null;
  is_open_access: number | null;
  references_raw: string;
  tags: string;
  reading_status: string;
  notes: string;
  pdf_path: string | null;
  pdf_status: string;
  pdf_reason: string | null;
  checksum: string | null;
  record_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PaperRow): LibraryPaper {
  return {
    id: row.id,
    doi: row.doi,
    title: row.title,
    authors: JSON.parse(row.authors) as PaperAuthor[],
    year: row.year,
    venue: row.venue,
    abstract: row.abstract,
    url: row.url,
    pdfUrl: row.pdf_url,
    ids: JSON.parse(row.source_ids) as PaperSourceIds,
    sources: JSON.parse(row.sources) as LiteratureSource[],
    citedByCount: row.cited_by_count,
    isOpenAccess: row.is_open_access === null ? null : row.is_open_access === 1,
    references: JSON.parse(row.references_raw) as string[],
    tags: JSON.parse(row.tags) as string[],
    readingStatus: row.reading_status as ReadingStatus,
    notes: row.notes,
    pdfPath: row.pdf_path,
    pdfStatus: row.pdf_status as PdfStatus,
    pdfReason: row.pdf_reason,
    checksum: row.checksum,
    recordId: row.record_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// LibraryPaper → 纯 Paper（去掉库字段），供去重/导出复用同一套逻辑。
export function toPaper(entry: LibraryPaper): Paper {
  return {
    title: entry.title,
    authors: entry.authors,
    year: entry.year,
    venue: entry.venue,
    doi: entry.doi,
    ids: entry.ids,
    abstract: entry.abstract,
    url: entry.url,
    pdfUrl: entry.pdfUrl,
    citedByCount: entry.citedByCount,
    isOpenAccess: entry.isOpenAccess,
    sources: entry.sources,
    references: entry.references,
  };
}

export interface LibraryStoreOptions {
  // 入库时自动写 record（type: paper）；不注入则只写 library.db。
  records?: RecordStore;
}

export class LibraryStore {
  private db: Database;
  private records?: RecordStore;

  constructor(dbPath: string, options: LibraryStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.records = options.records;
    this.initSchema();
  }

  initSchema(): void {
    this.db.exec(SCHEMA_SQL);
  }

  // 入库。已存在同一篇（DOI 相同或标题模糊匹配）时合并字段而不是插重复行。
  add(paper: Paper, options: AddPaperOptions = {}): AddPaperResult {
    if (!paper.title.trim()) throw new LibraryError("论文标题不能为空，拒绝入库");
    const existing = this.findMatch(paper);
    const now = new Date().toISOString();

    if (existing) {
      const merged = mergePapers(toPaper(existing), paper);
      const tags = [...new Set([...existing.tags, ...(options.tags ?? [])])];
      this.db
        .query(
          `UPDATE papers SET doi = ?, title = ?, title_key = ?, authors = ?, year = ?, venue = ?,
             abstract = ?, url = ?, pdf_url = ?, source_ids = ?, sources = ?, cited_by_count = ?,
             is_open_access = ?, references_raw = ?, tags = ?, reading_status = ?, notes = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          merged.doi,
          merged.title,
          titleKey(merged.title),
          JSON.stringify(merged.authors),
          merged.year,
          merged.venue,
          merged.abstract,
          merged.url,
          merged.pdfUrl,
          JSON.stringify(merged.ids),
          JSON.stringify(merged.sources),
          merged.citedByCount,
          merged.isOpenAccess === null ? null : merged.isOpenAccess ? 1 : 0,
          JSON.stringify(merged.references),
          JSON.stringify(tags),
          options.readingStatus ?? existing.readingStatus,
          options.notes ?? existing.notes,
          now,
          existing.id,
        );
      return { paper: this.get(existing.id)!, merged: true };
    }

    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO papers
           (id, doi, title, title_key, authors, year, venue, abstract, url, pdf_url,
            source_ids, sources, cited_by_count, is_open_access, references_raw,
            tags, reading_status, notes, pdf_path, pdf_status, pdf_reason, checksum,
            record_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'absent', NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        paper.doi,
        paper.title,
        titleKey(paper.title),
        JSON.stringify(paper.authors),
        paper.year,
        paper.venue,
        paper.abstract,
        paper.url,
        paper.pdfUrl,
        JSON.stringify(paper.ids),
        JSON.stringify(paper.sources),
        paper.citedByCount,
        paper.isOpenAccess === null ? null : paper.isOpenAccess ? 1 : 0,
        JSON.stringify(paper.references),
        JSON.stringify(options.tags ?? []),
        options.readingStatus ?? "unread",
        options.notes ?? "",
        now,
        now,
      );

    // 证据图联动：每篇入库论文都在 records.db 里有一个 type=paper 的锚点（DESIGN 域 C1）。
    if (this.records) {
      const record = this.records.create({
        type: "paper",
        title: paper.title,
        content: paper.abstract ?? paper.title,
        evidence: "sourced",
        origin: {
          kind: "connector",
          connector: paper.sources[0] ?? null,
          sessionId: options.sessionId ?? null,
          ref: paper.doi ?? paper.url ?? null,
        },
        metadata: {
          libraryPaperId: id,
          doi: paper.doi,
          year: paper.year,
          venue: paper.venue,
          sources: paper.sources,
        },
      });
      this.db.query("UPDATE papers SET record_id = ? WHERE id = ?").run(record.id, id);
    }

    return { paper: this.get(id)!, merged: false };
  }

  // 找库内是否已有同一篇：先 DOI 精确，再标题（完全相同或模糊匹配）。
  findMatch(paper: Paper): LibraryPaper | null {
    if (paper.doi) {
      const row = this.db.query("SELECT * FROM papers WHERE doi = ?").get(paper.doi) as PaperRow | null;
      if (row) return mapRow(row);
      // 有 DOI 的论文只认 DOI，不再回落到标题匹配（DOI 不同 = 不同论文）。
      const sameTitle = this.db
        .query("SELECT * FROM papers WHERE title_key = ? AND doi IS NULL")
        .get(titleKey(paper.title)) as PaperRow | null;
      return sameTitle ? mapRow(sameTitle) : null;
    }
    const exact = this.db.query("SELECT * FROM papers WHERE title_key = ?").get(titleKey(paper.title)) as
      | PaperRow
      | null;
    if (exact) return mapRow(exact);
    for (const candidate of this.list()) {
      if (canMerge(toPaper(candidate), paper)) return candidate;
    }
    return null;
  }

  get(id: string): LibraryPaper | null {
    const row = this.db.query("SELECT * FROM papers WHERE id = ?").get(id) as PaperRow | null;
    return row ? mapRow(row) : null;
  }

  getByDoi(doi: string): LibraryPaper | null {
    const row = this.db.query("SELECT * FROM papers WHERE doi = ?").get(doi.toLowerCase()) as PaperRow | null;
    return row ? mapRow(row) : null;
  }

  // 按某个源的原生 id 查（如 OpenAlex 的 W...），供引文边解析使用。
  getBySourceId(source: string, value: string): LibraryPaper | null {
    for (const paper of this.list()) {
      if (paper.ids[source as keyof PaperSourceIds] === value) return paper;
    }
    return null;
  }

  list(filter: LibraryFilter = {}): LibraryPaper[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.readingStatus) {
      clauses.push("reading_status = ?");
      params.push(filter.readingStatus);
    }
    if (filter.pdfStatus) {
      clauses.push("pdf_status = ?");
      params.push(filter.pdfStatus);
    }
    if (filter.q) {
      clauses.push("(lower(title) LIKE ? OR lower(coalesce(abstract, '')) LIKE ?)");
      const like = `%${filter.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    // 次序键用 rowid 而不是 id：同一次入库的多篇论文 created_at 完全相同，
    // 用随机 uuid 排序会让 list() 的顺序**每次进程都不一样**。
    // 这不只是显示顺序问题——bibtex key 的冲突后缀（a/b/c）按列表顺序分配，
    // 顺序不定就意味着同一篇论文的引用 key 可能在两次运行之间互换。rowid 即插入顺序，确定。
    const rows = this.db
      .query(`SELECT * FROM papers${where} ORDER BY created_at, rowid`)
      .all(...params) as PaperRow[];
    let papers = rows.map(mapRow);
    // 标签存 JSON 数组，SQL 层不好过滤，放到应用层做。
    if (filter.tag) papers = papers.filter((p) => p.tags.includes(filter.tag!));
    return filter.limit ? papers.slice(0, filter.limit) : papers;
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM papers").get() as { n: number }).n;
  }

  update(
    id: string,
    patch: Partial<Pick<LibraryPaper, "tags" | "readingStatus" | "notes" | "pdfPath" | "pdfStatus" | "pdfReason" | "checksum">>,
  ): LibraryPaper {
    const existing = this.get(id);
    if (!existing) throw new LibraryError(`论文 '${id}' 不在库中`);
    if (patch.readingStatus && !READING_STATUSES.includes(patch.readingStatus)) {
      throw new LibraryError(`未知阅读状态 '${patch.readingStatus}'`);
    }
    if (patch.pdfStatus && !PDF_STATUSES.includes(patch.pdfStatus)) {
      throw new LibraryError(`未知 PDF 状态 '${patch.pdfStatus}'`);
    }
    this.db
      .query(
        `UPDATE papers SET tags = ?, reading_status = ?, notes = ?, pdf_path = ?,
           pdf_status = ?, pdf_reason = ?, checksum = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(patch.tags ?? existing.tags),
        patch.readingStatus ?? existing.readingStatus,
        patch.notes ?? existing.notes,
        patch.pdfPath !== undefined ? patch.pdfPath : existing.pdfPath,
        patch.pdfStatus ?? existing.pdfStatus,
        patch.pdfReason !== undefined ? patch.pdfReason : existing.pdfReason,
        patch.checksum !== undefined ? patch.checksum : existing.checksum,
        new Date().toISOString(),
        id,
      );
    return this.get(id)!;
  }

  remove(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.query("DELETE FROM papers WHERE id = ?").run(id);
    return true;
  }

  // ── 引文边 ────────────────────────────────────────────────────────────────

  link(sourceId: string, targetId: string, origin = "openalex"): LibraryCitation {
    if (sourceId === targetId) throw new LibraryError("论文不能引用自己");
    const source = this.get(sourceId);
    const target = this.get(targetId);
    if (!source) throw new LibraryError(`引用方 '${sourceId}' 不在库中`);
    if (!target) throw new LibraryError(`被引方 '${targetId}' 不在库中`);
    const createdAt = new Date().toISOString();
    this.db
      .query("INSERT OR IGNORE INTO citations (source_id, target_id, origin, created_at) VALUES (?, ?, ?, ?)")
      .run(sourceId, targetId, origin, createdAt);
    // 证据图同步：两端都有 record 时补一条 cites 边（P1 的 EDGE_TYPES 已含 cites）。
    if (this.records && source.recordId && target.recordId) {
      this.records.link(source.recordId, target.recordId, "cites");
    }
    return { sourceId, targetId, origin, createdAt };
  }

  citations(): LibraryCitation[] {
    const rows = this.db.query("SELECT * FROM citations ORDER BY created_at, source_id").all() as Array<{
      source_id: string;
      target_id: string;
      origin: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      origin: r.origin,
      createdAt: r.created_at,
    }));
  }

  citationsOf(id: string): { cites: LibraryCitation[]; citedBy: LibraryCitation[] } {
    const all = this.citations();
    return {
      cites: all.filter((c) => c.sourceId === id),
      citedBy: all.filter((c) => c.targetId === id),
    };
  }

  // 用各篇的 references_raw（OpenAlex referenced_works）重算库内互引边。
  // 每次入库新论文后调用一次，即可把新论文与已有论文的引用关系补齐。
  rebuildCitations(): number {
    const papers = this.list();
    const byOpenAlex = new Map<string, string>();
    for (const paper of papers) {
      if (paper.ids.openalex) byOpenAlex.set(paper.ids.openalex, paper.id);
    }
    let added = 0;
    for (const paper of papers) {
      for (const ref of paper.references) {
        const targetId = byOpenAlex.get(ref.replace(/^https?:\/\/openalex\.org\//i, ""));
        if (!targetId || targetId === paper.id) continue;
        const before = this.citations().length;
        this.link(paper.id, targetId, "openalex");
        if (this.citations().length > before) added++;
      }
    }
    return added;
  }

  close(): void {
    this.db.close();
  }
}

// 便捷构造：从检索结果直接造一个可入库的 Paper（补齐缺省字段）。
export function paperFrom(partial: Partial<Paper> & { title: string }): Paper {
  return { ...emptyPaper(), ...partial };
}
