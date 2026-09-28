export type StartStage = "INVESTIGATION" | "IMPLEMENTATION";
export const DIRECT_IMPLEMENTATION_WARNING: string;
export function enqueueTask(
  taskId: string,
  stage: StartStage,
  prompt: string,
  idempotencyKey: string,
  fetchImpl?: typeof fetch,
  reusedFromInputId?: string,
): Promise<{ job_id: string | null; run_id: string; queue_position: number | null; created: boolean }>;
