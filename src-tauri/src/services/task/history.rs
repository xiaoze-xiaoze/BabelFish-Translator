use crate::services::task::store::{task_store, TaskItem, TaskStatus};
use crate::services::translate::command::{BabelDocCommand, OutputMode, WatermarkOutputMode};
use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const HISTORY_DB_FILE: &str = "translation-history.sqlite3";

struct HistoryStore {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: i64,
    pub task_id: String,
    pub status: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub files: Vec<String>,
    pub output: Option<String>,
    pub lang_in: String,
    pub lang_out: String,
    pub pages: Option<String>,
    pub qps: Option<u32>,
    pub use_openai: bool,
    pub openai_model: Option<String>,
    pub openai_base_url: Option<String>,
    pub watermark_output_mode: String,
    pub output_mode: String,
    pub result: Option<String>,
    pub error: Option<String>,
}

static HISTORY_STORE: OnceLock<Mutex<HistoryStore>> = OnceLock::new();

fn history_store() -> Result<&'static Mutex<HistoryStore>, String> {
    HISTORY_STORE
        .get()
        .ok_or_else(|| "history store is not initialized".to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn task_status_to_str(status: &TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn watermark_mode_to_str(mode: Option<&WatermarkOutputMode>) -> &'static str {
    match mode.unwrap_or(&WatermarkOutputMode::Watermarked) {
        WatermarkOutputMode::Watermarked => "watermarked",
        WatermarkOutputMode::NoWatermark => "no_watermark",
        WatermarkOutputMode::Both => "both",
    }
}

fn output_mode_to_str(mode: Option<&OutputMode>) -> &'static str {
    match mode.unwrap_or(&OutputMode::DualAndMono) {
        OutputMode::DualAndMono => "dualAndMono",
        OutputMode::DualOnly => "dualOnly",
        OutputMode::MonoOnly => "monoOnly",
    }
}

fn history_db_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve config dir failed: {e}"))?;
    fs::create_dir_all(&config_dir).map_err(|e| format!("create config dir failed: {e}"))?;
    Ok(config_dir.join(HISTORY_DB_FILE))
}

