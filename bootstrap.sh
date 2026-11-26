#!/usr/bin/env bash
# archclaw bootstrap: dependencies, config, systemd user service, the Claude connector
# (owner password + Cloudflare Tunnel) and, optionally, Spotify.
# Safe to re-run: every step checks what is already in place.
#
#   ./bootstrap.sh              install or update
#   ./bootstrap.sh --yes        accept all prompts (non-interactive; skips the interactive steps)
#   ./bootstrap.sh --uninstall  remove the services and the `archclaw` command (keeps config and state)
set -euo pipefail

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
CONFIG="${ARCHCLAW_CONFIG:-$CONFIG_HOME/archclaw/config.yaml}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT="$UNIT_DIR/archclaw.service"
TUNNEL_UNIT="$UNIT_DIR/archclaw-tunnel.service"
TUNNEL_CONFIG="$HOME/.cloudflared/archclaw.yml"
SHIM="$HOME/.local/bin/archclaw"
# command → Arch package that provides it (checked by command, so mise/nvm installs count too)
declare -A NEEDS=([node]=nodejs [npm]=npm [gum]=gum [jq]=jq [playerctl]=playerctl [pactl]=libpulse [cloudflared]=cloudflared)
MIN_NODE="22.18"

YES=0
UNINSTALL=0
for arg in "$@"; do
  case $arg in
    -y | --yes) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[[ -t 0 ]] || YES=1
cd "$APPDIR"

# ── UI ────────────────────────────────────────────────────────────────────────
# gum gives the Omarchy-style TUI; it's installed first, before anything else.
if ! command -v gum >/dev/null; then
  echo "archclaw: installing gum for the installer UI…"
  sudo pacman -S --needed --noconfirm gum
fi

ACCENT=208
header() { gum style --border rounded --border-foreground "$ACCENT" --padding "0 2" --margin "1 0" --bold "$@"; }
step()   { echo; gum style --foreground "$ACCENT" --bold "▸ $*"; }
ok()     { gum style --foreground 10 "  ✓ $*"; }
info()   { gum style --foreground 245 "  $*"; }
warn()   { gum style --foreground 214 "  ! $*"; }
die()    { gum style --foreground 9 --bold "  ✗ $*"; exit 1; }
confirm() { [[ $YES == 1 ]] && return 0; gum confirm --prompt.foreground "$ACCENT" "$1"; }
spin()   { local title=$1; shift; gum spin --spinner dot --title "$title" --show-error -- "$@"; }

archclaw() { node "$APPDIR/src/cli.ts" "$@"; }
yaml_get() { node -e 'const {parse}=require("yaml");const c=parse(require("fs").readFileSync(process.argv[1],"utf8"))??{};const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],c);console.log(v??"")' "$CONFIG" "$1"; }

# ── Uninstall ─────────────────────────────────────────────────────────────────
if [[ $UNINSTALL == 1 ]]; then
  header "archclaw – uninstall"
  if confirm "Stop and remove the archclaw services?"; then
    systemctl --user disable --now archclaw.service archclaw-tunnel.service 2>/dev/null || true
    rm -f "$UNIT" "$TUNNEL_UNIT" "$SHIM"
    systemctl --user daemon-reload
    ok "Removed the services and the archclaw command"
    info "Kept: $CONFIG, $STATE_HOME/archclaw and the Cloudflare tunnel ($TUNNEL_CONFIG)."
    info "Delete the tunnel with: cloudflared tunnel delete archclaw"
    info "Remove the connector in Claude: Settings → Connectors."
  fi
  exit 0
fi

header "archclaw" "Let Claude run this computer from your phone"

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

# The Google Home version of this project was called archnest; it can't run next to archclaw.
if systemctl --user list-unit-files archnest.service >/dev/null 2>&1 && [[ -f $UNIT_DIR/archnest.service ]]; then
  warn "Found the old archnest (Google Home) service."
  if confirm "Stop and remove archnest.service and its command?"; then
    systemctl --user disable --now archnest.service 2>/dev/null || true
    rm -f "$UNIT_DIR/archnest.service" "$HOME/.local/bin/archnest"
    systemctl --user daemon-reload
    ok "Removed archnest; remove the bridge in the Google Home app too"
  fi
fi

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
  die "Node $node_version is too old; archclaw needs at least $MIN_NODE (it runs TypeScript directly)."
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
  name="$(hostname)"
  [[ $YES == 1 ]] || name="$(gum input --value "$name" --header "What should Claude call this computer?")"
  archclaw init --name "${name:-$(hostname)}" | sed 's/^/  /'
  ok "Created $CONFIG"
fi
if ! check_output="$(archclaw check 2>&1)"; then
  echo "$check_output" | sed 's/^/  /'
  die "The config is invalid; fix $CONFIG and run again."
fi
ok "${check_output#*: }"

mkdir -p "$(dirname "$SHIM")"
printf '#!/bin/sh\nexec %s %s/src/cli.ts "$@"\n' "$NODE" "$APPDIR" >"$SHIM"
chmod +x "$SHIM"
ok "Installed the \`archclaw\` command in ~/.local/bin"

# ── 5. Owner password ─────────────────────────────────────────────────────────
step "Owner password"
if archclaw connector status | grep -q '^password:  set'; then
  ok "Set"
elif [[ $YES == 1 ]]; then
  warn "Not set; run \`archclaw connector password\`."
else
  info "You type this once, in the browser, when you connect Claude to this computer."
  archclaw connector password
  ok "Saved"
fi

