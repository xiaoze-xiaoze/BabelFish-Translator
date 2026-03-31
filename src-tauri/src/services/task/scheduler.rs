use crate::services::task::history::sync_task_state;
use crate::services::task::store::{task_store, TaskStatus};
use crate::services::translate::command::BabelDocCommand;
use crate::services::translate::runner::{spawn_babeldoc, RunningBabelDoc};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

const TASK_TIMEOUT_SECS: u64 = 60 * 20;

static RUNNING_TASKS: OnceLock<Mutex<HashMap<String, RunningBabelDoc>>> = OnceLock::new();
static SCHEDULER_STARTED: OnceLock<()> = OnceLock::new();
static SCHEDULER_NOTIFY: OnceLock<Notify> = OnceLock::new();

fn running_tasks() -> &'static Mutex<HashMap<String, RunningBabelDoc>> {
    RUNNING_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scheduler_notify() -> &'static Notify {
    SCHEDULER_NOTIFY.get_or_init(Notify::new)
}

fn scheduler_started() {
    SCHEDULER_STARTED.get_or_init(|| {
        tauri::async_runtime::spawn(async move {
            scheduler_loop().await;
        });
    });
}

pub fn notify_scheduler() {
    scheduler_started();
    scheduler_notify().notify_one();
}

async fn scheduler_loop() {
    loop {
        schedule_available();
        scheduler_notify().notified().await;
    }
}

fn schedule_available() {
    loop {
        let next = {
            let mut store = match task_store().lock() {
                Ok(store) => store,
                Err(err) => {
                    eprintln!("task store lock poisoned: {err}");
                    return;
                }
            };
            store.next_runnable()
        };

        let Some((task_id, cmd)) = next else {
            break;
        };
        sync_task_state(&task_id);
        run_task(task_id, cmd);
    }
}

pub fn cancel_running(task_id: &str) {
    let running = match running_tasks().lock() {
        Ok(running) => running,
        Err(err) => {
            eprintln!("running tasks lock poisoned: {err}");
            return;
        }
    };

    let Some(run) = running.get(task_id) else {
        return;
    };

    if let Err(err) = run.kill() {
        eprintln!("failed to cancel running task {task_id}: {err}");
    }
}

fn run_task(task_id: String, cmd: BabelDocCommand) {
    let spawned = match spawn_babeldoc(cmd) {
        Ok(spawned) => spawned,
        Err(err) => {
            let mut store = match task_store().lock() {
                Ok(store) => store,
                Err(lock_err) => {
                    eprintln!("task store lock poisoned: {lock_err}");
                    return;
                }
            };
            let retry_delay = store.mark_failed_or_retry(&task_id, err);
            drop(store);
            sync_task_state(&task_id);
            notify_delay(retry_delay);
            return;
        }
    };

    let run = spawned.run;
    let join = spawned.join;

    if let Some(pid) = run.pid() {
        eprintln!("task {task_id} started, pid={pid}");
    }

    match running_tasks().lock() {
        Ok(mut running) => {
            running.insert(task_id.clone(), run);
        }
        Err(err) => {
            eprintln!("running tasks lock poisoned: {err}");
        }
    }

    let should_cancel = {
        let store = match task_store().lock() {
            Ok(store) => store,
            Err(err) => {
                eprintln!("task store lock poisoned: {err}");
                return;
            }
        };

        store
            .get_task(&task_id)
            .map(|task| task.status == TaskStatus::Cancelled)
            .unwrap_or(false)
    };

    if should_cancel {
        cancel_running(&task_id);
    }

    tauri::async_runtime::spawn(async move {
        let join = join;
        tokio::pin!(join);

        let (run_result, timed_out) = tokio::select! {
            result = &mut join => (result, false),
            _ = tokio::time::sleep(Duration::from_secs(TASK_TIMEOUT_SECS)) => {
                // If the task finished right around the timeout edge, prefer the real
                // completion result instead of forcing a timeout failure.
                tokio::select! {
                    result = &mut join => (result, false),
                    else => {
                        cancel_running(&task_id);
                        let result = (&mut join).await;
                        let timed_out = !matches!(&result, Ok(Ok(_)));
                        (result, timed_out)
                    }
                }
            }
        };

        match running_tasks().lock() {
            Ok(mut running) => {
                running.remove(&task_id);
            }
            Err(err) => {
                eprintln!("running tasks lock poisoned: {err}");
            }
        }

        let mut store = match task_store().lock() {
            Ok(store) => store,
            Err(err) => {
                eprintln!("task store lock poisoned: {err}");
                return;
            }
        };

        let retry_delay = match run_result {
            Ok(Ok(output)) => {
                store.mark_succeeded(&task_id, output);
                Option::<u64>::None
            }
            Ok(Err(err)) => {
                if timed_out {
                    store.mark_failed_or_retry(
                        &task_id,
                        format!("task timed out after {TASK_TIMEOUT_SECS}s"),
                    )
                } else {
                    store.mark_failed_or_retry(&task_id, err)
                }
            }
            Err(err) => {
                if timed_out {
                    store.mark_failed_or_retry(
                        &task_id,
                        format!("task timed out after {TASK_TIMEOUT_SECS}s"),
                    )
                } else {
                    store.mark_failed_or_retry(&task_id, format!("task join error: {err}"))
                }
            }
        };

        drop(store);
        sync_task_state(&task_id);
        notify_delay(retry_delay);
    });
}

fn notify_delay(retry_delay_secs: Option<u64>) {
    match retry_delay_secs {
        Some(delay_secs) if delay_secs > 0 => {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;
                notify_scheduler();
            });
        }
        _ => notify_scheduler(),
    }
}
