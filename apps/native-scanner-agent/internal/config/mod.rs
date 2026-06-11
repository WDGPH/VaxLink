use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use crate::scanner::ScannerProfile;

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub data_dir: PathBuf,
    pub queue_path: PathBuf,
    pub log_dir: PathBuf,
    pub profile_id: String,
    pub port: Option<String>,
    pub baud_rate: u32,
}

impl AgentConfig {
    pub fn load() -> Result<Self, Box<dyn Error>> {
        let data_dir = default_data_dir()?;
        fs::create_dir_all(&data_dir)?;

        let queue_path = data_dir.join("scan-queue.jsonl");
        let log_dir = data_dir.join("logs");
        fs::create_dir_all(&log_dir)?;

        let default_profile = ScannerProfile::default();

        Ok(Self {
            data_dir,
            queue_path,
            log_dir,
            profile_id: env::var("VAXLINK_SCANNER_PROFILE")
                .unwrap_or_else(|_| default_profile.profile_id.clone()),
            port: env::var("VAXLINK_SCANNER_PORT").ok().filter(|value| !value.trim().is_empty()),
            baud_rate: env::var("VAXLINK_SCANNER_BAUD")
                .ok()
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(default_profile.baud_rate),
        })
    }
}

fn default_data_dir() -> Result<PathBuf, Box<dyn Error>> {
    if let Ok(value) = env::var("VAXLINK_SCANNER_AGENT_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    if cfg!(target_os = "windows") {
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data)
                .join("WDGPH")
                .join("VaxLinkScannerAgent"));
        }
    }

    if cfg!(target_os = "macos") {
        if let Ok(home) = env::var("HOME") {
            return Ok(PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("WDGPH")
                .join("VaxLinkScannerAgent"));
        }
    }

    if let Ok(xdg_data_home) = env::var("XDG_DATA_HOME") {
        let trimmed = xdg_data_home.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join("wdgph-vaxlink-scanner-agent"));
        }
    }

    if let Ok(home) = env::var("HOME") {
        return Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("wdgph-vaxlink-scanner-agent"));
    }

    Err("Cannot determine per-user scanner agent data directory".into())
}
