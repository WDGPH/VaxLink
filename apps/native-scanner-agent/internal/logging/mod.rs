use chrono::Utc;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const MAX_LOG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct AgentLogger {
    path: PathBuf,
}

impl AgentLogger {
    pub fn open(log_dir: PathBuf) -> Result<Self, Box<dyn Error>> {
        fs::create_dir_all(&log_dir)?;
        Ok(Self {
            path: log_dir.join("scanner-agent.log"),
        })
    }

    pub fn info(&self, message: &str) {
        let _ = self.write("INFO", message);
    }

    pub fn warn(&self, message: &str) {
        let _ = self.write("WARN", message);
    }

    fn write(&self, level: &str, message: &str) -> Result<(), Box<dyn Error>> {
        self.rotate_if_needed()?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path)?;
        writeln!(
            file,
            "{} {} {}",
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level,
            message.replace('\n', " ")
        )?;
        Ok(())
    }

    fn rotate_if_needed(&self) -> Result<(), Box<dyn Error>> {
        let Ok(metadata) = fs::metadata(&self.path) else {
            return Ok(());
        };
        if metadata.len() < MAX_LOG_BYTES {
            return Ok(());
        }
        let rotated = self.path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        fs::rename(&self.path, rotated)?;
        Ok(())
    }
}
