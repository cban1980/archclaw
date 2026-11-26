#!/usr/bin/env bash
# archnest bootstrap: dependencies, config, firewall, systemd user service and pairing.
# Safe to re-run: every step checks what is already in place.
#
#   ./bootstrap.sh              install or update
#   ./bootstrap.sh --yes        accept all prompts (non-interactive)
#   ./bootstrap.sh --uninstall  remove the service and the `archnest` command (keeps config and pairing)
set -euo pipefail

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
CONFIG="${ARCHNEST_CONFIG:-$CONFIG_HOME/archnest/config.yaml}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT="$UNIT_DIR/archnest.service"
SHIM="$HOME/.local/bin/archnest"
# command → Arch package that provides it (checked by command, so mise/nvm installs count too)
declare -A NEEDS=([node]=nodejs [npm]=npm [gum]=gum [qrencode]=qrencode [jq]=jq [playerctl]=playerctl [pactl]=libpulse [wl-copy]=wl-clipboard)
MIN_NODE="22.18"

YES=0
UNINSTALL=0
for arg in "$@"; do
  case $arg in
    -y | --yes) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[[ -t 0 ]] || YES=1
cd "$APPDIR"

# ── UI ────────────────────────────────────────────────────────────────────────
# gum gives the Omarchy-style TUI; it's installed first, before anything else.
if ! command -v gum >/dev/null; then
  echo "archnest: installing gum for the installer UI…"
  sudo pacman -S --needed --noconfirm gum
fi

ACCENT=212
header() { gum style --border rounded --border-foreground "$ACCENT" --padding "0 2" --margin "1 0" --bold "$@"; }
step()   { echo; gum style --foreground "$ACCENT" --bold "▸ $*"; }
ok()     { gum style --foreground 10 "  ✓ $*"; }
info()   { gum style --foreground 245 "  $*"; }
warn()   { gum style --foreground 214 "  ! $*"; }
die()    { gum style --foreground 9 --bold "  ✗ $*"; exit 1; }
confirm() { [[ $YES == 1 ]] && return 0; gum confirm --prompt.foreground "$ACCENT" "$1"; }
spin()   { local title=$1; shift; gum spin --spinner dot --title "$title" --show-error -- "$@"; }

archnest() { node "$APPDIR/src/cli.ts" "$@"; }

# ── Uninstall ─────────────────────────────────────────────────────────────────
if [[ $UNINSTALL == 1 ]]; then
  header "archnest – uninstall"
  if confirm "Stop and remove the archnest service?"; then
    systemctl --user disable --now archnest.service 2>/dev/null || true
    rm -f "$UNIT" "$SHIM"
    systemctl --user daemon-reload
    ok "Removed the service and the archnest command"
    info "Kept: $CONFIG and $STATE_HOME/archnest (pairing)."
    info "Remove the bridge in the Google Home app if you won't use it again."
  fi
  exit 0
fi

header "archnest" "Control your Omarchy PC with Google Home"

# ── 1. System ─────────────────────────────────────────────────────────────────
step "Checking the system"
[[ $EUID -ne 0 ]] || die "Run as your normal user, not root (sudo is only used where needed)."
command -v pacman >/dev/null || die "This installer is for Arch/Omarchy (pacman not found)."
ok "Arch Linux"
if [[ -n ${HYPRLAND_INSTANCE_SIGNATURE:-} ]]; then
  ok "Hyprland is running"
else
  warn "Hyprland doesn't seem to be running here; screen and app features only work in the desktop session."
fi
command -v omarchy-system >/dev/null && ok "Omarchy" || warn "Omarchy not found; falling back to plain systemd commands."

