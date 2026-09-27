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
      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "unknown content type";
        throw new Error(`${url} returned non-JSON data (HTTP ${response.status}, ${contentType}). Is the current backend running?`);
      }
      result = { error: body.slice(0, 180) };
    }
  }

  if (!response.ok) {
    if (response.status === 404 && /^Route (GET|POST|PATCH|DELETE|PUT):/.test(result?.message ?? "")) {
      throw new Error(`The running backend is missing ${url}. Stop the old backend and restart it with "npm run dev:server".`);
    }
    const detail = result?.error ?? result?.message;
    if (response.status >= 500 && (!detail || detail === "Internal Server Error")) {
      throw new Error(`${url} failed with HTTP ${response.status}. Check that Vite's KANBAN_BACKEND_PORT matches the running backend (default 3000), and check the backend logs.`);
    }
    throw new Error(detail ?? `${url} failed with HTTP ${response.status}.`);
  }
  if (expectJson && result === undefined) {
    throw new Error(`${url} returned an empty response (HTTP ${response.status}). Check that the current backend is running.`);
  }
  return result;
}

export function loadBoard() {
  return request("/api/board");
}

export function loadQueue() {
  return request("/api/queue");
}

export function loadProjects() {
  return request("/api/projects");
}

export function createProject(name, rootPath, worktreeRoot) {
  return request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, root_path: rootPath, worktree_root: worktreeRoot }),
  });
}

export function deleteProject(projectId) {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }, false);
}

export function createTask(projectId, title, description) {
  return request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title, description }),
  });
}

export function deleteTask(taskId) {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" }, false);
}

export function reorderQueueJob(jobId, position) {
  return request(`/api/queue/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ position }),
  });
}

export function removeQueueJob(jobId) {
  return request(`/api/queue/${encodeURIComponent(jobId)}`, { method: "DELETE" }, false);
}

export function stopRun(runId) {
  return request(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
}
