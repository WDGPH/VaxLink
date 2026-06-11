#[path = "../internal/config/mod.rs"]
mod config;
#[path = "../internal/logging/mod.rs"]
mod logging;
#[path = "../internal/native_messaging/mod.rs"]
mod native_messaging;
#[path = "../internal/protocol/mod.rs"]
mod protocol;
#[path = "../internal/queue/mod.rs"]
mod queue;
#[path = "../internal/scanner/mod.rs"]
mod scanner;
#[path = "../internal/state/mod.rs"]
mod state;

use std::env;
use std::error::Error;
use std::process;

use config::AgentConfig;
use native_messaging::run_native_messaging;
use protocol::StatusResponse;
use queue::JsonlQueue;
use scanner::{capture_forever, list_serial_ports};
use state::AgentStateStore;

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
        let state_store = AgentStateStore::open(config.state_path.clone())?;
        let status = StatusResponse::from_config_queue_and_state(VERSION, &config, &queue, &state_store)?;
        println!("{}", serde_json::to_string_pretty(&status)?);
        return Ok(());
    }

    if args.iter().any(|arg| arg == "--native-messaging") {
        let config = AgentConfig::load()?;
        let queue = JsonlQueue::open(config.queue_path.clone())?;
        let state_store = AgentStateStore::open(config.state_path.clone())?;
        run_native_messaging(VERSION, &config, &queue, &state_store)?;
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
        let state_store = AgentStateStore::open(config.state_path.clone())?;
        capture_forever(&config, &queue, &state_store)?;
        return Ok(());
    }

    print_help();
    Ok(())
}

fn print_help() {
    println!(
        "vaxlink-scanner-agent {VERSION}\n\nUSAGE:\n  vaxlink-scanner-agent --status\n  vaxlink-scanner-agent --list-ports\n  vaxlink-scanner-agent --run\n  vaxlink-scanner-agent --native-messaging\n  vaxlink-scanner-agent --version\n\nOPTIONS:\n  --status            Print agent status as JSON\n  --list-ports        Print available serial ports as JSON\n  --run               Capture from the configured serial port and enqueue scans\n  --native-messaging  Serve Chrome/Edge native messaging protocol on stdin/stdout\n  --version           Print version"
    );
}
