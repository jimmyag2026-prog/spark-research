CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  project_slug TEXT,
  filename TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  checksum TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_code TEXT,
  code_description TEXT,
  lineage_messages TEXT NOT NULL DEFAULT '[]',
  environment_snapshot TEXT,
  parent_version_id TEXT,
  producing_cell_id TEXT,
  dependency_mappings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (project, filename, version)
);

-- project_slug 上的索引在 store.ts 的 migrate() 里建，
-- 因为老库要先 ALTER TABLE 补出这一列才能建索引。
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project, filename);

CREATE TABLE IF NOT EXISTS dependencies (
  source_version_id TEXT NOT NULL,
  target_version_id TEXT NOT NULL,
  PRIMARY KEY (source_version_id, target_version_id)
);

CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies (target_version_id);

CREATE TABLE IF NOT EXISTS execution_records (
  id TEXT PRIMARY KEY,
  frame TEXT NOT NULL,
  cell_index INTEGER NOT NULL,
  kernel_id TEXT,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  files_written TEXT NOT NULL DEFAULT '[]',
  files_read TEXT NOT NULL DEFAULT '[]',
  wall_time REAL,
  cpu_time REAL,
  peak_memory INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_records_frame ON execution_records (frame);
