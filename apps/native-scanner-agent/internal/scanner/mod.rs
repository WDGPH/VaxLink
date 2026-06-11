use std::error::Error;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;

use crate::config::AgentConfig;
use crate::logging::AgentLogger;
use crate::queue::{new_scan_id, JsonlQueue, ScanRecord, ScannerDevice};
use crate::state::AgentStateStore;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ScannerProfile {
    pub profile_id: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub delimiter: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanFrame {
    pub raw_text: String,
    pub raw_bytes_hex: String,
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    bytes: Vec<u8>,
    last_was_cr: bool,
}

impl FrameDecoder {
    pub fn push(&mut self, byte: u8) -> Option<ScanFrame> {
        match byte {
            b'\r' => {
                self.last_was_cr = true;
                self.finish_frame()
            }
            b'\n' => {
                if self.last_was_cr {
                    self.last_was_cr = false;
                    return None;
                }
                self.finish_frame()
            }
            value => {
                self.last_was_cr = false;
                self.bytes.push(value);
                None
            }
        }
    }

    fn finish_frame(&mut self) -> Option<ScanFrame> {
        let bytes = std::mem::take(&mut self.bytes);
        if bytes.is_empty() {
            return None;
        }
        let raw_text = String::from_utf8_lossy(&bytes).trim().to_string();
        if raw_text.is_empty() {
            return None;
        }
        Some(ScanFrame {
            raw_text,
            raw_bytes_hex: bytes_to_hex(&bytes),
        })
    }
}

pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, Box<dyn Error>> {
    let ports = serialport::available_ports()?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let mut info = SerialPortInfo {
                port_name: port.port_name,
                port_type: "unknown".to_string(),
                vendor_id: None,
                product_id: None,
            };
            match port.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    info.port_type = "usb".to_string();
                    info.vendor_id = Some(format!("{:04X}", usb.vid));
                    info.product_id = Some(format!("{:04X}", usb.pid));
                }
                serialport::SerialPortType::PciPort => {
                    info.port_type = "pci".to_string();
                }
                serialport::SerialPortType::BluetoothPort => {
                    info.port_type = "bluetooth".to_string();
                }
                serialport::SerialPortType::Unknown => {}
            }
            info
        })
        .collect())
}

pub fn capture_forever(
    config: &AgentConfig,
    queue: &JsonlQueue,
    state_store: &AgentStateStore,
) -> Result<(), Box<dyn Error>> {
    let port_name = config
        .port
        .as_deref()
        .ok_or("VAXLINK_SCANNER_PORT must be set before --run can capture scans")?;
    let logger = AgentLogger::open(config.log_dir.clone())?;
    let running = Arc::new(AtomicBool::new(true));
    {
        let running = Arc::clone(&running);
        ctrlc::set_handler(move || {
            running.store(false, Ordering::SeqCst);
        })?;
    }

    let mut backoff = Duration::from_millis(500);
    logger.info(&format!("starting scanner capture on {port_name}"));
    while running.load(Ordering::SeqCst) {
        match capture_until_disconnect(config, queue, state_store, port_name, &running) {
            Ok(()) => {
                backoff = Duration::from_millis(500);
            }
            Err(error) => {
                let message = error.to_string();
                let _ = state_store.mark_disconnected(Some(port_name), &message);
                logger.warn(&format!("scanner disconnected or unavailable: {message}"));
                sleep_interruptibly(backoff, &running);
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
    let _ = state_store.mark_disconnected(Some(port_name), "agent stopped");
    logger.info("scanner capture stopped");
    Ok(())
}

fn capture_until_disconnect(
    config: &AgentConfig,
    queue: &JsonlQueue,
    state_store: &AgentStateStore,
    port_name: &str,
    running: &AtomicBool,
) -> Result<(), Box<dyn Error>> {
    let mut port = serialport::new(port_name, config.baud_rate)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .timeout(Duration::from_millis(250))
        .open()?;
    state_store.mark_connected(port_name)?;

    let mut decoder = FrameDecoder::default();
    let mut buffer = [0u8; 256];

    while running.load(Ordering::SeqCst) {
        match port.read(&mut buffer) {
            Ok(count) => {
                for byte in &buffer[..count] {
                    if let Some(frame) = decoder.push(*byte) {
                        let record = scan_record_from_frame(config, port_name, frame);
                        queue.enqueue(record)?;
                        state_store.mark_scan()?;
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(error) => return Err(Box::new(error)),
        }
    }
    Ok(())
}

fn scan_record_from_frame(config: &AgentConfig, port_name: &str, frame: ScanFrame) -> ScanRecord {
    ScanRecord {
        id: new_scan_id(),
        captured_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        source: "native-serial".to_string(),
        raw_text: frame.raw_text,
        raw_bytes_hex: Some(frame.raw_bytes_hex),
        scanner: ScannerDevice {
            profile_id: config.profile_id.clone(),
            port: Some(port_name.to_string()),
            vendor_id: None,
            product_id: None,
        },
        delivery_state: crate::queue::DeliveryState::Pending,
        last_error: None,
    }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0F) as usize] as char);
    }
    output
}

fn sleep_interruptibly(duration: Duration, running: &AtomicBool) {
    let step = Duration::from_millis(100);
    let mut elapsed = Duration::from_millis(0);
    while running.load(Ordering::SeqCst) && elapsed < duration {
        let remaining = duration.saturating_sub(elapsed);
        let nap = remaining.min(step);
        thread::sleep(nap);
        elapsed += nap;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_frames_on_lf() {
        let mut decoder = FrameDecoder::default();
        assert_eq!(decoder.push(b'0'), None);
        assert_eq!(decoder.push(b'1'), None);
        let frame = decoder.push(b'\n').unwrap();
        assert_eq!(frame.raw_text, "01");
        assert_eq!(frame.raw_bytes_hex, "3031");
    }

    #[test]
    fn decoder_frames_on_crlf_once() {
        let mut decoder = FrameDecoder::default();
        for byte in b"ABC123" {
            decoder.push(*byte);
        }
        let frame = decoder.push(b'\r').unwrap();
        assert_eq!(frame.raw_text, "ABC123");
        assert_eq!(decoder.push(b'\n'), None);
    }

    #[test]
    fn decoder_ignores_empty_frames() {
        let mut decoder = FrameDecoder::default();
        assert_eq!(decoder.push(b'\r'), None);
        assert_eq!(decoder.push(b'\n'), None);
    }
}

impl Default for ScannerProfile {
    fn default() -> Self {
        Self {
            profile_id: "zebra-ds8178-usb-cdc".to_string(),
            baud_rate: 9600,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            delimiter: "CRLF/LF/CR".to_string(),
        }
    }
}
