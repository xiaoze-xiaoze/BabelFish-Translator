export type Direction = "zhToEn" | "enToZh";
export type WatermarkOutputMode = "watermarked" | "no_watermark" | "both";
export type OutputMode = "dualAndMono" | "dualOnly" | "monoOnly";
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type EnvState = "checking" | "ready" | "missing" | "installing" | "error";

export type ProviderSettings = {
  modelName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Frontend-only stable ID for React keys. Not persisted to backend. */
  _key?: string;
};

export type AppSettings = {
  schemaVersion: number;
  providers: ProviderSettings[];
  direction: Direction;
  qps: number;
  outputDir: string;
  watermarkOutputMode: WatermarkOutputMode;
  outputMode: OutputMode;
};

export type AppSettingsDraft = Omit<AppSettings, "qps"> & {
  qps: string;
};

export type EnvCheckResult = {
  babelfishVersion: boolean;
  babeldocVersion?: string | null;
  uvVersion?: string | null;
  message?: string | null;
};

export type RuntimeProvider = ProviderSettings & {
  id: string;
};

export const QPS_MIN = 1;
export const QPS_MAX = 12;

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 3,
  providers: [],
  direction: "zhToEn",
  qps: 4,
  outputDir: "",
  watermarkOutputMode: "watermarked",
  outputMode: "dualOnly",
};

export const BLANK_PROVIDER: ProviderSettings = {
  modelName: "",
  model: "",
  baseUrl: "",
  apiKey: "",
};

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

export function firstFileName(files: string[]): string {
  const first = files[0]?.trim();
  if (!first) return "(未提供文件)";
  const normalized = first.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s !== "");
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

export function outputLabel(
  output?: string | null,
  defaultDir?: string,
): string {
  const trimmed = output?.trim();
  if (trimmed) return trimmed;
  return defaultDir || "默认输出目录";
}

export function statusLabel(status: string): string {
  switch (status) {
    case "pending": return "排队中";
    case "running": return "进行中";
    case "succeeded": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    default: return "未知";
  }
}

export function cloneProviders(
  providers: ProviderSettings[],
): ProviderSettings[] {
  return providers.map((p) => ({ ...p }));
}

export function cloneDraft(draft: AppSettingsDraft): AppSettingsDraft {
  return { ...draft, providers: cloneProviders(draft.providers) };
}

export function normalizeSettings(
  raw: Partial<AppSettings> | undefined,
): AppSettings {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    providers: Array.isArray(raw?.providers)
      ? raw.providers.map((p) => ({
          modelName: p?.modelName ?? "",
          model: p?.model ?? "",
          baseUrl: p?.baseUrl ?? "",
          apiKey: p?.apiKey ?? "",
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

export function toDraft(settings: AppSettings): AppSettingsDraft {
  return {
    ...settings,
    qps: String(settings.qps),
    providers: cloneProviders(settings.providers),
  };
}

export function toPayload(draft: AppSettingsDraft): AppSettings {
  const qps = Number.parseInt(draft.qps, 10);
  const providers = draft.providers
    .map((p) => ({
      modelName: p.modelName.trim(),
      model: p.model.trim(),
      baseUrl: p.baseUrl.trim(),
      apiKey: p.apiKey.trim(),
    }))
    .filter(
      (p) =>
        p.modelName !== "" ||
        p.model !== "" ||
        p.baseUrl !== "" ||
        p.apiKey !== "",
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

export function normalizeQps(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < QPS_MIN) return QPS_MIN;
  if (parsed > QPS_MAX) return QPS_MAX;
  return parsed;
}

export function validateTranslateDraft(
  draft: AppSettingsDraft,
): string | null {
  const parsedQps = Number.parseInt(draft.qps, 10);
  if (!Number.isFinite(parsedQps) || parsedQps < 1) {
    return "QPS must be an integer >= 1";
  }
  return null;
}

export function validateApiDraft(draft: AppSettingsDraft): string | null {
  for (let i = 0; i < draft.providers.length; i += 1) {
    const p = draft.providers[i];
    const modelName = p.modelName.trim();
    const model = p.model.trim();
    const baseUrl = p.baseUrl.trim();
    const apiKey = p.apiKey.trim();

    const isEmpty =
      modelName === "" && model === "" && baseUrl === "" && apiKey === "";
    if (isEmpty) continue;

    if (modelName === "" || model === "" || baseUrl === "") {
      return `Provider ${i + 1}: modelName / model / baseUrl are required`;
    }
  }
  return null;
}

export function formatEnvError(error: unknown): string {
  if (typeof error === "string") return error;
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

export function resolveEnvMessage(result: EnvCheckResult): string {
  if (result.babelfishVersion) return "环境准备完成。";
  if (result.uvVersion) return "已检测到 uv，还缺少 BabelDOC，可直接继续安装。";
  return "未检测到 uv 和 BabelDOC，请先安装环境。";
}
