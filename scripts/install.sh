#!/usr/bin/env bash
# Installs the WhatsApp bridge plugin + skill into the global OpenCode config.
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Installing opencode-whatsapp..."

mkdir -p "$CONFIG_DIR/plugins/whatsapp" "$CONFIG_DIR/skills/whatsapp"
cp "$ROOT/src/index.ts" "$CONFIG_DIR/plugins/whatsapp/index.ts"
cp "$ROOT/skills/whatsapp/SKILL.md" "$CONFIG_DIR/skills/whatsapp/SKILL.md"

echo "Copied plugin to $CONFIG_DIR/plugins/whatsapp"
echo "Copied skill  to $CONFIG_DIR/skills/whatsapp"

if command -v npm >/dev/null 2>&1; then
  echo "Installing dependencies (baileys, qrcode, pino)..."
  (cd "$CONFIG_DIR" && npm install "@whiskeysockets/baileys@^7.0.0-rc14" "qrcode@^1.5.4" "pino@^10.4.0" --save --no-fund --no-audit >/dev/null)
  echo "Dependencies installed."
else
  echo "npm not found. Install Node.js, then run: cd \"$CONFIG_DIR\" && npm install @whiskeysockets/baileys qrcode pino"
fi

echo
echo "Done. OpenCode loads plugins from $CONFIG_DIR/plugins automatically."
echo "A QR code appears at: $HOME/.local/share/opencode/whatsapp/qr.html"
echo "Scan it with WhatsApp -> Linked devices -> Link a device."
