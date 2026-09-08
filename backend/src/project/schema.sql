CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL,
  origin_kind TEXT NOT NULL DEFAULT 'manual',
  origin_ref TEXT,
  origin_connector TEXT,
  session_id TEXT,
  artifact_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_type ON records (type, created_at);
CREATE INDEX IF NOT EXISTS idx_records_session ON records (session_id);
CREATE INDEX IF NOT EXISTS idx_records_artifact ON records (artifact_id);

CREATE TABLE IF NOT EXISTS record_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, type),
  FOREIGN KEY (source_id) REFERENCES records (id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES records (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_record_edges_target ON record_edges (target_id);
CREATE INDEX IF NOT EXISTS idx_record_edges_type ON record_edges (type);
