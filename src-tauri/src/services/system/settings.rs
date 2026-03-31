use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tempfile::NamedTempFile;

const SETTINGS_FILE_NAME: &str = ".settings.json";
const CURRENT_SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub schema_version: u32,
    pub providers: Vec<ProviderSettings>,
    pub direction: String,
    pub qps: u32,
    pub output_dir: String,
    pub watermark_output_mode: String,
    pub output_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    #[serde(default)]
    pub model_name: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            providers: vec![],
            direction: "zhToEn".to_string(),
            qps: 4,
            output_dir: String::new(),
            watermark_output_mode: "watermarked".to_string(),
            output_mode: "dualOnly".to_string(),
        }
    }
}

fn settings_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve config dir failed: {e}"))?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if settings.qps == 0 {
        return Err("qps must be >= 1".to_string());
    }

    for (i, p) in settings.providers.iter().enumerate() {
        if p.model_name.trim().is_empty() {
            return Err(format!("providers[{i}].modelName is required"));
        }
        if p.model.trim().is_empty() {
            return Err(format!("providers[{i}].model is required"));
        }
        if p.base_url.trim().is_empty() {
            return Err(format!("providers[{i}].baseUrl is required"));
        }
    }

    Ok(())
}

fn write_settings_atomically(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "settings path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {e}"))?;

    let mut normalized = settings.clone();
    normalized.schema_version = CURRENT_SCHEMA_VERSION;

    let content = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("serialize settings failed: {e}"))?;
    let mut tmp = NamedTempFile::new_in(parent)
        .map_err(|e| format!("create temp settings file failed: {e}"))?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| format!("write temp settings failed: {e}"))?;
    tmp.write_all(b"\n")
        .map_err(|e| format!("write temp settings newline failed: {e}"))?;
    tmp.as_file_mut()
        .sync_all()
        .map_err(|e| format!("sync temp settings failed: {e}"))?;
    tmp.persist(path)
        .map_err(|e| format!("replace settings file failed: {}", e.error))?;

    Ok(())
}

fn backup_broken(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("time error: {e}"))?
        .as_secs();

    let backup = path.with_file_name(format!("{SETTINGS_FILE_NAME}.broken-{ts}"));
    fs::copy(path, &backup).map_err(|e| format!("backup broken settings failed: {e}"))?;
    Ok(())
}

fn migrate_to_current(value: Value) -> Result<AppSettings, String> {
    let schema = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    if schema > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "unsupported schemaVersion {schema}, current is {CURRENT_SCHEMA_VERSION}"
        ));
    }

    let mut settings: AppSettings =
        serde_json::from_value(value).map_err(|e| format!("parse settings failed: {e}"))?;

    if schema < 2 {
        for provider in &mut settings.providers {
            if provider.model_name.trim().is_empty() {
                provider.model_name = provider.model.clone();
            }
        }
    }

    settings.schema_version = CURRENT_SCHEMA_VERSION;

    Ok(settings)
}

fn read_settings(path: &Path) -> Result<AppSettings, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read settings failed: {e}"))?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse settings json failed: {e}"))?;
    let settings = migrate_to_current(value)?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn ensure_settings(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let path = settings_path(app_handle)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {e}"))?;
    }

    if !path.exists() {
        write_settings_atomically(&path, &AppSettings::default())?;
        return Ok(path);
    }

    if let Err(err) = read_settings(&path) {
        eprintln!("settings broken, recreate default: {err}");
        backup_broken(&path)?;
        write_settings_atomically(&path, &AppSettings::default())?;
    }

    Ok(path)
}

pub fn get_settings(app_handle: AppHandle) -> Result<AppSettings, String> {
    let path = ensure_settings(&app_handle)?;
    read_settings(&path)
}

pub fn save_settings(
    app_handle: AppHandle,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    validate_settings(&settings)?;
    settings.schema_version = CURRENT_SCHEMA_VERSION;
    let path = ensure_settings(&app_handle)?;
    write_settings_atomically(&path, &settings)?;
    Ok(settings)
}
