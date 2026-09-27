interface CountBadgeProps {
  value: number;
  className?: string;
}

export function CountBadge({ value, className = "" }: CountBadgeProps) {
  return <span className={`count-badge ${className}`.trim()}>{value}</span>;
}
