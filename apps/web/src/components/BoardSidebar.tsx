import type { BoardSnapshot, Project, QueueSnapshot } from "@kanban-board/shared";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { AddIconButton } from "./AddIconButton.js";
import { CountBadge } from "./CountBadge.js";
import { DeleteIcon } from "./DeleteIcon.js";
import { ProjectMark } from "./ProjectMark.js";

interface BoardSidebarProps {
  projects: Project[];
  selectedProject: string;
  board: BoardSnapshot | null;
  queue: QueueSnapshot | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: () => void;
  onDeleteProject: (project: Project) => void;
}

export function BoardSidebar({ projects, selectedProject, board, queue, onSelectProject, onAddProject, onDeleteProject }: BoardSidebarProps) {
  const taskCount = board ? Object.values(board.columns).reduce((sum, tasks) => sum + tasks.length, 0) : 0;

  return (
    <aside className="sidebar">
      <a className="brand" href="#board" aria-label="Local Agent Kanban home">
        <span className="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none"><path d="M5 7.5h6v17H5zM13 7.5h6v11h-6zM21 7.5h6v7h-6z" fill="currentColor" /><path d="M5 27h22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </span>
        <span><strong>Local Agent</strong><small>Kanban workspace</small></span>
      </a>

      <button className="sidebar-nav active" onClick={() => onSelectProject("all")}>
        <span className="nav-symbol" aria-hidden="true">▦</span>
        <span>Board</span>
        <CountBadge value={taskCount} className="nav-count" />
      </button>

      <div className="sidebar-section-label"><span>Projects</span><div><CountBadge value={projects.length} className="sidebar-project-count" /><AddIconButton label="Add project" onClick={onAddProject} /></div></div>
      <nav className="project-nav" aria-label="Filter board by project">
        <button className={`project-link ${selectedProject === "all" ? "selected" : ""}`} onClick={() => onSelectProject("all")}>
          <span className="project-mark all-projects" aria-hidden="true">✳</span>
          <span>All projects</span>
          <CountBadge value={taskCount} className="project-count" />
        </button>
        {projects.map((project, index) => {
          const projectTasks = board ? Object.values(board.columns).flat().filter((task) => task.project_id === project.id) : [];
          const count = projectTasks.length;
          const hasQueuedWork = queue?.jobs.some((job) => projectTasks.some((task) => task.id === job.task_id)) ?? false;
          return (
            <div className="project-row" key={project.id}>
              <button
                className={`project-link ${selectedProject === project.id ? "selected" : ""}`}
                onClick={() => onSelectProject(project.id)}
              >
                <ProjectMark name={project.name} colorIndex={index} />
                <span className="project-name">{project.name}</span>
                <CountBadge value={count} className="project-count" />
              </button>
              <IconButton className="project-delete" label={`Delete project ${project.name}`} tooltip={hasQueuedWork ? "Remove queued work or stop runs before deleting" : "Delete project"}
                isDisabled={hasQueuedWork} onClick={() => onDeleteProject(project)} icon={<Icon icon={DeleteIcon} />} size="sm" variant="ghost" />
            </div>
          );
        })}
        {projects.length === 0 && <p className="sidebar-empty">No projects registered yet.</p>}
      </nav>

      <div className="sidebar-footer">
        <span className="online-dot" />
        <span><strong>Local workspace</strong><small>Private to this device</small></span>
      </div>
    </aside>
  );
}
