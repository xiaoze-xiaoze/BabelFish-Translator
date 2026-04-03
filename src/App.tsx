import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Plus, Save, Settings, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type ProviderSettings = {
  modelName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
};

type AppSettings = {
  schemaVersion: number;
  providers: ProviderSettings[];
  direction: Direction;
  qps: number;
  outputDir: string;
  watermarkOutputMode: WatermarkOutputMode;
  outputMode: OutputMode;
};

type AppSettingsDraft = Omit<AppSettings, "qps"> & {
  qps: string;
};

type EnvState = "checking" | "ready" | "missing" | "installing" | "error";

type EnvCheckResult = {
  babelfishVersion: boolean;
  babeldocVersion?: string | null;
  uvVersion?: string | null;
  message?: string | null;
};

type EnvProgressEvent = {
  stage: string;
  message: string;
  detail?: string | null;
};

type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
type Direction = "zhToEn" | "enToZh";
type WatermarkOutputMode = "watermarked" | "no_watermark" | "both";
type OutputMode = "dualAndMono" | "dualOnly" | "monoOnly";

type RuntimeProvider = ProviderSettings & {
  id: string;
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


const QPS_MIN = 1;
const QPS_MAX = 12;
const ENV_PROGRESS_EVENT = "env://progress";

let sharedEnvCheckPromise: Promise<EnvCheckResult> | null = null;

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 3,
  providers: [],
  direction: "zhToEn",
  qps: 4,
  outputDir: "",
  watermarkOutputMode: "watermarked",
  outputMode: "dualOnly",
};

const BLANK_PROVIDER: ProviderSettings = {
  modelName: "",
  model: "",
  baseUrl: "",
  apiKey: "",
};

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

function cloneProviders(providers: ProviderSettings[]): ProviderSettings[] {
  return providers.map((provider) => ({ ...provider }));
}

function cloneDraft(draft: AppSettingsDraft): AppSettingsDraft {
  return {
    ...draft,
    providers: cloneProviders(draft.providers),
  };
}

function normalizeSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    providers: Array.isArray(raw?.providers)
      ? raw.providers.map((provider) => ({
          modelName: provider?.modelName ?? "",
          model: provider?.model ?? "",
          baseUrl: provider?.baseUrl ?? "",
          apiKey: provider?.apiKey ?? "",
        }))
      : [],
  };

  if (!Number.isFinite(merged.qps) || merged.qps < QPS_MIN) {
    merged.qps = QPS_MIN;
  }
  if (merged.qps > QPS_MAX) {
    merged.qps = QPS_MAX;
  }
  if (merged.direction !== "zhToEn" && merged.direction !== "enToZh") {
    merged.direction = "zhToEn";
  }
  if (
    merged.watermarkOutputMode !== "watermarked" &&
    merged.watermarkOutputMode !== "no_watermark" &&
    merged.watermarkOutputMode !== "both"
  ) {
    merged.watermarkOutputMode = "watermarked";
  }
  if (
    merged.outputMode !== "dualAndMono" &&
    merged.outputMode !== "dualOnly" &&
    merged.outputMode !== "monoOnly"
  ) {
    merged.outputMode = "dualOnly";
  }
  if (merged.outputMode === "dualAndMono") {
    merged.outputMode = "dualOnly";
  }

  return merged;
}

function toDraft(settings: AppSettings): AppSettingsDraft {
  return {
    ...settings,
    qps: String(settings.qps),
    providers: cloneProviders(settings.providers),
  };
}

function validateTranslateDraft(draft: AppSettingsDraft): string | null {
  const parsedQps = Number.parseInt(draft.qps, 10);
  if (!Number.isFinite(parsedQps) || parsedQps < 1) {
    return "QPS must be an integer >= 1";
  }

  return null;
}

function validateApiDraft(draft: AppSettingsDraft): string | null {
  for (let i = 0; i < draft.providers.length; i += 1) {
    const provider = draft.providers[i];
    const modelName = provider.modelName.trim();
    const model = provider.model.trim();
    const baseUrl = provider.baseUrl.trim();
    const apiKey = provider.apiKey.trim();

    const isEmpty =
      modelName === "" && model === "" && baseUrl === "" && apiKey === "";
    if (isEmpty) {
      continue;
    }

    if (modelName === "" || model === "" || baseUrl === "") {
      return `Provider ${i + 1}: modelName / model / baseUrl are required`;
    }
  }

  return null;
}

