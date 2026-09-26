import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectSchema,
  RunStatusSchema,
  TaskSchema,
  WorkflowStateSchema,
} from "../dist/index.js";

const timestamp = "2025-01-01T00:00:00.000Z";

test("workflow enums accept declared values and reject unknown values", () => {
  assert.equal(WorkflowStateSchema.safeParse("IN_PROGRESS").success, true);
  assert.equal(WorkflowStateSchema.safeParse("ARCHIVED").success, false);
  assert.equal(RunStatusSchema.safeParse("WAITING_FOR_HUMAN").success, true);
  assert.equal(RunStatusSchema.safeParse("PAUSED").success, false);
});

test("project schema validates required project fields", () => {
  const project = {
    id: "p1",
    name: "Demo",
    root_path: "C:/repos/demo",
    created_at: timestamp,
    updated_at: timestamp,
  };
  assert.equal(ProjectSchema.safeParse(project).success, true);
  assert.equal(ProjectSchema.safeParse({ ...project, root_path: "" }).success, false);
});

test("task schema validates workflow state and required fields", () => {
  const task = {
    id: "t1",
    project_id: "p1",
    title: "Example task",
    description: "Details",
    workflow_state: "TODO",
    review_tag: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  assert.equal(TaskSchema.safeParse(task).success, true);
  assert.equal(TaskSchema.safeParse({ ...task, workflow_state: "ARCHIVED" }).success, false);
});
