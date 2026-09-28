import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../dist/db.js";

test("migration 4 adds run inputs and transcript boundaries without deleting legacy comments", (t) => {
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
    CREATE TABLE ticket_comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), content TEXT NOT NULL);
    CREATE TABLE validation_snapshots (id TEXT PRIMARY KEY);
    INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES
      ('p1', 'Project', '/tmp/project', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
      VALUES ('t1', 'p1', 'Task', '', 'TODO', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    INSERT INTO task_runs (id, task_id) VALUES ('r1', 't1');
    INSERT INTO ticket_comments VALUES ('c1', 't1', 'legacy guidance');`);
  legacy.close();

  db = openDatabase(path);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 6);
  assert.deepEqual(db.prepare("SELECT id, content FROM ticket_comments").all(), [
    { id: "c1", content: "legacy guidance" },
  ]);
  assert.deepEqual(db.prepare("SELECT transcript_start_entry_id, transcript_end_entry_id FROM task_runs WHERE id = 'r1'").get(), {
    transcript_start_entry_id: null,
    transcript_end_entry_id: null,
  });
  assert.equal(db.prepare("SELECT messages_watermark FROM validation_snapshots").all().length, 0);
  assert.deepEqual(db.prepare("PRAGMA table_info(run_inputs)").all().map((column) => column.name), [
    "id", "task_id", "run_id", "sequence", "idempotency_key", "content", "delivery_type",
    "delivery_status", "accepted_at", "delivered_at", "session_id", "transcript_entry_id",
    "failure_reason", "reused_from_input_id", "session_sequence", "transcript_boundary_entry_id",
  ]);
  assert.deepEqual(db.prepare("PRAGMA table_info(run_transcript_entries)").all().map((column) => column.name), [
    "session_id", "entry_id", "run_id", "sequence",
  ]);
  assert.throws(() => db.prepare(`INSERT INTO run_inputs
    (id, task_id, run_id, sequence, idempotency_key, content, delivery_type, delivery_status, accepted_at)
    VALUES ('i1', 't1', 'r1', 1, 'k1', 'text', 'STEERING', 'NOPE', '2025-01-01T00:00:00.000Z')`).run(), /CHECK constraint failed/);
});

test("fresh databases apply migrations through live-history schema", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 6);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_comments'").get().name, "ticket_comments");
});
