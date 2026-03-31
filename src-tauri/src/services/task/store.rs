use crate::services::translate::command::BabelDocCommand;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_MAX_CONCURRENCY: usize = 2;
const DEFAULT_MAX_RETRIES: u32 = 2;
const MAX_RETRY_DELAY_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub status: TaskStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub ready_at: u64,
    pub attempts: u32,
    pub max_retries: u32,
    pub files: Vec<String>,
    pub output: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
}

pub struct TaskStore {
    next_id: u64,
    max_concurrency: usize,
    max_retries: u32,
    tasks: HashMap<String, TaskItem>,
    commands: HashMap<String, BabelDocCommand>,
    queue: VecDeque<String>,
    running: HashSet<String>,
    cancel_requested: HashSet<String>,
}

impl TaskStore {
    pub fn new(max_concurrency: usize) -> Self {
        Self {
            next_id: 1,
            max_concurrency: max_concurrency.max(1),
            max_retries: DEFAULT_MAX_RETRIES,
            tasks: HashMap::new(),
            commands: HashMap::new(),
            queue: VecDeque::new(),
            running: HashSet::new(),
            cancel_requested: HashSet::new(),
        }
    }

    pub fn create_task(&mut self, command: BabelDocCommand) -> String {
        let id = format!("task-{}", self.next_id);
        self.next_id += 1;

        let now = now_secs();
        let item = TaskItem {
            id: id.clone(),
            status: TaskStatus::Pending,
            created_at: now,
            updated_at: now,
            ready_at: now,
            attempts: 0,
            max_retries: self.max_retries,
            files: command.files.clone(),
            output: command.output.clone(),
            result: None,
            error: None,
        };

        self.tasks.insert(id.clone(), item);
        self.commands.insert(id.clone(), command);
        self.queue.push_back(id.clone());
        id
    }

    pub fn create_tasks(&mut self, commands: Vec<BabelDocCommand>) -> Vec<String> {
        let mut ids = Vec::with_capacity(commands.len());
        for command in commands {
            ids.push(self.create_task(command));
        }
        ids
    }

    pub fn list_tasks(&self) -> Vec<TaskItem> {
        let mut list: Vec<TaskItem> = self.tasks.values().cloned().collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        list
    }

    pub fn get_task(&self, task_id: &str) -> Option<TaskItem> {
        self.tasks.get(task_id).cloned()
    }

    pub fn cancel_task(&mut self, task_id: &str) -> bool {
        let Some(task) = self.tasks.get_mut(task_id) else {
            return false;
        };

        match task.status {
            TaskStatus::Pending => {
                self.queue.retain(|id| id != task_id);
                self.commands.remove(task_id);
                task.status = TaskStatus::Cancelled;
                task.updated_at = now_secs();
                true
            }
            TaskStatus::Running => {
                self.cancel_requested.insert(task_id.to_string());
                task.status = TaskStatus::Cancelled;
                task.updated_at = now_secs();
                true
            }
            TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Cancelled => false,
        }
    }

    pub fn next_runnable(&mut self) -> Option<(String, BabelDocCommand)> {
        if self.running.len() >= self.max_concurrency {
            return None;
        }

        let scan_count = self.queue.len();
        let now = now_secs();

        for _ in 0..scan_count {
            let Some(task_id) = self.queue.pop_front() else {
                break;
            };

            if self.cancel_requested.contains(&task_id) {
                self.commands.remove(&task_id);
                continue;
            }

            let Some(task) = self.tasks.get_mut(&task_id) else {
                self.commands.remove(&task_id);
                continue;
            };

            if task.status != TaskStatus::Pending {
                self.commands.remove(&task_id);
                continue;
            }

            if task.ready_at > now {
                self.queue.push_back(task_id);
                continue;
            }

            let Some(command) = self.commands.get(&task_id).cloned() else {
                task.status = TaskStatus::Failed;
                task.error = Some("missing command payload".to_string());
                task.updated_at = now_secs();
                continue;
            };

            task.status = TaskStatus::Running;
            task.attempts = task.attempts.saturating_add(1);
            task.error = None;
            task.updated_at = now_secs();
            self.running.insert(task_id.clone());
            return Some((task_id, command));
        }

        None
    }

    pub fn mark_succeeded(&mut self, task_id: &str, result: String) {
        self.running.remove(task_id);
        self.commands.remove(task_id);

        if self.cancel_requested.remove(task_id) {
            return;
        }

        if let Some(task) = self.tasks.get_mut(task_id) {
            if task.status != TaskStatus::Cancelled {
                task.status = TaskStatus::Succeeded;
                task.result = Some(result);
                task.error = None;
                task.updated_at = now_secs();
            }
        }
    }

    pub fn mark_failed_or_retry(&mut self, task_id: &str, error: String) -> Option<u64> {
        self.running.remove(task_id);

        if self.cancel_requested.remove(task_id) {
            self.commands.remove(task_id);
            return None;
        }

        let mut remove_command = false;
        let decision = {
            let Some(task) = self.tasks.get_mut(task_id) else {
                self.commands.remove(task_id);
                return None;
            };

            if task.status == TaskStatus::Cancelled {
                remove_command = true;
                None
            } else if task.attempts <= task.max_retries {
                let delay_secs = retry_delay_secs(task.attempts);
                task.status = TaskStatus::Pending;
                task.error = Some(format!("attempt {} failed: {error}", task.attempts));
                task.updated_at = now_secs();
                task.ready_at = task.updated_at.saturating_add(delay_secs);
                self.queue.push_back(task_id.to_string());
                Some(delay_secs)
            } else {
                task.status = TaskStatus::Failed;
                task.error = Some(error);
                task.updated_at = now_secs();
                task.ready_at = task.updated_at;
                remove_command = true;
                None
            }
        };

        if remove_command {
            self.commands.remove(task_id);
        }

        decision
    }
}

static STORE: OnceLock<Mutex<TaskStore>> = OnceLock::new();

pub fn task_store() -> &'static Mutex<TaskStore> {
    STORE.get_or_init(|| Mutex::new(TaskStore::new(DEFAULT_MAX_CONCURRENCY)))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn retry_delay_secs(attempts: u32) -> u64 {
    let shift = attempts.saturating_sub(1).min(4);
    let delay = 1_u64 << shift;
    delay.min(MAX_RETRY_DELAY_SECS)
}
