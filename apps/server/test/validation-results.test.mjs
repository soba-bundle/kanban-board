import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";

let recordValidationResult;
let invalidateStaleValidationReadiness;
let importError;
try {
  ({ recordValidationResult, invalidateStaleValidationReadiness } = await import("../dist/agents/validation-results.js"));
} catch (error) {
  importError = error;
}

const taskSha = "c".repeat(40);
const baseSha = "b".repeat(40);

function setup(t, tag = "IMPLEMENTATION_COMPLETE") {
  assert.equal(typeof recordValidationResult, "function",
    `Expected validation result persistence; ${importError?.message ?? "export is missing"}`);
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag,
    base_commit_sha, latest_task_commit_sha, created_at, updated_at)
    VALUES ('t', 'p', 'Task', 'Description', 'REVIEW', ?, ?, ?, ?, ?)`)
    .run(tag, baseSha, taskSha, now, now);
  const insertRun = (id, sequence) => db.prepare(`INSERT INTO task_runs
    (id, task_id, stage, sequence, status) VALUES (?, 't', 'VALIDATION_REVIEW', ?, 'COMPLETED')`).run(id, sequence);
  insertRun("validation-1", 1);
  t.after(() => db.close());
  return { db, insertRun };
}

function finding(attribution, overrides = {}) {
  return {
    id: `${attribution.toLowerCase()}-finding`, attribution,
    summary: `${attribution} finding summary`,
    rationale: `${attribution} attribution rationale`,
    evidence: "Reproduced with the supplied validation input.",
    locations: [{ file: "src/example.ts", line: 12 }],
    ...overrides,
  };
}

async function record(db, report, runId = "validation-1", overrides = {}) {
  await recordValidationResult(db, {
    task_id: "t", run_id: runId, candidate_sha: taskSha, base_sha: baseSha,
    base_tip_at_start: baseSha, base_tip_at_finish: baseSha,
    guidance_watermark: "cursor-3", report, ...overrides,
  });
}

function task(db) {
  return db.prepare("SELECT workflow_state, review_tag, active_validation_snapshot_id FROM tasks WHERE id = 't'").get();
}

test("a clean report persists an immutable active snapshot and becomes Ready to Merge", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] });
  assert.deepEqual(task(db), {
    workflow_state: "REVIEW", review_tag: "READY_TO_MERGE",
    active_validation_snapshot_id: db.prepare("SELECT id FROM validation_snapshots WHERE task_id = 't'").pluck().get(),
  });
  const result = db.prepare("SELECT result, findings_json FROM validation_results WHERE task_id = 't'").get();
  assert.equal(result.result, "PASSED");
  assert.deepEqual(JSON.parse(result.findings_json), []);
  const snapshot = db.prepare("SELECT validated_task_sha, validated_base_sha, messages_watermark, result FROM validation_snapshots WHERE task_id = 't'").get();
  assert.deepEqual(snapshot, {
    validated_task_sha: taskSha, validated_base_sha: baseSha, messages_watermark: "cursor-3", result: "PASSED",
  });
});

test("indirect-only findings remain visible and active while direct, mixed, or uncertain findings stay inactive", async (t) => {
  for (const [name, findings, expectedTag, active] of [
    ["indirect", [finding("INDIRECT")], "READY_TO_MERGE", true],
    ["direct", [finding("DIRECT")], "VALIDATION_ISSUES", false],
    ["mixed", [finding("DIRECT"), finding("INDIRECT", { id: "indirect-2" })], "VALIDATION_ISSUES", false],
    ["uncertain", [finding("UNCERTAIN")], "VALIDATION_ISSUES", false],
  ]) {
    await t.test(name, async (t2) => {
      const { db } = setup(t2);
      await record(db, { findings });
      const stored = db.prepare("SELECT result, findings_json FROM validation_results WHERE task_id = 't'").get();
      assert.equal(stored.result, "ISSUES_FOUND");
      assert.deepEqual(JSON.parse(stored.findings_json), findings);
      assert.equal(task(db).review_tag, expectedTag);
      const snapshot = db.prepare("SELECT id, result FROM validation_snapshots WHERE task_id = 't'").get();
      assert.ok(snapshot, "completed structured findings must be retained in a snapshot");
      assert.equal(snapshot.result, "ISSUES_FOUND");
      assert.equal(Boolean(task(db).active_validation_snapshot_id), active);
    });
  }
});

test("malformed reports and infrastructure failures persist Validation Failed without snapshots", async (t) => {
  for (const [name, input] of [
    ["malformed", { report: { findings: [{ attribution: "DIRECT" }] } }],
    ["infrastructure", { failure: { kind: "SESSION_ERROR", message: "provider failed" } }],
    ["tool", { failure: { kind: "TOOL_ERROR", message: "review tool failed" } }],
  ]) {
    await t.test(name, async (t2) => {
      const { db } = setup(t2);
      await record(db, input.report ?? null, "validation-1", { failure: input.failure });
      assert.equal(task(db).review_tag, "VALIDATION_FAILED");
      assert.equal(db.prepare("SELECT COUNT(*) FROM validation_snapshots").pluck().get(), 0);
      assert.equal(db.prepare("SELECT result FROM validation_results").get()?.result, "VALIDATION_FAILED");
    });
  }
});

test("tracked mutation in the detached Validation worktree overrides a claimed pass", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] }, "validation-1", { validation_worktree_clean: false });
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "VALIDATION_FAILED");
  assert.equal(db.prepare("SELECT COUNT(*) FROM validation_snapshots").pluck().get(), 0);
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
});

test("a complete stale report remains historical but cannot activate readiness", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [finding("INDIRECT")] }, "validation-1", {
    base_tip_at_finish: "d".repeat(40),
  });
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.equal(db.prepare("SELECT result FROM validation_snapshots").get().result, "STALE");
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "STALE");
});

test("live base tip is reread at report finalization before readiness activation", async (t) => {
  const { db } = setup(t);
  let reads = 0;
  await record(db, { findings: [] }, "validation-1", {
    read_live_base_tip: () => { reads++; return "d".repeat(40); },
  });
  assert.equal(reads, 1);
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "STALE");
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
});

test("partial persistence failure cannot leave a result or snapshot falsely merge-ready", async (t) => {
  const { db } = setup(t);
  db.exec(`CREATE TRIGGER fail_ready_activation BEFORE UPDATE ON tasks
    WHEN NEW.review_tag = 'READY_TO_MERGE'
    BEGIN SELECT RAISE(ABORT, 'simulated readiness activation crash'); END;`);
  await assert.rejects(record(db, { findings: [] }), /simulated readiness activation crash/i);
  assert.equal(db.prepare("SELECT COUNT(*) FROM validation_results").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM validation_snapshots").pluck().get(), 0);
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.equal(task(db).review_tag, "IMPLEMENTATION_COMPLETE");
});

test("a base tip move after readiness clears the active pointer but preserves the historical snapshot", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] });
  const before = db.prepare("SELECT * FROM validation_snapshots WHERE task_id = 't'").get();
  assert.ok(task(db).active_validation_snapshot_id);
  assert.equal(typeof invalidateStaleValidationReadiness, "function",
    `Expected live-base readiness invalidation; ${importError?.message ?? "export is missing"}`);
  await invalidateStaleValidationReadiness(db, "t", "d".repeat(40));
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.deepEqual(db.prepare("SELECT * FROM validation_snapshots WHERE id = ?").get(before.id), before);
  assert.equal(db.prepare("SELECT result FROM validation_results WHERE task_id = 't'").get().result, "PASSED");
});

test("candidate change between snapshot creation and readiness activation prevents activation", async (t) => {
  const { db } = setup(t);
  const movedSha = "d".repeat(40);
  db.exec(`CREATE TRIGGER advance_checkpoint_after_snapshot AFTER INSERT ON validation_snapshots
    BEGIN UPDATE tasks SET latest_task_commit_sha = '${movedSha}' WHERE id = 't'; END;`);
  await record(db, { findings: [] });
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "STALE");
});

test("task worktree HEAD change during validation makes the candidate stale", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] }, "validation-1", {
    task_head_at_finish: "d".repeat(40), task_worktree_clean_at_finish: true,
  });
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "STALE");
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
});

test("task worktree becoming dirty during validation makes the candidate stale", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] }, "validation-1", { task_worktree_clean_at_finish: false });
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "STALE");
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
});

test("candidate changes after report capture make the result stale and never merge-ready", async (t) => {
  const { db } = setup(t);
  db.prepare("UPDATE tasks SET latest_task_commit_sha = ? WHERE id = 't'").run("d".repeat(40));
  await record(db, { findings: [] });
  assert.equal(db.prepare("SELECT result FROM validation_results").get().result, "STALE");
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.notEqual(task(db).review_tag, "READY_TO_MERGE");
  assert.equal(db.prepare("SELECT validated_task_sha FROM validation_snapshots").get().validated_task_sha, taskSha);
});

test("an older late result cannot clear or replace readiness from a newer attempt", async (t) => {
  const { db, insertRun } = setup(t);
  insertRun("validation-2", 2);
  await record(db, { findings: [] }, "validation-2");
  const currentSnapshot = task(db).active_validation_snapshot_id;
  await record(db, { findings: [finding("DIRECT")] }, "validation-1");
  assert.equal(task(db).review_tag, "READY_TO_MERGE");
  assert.equal(task(db).active_validation_snapshot_id, currentSnapshot);
  assert.equal(db.prepare("SELECT COUNT(*) FROM validation_snapshots").pluck().get(), 2);
});

test("task worktree changes after readiness clear the active snapshot without rewriting its history", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] });
  const before = db.prepare("SELECT * FROM validation_snapshots WHERE task_id = 't'").get();
  assert.equal(invalidateStaleValidationReadiness(db, "t", baseSha, { head_sha: taskSha, dirty: true }), true);
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.deepEqual(db.prepare("SELECT * FROM validation_snapshots WHERE id = ?").get(before.id), before);
});

test("task HEAD change after readiness clears the active snapshot without rewriting its history", async (t) => {
  const { db } = setup(t);
  await record(db, { findings: [] });
  const before = db.prepare("SELECT * FROM validation_snapshots WHERE task_id = 't'").get();
  assert.equal(invalidateStaleValidationReadiness(db, "t", baseSha, { head_sha: "d".repeat(40), dirty: false }), true);
  assert.equal(task(db).active_validation_snapshot_id, null);
  assert.deepEqual(db.prepare("SELECT * FROM validation_snapshots WHERE id = ?").get(before.id), before);
});

test("a new checkpoint and fresh report replace readiness without mutating the prior snapshot", async (t) => {
  const { db, insertRun } = setup(t);
  await record(db, { findings: [finding("DIRECT")] });
  const prior = db.prepare("SELECT * FROM validation_snapshots WHERE task_id = 't'").get();
  const newSha = "e".repeat(40);
  db.prepare("UPDATE tasks SET latest_task_commit_sha = ?, review_tag = 'IMPLEMENTATION_COMPLETE' WHERE id = 't'").run(newSha);
  insertRun("validation-2", 2);
  await record(db, { findings: [] }, "validation-2", { candidate_sha: newSha });
  const current = task(db);
  assert.equal(current.review_tag, "READY_TO_MERGE");
  assert.equal(db.prepare("SELECT validated_task_sha FROM validation_snapshots WHERE id = ?").get(prior.id).validated_task_sha, taskSha);
  assert.equal(db.prepare("SELECT COUNT(*) FROM validation_snapshots WHERE task_id = 't'").pluck().get(), 2);
  assert.equal(db.prepare("SELECT validated_task_sha FROM validation_snapshots WHERE id = ?").get(current.active_validation_snapshot_id).validated_task_sha, newSha);
});
