use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub device_connected: bool,
    pub port: Option<String>,
    pub last_seen_at: Option<String>,
    pub last_scan_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentStateStore {
    path: PathBuf,
}

impl AgentStateStore {
    pub fn open(path: PathBuf) -> Result<Self, Box<dyn Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if !path.exists() {
            write_state_atomic(&path, &AgentState::default())?;
        }
        Ok(Self { path })
    }

    pub fn load(&self) -> Result<AgentState, Box<dyn Error>> {
        let text = fs::read_to_string(&self.path)?;
        if text.trim().is_empty() {
            return Ok(AgentState::default());
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub fn mark_connected(&self, port: &str) -> Result<(), Box<dyn Error>> {
        let mut state = self.load().unwrap_or_default();
        state.device_connected = true;
        state.port = Some(port.to_string());
        state.last_seen_at = Some(now_iso());
        state.last_error = None;
        write_state_atomic(&self.path, &state)
    }

    pub fn mark_disconnected(&self, port: Option<&str>, error: &str) -> Result<(), Box<dyn Error>> {
        let mut state = self.load().unwrap_or_default();
        state.device_connected = false;
        if let Some(port) = port {
            state.port = Some(port.to_string());
        }
        state.last_error = Some(error.to_string());
        write_state_atomic(&self.path, &state)
    }

    pub fn mark_scan(&self) -> Result<(), Box<dyn Error>> {
        let mut state = self.load().unwrap_or_default();
        let now = now_iso();
        state.last_seen_at = Some(now.clone());
        state.last_scan_at = Some(now);
        write_state_atomic(&self.path, &state)
    }
}

fn write_state_atomic(path: &PathBuf, state: &AgentState) -> Result<(), Box<dyn Error>> {
    let tmp_path = path.with_extension("tmp");
    {
        let mut file = File::create(&tmp_path)?;
        file.write_all(serde_json::to_string_pretty(state)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(tmp_path, path)?;
    Ok(())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip_tracks_connection_and_scan() {
        let dir = tempfile::tempdir().unwrap();
        let store = AgentStateStore::open(dir.path().join("state.json")).unwrap();

        store.mark_connected("COM4").unwrap();
        let connected = store.load().unwrap();
        assert!(connected.device_connected);
        assert_eq!(connected.port.as_deref(), Some("COM4"));
        assert!(connected.last_seen_at.is_some());

        store.mark_scan().unwrap();
        assert!(store.load().unwrap().last_scan_at.is_some());

        store.mark_disconnected(Some("COM4"), "unplugged").unwrap();
        let disconnected = store.load().unwrap();
        assert!(!disconnected.device_connected);
        assert_eq!(disconnected.last_error.as_deref(), Some("unplugged"));
    }
}
