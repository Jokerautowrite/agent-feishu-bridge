#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGENT_BRIDGE_REPO_URL:-https://github.com/Jokerautowrite/agent-feishu-bridge.git}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/agent-feishu-bridge"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/agent-feishu-bridge"
INSTALL_DIR="${AGENT_BRIDGE_INSTALL_DIR:-$DATA_HOME/app}"
ENV_FILE="${AGENT_BRIDGE_ENV_FILE:-$CONFIG_HOME/.env}"
LOG_DIR="$CONFIG_HOME/logs"
NO_SERVICE=false

if [[ "${1:-}" == "--no-service" ]]; then
  NO_SERVICE=true
fi

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }

prompt() {
  local label="$1" default_value="${2:-}" answer=""
  if [[ -r /dev/tty ]]; then
    if [[ -n "$default_value" ]]; then
      printf '%s [%s]: ' "$label" "$default_value" >/dev/tty
    else
      printf '%s: ' "$label" >/dev/tty
    fi
    IFS= read -r answer </dev/tty || true
  fi
  printf '%s' "${answer:-$default_value}"
}

prompt_secret() {
  local label="$1" answer=""
  if [[ -r /dev/tty ]]; then
    printf '%s: ' "$label" >/dev/tty
    IFS= read -r -s answer </dev/tty || true
    printf '\n' >/dev/tty
  fi
  printf '%s' "$answer"
}

read_env_value() {
  local key="$1" line=""
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  printf '%s' "$line"
}

quote_env() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_env_file() {
  local temp_file managed_pattern
  temp_file="$(mktemp "$CONFIG_HOME/.env.XXXXXX")"
  managed_pattern='^(FEISHU_APP_ID|FEISHU_APP_SECRET|AGENT_BRIDGE_BACKEND|AGENT_BRIDGE_PROJECTS_ROOT|AGENT_BRIDGE_SESSIONS_FILE|AGENT_BRIDGE_ATTACHMENTS_DIR|AGENT_BRIDGE_CODEX_COMMAND|AGENT_BRIDGE_FEISHU_STREAMING_OUTPUT|AGENT_BRIDGE_FEISHU_CARDKIT_STREAMING|AGENT_BRIDGE_OUTPUT_VISIBLE_TAIL_PERCENT)='
  if [[ -f "$ENV_FILE" ]]; then
    grep -Ev "$managed_pattern" "$ENV_FILE" >"$temp_file" || true
  fi
  {
    printf 'FEISHU_APP_ID=%s\n' "$(quote_env "$APP_ID")"
    printf 'FEISHU_APP_SECRET=%s\n' "$(quote_env "$APP_SECRET")"
    printf 'AGENT_BRIDGE_BACKEND=%s\n' "$(quote_env "$BACKEND")"
    printf 'AGENT_BRIDGE_PROJECTS_ROOT=%s\n' "$(quote_env "$PROJECTS_ROOT")"
    printf 'AGENT_BRIDGE_SESSIONS_FILE=%s\n' "$(quote_env "$SESSIONS_FILE")"
    printf 'AGENT_BRIDGE_ATTACHMENTS_DIR=%s\n' "$(quote_env "$ATTACHMENTS_DIR")"
    if [[ -n "${AGENT_COMMAND:-}" ]]; then
      printf 'AGENT_BRIDGE_CODEX_COMMAND=%s\n' "$(quote_env "$AGENT_COMMAND")"
    fi
    printf 'AGENT_BRIDGE_FEISHU_STREAMING_OUTPUT=true\n'
    printf 'AGENT_BRIDGE_FEISHU_CARDKIT_STREAMING=true\n'
    printf 'AGENT_BRIDGE_OUTPUT_VISIBLE_TAIL_PERCENT=10\n'
  } >>"$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$ENV_FILE"
}

need git
need node
need npm

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 18 ]] || fail "Node.js 18 or newer is required (found $(node --version))."

say "Installing agent-feishu-bridge"
mkdir -p "$CONFIG_HOME" "$DATA_HOME" "$LOG_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  say "Updating existing checkout"
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  fail "$INSTALL_DIR exists but is not an agent-feishu-bridge Git checkout."
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

say "Installing Node.js dependencies"
npm --prefix "$INSTALL_DIR" ci --omit=dev

EXISTING_APP_ID="$(read_env_value FEISHU_APP_ID)"
EXISTING_APP_SECRET="$(read_env_value FEISHU_APP_SECRET)"
EXISTING_BACKEND="$(read_env_value AGENT_BRIDGE_BACKEND)"
EXISTING_PROJECTS_ROOT="$(read_env_value AGENT_BRIDGE_PROJECTS_ROOT)"

APP_ID="${FEISHU_APP_ID:-$(prompt 'Feishu App ID' "$EXISTING_APP_ID")}"
APP_SECRET="${FEISHU_APP_SECRET:-$EXISTING_APP_SECRET}"
if [[ -z "$APP_SECRET" ]]; then
  APP_SECRET="$(prompt_secret 'Feishu App Secret')"
