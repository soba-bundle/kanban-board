import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type Database from "better-sqlite3";
import { handoverSchemaForStage } from "@kanban-board/shared";

/**
 * The parameter schema is permissive because Pi fixes tool schemas at session
 * construction while one working session spans both Investigation and
 * Implementation runs. The stage-specific contract is enforced at call time.
 */
const HandoverParameters = Type.Object({
  stage: Type.Union([Type.Literal("INVESTIGATION"), Type.Literal("IMPLEMENTATION")], {
    description: "Must match the stage of the run you are completing.",
  }),
  summary: Type.String({ description: "What you did and what the outcome was." }),
  recommended_next_step: Type.Union([
    Type.Literal("IMPLEMENT"),
    Type.Literal("INVESTIGATE"),
    Type.Literal("REQUEST_HUMAN"),
    Type.Literal("CLOSE"),
  ], { description: "Advisory only; it does not move the ticket by itself." }),

  // Investigation fields.
  confidence: Type.Optional(Type.Union([Type.Literal("LOW"), Type.Literal("MEDIUM"), Type.Literal("HIGH")],
    { description: "Investigation only. Required." })),
  outcome: Type.Optional(Type.String({ description: "Investigation only. Required." })),
  root_cause: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Investigation only." })),
  evidence: Type.Optional(Type.Array(Type.String(), { description: "Investigation only." })),
  affected_files: Type.Optional(Type.Array(Type.String(), { description: "Investigation only." })),
  recommended_changes: Type.Optional(Type.Array(Type.String(), { description: "Investigation only." })),
  missing_information: Type.Optional(Type.Array(Type.String(), { description: "Investigation only." })),
  human_verification_required: Type.Optional(Type.Boolean({ description: "Investigation only." })),

  // Implementation fields.
  files_changed: Type.Optional(Type.Array(Type.String(), { description: "Implementation only." })),
  key_decisions: Type.Optional(Type.Array(Type.String(), { description: "Implementation only." })),
  known_limitations: Type.Optional(Type.Array(Type.String(), { description: "Implementation only." })),
  recommended_validation: Type.Optional(Type.Array(Type.String(), { description: "Implementation only." })),
});

export interface HandoverToolContext {
  /** The run the working session is currently executing, if any. */
  activeRunId(): string | undefined;
}

export function createHandoverTool(db: Database.Database, context: HandoverToolContext) {
  return defineTool({
    name: "submit_handover",
    label: "Submit Handover",
    description: [
      "Report the structured result of the current run. Call this exactly once, as your final action.",
      "Investigation requires: confidence, outcome.",
      "Implementation requires: files_changed.",
    ].join(" "),
    promptSnippet: "submit_handover - report the structured result of this run before finishing",
    promptGuidelines: ["Finish every Investigation or Implementation run by calling submit_handover."],
    parameters: HandoverParameters,
    execute: async (_toolCallId, params) => {
      const runId = context.activeRunId();
      if (!runId) throw new Error("No active run is associated with this session.");
      const run = db.prepare("SELECT stage FROM task_runs WHERE id = ?").get(runId) as { stage: string } | undefined;
      if (!run) throw new Error("The active run no longer exists.");

      const schema = handoverSchemaForStage[run.stage as keyof typeof handoverSchemaForStage];
      if (!schema) throw new Error(`Stage ${run.stage} does not accept a handover.`);
      if (params.stage !== run.stage) {
        throw new Error(`This run is ${run.stage}; submit a ${run.stage} handover instead of ${params.stage}.`);
      }

      const parsed = schema.safeParse(params);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new Error(`Handover rejected for ${run.stage}. Fix these fields and call submit_handover again: ${issues}`);
      }

      db.prepare("UPDATE task_runs SET handover_json = ? WHERE id = ?")
        .run(JSON.stringify(parsed.data), runId);
      return {
        content: [{ type: "text" as const, text: `Handover recorded for this ${run.stage} run.` }],
        details: parsed.data,
      };
    },
  });
}

export function readHandover(db: Database.Database, runId: string): unknown | undefined {
  const row = db.prepare("SELECT handover_json FROM task_runs WHERE id = ?").get(runId) as
    { handover_json: string | null } | undefined;
  return row?.handover_json ? JSON.parse(row.handover_json) : undefined;
}
