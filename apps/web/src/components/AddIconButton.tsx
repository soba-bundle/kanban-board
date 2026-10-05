import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";

interface AddIconButtonProps {
  label: string;
  onClick: () => void;
}

export function AddIconButton({ label, onClick }: AddIconButtonProps) {
  return <IconButton label={label} tooltip={label} icon={<Text aria-hidden="true">＋</Text>} size="sm" variant="ghost" onClick={onClick} />;
}
