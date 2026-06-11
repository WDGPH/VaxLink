param(
  [Parameter(Mandatory = $false)]
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"

$HostName = "ca.wdgph.vaxlink_scanner_agent"
$InstallDir = Join-Path $env:LOCALAPPDATA "WDGPH\VaxLinkScannerAgent"

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $RunKey -Name "VaxLinkScannerAgent" -ErrorAction SilentlyContinue

$ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
Remove-Item -Recurse -Force -Path $ChromeKey -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -Path $EdgeKey -ErrorAction SilentlyContinue

if ($RemoveData) {
  Remove-Item -Recurse -Force -Path $InstallDir -ErrorAction SilentlyContinue
} else {
  Remove-Item -Force -Path (Join-Path $InstallDir "vaxlink-scanner-agent.exe") -ErrorAction SilentlyContinue
  Remove-Item -Force -Path (Join-Path $InstallDir "native-messaging-host.json") -ErrorAction SilentlyContinue
}

Write-Host "Removed VaxLink Scanner Agent per-user startup and native messaging registration"
if ($RemoveData) {
  Write-Host "Removed scanner agent data directory $InstallDir"
}
