import { useState, type FormEvent } from "react";
import type { Project } from "@kanban-board/shared";
import { createTask } from "../board-api.js";

interface CreateTaskDialogProps {
  projects: Project[];
  onCancel: () => void;
  onCreated: () => void;
}

export function CreateTaskDialog({ projects, onCancel, onCreated }: CreateTaskDialogProps) {
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formIsValid = projectId.length > 0 && title.trim().length > 0 && description.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!projectId || !title.trim() || !description.trim()) {
      setError("Choose a project and provide both a title and description.");
      return;
    }
    setPending(true);
    try {
      await createTask(projectId, title.trim(), description.trim());
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="dialog create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-task-title">
        <div className="dialog-heading">
          <div><p className="eyebrow">BOARD TASK</p><h2 id="create-task-title">Create a task</h2></div>
          <button className="icon-button" aria-label="Close dialog" onClick={onCancel}>×</button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label>Project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
              <option value="" disabled>Select a project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>Task title
            <input autoFocus maxLength={300} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to be done?" />
          </label>
          <label>Description
            <textarea rows={4} required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add context for yourself and your agents…" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button-quiet" type="button" disabled={pending} onClick={onCancel}>Cancel</button>
            <button className="button-primary" type="submit" disabled={pending || !formIsValid}>
              {pending ? "Creating…" : "Create task"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
