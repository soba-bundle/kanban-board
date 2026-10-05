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
      title TEXT NOT NULL, description TEXT NOT NULL, workflow_state TEXT NOT NULL, review_tag TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE task_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), stage TEXT, sequence INTEGER,
      status TEXT, return_review_tag TEXT, handover_json TEXT);
    CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_runs(id),
      queue_position INTEGER, priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT);
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
    INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
      VALUES ('t1', 'p1', 'Task', '', 'REVIEW', 'READY_TO_MERGE', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO task_runs (id, task_id, stage, handover_json) VALUES
      ('r1', 't1', 'INVESTIGATION', '{"stage":"INVESTIGATION","summary":"legacy handover"}'),
      ('r-validation', 't1', 'VALIDATION_REVIEW', NULL);
    INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, status, created_at, answered_at) VALUES
      ('h1', 't1', 'r1', 's1', 'call1', 'Legacy question', '["Yes"]', 'Yes', 'ANSWERED',
        '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO ticket_comments VALUES ('c1', 't1', 'legacy guidance');`);
  legacy.close();

  db = openDatabase(path);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 15);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_comments'").get(), undefined);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'git_sync_attempts'").get());
  assert.deepEqual(db.prepare("SELECT id, status FROM git_sync_attempts").all(), []);
  assert.deepEqual(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 't1'").get(), {
    workflow_state: "REVIEW", review_tag: "READY_TO_MERGE",
  });
  assert.deepEqual(db.prepare("SELECT id, stage, handover_json FROM task_runs ORDER BY id").all(), [
    { id: "r-validation", stage: "VALIDATION_REVIEW", handover_json: null },
    { id: "r1", stage: "INVESTIGATION", handover_json: '{"stage":"INVESTIGATION","summary":"legacy handover"}' },
  ]);
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
    "failure_reason", "reused_from_input_id", "session_sequence", "transcript_boundary_entry_id", "delivery_intent_at",
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

test("version 13 preserves and safely interrupts earlier in-flight sync attempts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-sync-upgrade-"));
  const path = join(dir, "sync.sqlite");
  let db = openDatabase(path);
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(`INSERT INTO git_sync_attempts (id, task_id, status, base_sha, prior_base_sha, base_branch,
    task_branch, prior_task_sha, started_at) VALUES ('old-attempt', 'deleted-task', 'RUNNING', 'base', 'prior',
    'main', 'task-branch', 'task-head', '2025-01-01T00:00:00.000Z')`).run();
  db.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
  db.prepare("DROP INDEX git_sync_attempts_one_active").run();
  db.close();

  db = openDatabase(path);
  const attempt = db.prepare("SELECT id, status, error_message FROM git_sync_attempts WHERE id = 'old-attempt'").get();
  assert.equal(attempt.status, "INTERRUPTED");
  assert.match(attempt.error_message, /interrupted during application upgrade/i);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 15);
});

test("version 14 retires queued Validation work without deleting history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-validation-retirement-"));
  const path = join(dir, "retire.sqlite");
  let db = openDatabase(path);
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const now = "2025-01-01T00:00:00.000Z";
  db.prepare("DELETE FROM schema_migrations WHERE version = 14").run();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p', 'Project', '/tmp/p', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, return_workflow_state, return_review_tag)
    VALUES ('queued-validation', 't', 'VALIDATION_REVIEW', 1, 'QUEUED', 'REVIEW', 'WORK_COMPLETE'),
      ('running-validation', 't', 'VALIDATION_REVIEW', 2, 'RUNNING', 'REVIEW', 'WORK_COMPLETE'),
      ('old-validation', 't', 'VALIDATION_REVIEW', 3, 'COMPLETED', 'REVIEW', 'WORK_COMPLETE')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content, delivery_type, delivery_status, accepted_at)
    VALUES ('input-q', 't', 'queued-validation', 1, 'q', 'prompt', 'INITIAL_PROMPT', 'PENDING', ?),
      ('input-r', 't', 'running-validation', 1, 'r', 'prompt', 'INITIAL_PROMPT', 'ACCEPTED', ?)`).run(now, now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('job-q', 'queued-validation', 1, 1, 'QUEUED', ?), ('job-r', 'running-validation', NULL, 1, 'CLAIMED', ?),
      ('job-stale', 'old-validation', 2, 1, 'QUEUED', ?)`)
    .run(now, now, now);
  db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at)
    VALUES ('result-old', 't', 'old-validation', 'ISSUES_FOUND', '[{"summary":"historical"}]', ?)`).run(now);
  db.prepare(`INSERT INTO merge_attempts (id, task_id, approval_status, validated_base_sha, validated_task_sha,
    status, priority_validation_run_id) VALUES ('old-attempt', 't', 'APPROVED', 'base', 'candidate',
    'APPROVED', 'running-validation')`).run();
  db.close();

  db = openDatabase(path);
  assert.deepEqual(db.prepare("SELECT id, status FROM task_runs ORDER BY id").all(), [
    { id: "old-validation", status: "COMPLETED" },
    { id: "queued-validation", status: "CANCELLED" },
    { id: "running-validation", status: "FAILED" },
  ]);
  assert.deepEqual(db.prepare("SELECT id, status FROM agent_jobs ORDER BY id").all(), [
    { id: "job-q", status: "CANCELLED" }, { id: "job-r", status: "FINISHED" },
    { id: "job-stale", status: "CANCELLED" },
  ]);
  assert.deepEqual(db.prepare("SELECT id, delivery_status FROM run_inputs ORDER BY id").all(), [
    { id: "input-q", delivery_status: "UNDELIVERED" }, { id: "input-r", delivery_status: "DELIVERY_UNKNOWN" },
  ]);
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 't'").get().review_tag, "WORK_COMPLETE");
  assert.equal(db.prepare("SELECT findings_json FROM validation_results WHERE id = 'result-old'").get().findings_json,
    '[{"summary":"historical"}]');
  assert.deepEqual(db.prepare("SELECT approval_status, status, error_reason FROM merge_attempts WHERE id = 'old-attempt'").get(), {
    approval_status: "REVOKED", status: "VALIDATION_RETIRED", error_reason: "Automated Validation was retired.",
  });
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 15);
});

test("fresh databases apply migrations through validation result and run schemas", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 15);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_comments'").get(), undefined);
  assert.deepEqual(db.prepare("PRAGMA table_info(validation_snapshots)").all().map((column) => column.name), [
    "id", "task_id", "validation_run_id", "validated_task_sha", "validated_base_sha",
    "result", "created_at", "messages_watermark",
  ]);
  assert.deepEqual(db.prepare("PRAGMA table_info(git_sync_attempts)").all().map((column) => column.name), [
    "id", "task_id", "status", "base_sha", "prior_base_sha", "base_branch", "task_branch",
    "prior_task_sha", "prior_task_recorded_sha", "candidate_sha", "conflict_state_token",
    "started_at", "completed_at", "error_message",
  ]);
  for (const column of ["validation_context_json", "validation_base_tip_sha", "validation_guidance_watermark",
    "validation_task_head_sha", "validation_worktree_path"]) {
    assert.ok(db.prepare("PRAGMA table_info(task_runs)").all().some((entry) => entry.name === column),
      `task_runs must persist ${column} to dispatch a queued validation without replaying the working session`);
  }
});
