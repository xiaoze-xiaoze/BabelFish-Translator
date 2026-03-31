use crate::services::task::history::{record_task_created, sync_task_state};
use crate::services::task::scheduler::{cancel_running, notify_scheduler};
use crate::services::task::store::{task_store, TaskItem};
use crate::services::translate::command::BabelDocCommand;

pub fn create_task(command: BabelDocCommand) -> Result<String, String> {
    command.validate()?;
    let history_command = command.clone();

    let task_id = {
        let mut store = task_store()
            .lock()
            .map_err(|e| format!("task store lock poisoned: {e}"))?;
        store.create_task(command)
    };

    record_task_created(&task_id, &history_command);
    notify_scheduler();
    Ok(task_id)
}

pub fn create_tasks(commands: Vec<BabelDocCommand>) -> Result<Vec<String>, String> {
    for (idx, command) in commands.iter().enumerate() {
        command
            .validate()
            .map_err(|e| format!("commands[{idx}] invalid: {e}"))?;
    }
    let history_commands = commands.clone();

    let task_ids = {
        let mut store = task_store()
            .lock()
            .map_err(|e| format!("task store lock poisoned: {e}"))?;
        store.create_tasks(commands)
    };

    for (task_id, command) in task_ids.iter().zip(history_commands.iter()) {
        record_task_created(task_id, command);
    }

    notify_scheduler();
    Ok(task_ids)
}

pub fn list_tasks() -> Result<Vec<TaskItem>, String> {
    let store = task_store()
        .lock()
        .map_err(|e| format!("task store lock poisoned: {e}"))?;
    Ok(store.list_tasks())
}

pub fn get_task(task_id: String) -> Result<TaskItem, String> {
    let store = task_store()
        .lock()
        .map_err(|e| format!("task store lock poisoned: {e}"))?;

    store
        .get_task(&task_id)
        .ok_or_else(|| format!("task not found: {task_id}"))
}

pub fn cancel_task(task_id: String) -> Result<bool, String> {
    let changed = {
        let mut store = task_store()
            .lock()
            .map_err(|e| format!("task store lock poisoned: {e}"))?;
        store.cancel_task(&task_id)
    };

    if changed {
        cancel_running(&task_id);
        sync_task_state(&task_id);
    }

    Ok(changed)
}
