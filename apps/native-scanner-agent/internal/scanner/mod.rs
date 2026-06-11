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
