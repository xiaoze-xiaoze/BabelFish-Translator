mod api;
mod services;

#[cfg(not(rust_analyzer))]
fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg(rust_analyzer)]
fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    loop {}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            services::system::settings::ensure_settings(app.handle())?;
            services::task::history::init_history(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api::get_settings,
            api::save_settings,
            api::env_check,
            api::env_install,
            api::create_task,
            api::create_tasks,
            api::list_tasks,
            api::get_task,
            api::cancel_task,
            api::list_history,
            api::delete_history_item,
        ])
        .run(app_context())
        .expect("error while running tauri application");
}