# ── 2. Packages ───────────────────────────────────────────────────────────────
step "Packages"
missing=()
for cmd in "${!NEEDS[@]}"; do command -v "$cmd" >/dev/null || missing+=("${NEEDS[$cmd]}"); done
if ((${#missing[@]})); then
  info "Missing: ${missing[*]}"
  if confirm "Install ${missing[*]} with pacman?"; then
    sudo pacman -S --needed --noconfirm "${missing[@]}"
    ok "Installed ${missing[*]}"
  else
    warn "Skipped; some features may not work."
  fi
else
  ok "Everything needed is present (${!NEEDS[*]})"
fi

NODE="$(command -v node || true)"
[[ -x /usr/bin/node ]] && NODE=/usr/bin/node # prefer the system node for the service (version managers come and go)
[[ -n $NODE ]] || die "node not found."
node_version="$("$NODE" -p 'process.versions.node')"
if [[ "$(printf '%s\n' "$MIN_NODE" "$node_version" | sort -V | head -n1)" != "$MIN_NODE" ]]; then
  die "Node $node_version is too old; archnest needs at least $MIN_NODE (it runs TypeScript directly)."
fi
ok "Node $node_version ($NODE)"

# ── 3. Dependencies ───────────────────────────────────────────────────────────
step "Node dependencies"
spin "npm ci…" npm ci --no-audit --no-fund >/dev/null
ok "Installed"

# ── 4. Config ─────────────────────────────────────────────────────────────────
step "Configuration"
if [[ -f $CONFIG ]]; then
  ok "Keeping existing $CONFIG"
else
  preset=en
  if [[ $YES != 1 ]]; then
    choice="$(gum choose --header "Language for device names (what you say to Google):" "English" "Svenska")"
    [[ $choice == Svenska ]] && preset=sv
  fi
  name=archnest
  [[ $YES == 1 ]] || name="$(gum input --value archnest --header "Name of the bridge in Google Home (not a device name, e.g. not \"Computer\"):")"
  archnest init --preset "$preset" --name "${name:-archnest}" | sed 's/^/  /'
  ok "Created $CONFIG ($preset preset, random pairing passcode)"
fi
if ! check_output="$(archnest check 2>&1)"; then
  echo "$check_output" | sed 's/^/  /'
  die "The config is invalid; fix $CONFIG and run again."
fi
ok "${check_output#*: }"
port="$(node -e 'const {parse}=require("yaml");const c=parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c?.matter?.port ?? 5540)' "$CONFIG" 2>/dev/null || echo 5540)"

# ── 5. Firewall ───────────────────────────────────────────────────────────────
step "Firewall"
if systemctl is-active --quiet ufw 2>/dev/null; then
  info "ufw is active. Google Home needs mDNS (5353/udp) and Matter ($port/udp)."
  if confirm "Open 5353/udp and $port/udp in ufw?"; then
    sudo ufw allow 5353/udp comment 'mDNS (archnest)' >/dev/null
    sudo ufw allow "$port/udp" comment 'Matter (archnest)' >/dev/null
    ok "Ports are open"
  else
    warn "Without these ports Google Home can't find this PC."
  fi
else
  ok "ufw is not active; nothing to do"
fi

# ── 6. Service ────────────────────────────────────────────────────────────────
step "systemd service"
# A bridge started by hand holds the Matter port; the service can't start next to it.
if pgrep -f "^[^ ]*node [^ ]*src/cli.ts serve" >/dev/null && ! systemctl --user --quiet is-active archnest.service; then
  warn "archnest is already running by hand (not as a service)."
  if confirm "Stop the manual instance so the service can take over?"; then
    pkill -f "^[^ ]*node [^ ]*src/cli.ts serve" || true
    sleep 1
  fi
fi
mkdir -p "$UNIT_DIR"
grep -v '^# Rendered\|^# @NODE@' "$APPDIR/systemd/archnest.service.in" | sed -e "s|@NODE@|$NODE|g" -e "s|@APPDIR@|$APPDIR|g" >"$UNIT"
systemctl --user daemon-reload
systemctl --user enable archnest.service >/dev/null 2>&1
systemctl --user restart archnest.service
spin "Starting the service…" sleep 4
if systemctl --user --quiet is-active archnest.service; then
  ok "archnest.service is running and starts with the desktop"
else
  journalctl --user -u archnest -n 20 --no-pager | sed 's/^/  /'
  die "The service did not start (see the log above)."
fi

mkdir -p "$(dirname "$SHIM")"
printf '#!/bin/sh\nexec %s %s/src/cli.ts "$@"\n' "$NODE" "$APPDIR" >"$SHIM"
chmod +x "$SHIM"
ok "Installed the \`archnest\` command in ~/.local/bin"

# ── 7. Pairing ────────────────────────────────────────────────────────────────
step "Google Home"
if archnest status | grep -q '^paired:   yes'; then
  ok "Already paired with Google Home"
else
  gum style --margin "0 2" \
    "1. Register a test product at https://console.home.google.com" \
    "   Matter → Add integration → Test VID 0xFFF1, Product ID 0x8000" \
    "2. Google Home app → + → Add device → Matter-enabled device" \
    "3. Scan the QR code below (use this, not the generic device search):"
  echo
  archnest pair | sed 's/^/  /'
fi

# ── 8. Room and voice phrases ─────────────────────────────────────────────────
step "Room and voice phrases"
room="$(node -e 'const {parse}=require("yaml");const c=parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c?.room ?? "Desk")' "$CONFIG")"
gum style --margin "0 2" \
  "After pairing, put every archnest device in the room \"$room\" in the Google Home app" \
  "(device → settings → Room → add a custom room). Until a device has a room, Google" \
  "answers \"configure your devices in Google Home\" instead of controlling it." \
  "" \
  "Then add the voice phrases: home.google.com → Automations → Add new → Script editor," \
  "paste the output of \`archnest routines\`, Validate, Save."
if [[ $YES != 1 ]] && command -v wl-copy >/dev/null && confirm "Copy the routines to the clipboard now?"; then
  archnest routines --copy
  ok "Copied"
fi

# ── 9. Spotify (optional) ─────────────────────────────────────────────────────
step "Spotify (optional, needs Premium)"
if archnest spotify status 2>/dev/null | grep -q '^logged in: yes'; then
  ok "Logged in to Spotify"
elif [[ $YES == 1 ]]; then
  info "Skipped in non-interactive mode. Run ./bootstrap.sh again to set it up."
elif confirm "Set up Spotify, so music you ask the Nest for can move to this PC?"; then
  gum style --margin "0 2" \
    "1. https://developer.spotify.com/dashboard → Create app" \
    "   Redirect URI: http://127.0.0.1:8898/callback   API: Web API" \
    "2. Copy the Client ID (no secret is used)."
  client_id="$(gum input --header "Spotify Client ID:")"
  if [[ -n $client_id ]]; then
    archnest spotify login --client-id "$client_id"
    systemctl --user restart archnest.service
    ok "Spotify connected"
  else
    warn "No Client ID; skipped."
  fi
else
  info "Skipped. Run ./bootstrap.sh again any time to set it up."
fi

# ── 10. Claude connector (optional) ───────────────────────────────────────────
step "Claude connector (optional)"
connector_enabled="$(node -e 'const {parse}=require("yaml");const c=parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c?.connector?.enabled===true)' "$CONFIG")"
if [[ $connector_enabled == true ]]; then
  ok "Already enabled: $(archnest connector status | sed -n 's/^url: *//p')"
elif [[ $YES == 1 ]]; then
  info "Skipped in non-interactive mode. Run ./bootstrap.sh again to set it up."
elif confirm "Set up the Claude connector, so the Claude app can control this PC?"; then
  info "Claude connects from Anthropic's cloud, so archnest needs a public https address."
  info "This uses Tailscale Funnel (free, fixed address, no domain needed)."
  if ! archnest connector status | grep -q '^password:  set'; then
    info "Choose the owner password you'll enter when connecting Claude:"
    archnest connector password
  fi
  if ! command -v tailscale >/dev/null; then
    confirm "Install tailscale with pacman?" && sudo pacman -S --needed --noconfirm tailscale
  fi
  command -v tailscale >/dev/null || die "tailscale is required for the connector."
  systemctl is-active --quiet tailscaled || sudo systemctl enable --now tailscaled
  if ! tailscale status >/dev/null 2>&1; then
    info "Sign in to Tailscale in the browser window that opens (a free account is enough):"
    sudo tailscale up --operator="$USER"
  fi
  connector_port="$(node -e 'const {parse}=require("yaml");const c=parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c?.connector?.port ?? 8765)' "$CONFIG")"
  info "Publishing 127.0.0.1:$connector_port with Funnel. If Tailscale prints a link to enable Funnel, open it and approve."
  tailscale funnel --bg "$connector_port"
  host="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  [[ -n $host && $host != null ]] || die "Could not read this machine's Tailscale name."
  archnest connector enable "https://$host" >/dev/null
  systemctl --user restart archnest.service
  ok "Connector published at https://$host/mcp"
  gum style --margin "0 2" \
    "In the Claude app (or claude.ai → Settings → Connectors → Add custom connector):" \
    "  Name: archnest    URL: https://$host/mcp" \
    "Then sign in with the owner password you just chose."
else
  info "Skipped. Run ./bootstrap.sh again any time to set it up."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
header "Done!" \
  "Status:    archnest status" \
  "Logs:      journalctl --user -u archnest -f" \
  "Try it:    archnest list   /   archnest trigger <device> on" \
  "Phrases:   archnest routines --copy  → Google Home script editor"
