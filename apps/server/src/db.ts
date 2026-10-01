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
  error_reason TEXT,
  base_branch TEXT,
  priority_validation_run_id TEXT,
  sync_base_sha TEXT,
  sync_candidate_sha TEXT
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

  const runInputsApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
  if (!runInputsApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE task_runs ADD COLUMN transcript_start_entry_id TEXT;
        ALTER TABLE task_runs ADD COLUMN transcript_end_entry_id TEXT;
        ALTER TABLE validation_snapshots ADD COLUMN messages_watermark TEXT;

        CREATE TABLE run_inputs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          run_id TEXT NOT NULL REFERENCES task_runs(id),
          sequence INTEGER NOT NULL,
          idempotency_key TEXT NOT NULL,
          content TEXT NOT NULL,
          delivery_type TEXT NOT NULL CHECK (delivery_type IN ('INITIAL_PROMPT', 'QUEUED_INPUT', 'STEERING')),
          delivery_status TEXT NOT NULL CHECK (delivery_status IN
            ('PENDING', 'ACCEPTED', 'DELIVERED', 'UNDELIVERED', 'DELIVERY_UNKNOWN', 'CANCELLED')),
          accepted_at TEXT NOT NULL,
          delivered_at TEXT,
          session_id TEXT,
          transcript_entry_id TEXT,
          failure_reason TEXT,
          reused_from_input_id TEXT REFERENCES run_inputs(id),
          UNIQUE (run_id, sequence),
          UNIQUE (task_id, idempotency_key)
        );
        CREATE INDEX run_inputs_task_sequence ON run_inputs(task_id, sequence);
        CREATE INDEX run_inputs_run_sequence ON run_inputs(run_id, sequence);`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const steeringSequenceApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get();
  if (!steeringSequenceApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE task_runs ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'QUEUED';
        ALTER TABLE task_runs ADD COLUMN handover_input_sequence INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE run_inputs ADD COLUMN session_sequence INTEGER;
        ALTER TABLE run_inputs ADD COLUMN transcript_boundary_entry_id TEXT;
        CREATE UNIQUE INDEX run_inputs_session_sequence ON run_inputs(session_id, session_sequence)
          WHERE session_id IS NOT NULL AND session_sequence IS NOT NULL;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const liveHistoryApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
  if (!liveHistoryApplied) {
    const migrate = db.transaction(() => {
      db.exec(`CREATE TABLE run_transcript_entries (
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        PRIMARY KEY (session_id, entry_id),
        UNIQUE (run_id, sequence)
      );
      CREATE INDEX run_transcript_entries_run ON run_transcript_entries(run_id, sequence);`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const ticketCommentsRetired = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get();
  if (!ticketCommentsRetired) {
    const migrate = db.transaction(() => {
      db.exec(`DROP TABLE ticket_comments;
        ALTER TABLE validation_snapshots DROP COLUMN comments_watermark;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const structuredHumanRequestsApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get();
  if (!structuredHumanRequestsApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE human_requests ADD COLUMN questions_json TEXT;
        ALTER TABLE human_requests ADD COLUMN answers_json TEXT;
        CREATE UNIQUE INDEX human_requests_session_tool_call
          ON human_requests(session_id, tool_call_id)
          WHERE session_id IS NOT NULL AND tool_call_id IS NOT NULL;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const validationResultsApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get();
  if (!validationResultsApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE validation_results ADD COLUMN candidate_sha TEXT;
        ALTER TABLE validation_results ADD COLUMN base_sha TEXT;
        ALTER TABLE validation_results ADD COLUMN base_tip_at_start TEXT;
        ALTER TABLE validation_results ADD COLUMN base_tip_at_finish TEXT;
        ALTER TABLE validation_results ADD COLUMN guidance_watermark TEXT;
        ALTER TABLE validation_results ADD COLUMN task_head_at_start TEXT;
        ALTER TABLE validation_results ADD COLUMN task_head_at_finish TEXT;
        ALTER TABLE validation_results ADD COLUMN task_worktree_clean_at_start INTEGER;
        ALTER TABLE validation_results ADD COLUMN task_worktree_clean_at_finish INTEGER;
        ALTER TABLE validation_results ADD COLUMN validation_worktree_clean INTEGER;
        ALTER TABLE validation_results ADD COLUMN validation_worktree_path TEXT;
        ALTER TABLE validation_results ADD COLUMN cleanup_status TEXT;
        ALTER TABLE validation_results ADD COLUMN failure_kind TEXT;
        ALTER TABLE validation_results ADD COLUMN failure_message TEXT;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const validationRunsApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get();
  if (!validationRunsApplied) {
    const migrate = db.transaction(() => {
      db.exec(`ALTER TABLE task_runs ADD COLUMN validation_context_json TEXT;
        ALTER TABLE task_runs ADD COLUMN validation_base_tip_sha TEXT;
        ALTER TABLE task_runs ADD COLUMN validation_guidance_watermark INTEGER;
        ALTER TABLE task_runs ADD COLUMN validation_task_head_sha TEXT;
        ALTER TABLE task_runs ADD COLUMN validation_worktree_path TEXT;`);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  const mergeAttemptsApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get();
  if (!mergeAttemptsApplied) {
    const migrate = db.transaction(() => {
      const columns = new Set((db.prepare("PRAGMA table_info(merge_attempts)").all() as Array<{ name: string }>).map((column) => column.name));
      if (columns.size === 0) {
        db.exec(`CREATE TABLE merge_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          validation_snapshot_id TEXT REFERENCES validation_snapshots(id), approval_status TEXT NOT NULL,
          validated_base_sha TEXT NOT NULL, validated_task_sha TEXT NOT NULL, status TEXT NOT NULL,
          started_at TEXT, completed_at TEXT, error_reason TEXT)`);
      }
      for (const [name, type] of [["base_branch", "TEXT"], ["priority_validation_run_id", "TEXT"],
        ["sync_base_sha", "TEXT"], ["sync_candidate_sha", "TEXT"]] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE merge_attempts ADD COLUMN ${name} ${type}`);
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?)").run(new Date().toISOString());
    });
    migrate();
  }

  return db;
}
