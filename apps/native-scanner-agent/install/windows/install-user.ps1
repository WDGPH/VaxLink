param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [Parameter(Mandatory = $false)]
  [string]$BinaryPath = "",

  [Parameter(Mandatory = $false)]
  [switch]$RegisterEdge
)

$ErrorActionPreference = "Stop"

$HostName = "ca.wdgph.vaxlink_scanner_agent"
$InstallDir = Join-Path $env:LOCALAPPDATA "WDGPH\VaxLinkScannerAgent"
$ManifestPath = Join-Path $InstallDir "native-messaging-host.json"
$InstalledBinary = Join-Path $InstallDir "vaxlink-scanner-agent.exe"

if ([string]::IsNullOrWhiteSpace($BinaryPath)) {
  $BinaryPath = Join-Path (Get-Location) "target\release\vaxlink-scanner-agent.exe"
}

if (!(Test-Path $BinaryPath)) {
  throw "Binary not found: $BinaryPath. Build with: cargo build --release"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force -Path $BinaryPath -Destination $InstalledBinary

$AllowedOrigin = "chrome-extension://$ExtensionId/"
$Manifest = [ordered]@{
  name = $HostName
  description = "VaxLink native scanner agent"
  path = $InstalledBinary
  type = "stdio"
  allowed_origins = @($AllowedOrigin)
}
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -Path $ManifestPath

$ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Force -Path $ChromeKey | Out-Null
Set-Item -Path $ChromeKey -Value $ManifestPath

if ($RegisterEdge) {
  $EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  New-Item -Force -Path $EdgeKey | Out-Null
  Set-Item -Path $EdgeKey -Value $ManifestPath
}

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-Item -Force -Path $RunKey | Out-Null
Set-ItemProperty -Path $RunKey -Name "VaxLinkScannerAgent" -Value "`"$InstalledBinary`" --run"

Write-Host "Installed VaxLink Scanner Agent to $InstallDir"
Write-Host "Registered Chrome native messaging host $HostName"
if ($RegisterEdge) {
  Write-Host "Registered Edge native messaging host $HostName"
}
Write-Host "Registered per-user startup entry VaxLinkScannerAgent"
