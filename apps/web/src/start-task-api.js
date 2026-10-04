export async function enqueueTask(taskId, prompt, idempotencyKey, fetchImpl = fetch, reusedFromInputId) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A nonblank prompt is required.");
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new Error("An idempotency key is required.");
  const response = await fetchImpl(`/api/tasks/${encodeURIComponent(taskId)}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task_id: taskId, prompt: prompt.trim(), idempotency_key: idempotencyKey,
      ...(reusedFromInputId ? { reused_from_input_id: reusedFromInputId } : {}),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Unable to queue task.");
  return result;
}
