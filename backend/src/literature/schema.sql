-- Project Library（library.db）：每个 Project 一个，路径由 P1 的 ProjectPaths.libraryDb 给出。
-- 建法与 records.db / artifacts.db 保持一致：IF NOT EXISTS + 幂等，构造时执行。

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  -- 归一化 DOI（小写、去 URL 前缀）；无 DOI 的论文为 NULL。
  doi TEXT,
  title TEXT NOT NULL,
  -- 归一化标题，无 DOI 时的去重 key。
  title_key TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  venue TEXT,
  abstract TEXT,
  url TEXT,
  pdf_url TEXT,
  -- 各源原生 id 的 JSON 映射，如 {"openalex":"W123","pmid":"456"}。
  source_ids TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  cited_by_count INTEGER,
  is_open_access INTEGER,
  -- OpenAlex referenced_works 原始列表，供 rebuildCitations() 重算库内互引边。
  references_raw TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  reading_status TEXT NOT NULL DEFAULT 'unread',
  notes TEXT NOT NULL DEFAULT '',
  pdf_path TEXT,
  -- absent（未尝试）/ downloaded / unavailable
  pdf_status TEXT NOT NULL DEFAULT 'absent',
  -- unavailable 时的明确原因（HTTP 403、无 OA 直链…），不重试轰炸的依据。
  pdf_reason TEXT,
  checksum TEXT,
  -- 入库时自动创建的 record（type: paper）id，接进 P1 的证据图（AD-3 同图不同表）。
  record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- DOI 唯一：同一 DOI 不可能有两条库内记录。NULL 不参与唯一性约束，正合无 DOI 的情况。
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_doi ON papers (doi) WHERE doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_title_key ON papers (title_key);
CREATE INDEX IF NOT EXISTS idx_papers_reading_status ON papers (reading_status);

-- 库内互引边：source 引用 target，两端都必须是库内论文。
CREATE TABLE IF NOT EXISTS citations (
  source_id TEXT NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES papers (id) ON DELETE CASCADE,
  -- 引文数据的来源（当前只有 openalex 的 referenced_works）。
  origin TEXT NOT NULL DEFAULT 'openalex',
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_citations_target ON citations (target_id);
