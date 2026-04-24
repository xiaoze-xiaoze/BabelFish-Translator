import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { localDataDir } from "@tauri-apps/api/path";
import { Plus, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ConfigPanel from "./components/ConfigPanel";
import HistoryPanel from "./components/HistoryPanel";
import QueuePanel from "./components/QueuePanel";
import {
  type AppSettings, type AppSettingsDraft, type EnvCheckResult,
  type EnvState, type TaskStatus, type Direction,
  type WatermarkOutputMode, type OutputMode, type RuntimeProvider,
  BLANK_PROVIDER, DEFAULT_SETTINGS, QPS_MIN, QPS_MAX,
  isTauriRuntime, cloneProviders, cloneDraft,
  normalizeSettings, toDraft, toPayload, normalizeQps,
  validateTranslateDraft, validateApiDraft,
  formatEnvError, resolveEnvMessage,
} from "./utils";

type EnvProgressEvent = {
  stage: string;
  message: string;
  detail?: string | null;
};

type BabelDocCommandPayload = {
  files: string[];
  langIn: string;
  langOut: string;
  output?: string | null;
  pages?: string | null;
  useOpenai: boolean;
  openaiModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  qps?: number | null;
  watermarkOutputMode?: WatermarkOutputMode | null;
  outputMode?: OutputMode | null;
};

type TaskItem = {
  id: string;
  status: TaskStatus;
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

type HistoryItem = {
  id: number;
  taskId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  files: string[];
  output?: string | null;
};


const ENV_PROGRESS_EVENT = "env://progress";

let sharedEnvCheckPromise: Promise<EnvCheckResult> | null = null;

function runSharedEnvCheck(): Promise<EnvCheckResult> {
  if (!sharedEnvCheckPromise) {
    sharedEnvCheckPromise = invoke<EnvCheckResult>("env_check").finally(() => {
      sharedEnvCheckPromise = null;
    });
  }

  return sharedEnvCheckPromise;
}

const BABELDOC_DEFAULT_OUTPUT_DIR_NAME = "BabelFish";

function App() {
  const tauriAvailable = isTauriRuntime();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<AppSettingsDraft>(toDraft(DEFAULT_SETTINGS));
  const [loadedDraft, setLoadedDraft] =
    useState<AppSettingsDraft>(toDraft(DEFAULT_SETTINGS));
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [envState, setEnvState] = useState<EnvState>(
    tauriAvailable ? "checking" : "ready",
  );
  const [envMessage, setEnvMessage] = useState("正在检测环境...");
  const [envErrorMessage, setEnvErrorMessage] = useState("");
  const [envProgressItems, setEnvProgressItems] = useState<string[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [defaultOutputDir, setDefaultOutputDir] = useState("");
  const [runtimeProviderId, setRuntimeProviderId] = useState("");
  const [runtimeFiles, setRuntimeFiles] = useState<string[]>([]);
  const [runtimeOutputDir, setRuntimeOutputDir] = useState("");
  const [runtimeDirection, setRuntimeDirection] = useState<Direction>("zhToEn");
  const [runtimePages, setRuntimePages] = useState("");
  const [runtimeWatermarkMode, setRuntimeWatermarkMode] =
    useState<WatermarkOutputMode>("watermarked");
  const [runtimeOutputMode, setRuntimeOutputMode] =
    useState<OutputMode>("dualOnly");
  const [isRuntimeSubmitting, setIsRuntimeSubmitting] = useState(false);
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingHistoryIds, setDeletingHistoryIds] = useState<Set<number>>(
    () => new Set(),
  );

  const qpsValue = normalizeQps(draft.qps);
  const isEnvReady = envState === "ready";
  const isEnvBusy = envState === "checking" || envState === "installing";
  const runtimeProviders = useMemo<RuntimeProvider[]>(() => {
    return draft.providers
      .map((provider, index) => ({
        ...provider,
        id: String(index),
      }))
      .filter((provider) => {
        return (
          provider.modelName.trim() !== "" &&
          provider.model.trim() !== "" &&
          provider.baseUrl.trim() !== "" &&
          provider.apiKey.trim() !== ""
        );
      });
  }, [draft.providers]);
  const runtimeOutputDirValue = runtimeOutputDir.trim();
  const canSubmitRuntimeTask =
    tauriAvailable && isEnvReady && runtimeProviderId !== "" && runtimeFiles.length > 0;
  const queueItems = tasks
    .filter((task) => task.status === "pending" || task.status === "running")
    .sort((a, b) => {
      if (a.status === b.status) {
        return b.createdAt - a.createdAt;
      }
      return a.status === "running" ? -1 : 1;
    });
  const historyVisibleItems = useMemo(() => {
    return historyItems.filter(
      (item) => item.status === "succeeded" || item.status === "failed",
    );
  }, [historyItems]);

  const applyEnvCheckResult = (result: EnvCheckResult) => {
    setEnvState(result.babelfishVersion ? "ready" : "missing");
    setEnvErrorMessage("");
    setEnvMessage(resolveEnvMessage(result));
  };

  const checkRuntimeEnv = async () => {
    if (!tauriAvailable) {
      setEnvState("ready");
      setEnvMessage("当前为浏览器模式，跳过环境检测。");
      return;
    }

    setEnvState("checking");
    setEnvErrorMessage("");
    setEnvMessage("正在检测环境...");
    try {
      const result = await runSharedEnvCheck();
      applyEnvCheckResult(result);
    } catch (error) {
      console.error("environment check failed", error);
      setEnvErrorMessage(formatEnvError(error));
      setEnvMessage("环境检测失败，请重试。");
      setEnvState("error");
    }
  };

  const installRuntimeEnv = async () => {
    if (!tauriAvailable) {
      return;
    }

    setEnvState("installing");
    setEnvErrorMessage("");
    setEnvMessage("正在安装 uv 和 BabelDOC...");
    setEnvProgressItems(["开始安装环境..."]);
    try {
      const result = await invoke<EnvCheckResult>("env_install");
      applyEnvCheckResult(result);
    } catch (error) {
      console.error("environment install failed", error);
      const message = formatEnvError(error);
      setEnvState("error");
      setEnvErrorMessage(message);
      setEnvMessage("环境安装失败。");
      setEnvProgressItems((prev) => [...prev.slice(-4), `安装失败: ${message}`]);
    }
  };

  const loadSettings = async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;

    if (!isEnvReady) {
      return;
    }

    if (!tauriAvailable) {
      const fallback = toDraft(DEFAULT_SETTINGS);
      setDraft(cloneDraft(fallback));
      setLoadedDraft(cloneDraft(fallback));
      setRuntimeDirection(fallback.direction);
      setRuntimeOutputDir(fallback.outputDir);
      setRuntimeWatermarkMode(fallback.watermarkOutputMode);
      setRuntimeOutputMode(fallback.outputMode);
      return;
    }

    setIsLoading(true);
    try {
      const remote = await invoke<AppSettings>("get_settings");
      const normalized = toDraft(normalizeSettings(remote));
      setDraft(cloneDraft(normalized));
      setLoadedDraft(cloneDraft(normalized));
      setRuntimeDirection(normalized.direction);
      setRuntimeOutputDir(normalized.outputDir);
      setRuntimeWatermarkMode(normalized.watermarkOutputMode);
      setRuntimeOutputMode(normalized.outputMode);
    } catch {
      if (!silent) {
        // no-op: settings modal feedback text is intentionally hidden
      }
    } finally {
      setIsLoading(false);
    }
  };

  const saveSection = async (scope: "translate" | "api") => {
    const savingDraft: AppSettingsDraft =
      scope === "translate"
        ? {
            ...loadedDraft,
            direction: draft.direction,
            qps: draft.qps,
            outputDir: draft.outputDir,
            watermarkOutputMode: draft.watermarkOutputMode,
            outputMode: draft.outputMode,
          }
        : {
            ...loadedDraft,
            providers: cloneProviders(draft.providers),
          };

    const validationError =
      scope === "translate"
        ? validateTranslateDraft(savingDraft)
        : validateApiDraft(savingDraft);
    if (validationError) {
      return;
    }

    if (!tauriAvailable) {
      return;
    }

    setIsSaving(true);
    try {
      const saved = await invoke<AppSettings>("save_settings", {
        settings: toPayload(savingDraft),
      });
      const normalized = toDraft(normalizeSettings(saved));
      setLoadedDraft(cloneDraft(normalized));
      setDraft((prev) =>
        scope === "translate"
          ? {
              ...prev,
              schemaVersion: normalized.schemaVersion,
              direction: normalized.direction,
              qps: normalized.qps,
              outputDir: normalized.outputDir,
              watermarkOutputMode: normalized.watermarkOutputMode,
              outputMode: normalized.outputMode,
            }
          : {
              ...prev,
              schemaVersion: normalized.schemaVersion,
              providers: cloneProviders(normalized.providers),
            },
      );
      if (scope === "translate") {
        setRuntimeDirection(normalized.direction);
      }
    } catch {
      // no-op: settings modal feedback text is intentionally hidden
    } finally {
      setIsSaving(false);
    }
  };

  const loadTaskPanels = async () => {
    if (!isEnvReady) {
      setTasks([]);
      setHistoryItems([]);
      return;
    }

    if (!tauriAvailable) {
      setTasks([]);
      setHistoryItems([]);
      return;
    }

    try {
      const [taskList, historyList] = await Promise.all([
        invoke<TaskItem[]>("list_tasks"),
        invoke<HistoryItem[]>("list_history", { limit: 200 }),
      ]);
      setTasks(taskList);
      setHistoryItems(historyList);
    } catch (error) {
      console.error("refresh task panels failed", error);
    }
  };

  const pickRuntimeFiles = async () => {
    if (!tauriAvailable) {
      return;
    }

    try {
      const selected = await openDialog({
        title: "选择要翻译的 PDF 文件",
        multiple: true,
        directory: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (selected === null) {
        return;
      }

      const files = Array.isArray(selected) ? selected : [selected];
      const normalized = files
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim());

      if (normalized.length === 0) {
        return;
      }

      setRuntimeFiles(normalized);
    } catch (error) {
      console.error("pick runtime files failed", error);
    }
  };

  const pickRuntimeOutputDir = async () => {
    if (!tauriAvailable) {
      return;
    }

    try {
      const selected = await openDialog({
        title: "选择输出目录",
        directory: true,
        multiple: false,
      });
      if (typeof selected !== "string" || selected.trim() === "") {
        return;
      }
      setRuntimeOutputDir(selected.trim());
    } catch (error) {
      console.error("pick runtime output dir failed", error);
    }
  };

  const submitRuntimeTasks = async () => {
    if (!canSubmitRuntimeTask) {
      return;
    }

    const provider = runtimeProviders.find((p) => p.id === runtimeProviderId);
    if (!provider) return;

    const pages = runtimePages.trim();
    const output = runtimeOutputDirValue;
    const langIn = runtimeDirection === "enToZh" ? "en" : "zh";
    const langOut = runtimeDirection === "enToZh" ? "zh" : "en";

    const commands: BabelDocCommandPayload[] = runtimeFiles.map((file) => ({
      files: [file],
      langIn,
      langOut,
      output: output === "" ? null : output,
      pages: pages === "" ? null : pages,
      useOpenai: true,
      openaiModel: provider.model.trim(),
      openaiBaseUrl: provider.baseUrl.trim(),
      openaiApiKey: provider.apiKey.trim(),
      qps: qpsValue,
      watermarkOutputMode: runtimeWatermarkMode,
      outputMode: runtimeOutputMode,
    }));

    setIsRuntimeSubmitting(true);
    try {
      await invoke<string[]>("create_tasks", { commands });
      setRuntimeFiles([]);
      setRuntimePages("");
      await loadTaskPanels();
    } catch (error) {
      console.error("submit runtime tasks failed", error);
    } finally {
      setIsRuntimeSubmitting(false);
    }
  };

  const cancelQueueTask = async (taskId: string) => {
    if (!tauriAvailable) {
      return;
    }

    setCancellingTaskIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });

    try {
      await invoke<boolean>("cancel_task", { taskId });
      await loadTaskPanels();
    } catch (error) {
      console.error("cancel task failed", error);
    } finally {
      setCancellingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const deleteHistoryItem = async (historyId: number) => {
    if (!tauriAvailable) {
      return;
    }

    setDeletingHistoryIds((prev) => {
      const next = new Set(prev);
      next.add(historyId);
      return next;
    });

    try {
      await invoke<boolean>("delete_history_item", { historyId });
      await loadTaskPanels();
    } catch (error) {
      console.error("delete history item failed", error);
    } finally {
      setDeletingHistoryIds((prev) => {
        const next = new Set(prev);
        next.delete(historyId);
        return next;
      });
    }
  };

  useEffect(() => {
    if (!tauriAvailable) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<EnvProgressEvent>(ENV_PROGRESS_EVENT, (event) => {
      const detail = event.payload.detail?.trim();
      const line = detail
        ? `${event.payload.message}: ${detail}`
        : event.payload.message;

      setEnvMessage(event.payload.message);
      setEnvProgressItems((prev) => [...prev.slice(-4), line]);
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch((error) => {
        console.error("env progress listener failed", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tauriAvailable]);

  useEffect(() => {
    void checkRuntimeEnv();
  }, [tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable) {
      return;
    }
    void localDataDir().then((dir) => {
      setDefaultOutputDir(
        dir.replace(/\\/g, "/") + "/" + BABELDOC_DEFAULT_OUTPUT_DIR_NAME,
      );
    });
  }, [tauriAvailable]);

  useEffect(() => {
    if (!isEnvReady) {
      return;
    }
    void loadSettings({ silent: true });
  }, [isEnvReady]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }
    if (!isEnvReady) {
      return;
    }
    void loadSettings();
  }, [isSettingsOpen, isEnvReady]);

  useEffect(() => {
    if (runtimeProviders.length === 0) {
      setRuntimeProviderId("");
      return;
    }
    if (runtimeProviders.some((provider) => provider.id === runtimeProviderId)) {
      return;
    }
    setRuntimeProviderId(runtimeProviders[0].id);
  }, [runtimeProviders, runtimeProviderId]);

  useEffect(() => {
    if (!isEnvReady) {
      setTasks([]);
      setHistoryItems([]);
      return;
    }

    void loadTaskPanels();

    if (!tauriAvailable) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadTaskPanels();
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isEnvReady, tauriAvailable]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isSettingsOpen]);

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="workspace">
        <div className="workspace-body">
          <div className="left-column">
            <QueuePanel
              items={queueItems}
              defaultOutputDir={defaultOutputDir}
              cancellingTaskIds={cancellingTaskIds}
              cancelQueueTask={cancelQueueTask}
            />
            <HistoryPanel
              items={historyVisibleItems}
              defaultOutputDir={defaultOutputDir}
              deletingHistoryIds={deletingHistoryIds}
              deleteHistoryItem={deleteHistoryItem}
            />
          </div>
          <div className="right-column">
            <ConfigPanel
              runtimeProviders={runtimeProviders}
              runtimeProviderId={runtimeProviderId}
              setRuntimeProviderId={setRuntimeProviderId}
              runtimeDirection={runtimeDirection}
              setRuntimeDirection={setRuntimeDirection}
              runtimePages={runtimePages}
              setRuntimePages={setRuntimePages}
              runtimeOutputDirValue={runtimeOutputDirValue}
              defaultOutputDir={defaultOutputDir}
              pickRuntimeOutputDir={pickRuntimeOutputDir}
              setRuntimeOutputDir={setRuntimeOutputDir}
              runtimeWatermarkMode={runtimeWatermarkMode}
              setRuntimeWatermarkMode={setRuntimeWatermarkMode}
              runtimeOutputMode={runtimeOutputMode}
              setRuntimeOutputMode={setRuntimeOutputMode}
              runtimeFiles={runtimeFiles}
              pickRuntimeFiles={pickRuntimeFiles}
              setRuntimeFiles={setRuntimeFiles}
              isRuntimeSubmitting={isRuntimeSubmitting}
              canSubmitRuntimeTask={canSubmitRuntimeTask}
              submitRuntimeTasks={submitRuntimeTasks}
              isSettingsOpen={isSettingsOpen}
              setIsSettingsOpen={setIsSettingsOpen}
              isEnvReady={isEnvReady}
            />
          </div>
        </div>

        {envState === "installing" || envState === "missing" || envState === "error" ? (
          <div
            className="env-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Environment check"
          >
            <section className="env-modal">
              {envState === "installing" ? (
                <>
                  <p className="env-line">{envMessage}</p>
                  <p className="env-line">请保持应用开启。</p>
                  <div className="env-progress-list" aria-live="polite">
                    {envProgressItems.map((item, index) => (
                      <p className="env-status-text" key={`${item}-${index}`}>
                        {item}
                      </p>
                    ))}
                  </div>
                </>
              ) : null}

              {envState === "missing" || envState === "error" ? (
                <div className="env-compact">
                  <div className="env-copy">
                    <p className="env-line">{envMessage}</p>
                    {envErrorMessage !== "" ? (
                      <p className="env-error-text">{envErrorMessage}</p>
                    ) : null}
                  </div>
                  <button
                    className="primary-btn"
                    type="button"
                    onClick={() => {
                      void installRuntimeEnv();
                    }}
                    disabled={isEnvBusy}
                  >
                    {envState === "error" ? "重试安装" : "安装环境"}
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        <div
          className={`settings-overlay${isSettingsOpen ? " is-open" : ""}`}
          aria-hidden={!isSettingsOpen}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <aside
            id="settings-modal"
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="参数配置"
          >
            <button
              className="settings-close-btn"
              type="button"
              aria-label="Close settings"
              onClick={() => setIsSettingsOpen(false)}
            >
              <X aria-hidden="true" />
            </button>

            <h2 className="settings-title">参数配置</h2>

            <div className="settings-form">
              <section className="settings-section">
                <div className="settings-section-header">
                  <h3>翻译参数</h3>
                  <button
                    className="primary-btn section-confirm-btn"
                    type="button"
                    disabled={isLoading || isSaving}
                    onClick={() => {
                      void saveSection("translate");
                    }}
                  >
                    <Save aria-hidden="true" />
                    {isSaving ? "保存中..." : "确认翻译参数"}
                  </button>
                </div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span>翻译方向</span>
                    <div className="direction-switch" role="radiogroup" aria-label="翻译方向">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={draft.direction === "zhToEn"}
                        className={`direction-option${
                          draft.direction === "zhToEn" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, direction: "zhToEn" }))
                        }
                      >
                        中文到英文
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={draft.direction === "enToZh"}
                        className={`direction-option${
                          draft.direction === "enToZh" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, direction: "enToZh" }))
                        }
                      >
                        英文到中文
                      </button>
                    </div>
                  </label>
                  <label className="settings-field">
                    <span>请求频率 (QPS)</span>
                    <div className="qps-control">
                      <input
                        className="qps-slider"
                        type="range"
                        min={QPS_MIN}
                        max={QPS_MAX}
                        step={1}
                        value={qpsValue}
                        onChange={(event) =>
                          setDraft((prev) => ({ ...prev, qps: event.target.value }))
                        }
                      />
                      <div className="qps-scale" aria-hidden="true">
                        <span>1</span>
                        <span>4</span>
                        <span>8</span>
                        <span>{QPS_MAX}</span>
                      </div>
                    </div>
                  </label>
                  <label className="settings-field">
                    <span>水印输出模式</span>
                    <div className="direction-switch direction-switch--three">
                      <button
                        type="button"
                        className={`direction-option${
                          draft.watermarkOutputMode === "watermarked" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            watermarkOutputMode: "watermarked",
                          }))
                        }
                      >
                        仅水印
                      </button>
                      <button
                        type="button"
                        className={`direction-option${
                          draft.watermarkOutputMode === "no_watermark" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            watermarkOutputMode: "no_watermark",
                          }))
                        }
                      >
                        无水印
                      </button>
                      <button
                        type="button"
                        className={`direction-option${
                          draft.watermarkOutputMode === "both" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            watermarkOutputMode: "both",
                          }))
                        }
                      >
                        双版本
                      </button>
                    </div>
                  </label>
                  <label className="settings-field">
                    <span>输出格式</span>
                    <div className="direction-switch">
                      <button
                        type="button"
                        className={`direction-option${
                          draft.outputMode === "dualOnly" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, outputMode: "dualOnly" }))
                        }
                      >
                        双语对照
                      </button>
                      <button
                        type="button"
                        className={`direction-option${
                          draft.outputMode === "monoOnly" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, outputMode: "monoOnly" }))
                        }
                      >
                        仅译文
                      </button>
                    </div>
                  </label>
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-header">
                  <h3>API 参数</h3>
                  <button
                    className="outline-btn"
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        providers: [
                          ...prev.providers,
                          { ...BLANK_PROVIDER, _key: crypto.randomUUID() },
                        ],
                      }))
                    }
                  >
                    <Plus aria-hidden="true" />
                    新增一组
                  </button>
                </div>

                {draft.providers.length === 0 ? null : (
                  <div className="provider-list">
                    {draft.providers.map((provider, index) => (
                      <article className="provider-card" key={provider._key ?? `provider-${index}`}>
                        <div className="settings-grid provider-grid">
                          <label className="settings-field">
                            <span>Model Name</span>
                            <input
                              type="text"
                              value={provider.modelName}
                              onChange={(event) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  providers: prev.providers.map((item, i) =>
                                    i === index
                                      ? { ...item, modelName: event.target.value }
                                      : item,
                                  ),
                                }))
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>Model</span>
                            <input
                              type="text"
                              value={provider.model}
                              onChange={(event) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  providers: prev.providers.map((item, i) =>
                                    i === index
                                      ? { ...item, model: event.target.value }
                                      : item,
                                  ),
                                }))
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>Base URL</span>
                            <input
                              type="text"
                              value={provider.baseUrl}
                              onChange={(event) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  providers: prev.providers.map((item, i) =>
                                    i === index
                                      ? { ...item, baseUrl: event.target.value }
                                      : item,
                                  ),
                                }))
                              }
                            />
                          </label>
                          <label className="settings-field">
                            <span>API Key</span>
                            <input
                              type="password"
                              value={provider.apiKey}
                              onChange={(event) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  providers: prev.providers.map((item, i) =>
                                    i === index
                                      ? { ...item, apiKey: event.target.value }
                                      : item,
                                  ),
                                }))
                              }
                            />
                          </label>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {draft.providers.length > 0 ? (
                  <div className="api-section-footer">
                    <button
                      className="primary-btn section-confirm-btn"
                      type="button"
                      disabled={isLoading || isSaving}
                      onClick={() => {
                        void saveSection("api");
                      }}
                    >
                      <Save aria-hidden="true" />
                      {isSaving ? "保存中..." : "确认 API 参数"}
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </aside>
        </div>
      </section>
      {envState === "checking" ? (
        <div className="env-float-layer" role="status" aria-live="polite">
          <section className="env-float-card">
            <p className="env-banner-title">正在检测环境</p>
            <p className="env-banner-text">{envMessage}</p>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
