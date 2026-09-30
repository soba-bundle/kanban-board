import { defineTool } from "@earendil-works/pi-coding-agent";
import { ValidationReportSchema, type ValidationReport } from "@kanban-board/shared";
import { Type } from "typebox";

const ValidationReportParameters = Type.Object({
  findings: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    attribution: Type.Union([Type.Literal("DIRECT"), Type.Literal("INDIRECT"), Type.Literal("UNCERTAIN")]),
    summary: Type.String({ minLength: 1 }),
    rationale: Type.String({ minLength: 1 }),
    evidence: Type.String({ minLength: 1 }),
    locations: Type.Array(Type.Object({
      file: Type.String({ minLength: 1 }),
      line: Type.Integer({ minimum: 1 }),
    }), { minItems: 1 }),
  })),
});

export function createValidationReportTool(onReport: (report: ValidationReport) => void | Promise<void>) {
  return defineTool({
    name: "submit_validation_report",
    label: "Submit Validation Report",
    description: "Submit the complete structured findings from the independent review.",
    promptSnippet: "submit_validation_report - submit the final structured validation findings",
    promptGuidelines: ["Submit one complete report after reviewing the pinned candidate. Do not ask the user questions."],
    parameters: ValidationReportParameters,
    execute: async (_toolCallId, params) => {
      const parsed = ValidationReportSchema.safeParse(params);
      if (!parsed.success) throw new Error(`Invalid validation report: ${parsed.error.message}`);
      await onReport(parsed.data);
      return { content: [{ type: "text" as const, text: "Validation report accepted." }], details: parsed.data };
    },
  });
}
