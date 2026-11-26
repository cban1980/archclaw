# archclaw

**Let Claude run your Arch/Omarchy desktop from your phone.**

archclaw is a small server on your PC that the Claude apps connect to as a
[custom connector](https://support.claude.com/en/articles/11175166) (a remote MCP server). Then you
can say, in any language, from the Claude app on your phone:

- *"Start mirc"*: Discord and a terminal on the left screen, Edge in the middle, Spotify on the right.
- *"Play Daft Punk's Discovery on the computer"*, *"skip this song"*, *"volume to 30"*.
- *"Move Spotify to the middle screen"*, *"close the browser"*, *"what's open right now?"*
- *"Switch to the Tokyo Night theme and hide the bar"*, *"remind me in 20 minutes to take the pizza out"*,
  *"move the sound to the headset"*, *"what's on my left screen?"*
- *"Lock the computer and turn the screens off"*, *"shut it down"* (with a cancellable countdown on screen).
- *"When I say movie night, open Jellyfin on the TV screen and turn on night light"*: Claude saves
  that as a scene and remembers it.

Claude also manages archclaw's own setup: it adds apps, saves scenes with the words you use for
them, names your screens and keeps notes about your habits. You rarely edit the config by hand.

## How it works

```
Claude app (phone, desktop, web)
        │  MCP over https, OAuth with your owner password
        ▼
Cloudflare Tunnel (https://pc.example.com)  ──►  archclaw on 127.0.0.1:8765
                                                    │  Hyprland, PipeWire, playerctl,
                                                    │  Omarchy scripts, Spotify Web API
                                                    ▼
                                                 your desktop
```

archclaw listens only on localhost. The tunnel gives Claude's cloud a way in without opening a
port, and archclaw's own OAuth server only lets in Claude, after you approve it with your password.

## Install

On Arch/Omarchy, with a domain on Cloudflare (the free plan is fine):

```sh
git clone https://github.com/cban1980/archclaw.git ~/Work/archclaw
cd ~/Work/archclaw
./bootstrap.sh
```

The installer:
1. installs what's missing (`nodejs`, `cloudflared`, `playerctl`, `jq`, `gum`, …);
2. writes `~/.config/archclaw/config.yaml` from your monitors and default apps;
3. asks for an **owner password** (you type it once, when you connect Claude);
4. creates a **Cloudflare Tunnel** to a hostname you pick, e.g. `pc.example.com`;
5. starts two user services: `archclaw` (with your desktop session) and `archclaw-tunnel`;
6. optionally logs in to **Spotify**.

Then connect Claude: **claude.ai → Settings → Connectors → Add custom connector**, URL
`https://pc.example.com/mcp`, and sign in with the owner password. The connector is then
available in the Claude apps on your phone as well; switch it on in a chat's **+** menu, or use
voice mode.

## What Claude can do

| Tool | What it does |
|---|---|
| `get_status` | Locked, screens, volume, what's playing, active scenes, open apps, every window and monitor |
| `start_scene`, `stop_scene` | Your saved setups, by name or alias |
| `open_app`, `close_app`, `move_window`, `focus_window`, `close_window` | Apps and windows on named screens |
| `run_action` | Volume, media keys, screens on/off, lock, do not disturb, night light, keep awake, power |
| `spotify_search`, `spotify_play` | Any track, album, artist or playlist (also your own) on this PC |
| `omarchy_info`, `omarchy_do` | Omarchy itself: theme, wallpaper, font, text size, bar, transparency, animations, workspaces, fullscreen/float, audio output, mic, brightness, Bluetooth, power profile, reminders, notifications, screen recording, repairs (restart audio/Wi-Fi/Bluetooth/shell) |
| `screenshot` | Lets Claude see a screen (or all of them) |
| `find_installed_apps`, `add_app`, `remove_app` | Add programs or web apps |
| `save_scene`, `remove_scene`, `name_screen`, `set_notes`, `undo_config_change` | Change archclaw's setup |

## Safety

- **Power** (shutdown, reboot, sleep, logout) shows a notification with **Cancel** for 30 s first,
  is refused right after boot, and can't be part of a scene. `run_action power.cancel` stops it.
- **No remote unlock.** Claude can lock the computer, never unlock it.
- **No shell from Claude.** Apps Claude adds are launched from installed desktop entries or as web
  apps; scenes Claude saves can only open, close, play and run built-in actions. Omarchy operations
  are a fixed catalog, and every value is checked against a list (themes, fonts, outputs, paired
  devices), an enum or a pattern before it is quoted into the command. Custom commands
  (`{ run: … }`, custom `launch:`) are yours to add in the config file.
- **Every change Claude makes to the config** is validated, keeps your comments, and can be undone
  (`undo_config_change`; earlier versions are in `~/.local/state/archclaw/config-history/`).
- **Access**: only Claude's redirect URIs can register; signing in needs your owner password
  (5 wrong tries lock it for 15 minutes). `archclaw connector revoke` signs every client out.

## Commands

```
archclaw status                   service, tunnel, connector, Spotify and config at a glance
archclaw check                    validate the config
archclaw list                     built-in actions
archclaw run <action>             run one locally (same safety rules)
archclaw scene <name> start|stop  start or stop a scene
archclaw connector password|url|status|revoke
archclaw spotify login|status|logout
```

Logs: `journalctl --user -u archclaw -f` and `journalctl --user -u archclaw-tunnel -f`.

## Configuration

See [docs/CONFIG.md](docs/CONFIG.md). In short: `apps`, `screens`, `scenes` (with `aliases`) and
free-form `notes` that Claude reads every time. Hand edits apply as soon as you save.

## Spotify

Needs Spotify Premium and a free app at <https://developer.spotify.com/dashboard> (Web API,
redirect URI `http://127.0.0.1:8898/callback`). Then `archclaw spotify login --client-id <ID>`.
Claude can then play anything on this PC, and `spotify.handoff.on` moves music that starts on a
speaker to the PC automatically.

## Requirements

Arch Linux with Hyprland, Node 22.18+. [Omarchy](https://omarchy.org) adds do-not-disturb, night
light, keep-awake and nicer app launchers; without it the rest works with plain systemd/logind.

## Development

```sh
npm ci
npm test            # node --test; TypeScript runs natively (no build step)
npm run typecheck
ARCHCLAW_CONFIG=config.example.yaml node src/cli.ts check
```

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

*archclaw used to be **archnest**, a Google Home/Matter bridge. Gemini's speech recognition
couldn't reliably tell custom names apart, so it became a Claude connector instead.*
