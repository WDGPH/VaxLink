use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScannerDevice {
    pub profile_id: String,
    pub port: Option<String>,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanRecord {
    pub id: String,
    pub captured_at: String,
    pub source: String,
    pub raw_text: String,
    pub raw_bytes_hex: Option<String>,
    pub scanner: ScannerDevice,
    pub delivery_state: DeliveryState,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryState {
    Pending,
    Delivered,
    Nacked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueStats {
    pub pending: usize,
    pub last_scan_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JsonlQueue {
    path: PathBuf,
}

impl JsonlQueue {
    pub fn open(path: PathBuf) -> Result<Self, Box<dyn Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if !path.exists() {
            File::create(&path)?;
        }
        Ok(Self { path })
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[allow(dead_code)]
    pub fn enqueue(&self, mut scan: ScanRecord) -> Result<ScanRecord, Box<dyn Error>> {
        scan.delivery_state = DeliveryState::Pending;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path)?;
        let line = serde_json::to_string(&scan)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(scan)
    }

    #[allow(dead_code)]
    pub fn peek(&self, limit: usize) -> Result<Vec<ScanRecord>, Box<dyn Error>> {
        let max = limit.max(1);
        let mut rows = Vec::new();
        for record in self.read_all()? {
            if record.delivery_state == DeliveryState::Pending {
                rows.push(record);
                if rows.len() >= max {
                    break;
                }
            }
        }
        Ok(rows)
    }

    pub fn ack(&self, ids: &[String]) -> Result<usize, Box<dyn Error>> {
        self.rewrite_with_state(ids, DeliveryState::Delivered, None)
    }

    #[allow(dead_code)]
    pub fn nack(&self, ids: &[String], reason: Option<String>) -> Result<usize, Box<dyn Error>> {
        self.rewrite_with_state(ids, DeliveryState::Nacked, reason)
    }

    #[allow(dead_code)]
    pub fn mark_delivered(&self, ids: &[String]) -> Result<usize, Box<dyn Error>> {
        self.ack(ids)
    }

    #[allow(dead_code)]
    pub fn compact(&self) -> Result<usize, Box<dyn Error>> {
        let before = self.read_all()?;
        let kept: Vec<ScanRecord> = before
            .iter()
            .filter(|record| record.delivery_state == DeliveryState::Pending)
            .cloned()
            .collect();
        let removed = before.len().saturating_sub(kept.len());
        self.write_all_atomic(&kept)?;
        Ok(removed)
    }

    pub fn stats(&self) -> Result<QueueStats, Box<dyn Error>> {
        let mut pending = 0usize;
        let mut last_scan_at = None;
        for record in self.read_all()? {
            if record.delivery_state == DeliveryState::Pending {
                pending += 1;
            }
            last_scan_at = Some(record.captured_at);
        }
        Ok(QueueStats {
            pending,
            last_scan_at,
        })
    }

    fn rewrite_with_state(
        &self,
        ids: &[String],
        state: DeliveryState,
        reason: Option<String>,
    ) -> Result<usize, Box<dyn Error>> {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut changed = 0usize;
        let mut rows = self.read_all()?;
        for row in &mut rows {
            if wanted.contains(row.id.as_str()) {
                row.delivery_state = state.clone();
                row.last_error = reason.clone();
                changed += 1;
            }
        }
        self.write_all_atomic(&rows)?;
        Ok(changed)
    }

    fn read_all(&self) -> Result<Vec<ScanRecord>, Box<dyn Error>> {
        let file = File::open(&self.path)?;
        let reader = BufReader::new(file);
        let mut rows = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            rows.push(serde_json::from_str::<ScanRecord>(&line)?);
        }
        Ok(rows)
    }

    fn write_all_atomic(&self, rows: &[ScanRecord]) -> Result<(), Box<dyn Error>> {
        let tmp_path = self.path.with_extension(format!("tmp-{}", monotonic_id()));
        {
            let mut file = File::create(&tmp_path)?;
            for row in rows {
                file.write_all(serde_json::to_string(row)?.as_bytes())?;
                file.write_all(b"\n")?;
            }
            file.sync_all()?;
        }
        fs::rename(tmp_path, &self.path)?;
        Ok(())
    }
}

#[allow(dead_code)]
pub fn new_scan_id() -> String {
    format!("scan-{}", monotonic_id())
}

fn monotonic_id() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_scan(id: &str, raw_text: &str) -> ScanRecord {
        ScanRecord {
            id: id.to_string(),
            captured_at: "2026-06-11T14:03:22.123Z".to_string(),
            source: "native-serial".to_string(),
            raw_text: raw_text.to_string(),
            raw_bytes_hex: Some("30313030".to_string()),
            scanner: ScannerDevice {
                profile_id: "zebra-ds8178-usb-cdc".to_string(),
                port: Some("COM4".to_string()),
                vendor_id: Some("05E0".to_string()),
                product_id: None,
            },
            delivery_state: DeliveryState::Pending,
            last_error: None,
        }
    }

    #[test]
    fn queue_survives_reopen_and_ack() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.jsonl");
        let queue = JsonlQueue::open(path.clone()).unwrap();
        queue.enqueue(sample_scan("scan-1", "0100012345678905")).unwrap();
        queue.enqueue(sample_scan("scan-2", "01000614141999981726010110ABC123")).unwrap();

        let reopened = JsonlQueue::open(path).unwrap();
        assert_eq!(reopened.peek(10).unwrap().len(), 2);
        assert_eq!(reopened.ack(&["scan-1".to_string()]).unwrap(), 1);

        let pending = reopened.peek(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "scan-2");
    }

    #[test]
    fn nack_preserves_record_with_reason() {
        let dir = tempfile::tempdir().unwrap();
        let queue = JsonlQueue::open(dir.path().join("queue.jsonl")).unwrap();
        queue.enqueue(sample_scan("scan-1", "0100012345678905")).unwrap();
        queue
            .nack(&["scan-1".to_string()], Some("malformed".to_string()))
            .unwrap();

        let rows = queue.read_all().unwrap();
        assert_eq!(rows[0].delivery_state, DeliveryState::Nacked);
        assert_eq!(rows[0].last_error.as_deref(), Some("malformed"));
    }

    #[test]
    fn compact_removes_non_pending_records() {
        let dir = tempfile::tempdir().unwrap();
        let queue = JsonlQueue::open(dir.path().join("queue.jsonl")).unwrap();
        queue.enqueue(sample_scan("scan-1", "0100012345678905")).unwrap();
        queue.enqueue(sample_scan("scan-2", "01000614141999981726010110ABC123")).unwrap();
        queue.ack(&["scan-1".to_string()]).unwrap();

        assert_eq!(queue.compact().unwrap(), 1);
        let pending = queue.peek(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "scan-2");
    }
}