fi
BACKEND="${AGENT_BRIDGE_BACKEND:-$(prompt 'Agent backend (codex/opencode/claude/chuang/openclaw/hermes/grok)' "${EXISTING_BACKEND:-codex}")}"
PROJECTS_ROOT="${AGENT_BRIDGE_PROJECTS_ROOT:-$(prompt 'Projects root' "${EXISTING_PROJECTS_ROOT:-$HOME/projects}")}"

[[ -n "$APP_ID" ]] || fail "Feishu App ID is required."
[[ -n "$APP_SECRET" ]] || fail "Feishu App Secret is required."
case "$BACKEND" in codex|opencode|claude|chuang|openclaw|hermes|grok) ;; *) fail "Unsupported backend: $BACKEND" ;; esac

AGENT_COMMAND="${AGENT_BRIDGE_CODEX_COMMAND:-$(read_env_value AGENT_BRIDGE_CODEX_COMMAND)}"
case "$BACKEND" in
  codex)
    if [[ -z "$AGENT_COMMAND" ]]; then AGENT_COMMAND="$(command -v codex || true)"; fi
    [[ -n "$AGENT_COMMAND" ]] || fail "Codex CLI was not found. Install/login Codex, or set AGENT_BRIDGE_CODEX_COMMAND, then rerun."
    ;;
  opencode) command -v opencode >/dev/null 2>&1 || fail "OpenCode was not found. Install it and start 'opencode serve' first." ;;
  claude) command -v claude >/dev/null 2>&1 || fail "Claude Code was not found. Install/login Claude Code, then rerun." ;;
  openclaw) command -v openclaw >/dev/null 2>&1 || fail "OpenClaw was not found. Install/login OpenClaw, then rerun." ;;
  hermes) command -v hermes >/dev/null 2>&1 || fail "Hermes Agent was not found. Install/login Hermes, then rerun." ;;
  grok) command -v grok >/dev/null 2>&1 || fail "Grok CLI was not found. Install/login Grok, then rerun." ;;
esac

SESSIONS_FILE="$DATA_HOME/sessions.json"
ATTACHMENTS_DIR="$DATA_HOME/attachments"
mkdir -p "$ATTACHMENTS_DIR"

write_env_file

NODE_BIN="$(command -v node)"
ENTRY="$INSTALL_DIR/bin/codex-im.js"

install_linux_service() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit_file="$unit_dir/agent-feishu-bridge.service"
  mkdir -p "$unit_dir"
  cat >"$unit_file" <<EOF
[Unit]
Description=Agent Feishu Bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=AGENT_BRIDGE_ENV_FILE=$ENV_FILE
ExecStart=$NODE_BIN $ENTRY feishu-bot
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now agent-feishu-bridge.service
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  printf '%s' "$value"
}

install_macos_service() {
  local label="io.github.jokerautowrite.agent-feishu-bridge"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$(xml_escape "$NODE_BIN")</string><string>$(xml_escape "$ENTRY")</string><string>feishu-bot</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$INSTALL_DIR")</string>
  <key>EnvironmentVariables</key><dict>
    <key>AGENT_BRIDGE_ENV_FILE</key><string>$(xml_escape "$ENV_FILE")</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/bridge.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/bridge-error.log")</string>
</dict></plist>
EOF
  launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$plist"
}

if [[ "$NO_SERVICE" == "false" ]]; then
  case "$(uname -s)" in
    Linux)
      command -v systemctl >/dev/null 2>&1 || fail "systemd user services are unavailable; rerun with --no-service."
      install_linux_service
      ;;
    Darwin) install_macos_service ;;
    *) fail "Unsupported OS. Use install.ps1 on Windows, or rerun with --no-service." ;;
  esac
else
  say "Service installation skipped"
fi

verify_service() {
  local deadline=$((SECONDS + 15)) output=""
  while (( SECONDS < deadline )); do
    case "$(uname -s)" in
      Linux) output="$(journalctl --user -u agent-feishu-bridge.service --since '-30 seconds' --no-pager 2>/dev/null || true)" ;;
      Darwin) output="$(cat "$LOG_DIR/bridge.log" "$LOG_DIR/bridge-error.log" 2>/dev/null || true)" ;;
    esac
    if grep -q 'Feishu long connection started' <<<"$output"; then return 0; fi
    sleep 1
  done
  printf '%s\n' "$output" | tail -n 20 >&2
  fail "Service started but the Feishu long connection was not verified. Check credentials and the README application checklist."
}

if [[ "$NO_SERVICE" == "false" ]]; then verify_service; fi

say "Installation complete"
printf 'Config: %s\nApp:    %s\n' "$ENV_FILE" "$INSTALL_DIR"
printf 'Before testing, finish the Feishu application checklist at the top of README.md.\n'
if [[ "$NO_SERVICE" == "true" ]]; then
  printf 'Run: AGENT_BRIDGE_ENV_FILE=%q %q %q feishu-bot\n' "$ENV_FILE" "$NODE_BIN" "$ENTRY"
fi
