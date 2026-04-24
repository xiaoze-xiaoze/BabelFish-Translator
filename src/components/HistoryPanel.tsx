import { Clock } from "lucide-react";
import { firstFileName, outputLabel } from "../utils";
import { useScrollFade } from "../hooks/useScrollFade";

type HistoryItem = {
  id: number;
  taskId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  files: string[];
  output?: string | null;
};

type HistoryPanelProps = {
  items: HistoryItem[];
  defaultOutputDir: string;
  deletingHistoryIds: Set<number>;
  deleteHistoryItem: (historyId: number) => void;
};

export default function HistoryPanel({
  items,
  defaultOutputDir,
  deletingHistoryIds,
  deleteHistoryItem,
}: HistoryPanelProps) {
  const { listRef, hasTopFade, hasBottomFade, syncFade } = useScrollFade([items]);

  return (
    <section className="panel panel--history">
      <header className="panel-header">
        <h2>历史记录</h2>
      </header>
      {items.length === 0 ? (
        <div className="panel-body panel-body--empty">
          <div className="empty-state">
            <Clock aria-hidden="true" className="empty-state-icon" />
            <p className="empty-state-text">暂无历史记录</p>
            <p className="empty-state-hint">完成翻译任务后，记录会出现在这里</p>
          </div>
        </div>
      ) : (
        <div
          className={`panel-body panel-body--list task-strip-list${
            hasTopFade ? " has-top-fade" : ""
          }${hasBottomFade ? " has-bottom-fade" : ""}`}
          ref={listRef}
          onScroll={syncFade}
        >
          {items.map((item) => (
            <article className="task-strip task-strip--history" key={`history-${item.id}`}>
              <p className="task-strip-line">
                <span className="task-strip-key">PDF</span>
                <span className="task-strip-value" title={item.files[0] ?? ""}>
                  {firstFileName(item.files)}
                </span>
                <span className="task-strip-key">保存到</span>
                <span className="task-strip-value" title={outputLabel(item.output, defaultOutputDir)}>
                  {outputLabel(item.output, defaultOutputDir)}
                </span>
              </p>
              <button
                className="danger-text-btn task-cancel-btn task-delete-btn"
                type="button"
                aria-label="删除历史记录"
                title="删除"
                disabled={deletingHistoryIds.has(item.id)}
                onClick={() => deleteHistoryItem(item.id)}
              >
                <span className="task-delete-mark" aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