# ── 6. Cloudflare Tunnel ──────────────────────────────────────────────────────
step "Public address (Cloudflare Tunnel)"
info "Claude connects from Anthropic's cloud, so archclaw needs a public https address."
info "A Cloudflare Tunnel provides one without opening any port. You need a domain on Cloudflare (free plan is fine)."
CLOUDFLARED="$(command -v cloudflared || true)"
public_url="$(yaml_get connector.publicUrl)"
connector_port="$(yaml_get connector.port)"
connector_port="${connector_port:-8765}"
if [[ -f $TUNNEL_CONFIG && -n $public_url ]]; then
  ok "Tunnel configured: $public_url"
elif [[ $YES == 1 ]]; then
  warn "Skipped in non-interactive mode. Run ./bootstrap.sh again to set it up."
elif [[ -z $CLOUDFLARED ]]; then
  warn "cloudflared isn't installed; skipped."
elif confirm "Set up the Cloudflare Tunnel now?"; then
  if [[ ! -f $HOME/.cloudflared/cert.pem ]]; then
    info "A browser window opens: sign in to Cloudflare and pick the domain to use."
    cloudflared tunnel login
  fi
  if ! cloudflared tunnel info archclaw >/dev/null 2>&1; then
    cloudflared tunnel create archclaw >/dev/null
  fi
  tunnel_id="$(cloudflared tunnel list -o json | jq -r '.[] | select(.name=="archclaw") | .id')"
  [[ -n $tunnel_id ]] || die "Could not create the tunnel."
  host="$(gum input --header "Hostname for this computer (on your Cloudflare domain):" --placeholder "pc.example.com")"
  [[ $host =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || die "\"$host\" isn't a hostname."
  cloudflared tunnel route dns --overwrite-dns archclaw "$host" >/dev/null
  cat >"$TUNNEL_CONFIG" <<EOF
# Written by archclaw's bootstrap.sh
tunnel: $tunnel_id
credentials-file: $HOME/.cloudflared/$tunnel_id.json
ingress:
  - hostname: $host
    service: http://127.0.0.1:$connector_port
  - service: http_status:404
EOF
  archclaw connector url "https://$host" >/dev/null
  public_url="https://$host"
  ok "https://$host → 127.0.0.1:$connector_port"
fi

# ── 7. Services ───────────────────────────────────────────────────────────────
step "systemd services"
mkdir -p "$UNIT_DIR"
grep -v '^# Rendered\|^# @NODE@' "$APPDIR/systemd/archclaw.service.in" | sed -e "s|@NODE@|$NODE|g" -e "s|@APPDIR@|$APPDIR|g" >"$UNIT"
if [[ -f $TUNNEL_CONFIG && -n $CLOUDFLARED ]]; then
  grep -v '^# Rendered' "$APPDIR/systemd/archclaw-tunnel.service.in" |
    sed -e "s|@CLOUDFLARED@|$CLOUDFLARED|g" -e "s|@TUNNEL_CONFIG@|$TUNNEL_CONFIG|g" -e "s|@APPDIR@|$APPDIR|g" >"$TUNNEL_UNIT"
fi
systemctl --user daemon-reload
systemctl --user enable archclaw.service >/dev/null 2>&1
systemctl --user restart archclaw.service
if [[ -f $TUNNEL_UNIT ]]; then
  systemctl --user enable archclaw-tunnel.service >/dev/null 2>&1
  systemctl --user restart archclaw-tunnel.service
fi
spin "Starting…" sleep 4
if systemctl --user --quiet is-active archclaw.service; then
  ok "archclaw.service is running and starts with the desktop"
else
  journalctl --user -u archclaw -n 20 --no-pager | sed 's/^/  /'
  die "The service did not start (see the log above)."
fi
if [[ -f $TUNNEL_UNIT ]]; then
  systemctl --user --quiet is-active archclaw-tunnel.service && ok "archclaw-tunnel.service is running" ||
    warn "The tunnel didn't start: journalctl --user -u archclaw-tunnel"
fi

# ── 8. Spotify (optional) ─────────────────────────────────────────────────────
step "Spotify (optional, needs Premium)"
if archclaw spotify status 2>/dev/null | grep -q '^logged in: yes'; then
  ok "Logged in to Spotify"
elif [[ $YES == 1 ]]; then
  info "Skipped in non-interactive mode. Run ./bootstrap.sh again to set it up."
elif confirm "Set up Spotify, so Claude can play anything on this computer?"; then
  gum style --margin "0 2" \
    "1. https://developer.spotify.com/dashboard → Create app" \
    "   Redirect URI: http://127.0.0.1:8898/callback   API: Web API" \
    "2. Copy the Client ID (no secret is used)."
  client_id="$(gum input --header "Spotify Client ID:")"
  if [[ -n $client_id ]]; then
    archclaw spotify login --client-id "$client_id"
    systemctl --user restart archclaw.service
    ok "Spotify connected"
  else
    warn "No Client ID; skipped."
  fi
else
  info "Skipped. Run ./bootstrap.sh again any time to set it up."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
if [[ -n $public_url ]]; then
  header "Done! Now connect Claude" \
    "claude.ai → Settings → Connectors → Add custom connector" \
    "  Name: archclaw    URL: ${public_url%/}/mcp" \
    "Sign in with your owner password. The connector then works in" \
    "the Claude apps on your phone too (enable it in a chat's + menu)." \
    "" \
    "Status: archclaw status    Logs: journalctl --user -u archclaw -f"
else
  header "Almost done" \
    "archclaw runs, but Claude can't reach it yet: run ./bootstrap.sh again" \
    "to set up the Cloudflare Tunnel, or publish 127.0.0.1:$connector_port yourself" \
    "and run: archclaw connector url https://<your host>"
fi
