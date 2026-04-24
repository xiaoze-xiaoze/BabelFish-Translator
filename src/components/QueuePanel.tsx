import { Inbox } from "lucide-react";
import { firstFileName, outputLabel, statusLabel } from "../utils";
import { useScrollFade } from "../hooks/useScrollFade";

type TaskItem = {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  readyAt: number;
  attempts: number;
  maxRetries: number;
  files: string[];
  output?: string | null;
  result?: string | null;
  error?: string | null;
};

type QueuePanelProps = {
  items: TaskItem[];
  defaultOutputDir: string;
  cancellingTaskIds: Set<string>;
  cancelQueueTask: (taskId: string) => void;
};

export default function QueuePanel({
  items,
  defaultOutputDir,
  cancellingTaskIds,
  cancelQueueTask,
}: QueuePanelProps) {
  const { listRef, hasTopFade, hasBottomFade, syncFade } = useScrollFade([items]);

  return (
    <section className="panel panel--queue">
      <header className="panel-header">
        <h2>待办队列</h2>
      </header>
      {items.length === 0 ? (
        <div className="panel-body panel-body--empty">
          <div className="empty-state">
            <Inbox aria-hidden="true" className="empty-state-icon" />
            <p className="empty-state-text">暂无待办任务</p>
            <p className="empty-state-hint">选择 PDF 文件后加入待办队列即可开始翻译</p>
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
          {items.map((task) => (
            <article className="task-strip" key={task.id}>
              <p className="task-strip-line">
                <span className="task-strip-key">PDF</span>
                <span className="task-strip-value" title={task.files[0] ?? ""}>
                  {firstFileName(task.files)}
                </span>
                <span className="task-strip-key">保存到</span>
                <span className="task-strip-value" title={outputLabel(task.output, defaultOutputDir)}>
                  {outputLabel(task.output, defaultOutputDir)}
                </span>
              </p>
              <div className="task-strip-actions">
                <span className={`task-chip task-chip--${task.status}`}>
                  {statusLabel(task.status)}
                </span>
                {task.status === "running" ? (
                  <div className="task-progress">
                    <div className="task-progress-bar" />
                  </div>
                ) : null}
                <button
                  className="danger-text-btn task-cancel-btn"
                  type="button"
                  disabled={cancellingTaskIds.has(task.id)}
                  onClick={() => cancelQueueTask(task.id)}
                >
                  {cancellingTaskIds.has(task.id) ? "取消中..." : "取消"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
