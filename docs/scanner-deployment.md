# Scanner Deployment

The first deployment model is a per-user native scanner agent. It is intentionally not a Windows Service.

## User Install

Recommended first target:

- Install the binary under `%LOCALAPPDATA%\WDGPH\VaxLinkScannerAgent\`.
- Load config and queue data from the same per-user app data root.
- Start at user login with an HKCU Run entry or Startup shortcut.
- Register the Chrome native messaging host under HKCU.
- Optionally register the Edge native messaging host under HKCU.
- Avoid admin rights.

The first Windows user-install scripts live in `apps/native-scanner-agent/install/windows/`:

- `install-user.ps1` copies the binary, writes the native messaging manifest, registers Chrome/Edge HKCU native messaging keys, and creates the HKCU startup entry.
- `uninstall-user.ps1` removes the startup entry and native messaging keys, with an optional data-directory cleanup.

Equivalent user-level packaging can be added later:

- macOS: `~/Library/LaunchAgents/` plus user native messaging host manifest.
- Linux: `systemd --user` service or desktop autostart plus user native messaging host manifest.

## Lock-Screen Model

The user-session agent can continue while the workstation is locked if the user session remains alive. In that state, scans should be captured and persisted locally even if Chrome is closed or no EMR tab is open.

This model does not promise capture:

- Before first user login.
- After full logout.
- During sleep or hibernate.
- After shutdown.
- When OS power policy suspends the USB device and it does not resume cleanly.

If pre-login, machine-wide, or full background operation is required, use a separately planned admin-installed Windows Service.

## Validation Checklist

- Scanner is configured as USB CDC / virtual COM, not keyboard wedge.
- Agent starts after user login.
- Agent reconnects after scanner unplug and replug.
- Scan while Chrome is closed remains in the native queue.
- Scan while no chart is open moves to the extension pending inbox after browser drain.
- Scan while locked is queued when the user session remains active.
- Unlocking and opening VaxLink drains queued scans.
- Pasting into Panorama notes, dates, and identifiers is unaffected.
- Tab and Enter navigation in Panorama is unaffected.
