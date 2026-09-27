import { Avatar } from "./Avatar.js";

export function ProfileMenu() {
  return (
    <div className="profile-menu">
      <button className="profile-trigger" aria-label="Open settings menu" aria-haspopup="true">
        <Avatar name="You" size="medium" />
        <span className="profile-name">You</span>
        <svg className="profile-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      <div className="settings-popover" role="menu" aria-label="Settings">
        <p className="popover-label">Settings</p>
        <div className="settings-identity">
          <Avatar name="You" size="medium" />
          <span><strong>You</strong><small>Local profile</small></span>
        </div>
        <div className="settings-row"><span>Appearance</span><span className="theme-badge"><i /> Dark</span></div>
        <p className="settings-note">Your workspace stays on this device.</p>
      </div>
    </div>
  );
}
