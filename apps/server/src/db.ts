import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const initialSchema = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  review_tag TEXT,
  working_session_id TEXT,
  working_session_file TEXT,
  base_branch TEXT,
  base_commit_sha TEXT,
  agent_branch TEXT,
  worktree_path TEXT,
  cleanup_status TEXT,
  latest_task_commit_sha TEXT,
  active_validation_snapshot_id TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  stage TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  session_id TEXT,
  session_file TEXT,
  status TEXT NOT NULL,
  reason_code TEXT,
  return_workflow_state TEXT,
  return_review_tag TEXT,
  handover_json TEXT,
  task_commit_sha TEXT,
  started_at TEXT,
  completed_at TEXT,
  interrupted_at TEXT,
  error_message TEXT
);

CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id),
  queue_position INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES task_runs(id),
  author_type TEXT NOT NULL,
  content TEXT NOT NULL,
  delivery_status TEXT,
  delivery_type TEXT,
  delivered_session_id TEXT,
  delivered_run_id TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE human_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  session_id TEXT,
  tool_call_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT,
  answer TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE validation_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  result TEXT NOT NULL,
  findings_json TEXT,
  build_result_json TEXT,
  test_result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE validation_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  validation_run_id TEXT NOT NULL REFERENCES task_runs(id),
  validated_task_sha TEXT NOT NULL,
  validated_base_sha TEXT NOT NULL,
  comments_watermark TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE merge_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  validation_snapshot_id TEXT REFERENCES validation_snapshots(id),
  approval_status TEXT NOT NULL,
  validated_base_sha TEXT NOT NULL,
  validated_task_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_reason TEXT
);
`;

export function openDatabase(filename = process.env.KANBAN_DB_PATH ?? "data/kanban.sqlite") {
  const path = filename === ":memory:" ? filename : resolve(filename);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get();
  if (!applied) {
    const migrate = db.transaction(() => {
      db.exec(initialSchema);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const projectSettingsApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get();
  if (!projectSettingsApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE projects ADD COLUMN ide_command TEXT;
        ALTER TABLE projects ADD COLUMN worktree_root TEXT;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const softDeleteApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
  if (!softDeleteApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE projects ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  return db;
}
