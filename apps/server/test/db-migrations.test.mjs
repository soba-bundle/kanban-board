import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../dist/db.js";

test("migrations retire ticket comments and preserve legacy Human Requests and transcript schema", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-db-migration-"));
  const path = join(dir, "legacy.sqlite");
  let db;
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const legacy = new Database(path);
  legacy.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, '2025-01-01T00:00:00.000Z');
    INSERT INTO schema_migrations VALUES (2, '2025-01-01T00:00:00.000Z');
    INSERT INTO schema_migrations VALUES (3, '2025-01-01T00:00:00.000Z');
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ide_command TEXT, worktree_root TEXT,
      is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, description TEXT NOT NULL, workflow_state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE task_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id));
    CREATE TABLE human_requests (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      run_id TEXT NOT NULL REFERENCES task_runs(id), session_id TEXT, tool_call_id TEXT,
      question TEXT NOT NULL, options_json TEXT, answer TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, answered_at TEXT);
    CREATE TABLE ticket_comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), content TEXT NOT NULL);
    CREATE TABLE validation_results (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      run_id TEXT NOT NULL REFERENCES task_runs(id), result TEXT NOT NULL, findings_json TEXT,
      build_result_json TEXT, test_result_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE validation_snapshots (
      id TEXT PRIMARY KEY, comments_watermark TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES
      ('p1', 'Project', '/tmp/project', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
      VALUES ('t1', 'p1', 'Task', '', 'TODO', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO task_runs (id, task_id) VALUES ('r1', 't1');
    INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, status, created_at, answered_at) VALUES
      ('h1', 't1', 'r1', 's1', 'call1', 'Legacy question', '["Yes"]', 'Yes', 'ANSWERED',
        '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO ticket_comments VALUES ('c1', 't1', 'legacy guidance');`);
  legacy.close();

  db = openDatabase(path);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 11);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_comments'").get(), undefined);
  assert.deepEqual(db.prepare("SELECT transcript_start_entry_id, transcript_end_entry_id FROM task_runs WHERE id = 'r1'").get(), {
    transcript_start_entry_id: null,
    transcript_end_entry_id: null,
  });
  assert.deepEqual(db.prepare("PRAGMA table_info(validation_results)").all().map((column) => column.name), [
    "id", "task_id", "run_id", "result", "findings_json", "build_result_json", "test_result_json", "created_at",
    "candidate_sha", "base_sha", "base_tip_at_start", "base_tip_at_finish", "guidance_watermark",
    "task_head_at_start", "task_head_at_finish", "task_worktree_clean_at_start", "task_worktree_clean_at_finish",
    "validation_worktree_clean", "validation_worktree_path", "cleanup_status", "failure_kind", "failure_message",
  ]);
  assert.deepEqual(db.prepare("PRAGMA table_info(validation_snapshots)").all().map((column) => column.name), [
    "id", "result", "created_at", "messages_watermark",
  ]);
  assert.deepEqual(db.prepare("PRAGMA table_info(run_inputs)").all().map((column) => column.name), [
    "id", "task_id", "run_id", "sequence", "idempotency_key", "content", "delivery_type",
    "delivery_status", "accepted_at", "delivered_at", "session_id", "transcript_entry_id",
    "failure_reason", "reused_from_input_id", "session_sequence", "transcript_boundary_entry_id",
  ]);
  assert.deepEqual(db.prepare("PRAGMA table_info(run_transcript_entries)").all().map((column) => column.name), [
    "session_id", "entry_id", "run_id", "sequence",
  ]);
  assert.deepEqual(db.prepare(`SELECT question, options_json, answer, status, questions_json, answers_json
    FROM human_requests WHERE id = 'h1'`).get(), {
    question: "Legacy question", options_json: '["Yes"]', answer: "Yes", status: "ANSWERED",
    questions_json: null, answers_json: null,
  });
  assert.throws(() => db.prepare(`INSERT INTO run_inputs
    (id, task_id, run_id, sequence, idempotency_key, content, delivery_type, delivery_status, accepted_at)
    VALUES ('i1', 't1', 'r1', 1, 'k1', 'text', 'STEERING', 'NOPE', '2025-01-01T00:00:00.000Z')`).run(), /CHECK constraint failed/);
});

test("fresh databases apply migrations through validation result and run schemas", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 11);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_comments'").get(), undefined);
  assert.deepEqual(db.prepare("PRAGMA table_info(validation_snapshots)").all().map((column) => column.name), [
    "id", "task_id", "validation_run_id", "validated_task_sha", "validated_base_sha",
    "result", "created_at", "messages_watermark",
  ]);
  for (const column of ["validation_context_json", "validation_base_tip_sha", "validation_guidance_watermark",
    "validation_task_head_sha", "validation_worktree_path"]) {
    assert.ok(db.prepare("PRAGMA table_info(task_runs)").all().some((entry) => entry.name === column),
      `task_runs must persist ${column} to dispatch a queued validation without replaying the working session`);
  }
});
