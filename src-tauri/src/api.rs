use crate::services::system::env::EnvCheck;
use crate::services::system::settings::AppSettings;
use crate::services::task::history::HistoryItem;
use crate::services::task::store::TaskItem;
use crate::services::translate::command::BabelDocCommand;
use tauri::AppHandle;

#[tauri::command]
pub fn get_settings(app_handle: AppHandle) -> Result<AppSettings, String> {
    crate::services::system::settings::get_settings(app_handle)
}

#[tauri::command]
pub fn save_settings(app_handle: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    crate::services::system::settings::save_settings(app_handle, settings)
}

#[tauri::command]
pub async fn env_check() -> Result<EnvCheck, String> {
    crate::services::system::env::env_check().await
}

#[tauri::command]
pub async fn env_install(app_handle: AppHandle) -> Result<EnvCheck, String> {
    crate::services::system::env::env_install(app_handle).await
}

#[tauri::command]
pub fn create_task(command: BabelDocCommand) -> Result<String, String> {
    crate::services::task::service::create_task(command)
}

#[tauri::command]
pub fn create_tasks(commands: Vec<BabelDocCommand>) -> Result<Vec<String>, String> {
    crate::services::task::service::create_tasks(commands)
}

#[tauri::command]
pub fn list_tasks() -> Result<Vec<TaskItem>, String> {
    crate::services::task::service::list_tasks()
}

#[tauri::command]
pub fn get_task(task_id: String) -> Result<TaskItem, String> {
    crate::services::task::service::get_task(task_id)
}

#[tauri::command]
pub fn cancel_task(task_id: String) -> Result<bool, String> {
    crate::services::task::service::cancel_task(task_id)
}

#[tauri::command]
pub fn list_history(limit: Option<u32>) -> Result<Vec<HistoryItem>, String> {
    crate::services::task::history::list_history(limit)
}

#[tauri::command]
pub fn delete_history_item(history_id: i64) -> Result<bool, String> {
    crate::services::task::history::delete_history_item(history_id)
}
