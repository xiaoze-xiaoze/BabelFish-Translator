use crate::services::translate::command::{build_command, BabelDocCommand};
use std::process::{ExitStatus, Stdio};
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command as TokioCommand;
use tokio::sync::watch;

pub struct RunningBabelDoc {
    pid: Option<u32>,
    cancel_tx: watch::Sender<bool>,
}

impl RunningBabelDoc {
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn kill(&self) -> Result<(), String> {
        self.cancel_tx
            .send(true)
            .map_err(|_| "task is no longer running".to_string())
    }
}

pub struct SpawnedBabelDoc {
    pub run: RunningBabelDoc,
    pub join: JoinHandle<Result<String, String>>,
}

fn finalize_babeldoc(
    status: ExitStatus,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&stdout_bytes).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();

    if status.success() {
        if stdout.is_empty() {
            Ok(stderr)
        } else {
            Ok(stdout)
        }
    } else {
        let mut msg = format!("babeldoc exited with status {status}");
        if !stderr.is_empty() {
            msg.push_str(&format!("\nstderr: {stderr}"));
        }
        if !stdout.is_empty() {
            msg.push_str(&format!("\nstdout: {stdout}"));
        }
        Err(msg)
    }
}

async fn read_pipe<R>(mut reader: R, pipe_name: &str) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("failed to read babeldoc {pipe_name}: {e}"))?;
    Ok(bytes)
}

pub fn spawn_babeldoc(opts: BabelDocCommand) -> Result<SpawnedBabelDoc, String> {
    let built = build_command(&opts)?;

    let mut command = TokioCommand::new(&built.program);
    command
        .args(&built.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to launch babeldoc: {e}"))?;

    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture babeldoc stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture babeldoc stderr".to_string())?;

    let stdout_task = tauri::async_runtime::spawn(async move { read_pipe(stdout, "stdout").await });
    let stderr_task = tauri::async_runtime::spawn(async move { read_pipe(stderr, "stderr").await });

    let (cancel_tx, mut cancel_rx) = watch::channel(false);

    let join = tauri::async_runtime::spawn(async move {
        let (status, cancelled) = tokio::select! {
            wait = child.wait() => {
                let status = wait.map_err(|e| format!("failed waiting for babeldoc: {e}"))?;
                (status, false)
            }
            changed = cancel_rx.changed() => {
                let requested = changed.is_ok() && *cancel_rx.borrow();
                if requested {
                    let _ = child.kill().await;
                    let status = child
                        .wait()
                        .await
                        .map_err(|e| format!("failed waiting for cancelled babeldoc: {e}"))?;
                    (status, true)
                }
                else {
                    let status = child
                        .wait()
                        .await
                        .map_err(|e| format!("failed waiting for babeldoc: {e}"))?;
                    (status, false)
                }
            }
        };

        let stdout = match stdout_task.await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(format!("stdout task join error: {err}")),
        };

        let stderr = match stderr_task.await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(format!("stderr task join error: {err}")),
        };

        if cancelled {
            return Err("task cancelled".to_string());
        }

        finalize_babeldoc(status, stdout, stderr)
    });

    Ok(SpawnedBabelDoc {
        run: RunningBabelDoc { pid, cancel_tx },
        join,
    })
}
