export const DIRECT_IMPLEMENTATION_WARNING =
  "The implementation agent will begin directly from the task description and current comments.";

export function chooseStartAction(stage, directConfirmed = false) {
  if (stage === "INVESTIGATION") return { type: "enqueue", stage };
  if (stage === "IMPLEMENTATION") {
    return directConfirmed
      ? { type: "enqueue", stage }
      : { type: "confirm", title: "Skip investigation?", warning: DIRECT_IMPLEMENTATION_WARNING };
  }
  throw new Error("Unsupported task start stage.");
}

export async function enqueueTask(taskId, stage, fetchImpl = fetch) {
  if (stage !== "INVESTIGATION" && stage !== "IMPLEMENTATION") {
    throw new Error("Unsupported task start stage.");
  }
  const response = await fetchImpl(`/api/tasks/${encodeURIComponent(taskId)}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Unable to queue task.");
  return result;
}
