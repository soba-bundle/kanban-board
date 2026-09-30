import { z } from "zod";

export const ValidationAttributionSchema = z.enum(["DIRECT", "INDIRECT", "UNCERTAIN"]);
export const ValidationResultSchema = z.enum(["PASSED", "ISSUES_FOUND", "VALIDATION_FAILED", "STALE"]);

export const ValidationFindingLocationSchema = z.object({
  file: z.string().trim().min(1),
  line: z.number().int().positive(),
});

export const ValidationFindingSchema = z.object({
  id: z.string().trim().min(1),
  attribution: ValidationAttributionSchema,
  summary: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
  locations: z.array(ValidationFindingLocationSchema).min(1),
});

export const ValidationReportSchema = z.object({
  findings: z.array(ValidationFindingSchema),
}).superRefine((report, context) => {
  const ids = new Set<string>();
  report.findings.forEach((finding, index) => {
    if (ids.has(finding.id)) {
      context.addIssue({ code: "custom", path: ["findings", index, "id"], message: "Finding IDs must be unique." });
    }
    ids.add(finding.id);
  });
});

export type ValidationAttribution = z.infer<typeof ValidationAttributionSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