function formatEnvError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return String(error);
}

function resolveEnvMessage(result: EnvCheckResult): string {
  if (result.babelfishVersion) {
    return "环境准备完成。";
  }

  if (result.uvVersion) {
    return "已检测到 uv，还缺少 BabelDOC，可直接继续安装。";
  }

  return "未检测到 uv 和 BabelDOC，请先安装环境。";
}

function runSharedEnvCheck(): Promise<EnvCheckResult> {
  if (!sharedEnvCheckPromise) {
    sharedEnvCheckPromise = invoke<EnvCheckResult>("env_check").finally(() => {
      sharedEnvCheckPromise = null;
    });
  }

  return sharedEnvCheckPromise;
}

function toPayload(draft: AppSettingsDraft): AppSettings {
  const qps = Number.parseInt(draft.qps, 10);

  const providers = draft.providers
    .map((provider) => ({
      modelName: provider.modelName.trim(),
      model: provider.model.trim(),
      baseUrl: provider.baseUrl.trim(),
      apiKey: provider.apiKey.trim(),
    }))
    .filter(
      (provider) =>
        provider.modelName !== "" ||
        provider.model !== "" ||
        provider.baseUrl !== "" ||
        provider.apiKey !== "",
    );

  return {
    schemaVersion: draft.schemaVersion,
    providers,
    direction: draft.direction,
    qps: Number.isFinite(qps) && qps >= 1 ? qps : 1,
    outputDir: draft.outputDir.trim(),
    watermarkOutputMode: draft.watermarkOutputMode,
    outputMode: draft.outputMode,
  };
}

function normalizeQps(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < QPS_MIN) {
    return QPS_MIN;
  }
  if (parsed > QPS_MAX) {
    return QPS_MAX;
  }
  return parsed;
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "\u6392\u961f\u4e2d";
    case "running":
      return "\u8fdb\u884c\u4e2d";
    case "succeeded":
      return "\u5df2\u5b8c\u6210";
    case "failed":
      return "\u5931\u8d25";
    case "cancelled":
      return "\u5df2\u53d6\u6d88";
    default:
      return "\u672a\u77e5";
  }
}

