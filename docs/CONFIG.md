# Configuration reference

archclaw reads `~/.config/archclaw/config.yaml` (override with `ARCHCLAW_CONFIG`). `archclaw init`
(or the installer) writes it from [`config.example.yaml`](../config.example.yaml).

Claude edits most of it for you through its tools. Hand edits apply as soon as you save; if the
file is invalid, archclaw keeps the last good version and shows a notification. `archclaw check`
validates.

## Top level

| Key | Default | Meaning |
|---|---|---|
| `name` | `archclaw` | What Claude and the sign-in page call this computer. |
| `notes` | `""` | Free text Claude reads in every conversation: your language, the words you use, habits. Claude can update it (`set_notes`). |
| `screens` | `{}` | Friendly names → Hyprland monitor names (`hyprctl monitors`), e.g. `left: HDMI-A-1`. |
| `apps` | `{}` | See [Apps](#apps). |
| `terminalPrograms` | `{}` | Your own terminal programs, name → command line, e.g. `logs: journalctl --user -f`. Claude opens them with `open_terminal`, next to installed TUIs (btop, htop, nvim, hx, lazygit, lazydocker, yazi, ranger, mc, ncdu, k9s, tmux, herdr, impala, wiremix, bluetui, claude, opencode…) and ssh to hosts in `~/.ssh/config`. Claude can't add or change these. |
| `scenes` | `[]` | See [Scenes](#scenes). |
| `connector` | | `port` (8765), `publicUrl` (your tunnel's https address), `listen` and `allowFrom` (see [The connector](#the-connector)). |
| `spotify` | | See [Spotify](#spotify). |
| `safety` | | `countdownSeconds` (30), `bootGraceSeconds` (120). See [Safety](#safety). |

## Apps

```yaml
apps:
  discord:
    launch: omarchy-launch-webapp 'https://discord.com/channels/@me'
    match: discord                    # a word in the window class or title
    description: chat with friends    # helps Claude pick the right one
    confirmClose: true                # accept "Leave site?" when closing (presses Return if the window stays)
  spotify:
    launch: omarchy-launch-spotify
    match: spotify
    player: spotify                   # MPRIS name for { play: … } (`playerctl -l`); defaults to the key
  work-pc:
    launch: remmina -c ~/.local/share/remmina/work.remmina
    match: work                       # RDP windows are titled with the connection name
```

- **Claude adds apps** with `add_app` from an installed desktop entry (`uwsm-app -- <id>.desktop`)
  or as a web app (`omarchy-launch-webapp '<https url>'`). It can't write other commands, and it
  won't change apps you set up with a custom `launch`.
- **To find `match`**, open the app and run `hyprctl clients -j | jq -r '.[] | "\(.class)  \(.title)"'`.
  For terminal apps, give them their own app id: `omarchy-launch-tui --app-id=org.omarchy.myapp <cmd>`,
  then `match: myapp`.

## Scenes

```yaml
scenes:
  - name: mirc
    aliases: [chattläge, chat mode]    # any words, any language; matching ignores case and accents
    description: Discord and archflux left, Edge middle, Spotify right
    start:
      - { open: discord, screen: left }
      - { open: archflux, screen: left }
      - { open: edge, screen: middle }
      - { open: spotify, screen: right }
    stop:
      - { close: discord }
      - { close: archflux }
    probe: hyprctl clients -j | jq -e 'any(.[]; .class == "org.omarchy.archflux")' >/dev/null
```

| Key | Meaning |
|---|---|
| `name`, `aliases` | What you call it. Names and aliases must be unique across scenes. |
| `description` | What it does, for Claude. |
| `start`, `stop` | Steps, run in order; one failing step doesn't stop the rest. Without `stop`, there's nothing to stop. |
| `probe` | Shell command; exit 0 = the scene is active (shown in `get_status`). Default: the first app it opens is running. |

Steps:

| Step | Does |
|---|---|
| `display.off` | a built-in action (`archclaw list`) |
| `{ open: app, screen: left }` | opens the app, or focuses it if open, and moves it to that screen |
| `{ open: terminal, new: true }` | always a new window |
| `{ close: app }` | closes every window of the app |
| `{ play: spotify, screen: right }` | resumes music, or opens the player there and starts playback |
| `{ terminal: lazygit, dir: ~/Work/app, screen: left }` | a terminal running a program in a folder (`terminal: shell` for a plain shell; `ssh: host` for ssh) |
| `{ hue: Living room, brightness: 30, temperature: warm, fade: 2 }` | Philips Hue: a room, zone, light or `all`; `on`, `brightness` (0 = off), `color` (name or #rrggbb), `temperature` (K or warm/neutral/cool/daylight), `fade` (s) |
| `{ hueScene: Relax, room: Living room }` | recall a Hue scene |
| `{ omarchy: theme.set, value: Tokyo Night }` | an Omarchy operation (the list is in `src/omarchy.ts`; Claude sees it in `omarchy_do`) |
| `{ run: "shell command" }` | anything; **hand edits only** (Claude can't add these) |

Power actions can't be in scenes. When Claude saves a scene without stop steps, stopping closes
the apps it opens.

## Built-in actions

| Id | Does | Needs |
|---|---|---|
| `power.shutdown`, `power.reboot`, `power.suspend`, `power.logout` | power, after a countdown | systemd/logind (Omarchy's scripts if present) |
| `power.lock` | lock the screen | `omarchy-system-lock`, else `loginctl lock-session` |
| `power.cancel` | cancel a pending power action | |
| `display.on`, `display.off` | DPMS | Hyprland |
| `media.play`, `media.pause`, `media.playpause`, `media.next`, `media.previous` | any MPRIS player (`pause` pauses all) | `playerctl` |
| `volume.set` (percent), `volume.mute`, `volume.unmute` | output volume | `pactl` |
| `dnd.on`, `dnd.off`, `nightlight.on`, `nightlight.off`, `awake.on`, `awake.off` | desktop toggles | Omarchy |
| `spotify.here` | move Spotify playback here, or start/resume it | Spotify login |
| `spotify.handoff.on`, `spotify.handoff.off` | keep moving music that starts on a speaker to this PC | Spotify login |

## Spotify

```yaml
spotify:
  clientId: …                  # set by `archclaw spotify login --client-id …`
  app: spotify                 # key in `apps` to start when this PC isn't a Connect device yet
  screen: right                # where it opens
  device: my-pc                # this PC's name in Spotify Connect (default: hostname)
  handoffFrom: [Kitchen]       # handoff moves from these (default: speakers/TVs, never phones or computers)
```

## Safety

| Rule | Setting |
|---|---|
| Shutdown, reboot, sleep and logout show a notification with **Cancel** first | `countdownSeconds` |
| …and are refused right after boot | `bootGraceSeconds` |
| Power actions can't be in scenes | always |
| No remote unlock | always |
| Claude can't add shell commands (apps or scenes) | always |

## The connector

```sh
archclaw connector password            # the owner password (signs every client out)
archclaw connector url https://pc.example.com
archclaw connector status              # address, password, signed-in clients
archclaw connector revoke              # sign every Claude client out
```

The connector needs a public https address that forwards to `<listen>:<port>`. The installer
sets up a Cloudflare Tunnel on this computer (`~/.cloudflared/archclaw.yml`, service
`archclaw-tunnel`); any other reverse proxy or tunnel works too, as long as it passes the original
`Host` header.

**Tunnel on another machine** (a cloudflared LXC, a VPS, a reverse proxy box): let archclaw listen
on the LAN and accept only that machine, then point a public hostname of that tunnel at
`http://<this computer's LAN IP>:8765`.

```yaml
connector:
  port: 8765
  publicUrl: https://pc.example.com
  listen: 192.168.1.20        # this computer's LAN address
  allowFrom: [192.168.1.5]    # the cloudflared host; everyone else gets 403
```
