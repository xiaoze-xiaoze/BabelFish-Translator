use serde::Serialize;
use std::env;
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheck {
    pub babelfish_version: bool,
    pub babeldoc_version: Option<String>,
    pub uv_version: Option<String>,
    pub message: Option<String>,
}

fn run<const N: usize>(program: &str, args: [&str; N]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !stdout.is_empty() {
        Some(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if stderr.is_empty() {
            None
        } else {
            Some(stderr)
        }
    }
}

fn run_ok<const N: usize>(program: &str, args: [&str; N]) -> bool {
    Command::new(program)
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn uv_candidates() -> Vec<String> {
    let mut candidates = vec!["uv".to_string()];

    #[cfg(target_os = "windows")]
    if let Ok(user_profile) = env::var("USERPROFILE") {
        candidates.push(format!(r"{user_profile}\.local\bin\uv.exe"));
    }

    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = env::var("HOME") {
        candidates.push(format!("{home}/.local/bin/uv"));
    }

    candidates
}

fn detect_uv() -> Option<(String, String)> {
    for candidate in uv_candidates() {
        if let Some(version) = run(&candidate, ["--version"]) {
            return Some((candidate, version));
        }
    }
    None
}

pub fn env_check() -> Result<EnvCheck, String> {
    let babeldoc_version = run("babeldoc", ["--version"]);
    let uv_version = detect_uv().map(|(_, version)| version);

    let babelfish_version = babeldoc_version.is_some();
    let message = if babelfish_version {
        None
    } else if uv_version.is_some() {
        Some("BabelDoc was not detected. Would you like to install it?".to_string())
    } else {
        Some("Both BabelDoc and uv were not detected. Would you like to install them?".to_string())
    };

    Ok(EnvCheck {
        babelfish_version,
        babeldoc_version,
        uv_version,
        message,
    })
}

pub fn env_install() -> Result<(), String> {
    let mut uv_program = detect_uv().map(|(program, _)| program);

    if uv_program.is_none() {
        #[cfg(target_os = "windows")]
        if !run_ok(
            "powershell",
            [
                "-NoProfile",
                "-ExecutionPolicy",
                "ByPass",
                "-Command",
                "irm https://astral.sh/uv/install.ps1 | iex",
            ],
        ) {
            return Err("install uv failed".to_string());
        }

        #[cfg(not(target_os = "windows"))]
        if !run_ok(
            "sh",
            ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
        ) {
            return Err("install uv failed".to_string());
        }

        uv_program = detect_uv().map(|(program, _)| program);
    }

    let uv_program = uv_program.ok_or_else(|| {
        "uv install finished, but uv is not available in current process. Restart app and retry."
            .to_string()
    })?;

    if !run_ok(
        &uv_program,
        ["tool", "install", "--python", "3.12", "BabelDOC"],
    ) {
        return Err("install BabelDOC failed".to_string());
    }

    Ok(())
}
