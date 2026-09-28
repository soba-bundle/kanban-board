async function request(url, options, expectJson = true) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach the backend for ${url}. Start it with "npm run dev:server". ${detail}`);
  }

  const body = await response.text();
  let result;
  if (body.trim()) {
    try {
      result = JSON.parse(body);
    } catch {
      result = response.ok ? undefined : { error: body.slice(0, 180) };
    }
  }
  if (!response.ok) throw new Error(result?.error ?? result?.message ?? `${url} failed with HTTP ${response.status}.`);
  if (expectJson && result === undefined) throw new Error(`${url} returned an empty response.`);
  return result;
}

const json = (body) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function loadComments(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
}

export function loadRuns(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/runs`);
}

export function addComment(taskId, content) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/comments`, { method: "POST", ...json({ content }) });
}

export function editComment(commentId, content) {
  return request(`/api/comments/${encodeURIComponent(commentId)}`, { method: "PATCH", ...json({ content }) });
}

export function deleteComment(commentId) {
  return request(`/api/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }, false);
}

export function steerRun(runId, text) {
  return request(`/api/runs/${encodeURIComponent(runId)}/steer`, { method: "POST", ...json({ text }) });
}

export function enqueueReviewTask(taskId, stage) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/queue`, { method: "POST", ...json({ stage }) });
}

export function loadCheckpointPreview(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoint-preview`);
}

export function loadCheckpointDiff(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoint-diff`);
}

export function createCheckpoint(taskId, includeUntrackedFiles = []) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoint`, {
    method: "POST", ...json({ include_untracked_files: includeUntrackedFiles }),
  });
}

/** Opens the live event stream for a run. Returns the socket so callers can close it. */
export function openRunEvents(runId, onEvent) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/api/runs/${encodeURIComponent(runId)}/events`);
  socket.addEventListener("message", (event) => {
    try {
      onEvent(JSON.parse(event.data));
    } catch {
      // Ignore malformed frames; the REST snapshot stays authoritative.
    }
  });
  return socket;
}
