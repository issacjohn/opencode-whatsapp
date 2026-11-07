<#
  Installs the WhatsApp bridge plugin + skill into the global OpenCode config.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#>

param(
  [string]$ConfigDir = (Join-Path $env:USERPROFILE ".config\opencode")
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "Installing opencode-whatsapp..." -ForegroundColor Cyan

$pluginDir = Join-Path $ConfigDir "plugins\whatsapp"
$skillDir = Join-Path $ConfigDir "skills\whatsapp"

New-Item -ItemType Directory -Force -Path $pluginDir, $skillDir | Out-Null

Copy-Item (Join-Path $root "src\index.ts") (Join-Path $pluginDir "index.ts") -Force
Copy-Item (Join-Path $root "skills\whatsapp\SKILL.md") (Join-Path $skillDir "SKILL.md") -Force

Write-Host "Copied plugin to $pluginDir"
Write-Host "Copied skill  to $skillDir"

# Install runtime dependencies next to the global config so the plugin can import them.
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
  Write-Host "Installing dependencies (baileys, qrcode, pino)..."
  Push-Location $ConfigDir
  try {
    & $npm.Source install "@whiskeysockets/baileys@^7.0.0-rc14" "qrcode@^1.5.4" "pino@^10.4.0" --save --no-fund --no-audit | Out-Null
  } finally {
    Pop-Location
  }
  Write-Host "Dependencies installed." -ForegroundColor Green
} else {
  Write-Warning "npm was not found. Install Node.js, then run: cd `"$ConfigDir`" && npm install @whiskeysockets/baileys qrcode pino"
}

Write-Host ""
Write-Host "Done. OpenCode loads plugins from $pluginDir automatically." -ForegroundColor Green
Write-Host "A QR code appears at: $env:USERPROFILE\.local\share\opencode\whatsapp\qr.html"
Write-Host "Scan it with WhatsApp -> Linked devices -> Link a device."
