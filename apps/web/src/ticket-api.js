async function request(url, options) {
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
  if (result === undefined) throw new Error(`${url} returned an empty response.`);
  return result;
}

const json = (body) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function loadRuns(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/runs`);
}

export function loadLiveHistory(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/live/history`);
}

export function loadHumanRequests(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/human-requests`);
}

export function answerHumanRequest(requestId, answers) {
  return request(`/api/human-requests/${encodeURIComponent(requestId)}/answer`, {
    method: "POST", ...json({ answers }),
  });
}

export function stopHumanRequest(requestId) {
  return request(`/api/human-requests/${encodeURIComponent(requestId)}/stop`, {
    method: "POST", ...json({}),
  });
}

export function steerRun(runId, inputId, text, reusedFromInputId) {
  return request(`/api/runs/${encodeURIComponent(runId)}/inputs`, {
    method: "POST",
    ...json({ input_id: inputId, text, ...(reusedFromInputId ? { reused_from_input_id: reusedFromInputId } : {}) }),
  });
}

export function loadCheckpointPreview(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoint-preview`);
}

export function loadCheckpointDiff(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoint-diff`);
}

export function createCheckpoint(taskId, confirmation) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/checkpoint`, {
    method: "POST", ...json(confirmation),
  });
}

/** Opens the live event stream for a run. Returns the socket so callers can close it. */
export function openRunEvents(taskId, runId, onEvent, after = 0) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`);
  socket.addEventListener("message", (event) => {
    try {
      onEvent(JSON.parse(event.data));
    } catch {
      // Ignore malformed frames; the REST snapshot stays authoritative.
    }
  });
  return socket;
}
