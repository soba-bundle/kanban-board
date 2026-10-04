export function enqueueTask(
  taskId: string,
  prompt: string,
  idempotencyKey: string,
  fetchImpl?: typeof fetch,
  reusedFromInputId?: string,
): Promise<{ job_id: string | null; run_id: string; queue_position: number | null; created: boolean }>;
