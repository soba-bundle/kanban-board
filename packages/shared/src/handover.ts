import { z } from "zod";

export const RecommendedNextStepSchema = z.enum([
  "IMPLEMENT",
  "INVESTIGATE",
  "REQUEST_HUMAN",
  "CLOSE",
]);
export type RecommendedNextStep = z.infer<typeof RecommendedNextStepSchema>;

export const HandoverConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const nonEmptyStrings = z.array(z.string().trim().min(1));

export const InvestigationHandoverSchema = z.object({
  stage: z.literal("INVESTIGATION"),
  summary: z.string().trim().min(1),
  confidence: HandoverConfidenceSchema,
  outcome: z.string().trim().min(1),
  root_cause: z.string().trim().min(1).nullable().default(null),
  evidence: nonEmptyStrings.default([]),
  affected_files: nonEmptyStrings.default([]),
  recommended_changes: nonEmptyStrings.default([]),
  missing_information: nonEmptyStrings.default([]),
  human_verification_required: z.boolean().default(false),
  recommended_next_step: RecommendedNextStepSchema,
});
export type InvestigationHandover = z.infer<typeof InvestigationHandoverSchema>;

export const ImplementationHandoverSchema = z.object({
  stage: z.literal("IMPLEMENTATION"),
  summary: z.string().trim().min(1),
  files_changed: nonEmptyStrings.default([]),
  key_decisions: nonEmptyStrings.default([]),
  known_limitations: nonEmptyStrings.default([]),
  recommended_validation: nonEmptyStrings.default([]),
  recommended_next_step: RecommendedNextStepSchema,
});
export type ImplementationHandover = z.infer<typeof ImplementationHandoverSchema>;

export const HandoverSchema = z.discriminatedUnion("stage", [
  InvestigationHandoverSchema,
  ImplementationHandoverSchema,
]);
export type Handover = z.infer<typeof HandoverSchema>;

export const handoverSchemaForStage = {
  INVESTIGATION: InvestigationHandoverSchema,
  IMPLEMENTATION: ImplementationHandoverSchema,
} as const;
