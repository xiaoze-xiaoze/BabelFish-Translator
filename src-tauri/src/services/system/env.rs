use serde::Serialize;
use std::env;
use std::path::Path;
use std::process::Output;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const LOOKUP_TIMEOUT_SECS: u64 = 5;
const VERIFY_TIMEOUT_SECS: u64 = 15;
const UV_INSTALL_TIMEOUT_SECS: u64 = 120;
const BABELDOC_INSTALL_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheck {
    pub babelfish_version: bool,
    pub babeldoc_version: Option<String>,
    pub uv_version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProgress {
    pub stage: String,
    pub message: String,
    pub detail: Option<String>,
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

fn trim_output(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

async fn command_output(program: &str, args: &[&str], timeout_secs: u64) -> Result<Output, String> {
    let mut command = hidden_command(program);
    command.args(args);

    timeout(Duration::from_secs(timeout_secs), command.output())
        .await
        .map_err(|_| format!("{program} timed out after {timeout_secs}s"))?
        .map_err(|error| format!("failed to run {program}: {error}"))
}

async fn run_capture(program: &str, args: &[&str], timeout_secs: u64) -> Option<String> {
    let output = command_output(program, args, timeout_secs).await.ok()?;
    if !output.status.success() {
        return None;
    }

    let text = trim_output(&output);
    if text.is_empty() { None } else { Some(text) }
}

async fn run_checked(
    program: &str,
    args: &[&str],
    timeout_secs: u64,
    description: &str,
) -> Result<String, String> {
    let output = command_output(program, args, timeout_secs).await?;
    if output.status.success() {
        return Ok(trim_output(&output));
    }

    let detail = trim_output(&output);
    if detail.is_empty() {
        Err(format!("{description} failed with status {}", output.status))
    } else {
        Err(format!("{description} failed: {detail}"))
    }
}

fn local_bin_candidate(tool: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return env::var("USERPROFILE")
            .ok()
            .map(|user_profile| format!(r"{user_profile}\.local\bin\{tool}.exe"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var("HOME")
            .ok()
            .map(|home| format!("{home}/.local/bin/{tool}"))
    }
}

fn first_existing_path(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| Path::new(candidate.as_str()).exists())
        .cloned()
}

async fn lookup_on_path(program: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return run_capture("where", &[program], LOOKUP_TIMEOUT_SECS)
            .await
            .and_then(|result| {
                result
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(str::to_string)
            });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let script = format!("command -v {program}");
        run_capture("sh", &["-c", script.as_str()], LOOKUP_TIMEOUT_SECS)
            .await
            .and_then(|result| {
                result
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .map(str::to_string)
            })
    }
}

fn tool_candidates(tool: &str) -> Vec<String> {
    local_bin_candidate(tool).into_iter().collect()
}

async fn locate_tool(tool: &str) -> Option<String> {
    let candidates = tool_candidates(tool);
    if let Some(path) = first_existing_path(&candidates) {
        return Some(path);
    }

    lookup_on_path(tool).await
}

async fn get_tool_version(path: &str) -> Option<String> {
    run_capture(path, &["--version"], VERIFY_TIMEOUT_SECS).await
}

fn build_env_check(
    babeldoc_path: Option<String>,
    babeldoc_version: Option<String>,
    uv_version: Option<String>,
) -> EnvCheck {
    let babelfish_version = babeldoc_path.is_some();
    let message = if babelfish_version {
        None
    } else if uv_version.is_some() {
        Some("BabelDoc was not detected. Would you like to install it?".to_string())
    } else {
        Some("Both BabelDoc and uv were not detected. Would you like to install them?".to_string())
    };

    EnvCheck {
        babelfish_version,
        babeldoc_version,
        uv_version,
        message,
    }
}

fn emit_progress(
    app_handle: &AppHandle,
    stage: &str,
    message: &str,
    detail: Option<String>,
) -> Result<(), String> {
    app_handle
        .emit(
            "env://progress",
            EnvProgress {
                stage: stage.to_string(),
                message: message.to_string(),
                detail,
            },
        )
        .map_err(|error| error.to_string())
}

async fn verify_env_state() -> EnvCheck {
    let babeldoc_path = locate_tool("babeldoc").await;
    let uv_path = locate_tool("uv").await;
    let babeldoc_version = match babeldoc_path.as_deref() {
        Some(path) => get_tool_version(path).await,
        None => None,
    };
    let uv_version = match uv_path.as_deref() {
        Some(path) => get_tool_version(path).await,
        None => None,
    };

    build_env_check(babeldoc_path, babeldoc_version, uv_version)
}

pub async fn env_check() -> Result<EnvCheck, String> {
    Ok(verify_env_state().await)
}

pub async fn env_install(app_handle: AppHandle) -> Result<EnvCheck, String> {
    emit_progress(&app_handle, "checking_uv", "正在检测 uv", None)?;
    let mut uv_program = locate_tool("uv").await;

    if uv_program.is_none() {
        emit_progress(&app_handle, "installing_uv", "正在安装 uv", None)?;

        #[cfg(target_os = "windows")]
        run_checked(
            "powershell",
            &[
                "-NoProfile",
                "-ExecutionPolicy",
                "ByPass",
                "-Command",
                "irm https://astral.sh/uv/install.ps1 | iex",
            ],
            UV_INSTALL_TIMEOUT_SECS,
            "install uv",
        )
        .await?;

        #[cfg(not(target_os = "windows"))]
        run_checked(
            "sh",
            &["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
            UV_INSTALL_TIMEOUT_SECS,
            "install uv",
        )
        .await?;

        uv_program = locate_tool("uv").await;
    }

    let uv_program = uv_program.ok_or_else(|| {
        "uv install finished, but uv is not available in current process. Restart app and retry."
            .to_string()
    })?;

    emit_progress(&app_handle, "installing_babeldoc", "正在安装 BabelDOC", None)?;
    run_checked(
        &uv_program,
        &["tool", "install", "--python", "3.12", "BabelDOC"],
        BABELDOC_INSTALL_TIMEOUT_SECS,
        "install BabelDOC",
    )
    .await?;

    emit_progress(&app_handle, "verifying", "正在校验环境", None)?;
    let env_check = verify_env_state().await;
    if !env_check.babelfish_version {
        return Err("BabelDOC install finished, but the executable was not detected.".to_string());
    }

    emit_progress(
        &app_handle,
        "done",
        "环境准备完成",
        env_check.babeldoc_version.clone(),
    )?;

    Ok(env_check)
}
