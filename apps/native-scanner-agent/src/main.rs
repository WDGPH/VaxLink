#[path = "../internal/config/mod.rs"]
mod config;
#[path = "../internal/protocol/mod.rs"]
mod protocol;
#[path = "../internal/queue/mod.rs"]
mod queue;
#[path = "../internal/scanner/mod.rs"]
mod scanner;

use std::env;
use std::error::Error;
use std::process;

use config::AgentConfig;
use protocol::StatusResponse;
use queue::JsonlQueue;
use scanner::{capture_forever, list_serial_ports};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    if let Err(error) = run() {
        eprintln!("vaxlink-scanner-agent: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("vaxlink-scanner-agent {VERSION}");
        return Ok(());
    }

    if args.iter().any(|arg| arg == "--status") {
        let config = AgentConfig::load()?;
        let queue = JsonlQueue::open(config.queue_path.clone())?;
        let status = StatusResponse::from_config_and_queue(VERSION, &config, &queue)?;
        println!("{}", serde_json::to_string_pretty(&status)?);
        return Ok(());
    }

    if args.iter().any(|arg| arg == "--list-ports") {
        let ports = list_serial_ports()?;
        println!("{}", serde_json::to_string_pretty(&ports)?);
        return Ok(());
    }

    if args.iter().any(|arg| arg == "--run") {
        let config = AgentConfig::load()?;
        let queue = JsonlQueue::open(config.queue_path.clone())?;
        capture_forever(&config, &queue)?;
        return Ok(());
    }

    print_help();
    Ok(())
}

fn print_help() {
    println!(
        "vaxlink-scanner-agent {VERSION}\n\nUSAGE:\n  vaxlink-scanner-agent --status\n  vaxlink-scanner-agent --list-ports\n  vaxlink-scanner-agent --run\n  vaxlink-scanner-agent --version\n\nOPTIONS:\n  --status      Print agent status as JSON\n  --list-ports  Print available serial ports as JSON\n  --run         Capture from the configured serial port and enqueue scans\n  --version     Print version"
    );
}
