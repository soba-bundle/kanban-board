import { useState } from "react";

interface AvatarProps {
  name: string;
  size?: "small" | "medium" | "large";
}

export function Avatar({ name, size = "medium" }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  return (
    <span className={`avatar avatar-${size}`} aria-label={name} title={name}>
      {!failed ? (
        <img
          src={`https://blobatar.dev/?name=${encodeURIComponent(name)}`}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : initials}
    </span>
  );
}