pub fn init_history(app_handle: &AppHandle) -> Result<(), String> {
    if HISTORY_STORE.get().is_some() {
        return Ok(());
    }

    let db_path = history_db_path(app_handle)?;
    let conn =
        Connection::open(db_path).map_err(|e| format!("open history database failed: {e}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS translation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            files_json TEXT NOT NULL,
            output TEXT,
            lang_in TEXT NOT NULL,
            lang_out TEXT NOT NULL,
            pages TEXT,
            qps INTEGER,
            use_openai INTEGER NOT NULL,
            openai_model TEXT,
            openai_base_url TEXT,
            watermark_output_mode TEXT NOT NULL,
            output_mode TEXT NOT NULL,
            result TEXT,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_translation_history_created_at
            ON translation_history(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_translation_history_task_id
            ON translation_history(task_id);
        "#,
    )
    .map_err(|e| format!("init history schema failed: {e}"))?;

    let store = HistoryStore { conn };
    let _ = HISTORY_STORE.set(Mutex::new(store));
    Ok(())
}

pub fn record_task_created(task_id: &str, command: &BabelDocCommand) {
    let record_result = (|| -> Result<(), String> {
        let store = history_store()?;
        let store = store
            .lock()
            .map_err(|e| format!("history store lock poisoned: {e}"))?;

        let now = now_secs();
        let files_json = serde_json::to_string(&command.files)
            .map_err(|e| format!("serialize history files failed: {e}"))?;

        let (openai_model, openai_base_url) = if command.use_openai {
            (
                Some(command.openai_model.clone()),
                Some(command.openai_base_url.clone()),
            )
        } else {
            (None, None)
        };

        store
            .conn
            .execute(
                r#"
                INSERT INTO translation_history (
                    task_id, status, created_at, updated_at, files_json, output,
                    lang_in, lang_out, pages, qps, use_openai, openai_model,
                    openai_base_url, watermark_output_mode, output_mode, result, error
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, NULL)
                "#,
                (
                    task_id,
                    "pending",
                    now as i64,
                    now as i64,
                    files_json,
                    command.output.clone(),
                    command.lang_in.clone(),
                    command.lang_out.clone(),
                    command.pages.clone(),
                    command.qps.map(|v| v as i64),
                    if command.use_openai { 1_i64 } else { 0_i64 },
                    openai_model,
                    openai_base_url,
                    watermark_mode_to_str(command.watermark_output_mode.as_ref()),
                    output_mode_to_str(command.output_mode.as_ref()),
                ),
            )
            .map_err(|e| format!("insert history record failed: {e}"))?;

        Ok(())
    })();

    if let Err(err) = record_result {
        eprintln!("record task created history failed for {task_id}: {err}");
    }
}

fn update_task_state(task_id: &str, task: &TaskItem) -> Result<(), String> {
    let store = history_store()?;
    let store = store
        .lock()
        .map_err(|e| format!("history store lock poisoned: {e}"))?;

    store
        .conn
        .execute(
            r#"
            UPDATE translation_history
            SET
                status = ?1,
                updated_at = ?2,
                output = ?3,
                result = ?4,
                error = ?5
            WHERE task_id = ?6
            ORDER BY id DESC
            LIMIT 1
            "#,
            (
                task_status_to_str(&task.status),
                task.updated_at as i64,
                task.output.clone(),
                task.result.clone(),
                task.error.clone(),
                task_id,
            ),
        )
        .map_err(|e| format!("update history state failed: {e}"))?;

    Ok(())
}

pub fn sync_task_state(task_id: &str) {
    let task = match task_store().lock() {
        Ok(store) => store.get_task(task_id),
        Err(err) => {
            eprintln!("task store lock poisoned while syncing history: {err}");
            None
        }
    };

    let Some(task) = task else {
        return;
    };

    if let Err(err) = update_task_state(task_id, &task) {
        eprintln!("sync task history failed for {task_id}: {err}");
    }
}

pub fn list_history(limit: Option<u32>) -> Result<Vec<HistoryItem>, String> {
    let store = history_store()?;
    let store = store
        .lock()
        .map_err(|e| format!("history store lock poisoned: {e}"))?;

    let bounded = limit.unwrap_or(100).clamp(1, 1000) as i64;

    let mut stmt = store
        .conn
        .prepare(
            r#"
            SELECT
                id, task_id, status, created_at, updated_at, files_json, output,
                lang_in, lang_out, pages, qps, use_openai, openai_model,
                openai_base_url, watermark_output_mode, output_mode, result, error
            FROM translation_history
            ORDER BY created_at DESC, id DESC
            LIMIT ?1
            "#,
        )
        .map_err(|e| format!("prepare list history failed: {e}"))?;

    let rows = stmt
        .query_map([bounded], |row| -> rusqlite::Result<HistoryItem> {
            let files_json: String = row.get(5)?;
            let files = serde_json::from_str::<Vec<String>>(&files_json).unwrap_or_default();
            let created_at_i64: i64 = row.get(3)?;
            let updated_at_i64: i64 = row.get(4)?;

            Ok(HistoryItem {
                id: row.get(0)?,
                task_id: row.get(1)?,
                status: row.get(2)?,
                created_at: u64::try_from(created_at_i64).unwrap_or_default(),
                updated_at: u64::try_from(updated_at_i64).unwrap_or_default(),
                files,
                output: row.get(6)?,
                lang_in: row.get(7)?,
                lang_out: row.get(8)?,
                pages: row.get(9)?,
                qps: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                use_openai: row.get::<_, i64>(11)? != 0,
                openai_model: row.get(12)?,
                openai_base_url: row.get(13)?,
                watermark_output_mode: row.get(14)?,
                output_mode: row.get(15)?,
                result: row.get(16)?,
                error: row.get(17)?,
            })
        })
        .map_err(|e| format!("query history failed: {e}"))?;

    let mut list = Vec::new();
    for row in rows {
        list.push(row.map_err(|e| format!("read history row failed: {e}"))?);
    }

    Ok(list)
}

pub fn delete_history_item(history_id: i64) -> Result<bool, String> {
    let store = history_store()?;
    let store = store
        .lock()
        .map_err(|e| format!("history store lock poisoned: {e}"))?;

    let affected = store
        .conn
        .execute(
            r#"
            DELETE FROM translation_history
            WHERE id = ?1
            "#,
            [history_id],
        )
        .map_err(|e| format!("delete history item failed: {e}"))?;

    Ok(affected > 0)
}
