import { Settings } from "lucide-react";

type TopBarProps = {
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  isEnvReady: boolean;
};

export default function TopBar({ isSettingsOpen, setIsSettingsOpen, isEnvReady }: TopBarProps) {
  return (
    <div className="top-bar">
      <div className="brand-mark">
        <img className="brand-mark-icon" src="/icon.png" alt="" />
        <span className="brand-mark-text">
          Babel<span className="brand-accent">Fish</span>
        </span>
      </div>
      <div className="top-bar-right">
        <button
          className="top-bar-settings-btn"
          type="button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={isSettingsOpen}
          aria-controls="settings-modal"
          disabled={!isEnvReady}
          onClick={() => setIsSettingsOpen(true)}
        >
          <Settings aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
