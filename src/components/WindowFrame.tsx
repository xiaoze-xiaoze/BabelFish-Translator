import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import type { MouseEvent } from "react";

function runWindowAction(action: () => Promise<void>) {
  void action().catch((error) => {
    console.error("window action failed", error);
  });
}

export default function WindowFrame() {
  const currentWindow = getCurrentWindow();

  const startDragging = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    runWindowAction(() => currentWindow.startDragging());
  };

  return (
    <>
      <div
        className="window-drag-zone"
        aria-hidden="true"
        onMouseDown={startDragging}
      />
      <div className="window-controls" aria-label="Window controls">
        <button
          className="window-control-btn"
          type="button"
          aria-label="Minimize window"
          title="Minimize"
          onClick={() => runWindowAction(() => currentWindow.minimize())}
        >
          <Minus aria-hidden="true" className="window-control-icon" />
        </button>
        <button
          className="window-control-btn"
          type="button"
          aria-label="Maximize window"
          title="Maximize"
          onClick={() => runWindowAction(() => currentWindow.toggleMaximize())}
        >
          <Square aria-hidden="true" className="window-control-icon window-control-icon--square" />
        </button>
        <button
          className="window-control-btn window-control-btn--close"
          type="button"
          aria-label="Close window"
          title="Close"
          onClick={() => runWindowAction(() => currentWindow.close())}
        >
          <X aria-hidden="true" className="window-control-icon" />
        </button>
      </div>
    </>
  );
}
