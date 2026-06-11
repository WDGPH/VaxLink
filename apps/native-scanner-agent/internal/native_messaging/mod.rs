use serde_json::Value;
use std::error::Error;
use std::io::{self, Read, Write};

use crate::config::AgentConfig;
use crate::protocol::{error_response, handle_request, Request};
use crate::queue::JsonlQueue;
use crate::state::AgentStateStore;

const MAX_MESSAGE_BYTES: u32 = 1024 * 1024;

pub fn run_native_messaging(
    version: &str,
    config: &AgentConfig,
    queue: &JsonlQueue,
    state_store: &AgentStateStore,
) -> Result<(), Box<dyn Error>> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    serve_native_messaging(
        version,
        config,
        queue,
        state_store,
        stdin.lock(),
        stdout.lock(),
    )
}

fn serve_native_messaging<R: Read, W: Write>(
    version: &str,
    config: &AgentConfig,
    queue: &JsonlQueue,
    state_store: &AgentStateStore,
    mut reader: R,
    mut writer: W,
) -> Result<(), Box<dyn Error>> {
    while let Some(payload) = read_frame(&mut reader)? {
        let response = match serde_json::from_slice::<Request>(&payload) {
            Ok(request) => handle_request(version, config, queue, state_store, request)
                .unwrap_or_else(|error| error_response(&error.to_string())),
            Err(error) => error_response(&format!("Invalid request: {error}")),
        };
        write_frame(&mut writer, &response)?;
        writer.flush()?;
    }
    Ok(())
}

fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Vec<u8>>, Box<dyn Error>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(Box::new(error)),
    }
    let len = u32::from_le_bytes(len_bytes);
    if len > MAX_MESSAGE_BYTES {
        return Err(format!("Native messaging frame too large: {len} bytes").into());
    }
    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame<W: Write>(writer: &mut W, value: &Value) -> Result<(), Box<dyn Error>> {
    let payload = serde_json::to_vec(value)?;
    let len: u32 = payload
        .len()
        .try_into()
        .map_err(|_| "Native messaging response is too large")?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&payload)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::{DeliveryState, ScanRecord, ScannerDevice};

    fn frame(value: &Value) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }

    fn decode_first_frame(bytes: &[u8]) -> Value {
        let len = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        serde_json::from_slice(&bytes[4..4 + len]).unwrap()
    }

    #[test]
    fn native_messaging_hello_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let config = AgentConfig::load_for_test(dir.path()).unwrap();
        let queue = JsonlQueue::open(config.queue_path.clone()).unwrap();
        let state = AgentStateStore::open(config.state_path.clone()).unwrap();
        let input = frame(&serde_json::json!({
            "type": "hello",
            "protocolVersion": 1
        }));
        let mut output = Vec::new();

        serve_native_messaging("0.1.0", &config, &queue, &state, input.as_slice(), &mut output)
            .unwrap();

        let response = decode_first_frame(&output);
        assert_eq!(response["ok"], true);
        assert_eq!(response["protocolVersion"], 1);
    }

    #[test]
    fn native_messaging_poll_and_ack_queue() {
        let dir = tempfile::tempdir().unwrap();
        let config = AgentConfig::load_for_test(dir.path()).unwrap();
        let queue = JsonlQueue::open(config.queue_path.clone()).unwrap();
        let state = AgentStateStore::open(config.state_path.clone()).unwrap();
        queue
            .enqueue(ScanRecord {
                id: "scan-1".to_string(),
                captured_at: "2026-06-11T14:03:22.123Z".to_string(),
                source: "native-serial".to_string(),
                raw_text: "0100012345678905".to_string(),
                raw_bytes_hex: Some("30313030".to_string()),
                scanner: ScannerDevice {
                    profile_id: "zebra-ds8178-usb-cdc".to_string(),
                    port: Some("COM4".to_string()),
                    vendor_id: None,
                    product_id: None,
                },
                delivery_state: DeliveryState::Pending,
                last_error: None,
            })
            .unwrap();

        let mut input = frame(&serde_json::json!({ "type": "scan.poll", "limit": 5 }));
        input.extend_from_slice(&frame(&serde_json::json!({
            "type": "queue.ack",
            "ids": ["scan-1"]
        })));
        let mut output = Vec::new();

        serve_native_messaging("0.1.0", &config, &queue, &state, input.as_slice(), &mut output)
            .unwrap();

        let first = decode_first_frame(&output);
        assert_eq!(first["scans"].as_array().unwrap().len(), 1);
        assert_eq!(queue.peek(10).unwrap().len(), 0);
    }
}
