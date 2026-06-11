use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AgentConfig;
use crate::queue::JsonlQueue;
use crate::state::AgentStateStore;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[allow(dead_code)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum Request {
    #[serde(rename = "hello")]
    Hello { protocol_version: Option<u32> },
    #[serde(rename = "status.get")]
    StatusGet,
    #[serde(rename = "queue.peek")]
    QueuePeek { limit: Option<usize> },
    #[serde(rename = "queue.ack")]
    QueueAck { ids: Vec<String> },
    #[serde(rename = "queue.nack")]
    QueueNack { ids: Vec<String>, reason: Option<String> },
    #[serde(rename = "scan.poll")]
    ScanPoll { limit: Option<usize> },
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusResponse {
    pub ok: bool,
    pub protocol_version: u32,
    pub agent_version: String,
    pub data_dir: String,
    pub queue_path: String,
    pub state_path: String,
    pub log_dir: String,
    pub scanner: ScannerStatus,
    pub queue_depth: usize,
    pub last_scan_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScannerStatus {
    pub profile_id: String,
    pub port: Option<String>,
    pub baud_rate: u32,
    pub device_connected: bool,
    pub last_seen_at: Option<String>,
}

impl StatusResponse {
    pub fn from_config_queue_and_state(
        version: &str,
        config: &AgentConfig,
        queue: &JsonlQueue,
        state_store: &AgentStateStore,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let stats = queue.stats()?;
        let state = state_store.load()?;
        Ok(Self {
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            agent_version: version.to_string(),
            data_dir: config.data_dir.display().to_string(),
            queue_path: config.queue_path.display().to_string(),
            state_path: config.state_path.display().to_string(),
            log_dir: config.log_dir.display().to_string(),
            scanner: ScannerStatus {
                profile_id: config.profile_id.clone(),
                port: state.port.or_else(|| config.port.clone()),
                baud_rate: config.baud_rate,
                device_connected: state.device_connected,
                last_seen_at: state.last_seen_at,
            },
            queue_depth: stats.pending,
            last_scan_at: state.last_scan_at.or(stats.last_scan_at),
        })
    }
}

pub fn handle_request(
    version: &str,
    config: &AgentConfig,
    queue: &JsonlQueue,
    state_store: &AgentStateStore,
    request: Request,
) -> Result<Value, Box<dyn std::error::Error>> {
    match request {
        Request::Hello { protocol_version } => Ok(json!({
            "ok": true,
            "type": "hello",
            "protocolVersion": PROTOCOL_VERSION,
            "agentVersion": version,
            "compatible": protocol_version.unwrap_or(PROTOCOL_VERSION) == PROTOCOL_VERSION
        })),
        Request::StatusGet => Ok(serde_json::to_value(StatusResponse::from_config_queue_and_state(
            version,
            config,
            queue,
            state_store,
        )?)?),
        Request::QueuePeek { limit } | Request::ScanPoll { limit } => {
            let scans = queue.peek(limit.unwrap_or(25).clamp(1, 100))?;
            Ok(json!({
                "ok": true,
                "protocolVersion": PROTOCOL_VERSION,
                "scans": scans
            }))
        }
        Request::QueueAck { ids } => {
            let changed = queue.ack(&ids)?;
            Ok(json!({
                "ok": true,
                "protocolVersion": PROTOCOL_VERSION,
                "acked": changed
            }))
        }
        Request::QueueNack { ids, reason } => {
            let changed = queue.nack(&ids, reason)?;
            Ok(json!({
                "ok": true,
                "protocolVersion": PROTOCOL_VERSION,
                "nacked": changed
            }))
        }
    }
}

pub fn error_response(message: &str) -> Value {
    json!({
        "ok": false,
        "protocolVersion": PROTOCOL_VERSION,
        "error": message
    })
}
