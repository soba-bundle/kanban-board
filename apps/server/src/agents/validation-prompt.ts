import type { ValidationContextInput } from "./validation-context.js";

export type ValidationPromptContext = ReturnType<typeof buildValidationContext>;
import { buildValidationContext } from "./validation-context.js";

export function buildValidationPrompt(context: ValidationPromptContext): string {
  return [
    "You are an independent reviewer. Review only the pinned candidate and context below.",
    "Do not write source code or modify files. Bash is available for inspection, build, and test commands.",
    "Report each finding with a concise summary, causal rationale, reproducible evidence, and file/line locations.",
    "Classify attribution as DIRECT, INDIRECT, or UNCERTAIN. If information is missing, document the uncertainty in the report.",
    "Submit exactly one complete structured report with submit_validation_report. If there are no findings, submit an empty findings array.",
    "Pinned review context:",
    JSON.stringify(context, null, 2),
  ].join("\n\n");
}

export function buildValidationPromptFromInput(input: ValidationContextInput): string {
  return buildValidationPrompt(buildValidationContext(input));
}
