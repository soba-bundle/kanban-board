import { useState, type FormEvent } from "react";
import type { Project } from "@kanban-board/shared";
import { createProject } from "../board-api.js";

interface AddProjectDialogProps {
  onCancel: () => void;
  onCreated: (project: Project) => void;
}

export function AddProjectDialog({ onCancel, onCreated }: AddProjectDialogProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const project = await createProject(name, rootPath, worktreeRoot);
      onCreated(project);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="dialog create-dialog project-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
        <div className="dialog-heading">
          <div><p className="eyebrow">GET STARTED</p><h2 id="add-project-title">Add a local project</h2></div>
          <button className="icon-button" aria-label="Close dialog" onClick={onCancel}>×</button>
        </div>
        <p className="project-intro">Connect a Git repository. Kanban keeps agent work in separate worktrees so your main checkout stays untouched.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label>Project name
            <input autoFocus maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} placeholder="My project" />
          </label>
          <label>Local Git repository
            <input required value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="C:\Users\you\source\my-project" />
            <span className="field-help">Enter the absolute path to an existing Git working tree.</span>
          </label>
          <label>Agent worktree folder
            <input required value={worktreeRoot} onChange={(event) => setWorktreeRoot(event.target.value)} placeholder="C:\Users\you\agent-worktrees\my-project" />
            <span className="field-help">Use a folder outside the repository. Each task gets its own isolated checkout here.</span>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button-quiet" type="button" disabled={pending} onClick={onCancel}>Cancel</button>
            <button className="button-primary" type="submit" disabled={pending}>
              {pending ? "Checking repository…" : "Add project"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
