export type RunStage = "INVESTIGATION" | "IMPLEMENTATION" | "VALIDATION_REVIEW";

export interface StageToolPolicy {
  filterActiveTools(toolNames: string[]): string[];
  blockToolCall(toolName: string): { blocked: true; reason: string } | undefined;
}

const SOURCE_WRITING_TOOLS = new Set(["write", "edit"]);

export function createStageToolPolicy(getStage: () => RunStage | undefined): StageToolPolicy {
  return {
    filterActiveTools(toolNames) {
      const stage = getStage();
      const blocksSourceWrites = stage === "INVESTIGATION" || stage === "VALIDATION_REVIEW";
      return toolNames.filter((name) =>
        !(blocksSourceWrites && SOURCE_WRITING_TOOLS.has(name)) &&
        !(stage === "VALIDATION_REVIEW" && name === "kanban_questionnaire"));
    },
    blockToolCall(toolName) {
      const stage = getStage();
      if ((stage === "INVESTIGATION" || stage === "VALIDATION_REVIEW") && SOURCE_WRITING_TOOLS.has(toolName)) {
        return { blocked: true, reason: `${toolName} is disabled during ${stage} runs.` };
      }
      if (stage === "VALIDATION_REVIEW" && toolName === "kanban_questionnaire") {
        return { blocked: true, reason: "Human Requests are disabled during Validation Review." };
      }
      return undefined;
    },
  };
}
