# Configuration reference

archnest reads `~/.config/archnest/config.yaml` (override it with `ARCHNEST_CONFIG`).

- **Create it:** `archnest init` (or the installer) writes it from a preset, filled in with your
  monitors, default browser and terminal, and a random pairing code.
- **After every edit:**
  ```sh
  archnest check                        # validates everything, with clear errors
  systemctl --user restart archnest     # applies it
  archnest routines --copy              # only if you changed phrases → paste into Google Home
  ```
- **New devices** appear in Google Home within a minute. Put each one in your archnest room
  (see [`room`](#top-level)), or Gemini answers "set up your devices in the Google Home app".

Presets: [`config.example.yaml`](../config.example.yaml) (English) and
[`presets/sv.yaml`](../presets/sv.yaml) (Swedish). Both are full, commented examples.

## Top level

| Key | Default | Meaning |
|---|---|---|
| `name` | `archnest` | The bridge's own name in Google Home. It must differ from every device name, or Google shows one of them as "Name (2)". |
| `room` | `Desk` | The Google Home room you put all archnest devices in. Routines refer to devices as `<device> - <room>`. Use a room of its own, so room-wide commands ("turn off the living room lights") don't hit the screens or the volume. |
| `screens` | `{}` | Friendly names → Hyprland monitor names (`hyprctl monitors`), e.g. `left: HDMI-A-1`. Used by `screen:` in actions. |
| `apps` | `{}` | Apps archnest can open, close and play: see [Apps](#apps). |
| `devices` | (required) | What Google Home sees: see [Devices](#devices). |
| `routines` | `[]` | Phrases that switch several devices at once: see [Phrases and routines](#phrases-and-routines). |
| `matter` | | `port` (5540), `passcode`, `discriminator`. `init` randomises the last two; change them only before pairing. |
| `safety` | | `countdownSeconds` (30), `bootGraceSeconds` (120), `repeatWindowSeconds` (60): see [Safety](#safety). |
| `spotify` | | See [Spotify](#spotify). |
| `connector` | off | The optional Claude connector (`enabled`, `port`, `publicUrl`). |

## Devices

```yaml
devices:
  - name: Screens            # what you say; also the Google Home name
    type: light              # plug | light | dimmer | lock | momentary
    on: display.on           # action(s) when switched on
    off: display.off         # action(s) when switched off
    initial: true            # state shown at startup, until the probe says otherwise
    probe: "hyprctl monitors -j | jq -e 'all(.[]; .dpmsStatus)'"   # exit 0 = on
    phrases:                 # optional extra phrases → `archnest routines`
      on: ["wake up the screens"]
      off: ["screens off please"]
```

### Types

Gemini understands each type natively, so these work without any routine:

| Type | Gemini hears it as | Say | Notes |
|---|---|---|---|
| `plug` | an outlet | "turn on/off X" | stays on/off; the usual choice |
| `light` | a light | "turn on/off X" | also included in "turn off all the lights"; keep the room separate |
| `dimmer` | a dimmable light | "set X to 30 percent", "turn off X" | needs `level` (an action that takes a percent, e.g. `volume.set`) and optionally `levelProbe` (prints 0–100) |
| `lock` | a door lock | "lock X" | runs `on` when locked; **remote unlock is always refused**; only `on` |
| `momentary` | an outlet that flips back off | via routines ("shut down the computer") | a button: runs `on`, then resets. Required for power actions; only `on` |

### State (`probe`)

- **What it is:** a shell command polled every 5 s. Exit 0 means on (or locked).
- **Why:** with it, Google Home shows the real state, and "turn off X" works even when you changed
  it on the PC.
- **Without one:** devices that `open` an app track whether the app is running; others keep the
  last state Google set.

Useful probes:

```yaml
probe: omarchy-hyprland-session-locked                                  # screen locked
probe: playerctl -a status 2>/dev/null | grep -qx Playing                # music playing
probe: hyprctl clients -j | jq -e 'any(.[]; .class == "discord")' >/dev/null   # a window exists
probe: systemctl --user is-active --quiet syncthing                     # a service runs
probe: test "$(omarchy-shell notifications isDnd)" = on                  # do not disturb
```

## Actions

`on`, `off` and routine steps take an **action**, or a **list of actions** run in order (a scene):

| Form | Does |
|---|---|
| `display.off` | a built-in action (table below) |
| `{ run: "notify-send hi" }` | any shell command, run in your session |
| `{ open: browser, screen: left }` | opens an app, or focuses it if it's already open, and moves it to that screen |
| `{ open: terminal, screen: middle, new: true }` | always opens a new window |
| `{ close: spotify }` | closes every window of the app |
| `{ play: spotify, screen: right }` | plays music in the app (MPRIS): resumes it, or opens it on that screen and starts playback |
| `[a, b, c]` | a scene: runs them in order; one failing step doesn't stop the rest |

`screen:` takes a name from `screens` or a monitor name. On a missing monitor, the app opens
where it is.

### Built-in actions

| Id | Does | Needs |
|---|---|---|
| `power.shutdown`, `power.reboot`, `power.suspend`, `power.logout` | power, with [safety](#safety) | momentary device; systemd/logind (Omarchy's scripts if present) |
| `power.lock` | lock the screen | `omarchy-system-lock`, else `loginctl lock-session` |
| `power.cancel` | cancel a pending power action | |
| `display.on`, `display.off` | DPMS | Hyprland |
| `media.play`, `media.pause`, `media.playpause`, `media.next`, `media.previous` | media keys for any MPRIS player (`pause` pauses all) | `playerctl` |
| `volume.set` (percent), `volume.mute`, `volume.unmute` | output volume | `pactl` (PipeWire/Pulse) |
| `dnd.on`, `dnd.off` | do not disturb | Omarchy |
| `nightlight.on`, `nightlight.off` | night light | Omarchy |
| `awake.on`, `awake.off` | keep the PC awake (idle inhibitor) | Omarchy |
| `spotify.here` | play Spotify on this PC: take over from the Nest if it's playing there, else start/resume locally | an `apps` entry for Spotify; the takeover needs `archnest spotify login` |
| `spotify.handoff.on`, `spotify.handoff.off` | handoff mode: Spotify started on a speaker moves here | `archnest spotify login` |

`archnest list` prints the current list. `archnest run <id>` tries one, with the same safety rules.

## Apps

```yaml
apps:
  browser:
    launch: omarchy-launch-browser          # command that starts it
    match: microsoft-edge                   # whole word, case-insensitive, in window class or title
  discord:
    launch: omarchy-launch-webapp https://discord.com/channels/@me
    match: discord
  work-pc:
    launch: remmina -c ~/.local/share/remmina/work.remmina
    match: work                             # RDP windows are titled with the connection name
  spotify:
    launch: omarchy-launch-spotify
    match: spotify
    player: spotify                         # MPRIS name for `play` (`playerctl -l`); defaults to the key
```

To find `match`, open the app and run `hyprctl clients -j | jq -r '.[] | "\(.class)  \(.title)"'`.
For terminal apps, give them their own app id so they can be told apart:
`omarchy-launch-tui --app-id=org.omarchy.myapp <command>`, then use `match: myapp`.

## Phrases and routines

Gemini never passes your words to archnest, only device commands. For anything other than
"turn on/off X", add phrases. They become a Google Home **household routine**:

```yaml
devices:
  - name: Work mode
    type: plug
    on: { open: work-pc, screen: main }
    off: { close: work-pc }
    phrases:
      on: ["time to work", "start work mode"]
      off: ["done with work"]

routines:                                   # several devices from one phrase
  - phrases: ["i'm done with the computer"]
    actions:
      - Spotify app: false                  # device name: true (on/lock) or false (off)
      - Computer: true
      - Screens: false
```

Then:

1. Run `archnest routines --copy`.
2. Go to <https://home.google.com> → **Automations** → open your archnest script, or **Add new →
   Script editor** the first time.
3. Select all, paste, then **Validate**, **Save** and **Activate**. Warnings that switches "could
   impact the safety…" are normal.

Tips:

- **Pick words Gemini hears reliably.** A made-up word may be heard as something else; real words
  or short names work best.
- **Avoid phrases Google handles itself.** For example, "play …" is music and "set an alarm" is
  an alarm.
- **Matching is exact.** Phrases are lower-cased and must match what you say.

## Spotify

```yaml
spotify:
  clientId: …                  # set by `archnest spotify login --client-id …`
  app: spotify                 # key in `apps` to start when this PC isn't a Connect device yet
  screen: right                # where it opens
  device: my-pc                # this PC's name in Spotify Connect (default: hostname)
  handoffFrom: [Kitchen]       # devices handoff mode moves from (default: speakers/TVs, never phones or computers)
```

It needs Spotify Premium and a free app at developer.spotify.com. See
[README → Spotify](../README.md#spotify-play-x-from-the-nest-on-the-pc).

## Safety

| Rule | Setting |
|---|---|
| Power actions (`power.shutdown/reboot/suspend/logout`) only on `momentary` devices, never in scenes | always |
| From Google Home, the same power command must arrive twice, at least 3 s apart | `repeatWindowSeconds` (0 turns it off) |
| A notification counts down with a **Cancel** button before power actions run | `countdownSeconds` |
| Power commands are ignored right after boot | `bootGraceSeconds` |
| Locks never unlock remotely | always |

## What needs Omarchy

archnest targets [Omarchy](https://omarchy.org). On plain Arch + Hyprland, most of it works:

| Works on Arch + Hyprland | Needs Omarchy (or your own `{ run: … }` replacement) |
|---|---|
| Matter bridge, all device types, probes, routines | `dnd.*`, `nightlight.*`, `awake.*` |
| power, lock (logind fallbacks) | `omarchy-launch-*` in the preset apps (replace `launch:` with your own commands) |
| screens, volume, media, apps on screens, scenes, shell commands | the preset probes that call `omarchy-*` |
| Spotify handoff, Claude connector | |
