import { ChevronDown, Settings, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Direction, WatermarkOutputMode, OutputMode, RuntimeProvider } from "../utils";
import { firstFileName } from "../utils";

type ConfigPanelProps = {
  runtimeProviders: RuntimeProvider[];
  runtimeProviderId: string;
  setRuntimeProviderId: (id: string) => void;
  runtimeDirection: Direction;
  setRuntimeDirection: (dir: Direction) => void;
  runtimePages: string;
  setRuntimePages: (pages: string) => void;
  runtimeOutputDirValue: string;
  defaultOutputDir: string;
  pickRuntimeOutputDir: () => void;
  setRuntimeOutputDir: (dir: string) => void;
  runtimeWatermarkMode: WatermarkOutputMode;
  setRuntimeWatermarkMode: (mode: WatermarkOutputMode) => void;
  runtimeOutputMode: OutputMode;
  setRuntimeOutputMode: (mode: OutputMode) => void;
  runtimeFiles: string[];
  pickRuntimeFiles: () => void;
  setRuntimeFiles: (files: string[]) => void;
  isRuntimeSubmitting: boolean;
  canSubmitRuntimeTask: boolean;
  submitRuntimeTasks: () => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  isEnvReady: boolean;
};

export default function ConfigPanel(props: ConfigPanelProps) {
  const {
    runtimeProviders,
    runtimeProviderId,
    setRuntimeProviderId,
    runtimeDirection,
    setRuntimeDirection,
    runtimePages,
    setRuntimePages,
    runtimeOutputDirValue,
    defaultOutputDir,
    pickRuntimeOutputDir,
    setRuntimeOutputDir,
    runtimeWatermarkMode,
    setRuntimeWatermarkMode,
    runtimeOutputMode,
    setRuntimeOutputMode,
    runtimeFiles,
    pickRuntimeFiles,
    setRuntimeFiles,
    isRuntimeSubmitting,
    canSubmitRuntimeTask,
    submitRuntimeTasks,
    isSettingsOpen,
    setIsSettingsOpen,
    isEnvReady,
  } = props;

  const modelPickerRef = useRef<HTMLDivElement>(null);
  const isModelMenuOpenRef = useRef(false);

  const toggleModelMenu = () => {
    isModelMenuOpenRef.current = !isModelMenuOpenRef.current;
    modelPickerRef.current?.classList.toggle("is-open", isModelMenuOpenRef.current);
  };

  const closeModelMenu = () => {
    isModelMenuOpenRef.current = false;
    modelPickerRef.current?.classList.remove("is-open");
  };

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target || modelPickerRef.current?.contains(target)) return;
      closeModelMenu();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  const selectedProvider = runtimeProviders.find((p) => p.id === runtimeProviderId) ?? null;

  return (
    <section className="panel panel--config">
      <header className="panel-header">
        <h2>实时配置</h2>
        <button
          className="panel-header-btn"
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
      </header>
      <div className="panel-body panel-body--config">
        <div className="runtime-form">
          <label className="field">
            <span className="field-label">翻译模型</span>
            <div ref={modelPickerRef} className="model-picker">
              <button
                className="model-picker-trigger"
                type="button"
                onClick={toggleModelMenu}
                disabled={runtimeProviders.length === 0}
                aria-expanded={isModelMenuOpenRef.current}
                aria-haspopup="listbox"
              >
                <span className="model-picker-label">
                  {selectedProvider
                    ? selectedProvider.modelName
                    : runtimeProviders.length > 0
                      ? "请选择模型"
                      : "请先在设置中配置 API 参数"}
                </span>
                <ChevronDown aria-hidden="true" className="model-picker-chevron" />
              </button>
              <div className="model-picker-menu" role="listbox">
                {runtimeProviders.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`model-picker-option${
                      provider.id === runtimeProviderId ? " is-selected" : ""
                    }`}
                    onClick={() => {
                      setRuntimeProviderId(provider.id);
                      closeModelMenu();
                    }}
                  >
                    {provider.modelName}
                  </button>
                ))}
              </div>
            </div>
          </label>

          <label className="field">
            <span className="field-label">翻译方向</span>
            <div className="pill-switch" role="radiogroup" aria-label="翻译方向">
              <button
                type="button"
                role="radio"
                aria-checked={runtimeDirection === "zhToEn"}
                className={`pill-option${runtimeDirection === "zhToEn" ? " is-active" : ""}`}
                onClick={() => setRuntimeDirection("zhToEn")}
              >
                中译英
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={runtimeDirection === "enToZh"}
                className={`pill-option${runtimeDirection === "enToZh" ? " is-active" : ""}`}
                onClick={() => setRuntimeDirection("enToZh")}
              >
                英译中
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-label">翻译页码（可选）</span>
            <input
              className="field-input"
              type="text"
              value={runtimePages}
              placeholder="例如: 1-3,7,10-12"
              onChange={(e) => setRuntimePages(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">输出目录</span>
            <div className="output-row">
              <button
                className={`outline-btn output-picker-btn${runtimeOutputDirValue === "" ? " is-empty" : ""}`}
                type="button"
                title={runtimeOutputDirValue === "" ? defaultOutputDir : runtimeOutputDirValue}
                onClick={() => pickRuntimeOutputDir()}
              >
                {runtimeOutputDirValue === ""
                  ? defaultOutputDir || "选择输出文件夹"
                  : runtimeOutputDirValue}
              </button>
              <button
                className="icon-btn output-clear-btn"
                type="button"
                aria-label="清空输出目录"
                title="清空输出目录"
                disabled={runtimeOutputDirValue === ""}
                onClick={() => setRuntimeOutputDir("")}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-label">水印模式</span>
            <div className="pill-switch pill-switch--three">
              <button
                type="button"
                className={`pill-option${runtimeWatermarkMode === "watermarked" ? " is-active" : ""}`}
                onClick={() => setRuntimeWatermarkMode("watermarked")}
              >
                仅水印
              </button>
              <button
                type="button"
                className={`pill-option${runtimeWatermarkMode === "no_watermark" ? " is-active" : ""}`}
                onClick={() => setRuntimeWatermarkMode("no_watermark")}
              >
                无水印
              </button>
              <button
                type="button"
                className={`pill-option${runtimeWatermarkMode === "both" ? " is-active" : ""}`}
                onClick={() => setRuntimeWatermarkMode("both")}
              >
                双版本
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-label">输出模式</span>
            <div className="pill-switch">
              <button
                type="button"
                className={`pill-option${runtimeOutputMode === "dualOnly" ? " is-active" : ""}`}
                onClick={() => setRuntimeOutputMode("dualOnly")}
              >
                双语对照
              </button>
              <button
                type="button"
                className={`pill-option${runtimeOutputMode === "monoOnly" ? " is-active" : ""}`}
                onClick={() => setRuntimeOutputMode("monoOnly")}
              >
                仅译文
              </button>
            </div>
          </label>

          <div className="runtime-toolbar">
            <button className="outline-btn" type="button" onClick={() => pickRuntimeFiles()}>
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
              onClick={() => submitRuntimeTasks()}
            >
              {isRuntimeSubmitting ? "创建中..." : "加入待办"}
            </button>
          </div>

          {runtimeFiles.length > 0 ? (
            <div className="runtime-files">
              {runtimeFiles.map((file, index) => (
                <p className="runtime-file-item" key={`${file}-${index}`} title={file}>
                  {firstFileName([file])}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
