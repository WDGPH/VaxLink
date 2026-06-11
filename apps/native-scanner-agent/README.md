# VaxLink Native Scanner Agent

Per-user native helper for serial/USB CDC barcode scanners. The agent owns the scanner connection, stores scans in a local durable queue, and exposes status plus queue operations to the browser extension through native messaging.

This crate is intentionally small at this stage:

- `--version` prints the agent version.
- `--status` loads per-user config paths and reports queue/status fields.
- `--list-ports` prints visible serial ports as JSON.
- `--run` opens the configured serial port, frames scans on CR/LF/CRLF, and queues them.
- Queue primitives are implemented before scanner I/O so reliability can be tested independently.
- Runtime state is persisted in `agent-state.json` so status survives process restarts.
- Scanner logs rotate at 1 MiB in the per-user `logs/` directory.

The first deployment target is a user-session process, not a Windows Service. It can keep running while the workstation is locked as long as the user session remains active.

## Build

```bash
~/.cargo/bin/cargo build --manifest-path apps/native-scanner-agent/Cargo.toml
```

## Run

```bash
~/.cargo/bin/cargo run --manifest-path apps/native-scanner-agent/Cargo.toml -- --status
~/.cargo/bin/cargo run --manifest-path apps/native-scanner-agent/Cargo.toml -- --list-ports
VAXLINK_SCANNER_PORT=COM4 ~/.cargo/bin/cargo run --manifest-path apps/native-scanner-agent/Cargo.toml -- --run
```

On Linux, the crate builds without optional `libudev` support so it does not require system development packages in this repo environment. Direct configured-port capture still works; richer USB metadata can be enabled later in installer/build environments that include `libudev`.

## Data Directory

Default per-user data roots:

- Windows: `%LOCALAPPDATA%\WDGPH\VaxLinkScannerAgent\`
- macOS: `~/Library/Application Support/WDGPH/VaxLinkScannerAgent/`
- Linux: `~/.local/share/wdgph-vaxlink-scanner-agent/`

Set `VAXLINK_SCANNER_AGENT_HOME` to override the data root for tests or development.
