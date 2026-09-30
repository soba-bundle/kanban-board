export interface ValidationContextInput {
  task: { id: string; title: string; description: string };
  checkpoint: { sha: string; producing_run_id: string };
  base: { sha: string };
  handovers: Array<{
    run_id: string;
    stage: string;
    sequence: number;
    status: string;
    handover?: Record<string, unknown> | null;
  }>;
  guidance_watermark: number;
  guidance: Array<{
    id: string;
    sequence: number;
    content: string;
    delivery_status: string;
  }>;
  changed_files: string[];
  diff: string;
  repository_context: string;
}

export function buildValidationContext(input: ValidationContextInput) {
  const checkpointRun = input.handovers.find((run) => run.run_id === input.checkpoint.producing_run_id &&
    run.stage === "IMPLEMENTATION" && run.status === "COMPLETED" && run.handover);
  if (!checkpointRun) {
    throw new Error("Validation requires a completed Implementation handover for the checkpoint-producing run.");
  }

  const implementationHandovers = input.handovers
    .filter((run) => run.stage === "IMPLEMENTATION" && run.status === "COMPLETED" &&
      run.sequence <= checkpointRun.sequence && run.handover)
    .sort((left, right) => left.sequence - right.sequence)
    .map((run) => ({
      run_id: run.run_id,
      sequence: run.sequence,
      ...structuredClone(run.handover),
    }));
  const confirmedGuidance = input.guidance
    .filter((item) => item.delivery_status === "DELIVERED" && item.sequence <= input.guidance_watermark)
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ id, sequence, content }) => ({ id, sequence, content }));

  return {
    task_description: input.task.description,
    implementation_handovers: implementationHandovers,
    confirmed_guidance: confirmedGuidance,
    guidance_watermark: input.guidance_watermark,
    base_commit_sha: input.base.sha,
    candidate_commit_sha: input.checkpoint.sha,
    checkpoint_run_id: input.checkpoint.producing_run_id,
    changed_files: [...input.changed_files],
    diff: input.diff,
    repository_context: input.repository_context,
  };
}
