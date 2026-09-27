import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { createHandoverTool, readHandover } from "../dist/agents/handover-tool.js";

function makeDb(stage = "INVESTIGATION") {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', ?, 1, 'RUNNING')`).run(stage);
  return db;
}

function makeTool(db, runId = "run-1") {
  return createHandoverTool(db, { activeRunId: () => runId });
}

const call = (tool, params) => tool.execute("call-1", params, undefined, undefined, {});

test("tool metadata is stable and stage agnostic", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const tool = makeTool(db);
  assert.equal(tool.name, "submit_handover");
  // One registered schema serves both stages because Pi fixes tools at session creation.
  assert.deepEqual(tool.parameters.properties.stage.anyOf.map((v) => v.const), ["INVESTIGATION", "IMPLEMENTATION"]);
  assert.equal(tool.parameters.required.includes("confidence"), false);
  assert.equal(tool.parameters.required.includes("files_changed"), false);
  assert.deepEqual([...tool.parameters.required].sort(), ["recommended_next_step", "stage", "summary"]);
});

test("valid investigation handover is persisted with defaults applied", async (t) => {
  const db = makeDb("INVESTIGATION");
  t.after(() => db.close());
  const result = await call(makeTool(db), {
    stage: "INVESTIGATION",
    summary: "Abort signal is dropped by the retry wrapper",
    confidence: "HIGH",
    outcome: "Root cause identified",
    affected_files: ["src/retry.ts"],
    recommended_next_step: "IMPLEMENT",
  });
  assert.match(result.content[0].text, /Handover recorded/);

  const stored = readHandover(db, "run-1");
  assert.equal(stored.confidence, "HIGH");
  assert.deepEqual(stored.affected_files, ["src/retry.ts"]);
  assert.deepEqual(stored.evidence, []);
  assert.equal(stored.root_cause, null);
  assert.equal(stored.human_verification_required, false);
});

test("investigation payload missing required fields is rejected with field names", async (t) => {
  const db = makeDb("INVESTIGATION");
  t.after(() => db.close());
  await assert.rejects(
    () => call(makeTool(db), {
      stage: "INVESTIGATION",
      summary: "No confidence or outcome",
      recommended_next_step: "IMPLEMENT",
    }),
    (error) => {
      assert.match(error.message, /Handover rejected for INVESTIGATION/);
      assert.match(error.message, /confidence/);
      assert.match(error.message, /outcome/);
      assert.match(error.message, /call submit_handover again/);
      return true;
    },
  );
  assert.equal(readHandover(db, "run-1"), undefined);
});

test("stage mismatch is rejected so the wrong contract cannot be used", async (t) => {
  const db = makeDb("IMPLEMENTATION");
  t.after(() => db.close());
  await assert.rejects(
    () => call(makeTool(db), {
      stage: "INVESTIGATION",
      summary: "Wrong stage",
      confidence: "LOW",
      outcome: "x",
      recommended_next_step: "CLOSE",
    }),
    /This run is IMPLEMENTATION/,
  );
  assert.equal(readHandover(db, "run-1"), undefined);
});

test("implementation handover validates its own required fields", async (t) => {
  const db = makeDb("IMPLEMENTATION");
  t.after(() => db.close());
  const tool = makeTool(db);

  await assert.rejects(
    () => call(tool, { stage: "IMPLEMENTATION", summary: "", recommended_next_step: "CLOSE" }),
    /Handover rejected for IMPLEMENTATION/,
  );

  await call(tool, {
    stage: "IMPLEMENTATION",
    summary: "Propagated the abort signal",
    files_changed: ["src/retry.ts"],
    key_decisions: ["Kept the existing backoff"],
    recommended_next_step: "CLOSE",
  });
  const stored = readHandover(db, "run-1");
  assert.deepEqual(stored.files_changed, ["src/retry.ts"]);
  assert.deepEqual(stored.known_limitations, []);
  // Investigation-only fields are not smuggled into an implementation handover.
  assert.equal("confidence" in stored, false);
});

test("handover without an active or existing run is rejected", async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const params = {
    stage: "INVESTIGATION", summary: "s", confidence: "LOW", outcome: "o", recommended_next_step: "CLOSE",
  };
  await assert.rejects(() => call(createHandoverTool(db, { activeRunId: () => undefined }), params), /No active run/);
  await assert.rejects(() => call(makeTool(db, "missing-run"), params), /no longer exists/);
});

test("validation review runs do not accept handovers", async (t) => {
  const db = makeDb("VALIDATION_REVIEW");
  t.after(() => db.close());
  await assert.rejects(
    () => call(makeTool(db), {
      stage: "INVESTIGATION", summary: "s", confidence: "LOW", outcome: "o", recommended_next_step: "CLOSE",
    }),
    /Stage VALIDATION_REVIEW does not accept a handover/,
  );
});
