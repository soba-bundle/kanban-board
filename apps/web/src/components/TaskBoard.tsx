import type { BoardSnapshot, Project, QueueItem, QueueSnapshot, Task, WorkflowState } from "@kanban-board/shared";
import { AddIconButton } from "./AddIconButton.js";
import { Avatar } from "./Avatar.js";
import { CountBadge } from "./CountBadge.js";
import { DeleteIcon } from "./DeleteIcon.js";
import { ProjectMark } from "./ProjectMark.js";

const columns: Array<{ state: WorkflowState; title: string; description: string }> = [
  { state: "TODO", title: "Todo", description: "Ready to be picked up" },
  { state: "IN_PROGRESS", title: "In Progress", description: "Agents are at work" },
  { state: "REQUIRES_HUMAN", title: "Needs Input", description: "Waiting for your decision" },
  { state: "REVIEW", title: "Review", description: "Ready for your review" },
  { state: "DONE", title: "Done", description: "Completed tasks" },
];

interface TaskBoardProps {
  board: BoardSnapshot;
  queue: QueueSnapshot | null;
  projects: Project[];
  projectId: string;
  onStartTask: (task: Task) => void;
  onOpenTask: (task: Task) => void;
  onCreateTask: () => void;
  onDeleteTask: (task: Task) => void;
  onCancelTask: (task: Task, job: QueueItem) => void;
}

function agentFor(task: Task, queue: QueueSnapshot | null): string | null {
  const activeJob = queue?.jobs.find((job) => job.task_id === task.id);
  if (activeJob) return activeJob.stage === "INVESTIGATION" ? "Investigator" : "Worker";
  if (task.review_tag === "INVESTIGATION_COMPLETE") return "Investigator";
  if (task.review_tag === "IMPLEMENTATION_COMPLETE" || task.review_tag === "VALIDATION_ISSUES" || task.review_tag === "VALIDATION_FAILED") return "Worker";
  return null;
}

export function TaskBoard({ board, queue, projects, projectId, onStartTask, onOpenTask, onCreateTask, onDeleteTask, onCancelTask }: TaskBoardProps) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const projectColors = new Map(projects.map((project, index) => [project.id, index]));

  return (
    <div className="board-scroller">
      <div className="board-grid">
        {columns.map(({ state, title, description }) => {
          const tasks = board.columns[state].filter((task) => projectId === "all" || task.project_id === projectId);
          return (
            <section className={`board-column column-${state.toLowerCase()}`} key={state} aria-labelledby={`column-${state}`}>
              <header className="column-header">
                <div className="column-title-row">
                  <span className={`column-dot dot-${state.toLowerCase()}`} />
                  <h2 id={`column-${state}`}>{title}</h2>
                  <CountBadge value={tasks.length} className="column-count" />
                  {state === "TODO" && (
                    <AddIconButton label="Add task" onClick={onCreateTask} />
                  )}
                </div>
                <p>{description}</p>
              </header>
              <div className="column-cards">
                {tasks.map((task) => {
                  const agent = agentFor(task, queue);
                  const activeJob = queue?.jobs.find((job) => job.task_id === task.id);
                  const reviewTag = task.review_tag === "READY_TO_MERGE" &&
                    (!task.active_validation_snapshot_id || task.validation_snapshot_current !== true)
                    ? "IMPLEMENTATION_COMPLETE" : task.review_tag;
                  return (
                    <article
                      className="task-card task-card-clickable"
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      title="Open ticket"
                      onClick={() => onOpenTask(task)}
                      onKeyDown={(event) => { if (event.key === "Enter") onOpenTask(task); }}
                    >
                      <div className="task-card-topline">
                        <div className="task-project-heading">
                          <ProjectMark name={projectNames.get(task.project_id) ?? "Project"} colorIndex={projectColors.get(task.project_id) ?? 0} />
                          <span className="task-project">{projectNames.get(task.project_id) ?? "Project"}</span>
                        </div>
                        {reviewTag && <span className="review-tag">{reviewTag.replaceAll("_", " ")}</span>}
                      </div>
                      <h3>{task.title}</h3>
                      {task.description && <p className="task-description">{task.description}</p>}
                      <footer className="task-card-footer">
                        {agent ? (
                          <span className="agent-byline">
                            <Avatar name={agent} size="small" />
                            <span>{agent}</span>
                            {activeJob && <span className="pulse-dot pulse-dot-animate" aria-label="Working" title="Agent is working" />}
                          </span>
                        ) : <span className="task-updated">Updated {new Date(task.updated_at).toLocaleDateString()}</span>}
                        <div className="task-actions" onClick={(event) => event.stopPropagation()}>
                          {state === "TODO" && (
                            <button className="button-quiet start-button" onClick={() => onStartTask(task)}>
                              <svg className="start-button-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.2v9.6l8-4.8-8-4.8Z" /></svg>
                              Start
                            </button>
                          )}
                          {state === "IN_PROGRESS" ? (
                            <button className="button-stop" disabled={!activeJob} title={activeJob ? "Cancel active task" : "No queued or running job to cancel"} onClick={() => activeJob && onCancelTask(task, activeJob)}>Cancel task</button>
                          ) : (
                            <button className="card-delete" aria-label={`Delete ${task.title}`} title={activeJob ? "Cancel queued or running work before deleting" : "Delete task"} disabled={!!activeJob} onClick={() => onDeleteTask(task)}>
                              <DeleteIcon />
                            </button>
                          )}
                        </div>
                      </footer>
                    </article>
                  );
                })}
                {tasks.length === 0 && <div className="column-empty">No tasks here</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