function firstFileName(files: string[]): string {
  const first = files[0]?.trim();
  if (!first) {
    return "(\u672a\u63d0\u4f9b\u6587\u4ef6)";
  }

  const normalized = first.replace(/\\/g, "/");
  const segments = normalized
    .split("/")
    .filter((segment: string) => segment !== "");
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

function outputLabel(output?: string | null): string {
  const trimmed = output?.trim();
  return trimmed && trimmed !== ""
    ? trimmed
    : "(\u9ed8\u8ba4\u8f93\u51fa\u76ee\u5f55)";
}
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
  const [isRuntimeModelMenuOpen, setIsRuntimeModelMenuOpen] = useState(false);
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingHistoryIds, setDeletingHistoryIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [historyHasTopFade, setHistoryHasTopFade] = useState(false);
  const [historyHasBottomFade, setHistoryHasBottomFade] = useState(false);
  const [queueHasTopFade, setQueueHasTopFade] = useState(false);
  const [queueHasBottomFade, setQueueHasBottomFade] = useState(false);
  const runtimeModelPickerRef = useRef<HTMLDivElement | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const queueListRef = useRef<HTMLDivElement | null>(null);

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
  const selectedRuntimeProvider =
    runtimeProviders.find((provider) => provider.id === runtimeProviderId) ?? null;
  const runtimeOutputDirValue = runtimeOutputDir.trim();
  const canSubmitRuntimeTask =
    tauriAvailable && isEnvReady && selectedRuntimeProvider !== null && runtimeFiles.length > 0;
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

  const readFadeFlags = (element: HTMLDivElement | null) => {
    if (!element) {
      return { top: false, bottom: false };
    }
    if (element.scrollHeight <= element.clientHeight + 1) {
      return { top: false, bottom: false };
    }

    const atTop = element.scrollTop <= 1;
    const atBottom =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    return {
      top: !atTop,
      bottom: !atBottom,
    };
  };

  const syncHistoryFade = () => {
    const flags = readFadeFlags(historyListRef.current);
    setHistoryHasTopFade(flags.top);
    setHistoryHasBottomFade(flags.bottom);
  };

  const syncQueueFade = () => {
    const flags = readFadeFlags(queueListRef.current);
    setQueueHasTopFade(flags.top);
    setQueueHasBottomFade(flags.bottom);
  };

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
    if (!canSubmitRuntimeTask || !selectedRuntimeProvider) {
      return;
    }

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
      openaiModel: selectedRuntimeProvider.model.trim(),
      openaiBaseUrl: selectedRuntimeProvider.baseUrl.trim(),
      openaiApiKey: selectedRuntimeProvider.apiKey.trim(),
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
      setIsRuntimeModelMenuOpen(false);
      return;
    }
    if (runtimeProviders.some((provider) => provider.id === runtimeProviderId)) {
      return;
    }
    setRuntimeProviderId(runtimeProviders[0].id);
  }, [runtimeProviders, runtimeProviderId]);

  useEffect(() => {
    if (!isRuntimeModelMenuOpen) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (runtimeModelPickerRef.current?.contains(target)) {
        return;
      }
      setIsRuntimeModelMenuOpen(false);
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isRuntimeModelMenuOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      syncHistoryFade();
      syncQueueFade();
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [historyVisibleItems, queueItems, isEnvReady]);

  useEffect(() => {
    const handleResize = () => {
      syncHistoryFade();
      syncQueueFade();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

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
      <section className="glass-board" aria-label="workspace">
        <div className="settings-anchor">
          <span className="brand-mark" aria-hidden="true">
            BabelFish
          </span>
          <button
            className="settings-btn"
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

        <div className="main-panels" aria-label="main workspace">
          <section className="main-panel main-panel--history" aria-label="history-records">
            <header className="main-panel-header">
              <h2>{"\u5386\u53f2\u8bb0\u5f55"}</h2>
            </header>
            <div
              className={`panel-body panel-body--history task-strip-list${
                historyHasTopFade ? " has-top-fade" : ""
              }${historyHasBottomFade ? " has-bottom-fade" : ""}`}
              ref={historyListRef}
              onScroll={syncHistoryFade}
            >
              {historyVisibleItems.map((item) => (
                <article className="task-strip task-strip--history" key={`history-${item.id}`}>
                  <p className="task-strip-line">
                    <span className="task-strip-key">PDF</span>
                    <span className="task-strip-value" title={item.files[0] ?? ""}>
                      {firstFileName(item.files)}
                    </span>
                    <span className="task-strip-key">{"\u4fdd\u5b58\u5230"}</span>
                    <span className="task-strip-value" title={outputLabel(item.output)}>
                      {outputLabel(item.output)}
                    </span>
                  </p>
                  <button
                    className="danger-text-btn task-cancel-btn task-delete-btn"
                    type="button"
                    aria-label="\u5220\u9664\u5386\u53f2\u8bb0\u5f55"
                    title="\u5220\u9664"
                    disabled={deletingHistoryIds.has(item.id)}
                    onClick={() => {
                      void deleteHistoryItem(item.id);
                    }}
                  >
                    <span className="task-delete-mark" aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
          </section>

          <section className="main-panel main-panel--queue" aria-label="todo-queue">
            <header className="main-panel-header">
              <h2>{"\u5f85\u529e\u961f\u5217"}</h2>
            </header>
            <div
              className={`panel-body panel-body--queue task-strip-list${
                queueHasTopFade ? " has-top-fade" : ""
              }${queueHasBottomFade ? " has-bottom-fade" : ""}`}
              ref={queueListRef}
              onScroll={syncQueueFade}
            >
              {queueItems.map((task) => (
                <article className="task-strip" key={task.id}>
                  <p className="task-strip-line">
                    <span className="task-strip-key">PDF</span>
                    <span className="task-strip-value" title={task.files[0] ?? ""}>
                      {firstFileName(task.files)}
                    </span>
                    <span className="task-strip-key">{"\u4fdd\u5b58\u5230"}</span>
                    <span className="task-strip-value" title={outputLabel(task.output)}>
                      {outputLabel(task.output)}
                    </span>
                  </p>
                  <div className="task-strip-actions">
                    <span className={`task-chip task-chip--${task.status}`}>
                      {statusLabel(task.status)}
                    </span>
                    <button
                      className="danger-text-btn task-cancel-btn"
                      type="button"
                      disabled={cancellingTaskIds.has(task.id)}
                      onClick={() => {
                        void cancelQueueTask(task.id);
                      }}
                    >
                      {cancellingTaskIds.has(task.id)
                        ? "\u53d6\u6d88\u4e2d..."
                        : "\u53d6\u6d88"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="main-panel main-panel--config" aria-label="realtime-config">
            <header className="main-panel-header">
              <h2>实时配置</h2>
            </header>
            <div className="panel-body panel-body--config">
              <div className="runtime-form">
                <label className="settings-field">
                  <span>{"\u7ffb\u8bd1\u6a21\u578b"}</span>
                  <div
                    ref={runtimeModelPickerRef}
                    className={`runtime-model-picker${
                      isRuntimeModelMenuOpen ? " is-open" : ""
                    }`}
                  >
                    <button
                      className="runtime-model-trigger"
                      type="button"
                      onClick={() =>
                        setIsRuntimeModelMenuOpen((prev) => !prev)
                      }
                      disabled={runtimeProviders.length === 0}
                      aria-expanded={isRuntimeModelMenuOpen}
                      aria-haspopup="listbox"
                    >
                      <span className="runtime-model-label">
                        {selectedRuntimeProvider
                          ? selectedRuntimeProvider.modelName
                          : runtimeProviders.length > 0
                            ? "\u8bf7\u9009\u62e9\u6a21\u578b"
                            : "\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u914d\u7f6e API \u53c2\u6570"}
                      </span>
                      <ChevronDown aria-hidden="true" />
                    </button>
                    {isRuntimeModelMenuOpen ? (
                      <div className="runtime-model-menu" role="listbox">
                        {runtimeProviders.map((provider) => (
                          <button
                            key={provider.id}
                            type="button"
                            className={`runtime-model-option${
                              provider.id === runtimeProviderId
                                ? " is-selected"
                                : ""
                            }`}
                            onClick={() => {
                              setRuntimeProviderId(provider.id);
                              setIsRuntimeModelMenuOpen(false);
                            }}
                          >
                            {provider.modelName}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </label>

                <label className="settings-field">
                  <span>{"\u7ffb\u8bd1\u65b9\u5411"}</span>
                  <div className="direction-switch" role="radiogroup" aria-label={"\u7ffb\u8bd1\u65b9\u5411"}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={runtimeDirection === "zhToEn"}
                      className={`direction-option${
                        runtimeDirection === "zhToEn" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeDirection("zhToEn")}
                    >
                      {"\u4e2d\u8bd1\u82f1"}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={runtimeDirection === "enToZh"}
                      className={`direction-option${
                        runtimeDirection === "enToZh" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeDirection("enToZh")}
                    >
                      {"\u82f1\u8bd1\u4e2d"}
                    </button>
                  </div>
                </label>

                <label className="settings-field">
                  <span>{"\u7ffb\u8bd1\u9875\u7801\uff08\u53ef\u9009\uff09"}</span>
                  <input
                    className="runtime-pages-input"
                    type="text"
                    value={runtimePages}
                    placeholder={"\u4f8b\u5982: 1-3,7,10-12"}
                    onChange={(event) => setRuntimePages(event.target.value)}
                  />
                </label>

                <label className="settings-field">
                  <span>{"\u8f93\u51fa\u76ee\u5f55\uff08\u9ed8\u8ba4\u540c\u76ee\u5f55\uff09"}</span>
                  <div className="runtime-output-row">
                    <button
                      className={`outline-btn runtime-output-picker-btn${
                        runtimeOutputDirValue === "" ? " is-empty" : ""
                      }`}
                      type="button"
                      title={
                        runtimeOutputDirValue === ""
                          ? "\u9009\u62e9\u8f93\u51fa\u6587\u4ef6\u5939"
                          : runtimeOutputDirValue
                      }
                      onClick={() => {
                        void pickRuntimeOutputDir();
                      }}
                    >
                      {runtimeOutputDirValue === ""
                        ? "\u9009\u62e9\u8f93\u51fa\u6587\u4ef6\u5939"
                        : runtimeOutputDirValue}
                    </button>
                    <button
                      className="outline-btn runtime-output-clear-btn"
                      type="button"
                      aria-label="\u6e05\u7a7a\u8f93\u51fa\u76ee\u5f55"
                      title="\u6e05\u7a7a\u8f93\u51fa\u76ee\u5f55"
                      disabled={runtimeOutputDirValue === ""}
                      onClick={() => setRuntimeOutputDir("")}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </div>
                </label>

                <label className="settings-field">
                  <span>水印模式</span>
                  <div className="direction-switch direction-switch--three">
                    <button
                      type="button"
                      className={`direction-option${
                        runtimeWatermarkMode === "watermarked" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeWatermarkMode("watermarked")}
                    >
                      仅水印                    </button>
                    <button
                      type="button"
                      className={`direction-option${
                        runtimeWatermarkMode === "no_watermark" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeWatermarkMode("no_watermark")}
                    >
                      无水印                    </button>
                    <button
                      type="button"
                      className={`direction-option${
                        runtimeWatermarkMode === "both" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeWatermarkMode("both")}
                    >
                      双版本                    </button>
                  </div>
                </label>

                <label className="settings-field">
                  <span>输出模式</span>
                  <div className="direction-switch">
                    <button
                      type="button"
                      className={`direction-option${
                        runtimeOutputMode === "dualOnly" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeOutputMode("dualOnly")}
                    >
                      双语对照
                    </button>
                    <button
                      type="button"
                      className={`direction-option${
                        runtimeOutputMode === "monoOnly" ? " is-active" : ""
                      }`}
                      onClick={() => setRuntimeOutputMode("monoOnly")}
                    >
                      仅译文                    </button>
                  </div>
                </label>

                <div className="runtime-toolbar">
                  <button
                    className="outline-btn"
                    type="button"
                    onClick={() => {
                      void pickRuntimeFiles();
                    }}
                  >
                    选择 PDF 文件
                  </button>
                  <button
                    className="danger-text-btn"
                    type="button"
                    disabled={runtimeFiles.length === 0}
                    onClick={() => setRuntimeFiles([])}
                  >
                    清空文件
                  </button>
                  <button
                    className="primary-btn"
                    type="button"
                    disabled={isRuntimeSubmitting || !canSubmitRuntimeTask}
                    onClick={() => {
                      void submitRuntimeTasks();
                    }}
                  >
                    {isRuntimeSubmitting
                      ? "\u521b\u5efa\u4e2d..."
                      : "\u52a0\u5165\u5f85\u529e"}
                  </button>
                </div>

                <div className="runtime-files">
                  {runtimeFiles.map((file, index) => (
                    <p className="runtime-file-item" key={`${file}-${index}`} title={file}>
                      {firstFileName([file])}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </section>
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
                  <p className="env-line">{"\u8bf7\u4fdd\u6301\u5e94\u7528\u5f00\u542f\u3002"}</p>
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
                    {envState === "error"
                      ? "\u91cd\u8bd5\u5b89\u88c5"
                      : "\u5b89\u88c5\u73af\u5883"}
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
                        中文到英文                      </button>
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
                        英文到中文                      </button>
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
                        仅水印                      </button>
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
                        无水印                      </button>
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
                        双版本                      </button>
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
                        仅译文                      </button>
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
                        providers: [...prev.providers, { ...BLANK_PROVIDER }],
                      }))
                    }
                  >
                    <Plus aria-hidden="true" />
                    新增一组                  </button>
                </div>

                {draft.providers.length === 0 ? null : (
                  <div className="provider-list">
                    {draft.providers.map((provider, index) => (
                      <article className="provider-card" key={`provider-${index}`}>
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
