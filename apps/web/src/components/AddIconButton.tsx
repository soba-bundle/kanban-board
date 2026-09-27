interface AddIconButtonProps {
  label: string;
  onClick: () => void;
}

export function AddIconButton({ label, onClick }: AddIconButtonProps) {
  return <button className="add-icon-button" aria-label={label} title={label} onClick={onClick}>＋</button>;
}
