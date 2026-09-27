interface ProjectMarkProps {
  name: string;
  colorIndex: number;
}

export function ProjectMark({ name, colorIndex }: ProjectMarkProps) {
  return <span className={`project-mark project-color-${colorIndex % 5}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}
