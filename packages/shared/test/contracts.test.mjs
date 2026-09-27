import assert from "node:assert/strict";
import test from "node:test";
import {
  BoardSnapshotSchema,
  CreateTaskSchema,
  ProjectSchema,
  RunStatusSchema,
  TaskSchema,
  UpdateTaskSchema,
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
    ide_command: null,
    worktree_root: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  assert.equal(ProjectSchema.safeParse(project).success, true);
  assert.equal(ProjectSchema.safeParse({ ...project, root_path: "" }).success, false);
});

test("task create and update schemas validate task fields", () => {
  assert.equal(CreateTaskSchema.safeParse({ project_id: "p1", title: " New task ", description: " Useful context " }).success, true);
  assert.equal(CreateTaskSchema.safeParse({ project_id: "p1", title: "  ", description: "Details" }).success, false);
  assert.equal(CreateTaskSchema.safeParse({ project_id: "p1", title: "Task", description: "  " }).success, false);
  assert.equal(UpdateTaskSchema.safeParse({ title: "Renamed" }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({}).success, false);
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
  assert.equal(BoardSnapshotSchema.safeParse({ columns: {
    TODO: [task], IN_PROGRESS: [], REQUIRES_HUMAN: [], REVIEW: [], DONE: [],
  } }).success, true);
});
