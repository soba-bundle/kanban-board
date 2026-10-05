import { Badge } from "@astryxdesign/core/Badge";

interface CountBadgeProps {
  value: number;
  className?: string;
}

export function CountBadge({ value, className = "" }: CountBadgeProps) {
  return <Badge label={value} variant="neutral" className={className} />;
}
