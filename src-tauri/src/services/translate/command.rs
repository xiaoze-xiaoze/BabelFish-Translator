use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BabelDocCommand {
    pub files: Vec<String>,
    pub lang_in: String,
    pub lang_out: String,
    pub output: Option<String>,
    pub pages: Option<String>,
    pub use_openai: bool,
    pub openai_model: String,
    pub openai_base_url: String,
    pub openai_api_key: String,
    pub qps: Option<u32>,
    pub watermark_output_mode: Option<WatermarkOutputMode>,
    pub output_mode: Option<OutputMode>,
}

impl BabelDocCommand {
    pub fn validate(&self) -> Result<(), String> {
        if self.files.is_empty() {
            return Err("files must not be empty".to_string());
        }

        if self.files.iter().any(|f| f.trim().is_empty()) {
            return Err("files contains empty path".to_string());
        }

        if self.lang_in.trim().is_empty() {
            return Err("langIn is required".to_string());
        }
        if self.lang_out.trim().is_empty() {
            return Err("langOut is required".to_string());
        }

        if let Some(qps) = self.qps {
            if qps == 0 {
                return Err("qps must be >= 1".to_string());
            }
        }

        if self.use_openai {
            if self.openai_model.trim().is_empty() {
                return Err("openaiModel is required when useOpenai=true".to_string());
            }
            if self.openai_base_url.trim().is_empty() {
                return Err("openaiBaseUrl is required when useOpenai=true".to_string());
            }
            if self.openai_api_key.trim().is_empty() {
                return Err("openaiApiKey is required when useOpenai=true".to_string());
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatermarkOutputMode {
    Watermarked,
    NoWatermark,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputMode {
    DualAndMono,
    DualOnly,
    MonoOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltBabelDocCommand {
    pub program: String,
    pub args: Vec<String>,
    pub display_command: String,
}

impl WatermarkOutputMode {
    fn cli_value(&self) -> &'static str {
        match self {
            Self::Watermarked => "watermarked",
            Self::NoWatermark => "no_watermark",
            Self::Both => "both",
        }
    }
}

fn push_opt(args: &mut Vec<String>, flag: &str, val: &Option<String>) {
    if let Some(v) = val {
        let t = v.trim();
        if !t.is_empty() {
            args.push(flag.to_string());
            args.push(t.to_string());
        }
    }
}

fn trm_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }

    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:=,".contains(c))
    {
        return s.to_string();
    }

    format!("'{}'", s.replace('\'', "''"))
}

fn has_v1_path_segment(url: &str) -> bool {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let path_and_more = after_scheme
        .split_once('/')
        .map(|(_, path)| path)
        .unwrap_or("");
    let path = path_and_more
        .split(['?', '#'])
        .next()
        .unwrap_or(path_and_more);

    path.split('/')
        .any(|segment| segment.eq_ignore_ascii_case("v1"))
}

fn normalize_openai_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let without_trailing_slash = trimmed.trim_end_matches('/');
    if has_v1_path_segment(without_trailing_slash) {
        without_trailing_slash.to_string()
    } else {
        format!("{without_trailing_slash}/v1")
    }
}

pub fn build_command(opts: &BabelDocCommand) -> Result<BuiltBabelDocCommand, String> {
    opts.validate()?;

    let mut args: Vec<String> = Vec::new();

    args.push("--files".into());
    args.extend(opts.files.iter().cloned());

    args.push("--lang-in".into());
    args.push(opts.lang_in.clone());

    args.push("--lang-out".into());
    args.push(opts.lang_out.clone());

    push_opt(&mut args, "--output", &opts.output);
    push_opt(&mut args, "--pages", &opts.pages);

    if let Some(qps) = opts.qps {
        args.push("--qps".into());
        args.push(qps.to_string());
    }

    if opts.use_openai {
        args.push("--openai".into());

        args.push("--openai-model".into());
        args.push(opts.openai_model.clone());

        args.push("--openai-base-url".into());
        args.push(normalize_openai_base_url(&opts.openai_base_url));

        args.push("--openai-api-key".into());
        args.push(opts.openai_api_key.clone());
    }

    let wm = opts
        .watermark_output_mode
        .clone()
        .unwrap_or(WatermarkOutputMode::Watermarked);
    args.push("--watermark-output-mode".into());
    args.push(wm.cli_value().to_string());

    match opts.output_mode.clone().unwrap_or(OutputMode::DualAndMono) {
        OutputMode::DualAndMono => {}
        OutputMode::DualOnly => args.push("--no-mono".into()),
        OutputMode::MonoOnly => args.push("--no-dual".into()),
    }

    let program = "babeldoc".to_string();
    let mut display_parts = vec![program.clone()];
    display_parts.extend(args.clone());

    Ok(BuiltBabelDocCommand {
        program,
        args,
        display_command: display_parts
            .iter()
            .map(|s| trm_quote(s))
            .collect::<Vec<_>>()
            .join(" "),
    })
}
