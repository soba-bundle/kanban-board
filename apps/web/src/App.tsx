import { useCallback, useEffect, useState } from "react";
import type { BoardSnapshot, Project, QueueItem, QueueSnapshot, Task } from "@kanban-board/shared";
import { AddProjectDialog } from "./components/AddProjectDialog.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import { DangerConfirmDialog } from "./components/DangerConfirmDialog.js";
import { BoardSidebar } from "./components/BoardSidebar.js";
import { CreateTaskDialog } from "./components/CreateTaskDialog.js";
import { ProfileMenu } from "./components/ProfileMenu.js";
import { QueuePanel } from "./components/QueuePanel.js";
import { StartTaskDialog } from "./components/StartTaskDialog.js";
import { TaskBoard } from "./components/TaskBoard.js";
import { TicketPanel } from "./components/TicketPanel.js";
import { useToast } from "./components/ToastContext.js";
import { deleteProject, deleteTask, loadBoard, loadProjects, loadQueue, removeQueueJob, reorderQueueJob, stopRun } from "./board-api.js";
import "./app.css";

export function App() {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState("all");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: "task"; item: Task } | { kind: "project"; item: Project } | { kind: "cancel"; job: QueueItem } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pushToast } = useToast();

  const refreshData = useCallback(async () => {
    setLoading(true);
    const [boardResult, queueResult, projectsResult] = await Promise.allSettled([loadBoard(), loadQueue(), loadProjects()]);
    const failures: string[] = [];
    if (boardResult.status === "fulfilled") setBoard(boardResult.value);
    else failures.push(boardResult.reason instanceof Error ? boardResult.reason.message : String(boardResult.reason));
    if (queueResult.status === "fulfilled") setQueue(queueResult.value);
    else failures.push(queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason));
    if (projectsResult.status === "fulfilled") setProjects(projectsResult.value);
    else failures.push(projectsResult.reason instanceof Error ? projectsResult.reason.message : String(projectsResult.reason));
    setError(failures.length > 0 ? failures.join(" · ") : null);
    setLoading(false);
  }, []);

  useEffect(() => { void refreshData(); }, [refreshData]);

  async function performQueueAction(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await refreshData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      pushToast({ title: "Something went wrong", description: message, variant: "danger" });
    } finally {
      setBusyId(null);
    }
  }

  const selectedProjectName = projects.find((project) => project.id === selectedProject)?.name;

  function requestProjectDeletion(project: Project) {
    const activeInProject = board?.columns.IN_PROGRESS.some((task) => task.project_id === project.id)
      || queue?.jobs.some((job) => {
        const task = board && Object.values(board.columns).flat().find((candidate) => candidate.id === job.task_id);
        return task?.project_id === project.id;
      });
    if (activeInProject) {
      pushToast({ title: "Can't delete project", description: `${project.name} has tickets in progress. Cancel or finish them first.`, variant: "warning" });
      return;
    }
    setDeleteTarget({ kind: "project", item: project });
  }

  return (
    <div className="app-frame" id="board">
      <BoardSidebar projects={projects} selectedProject={selectedProject} board={board} queue={queue} onSelectProject={setSelectedProject} onAddProject={() => setAddingProject(true)} onDeleteProject={requestProjectDeletion} />
      <main className="workspace">
        <header className="workspace-header">
          <div className="breadcrumb"><span>{selectedProjectName ?? "All projects"}</span><span className="breadcrumb-divider">/</span><strong>Tickets</strong></div>
          <div className="header-actions">
            <ProfileMenu />
          </div>
        </header>
        <div className="workspace-content">
          <div className="page-heading">
            <div>
              <h1>Tickets</h1>
              <p className="selected-project-label">{selectedProjectName ?? "All projects"}</p>
              <p className="page-description">A clear view of the work, and the agents moving it forward.</p>
            </div>
          </div>

          {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
          {!board && loading && <div className="loading-state">Loading your workspace…</div>}
          {projects.length === 0 && !loading && !error && (
            <div className="onboarding-note"><strong>Start with a local project.</strong><span>Add a Git repository and an external worktree folder to create your first task.</span><button className="button-quiet" onClick={() => setAddingProject(true)}>Add project</button></div>
          )}
          <QueuePanel
            queue={queue}
            loading={loading}
            busyId={busyId}
            onMove={(jobId, position) => void performQueueAction(jobId, () => reorderQueueJob(jobId, position))}
            onRemove={(job) => setDeleteTarget({ kind: "cancel", job })}
            onStop={(job) => setDeleteTarget({ kind: "cancel", job })}
          />
          {board && <TaskBoard board={board} queue={queue} projects={projects} projectId={selectedProject} onStartTask={setSelectedTask} onOpenTask={setOpenTask} onCreateTask={() => projects.length === 0 ? setAddingProject(true) : setCreatingTask(true)} onDeleteTask={(task) => setDeleteTarget({ kind: "task", item: task })} onCancelTask={(_task, job) => setDeleteTarget({ kind: "cancel", job })} />}
        </div>
      </main>
      {openTask && (() => {
        const current = Object.values(board?.columns ?? {}).flat().find((task) => task.id === openTask.id) ?? openTask;
        return (
          <TicketPanel
            task={current}
            queue={queue}
            onClose={() => setOpenTask(null)}
            onChanged={() => void refreshData()}
          />
        );
      })()}
      {selectedTask && (
        <StartTaskDialog
          task={selectedTask}
          onCancel={() => setSelectedTask(null)}
          onStarted={() => { setSelectedTask(null); pushToast({ title: "Task queued", description: `${selectedTask.title} queued for work.`, variant: "success" }); void refreshData(); }}
        />
      )}
      {addingProject && (
        <AddProjectDialog
          onCancel={() => setAddingProject(false)}
          onCreated={(project) => {
            setAddingProject(false);
            setSelectedProject(project.id);
            pushToast({ title: "Project added", description: `${project.name} is ready.`, variant: "success" });
            void refreshData();
          }}
        />
      )}
      {deleteTarget && deleteTarget.kind === "cancel" && (
        <ConfirmDialog
          title={`Cancel “${deleteTarget.job.title}”?`}
          message={deleteTarget.job.job_status === "QUEUED"
            ? (<>Cancel <strong>{deleteTarget.job.title}</strong>? It will be removed from the queue and returned to its previous column. You can delete it after cancellation.</>)
            : (<>Cancel <strong>{deleteTarget.job.title}</strong>? The active run will stop and the task will move to Review / Interrupted. You can delete it from there afterward.</>)
          }
          confirmLabel={deleteTarget.job.job_status === "QUEUED" ? "Remove from queue" : "Stop run"}
          busyLabel={deleteTarget.job.job_status === "QUEUED" ? "Removing…" : "Stopping…"}
          busy={busyId === (deleteTarget.job.job_status === "QUEUED" ? deleteTarget.job.job_id : deleteTarget.job.run_id)}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            const actionId = target.job.job_status === "QUEUED" ? target.job.job_id : target.job.run_id;
            void performQueueAction(actionId, async () => {
              if (target.job.job_status === "QUEUED") await removeQueueJob(target.job.job_id);
              else await stopRun(target.job.run_id);
              pushToast({ title: target.job.job_status === "QUEUED" ? "Removed from queue" : "Run stopped", variant: "success" });
              setDeleteTarget(null);
            });
          }}
        />
      )}
      {deleteTarget && deleteTarget.kind !== "cancel" && (
        <DangerConfirmDialog
          name={deleteTarget.kind === "task"
            ? `${projects.find((project) => project.id === deleteTarget.item.project_id)?.name ?? "Project"}/${deleteTarget.item.title}`
            : deleteTarget.item.name}
          kind={deleteTarget.kind === "task" ? "ticket" : "project"}
          effects={deleteTarget.kind === "task"
            ? "This permanently deletes the ticket with its description, run history, and review state, and removes it from the board. A clean worktree is removed; dirty worktrees are kept and must be cleaned first."
            : "This permanently deletes the project and every ticket inside it, along with their run histories, and review states. Worktree files on disk are retained."
          }
          busy={busyId === deleteTarget.item.id}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            void performQueueAction(target.item.id, async () => {
              if (target.kind === "task") await deleteTask(target.item.id);
              else {
                await deleteProject(target.item.id);
                if (selectedProject === target.item.id) setSelectedProject("all");
              }
              pushToast(target.kind === "task"
                ? { title: "Ticket deleted", variant: "success" }
                : { title: "Project deleted", variant: "success" });
              setDeleteTarget(null);
            });
          }}
        />
      )}
      {creatingTask && (
        <CreateTaskDialog
          projects={projects}
          onCancel={() => setCreatingTask(false)}
          onCreated={() => { setCreatingTask(false); pushToast({ title: "Task created", variant: "success" }); void refreshData(); }}
        />
      )}
    </div>
  );
}
