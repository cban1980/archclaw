# archnest: architecture, research and roadmap

## 1. The constraint everything is built around

Gemini for Home understands natural language, including Swedish (early access since April
2026), but it does **not** pass what you said to third-party code. Google shut down
Conversational Actions in 2023, and there is still no public API for custom voice commands.
Every path from a Nest to this PC goes through a *smart-home device model*: Gemini turns your
sentence into "lock X", "turn off Y", "set Z to 30 %", or into a routine you defined. Free
text never reaches us.

So "natural language" here means choosing **device types and names that Gemini already
understands**, and covering the rest with routines:

| Path | What reaches archnest | How natural it feels | Status |
|---|---|---|---|
| Matter devices with fitting types (lock, light, dimmer) | Typed commands | "lock the computer", "turn off the screens", "set volume to 30 percent" | ✅ |
| Routines (script editor / app) | Fixed phrases → devices | Any phrase, but fixed | ✅ (`docs/routines/`) |
| Spotify handoff | Google searches Spotify, we move playback to the PC | Free-form music requests | Roadmap |
| Cloud-to-cloud "TV" device | AppSelector, TransportControl, Volume | "open Spotify on the computer" with no routine | Roadmap (needs public HTTPS + OAuth) |
| Claude connector (remote MCP, Claude apps) | Claude's tool calls | Fully free-form, via the Claude app (side button) | ✅ |
| Own voice front end (mic + STT + LLM) | Raw text → actions | Fully free-form, hands-free on the PC | Roadmap |

## 2. Shape

```
 Google Nest / Gemini ── Matter over LAN (mDNS + UDP 5540) ──┐
 archnest CLI (trigger/run) ─────────────────────────────────┤
                                                             ▼
                     adapters/matter.ts   (bridge: plug, light, momentary, lock, dimmer)
                                 │  Action + params, source
                                 ▼
          core/dispatcher → core/safety → action.run(ctx) → core/executor (sh, test, capture)
                              │ repeat + countdown + boot grace          │
                              ▼                                          ▼
                       core/notifier (notify-send + Avbryt)     Omarchy scripts / hyprctl /
                                                                pactl / playerctl / systemd
```

Rules that keep it sane:
- **Adapters only translate.** A Matter attribute change becomes `dispatch(action, "matter", params)`.
  Nothing outside `actions/` builds shell commands.
- **Every action goes through `Safety`**, whichever adapter it came from.
- **Config is validated up front** (zod + semantic checks). An unknown action, an unknown app,
  a power action on a non-button device, a forbidden passcode, or a duplicate name all stop
  startup with a clear message.
- **State flows back.** Devices with a `probe` are polled every 5 s, so Google Home shows the real
  lock state, volume, whether Spotify is open, and so on. Changes archnest makes itself are
  suppressed so they don't trigger actions.

## 3. Modules

```
src/
  cli.ts                 serve | init | pair | status | check | list | run | trigger
  config.ts              YAML schema, validation, paths, slug (stable endpoint ids, diacritics stripped)
  init.ts                config from a preset (en/sv): monitors → left/middle/right, random passcode
  pairing.ts             QR/manual code from the config; paired state from Matter storage
  resolve.ts             action refs → Action: ids, { run }, { open, screen, new }, { close }, lists
  core/
    action.ts            Action, Risk, Source, Outcome, ActionParams
    dispatcher.ts        Registry + Dispatcher
    safety.ts            repeat-confirm, countdown/cancel, boot grace
    executor.ts          sh (logged, dry-run aware), test/capture (quiet, read-only)
    notifier.ts          notify-send with a Cancel action
  actions/
    power.ts             shutdown/reboot/suspend/logout (confirm), lock, cancel
    display.ts           DPMS on/off
    system.ts            media (playerctl), volume (pactl), dnd/nightlight/stay-awake (Omarchy)
    apps.ts              open/focus/move-to-monitor/close via hyprctl
  adapters/matter.ts     bridge + per-type endpoint factories + probe loop
  adapters/connector/    Claude connector: remote MCP over Streamable HTTP (stateless)
    server.ts            express app: OAuth router, consent route, bearer-protected /mcp
    oauth.ts             single-user OAuth AS: DCR limited to Claude redirects, password consent,
                         PKCE, 1 h access tokens (memory), rotating 30-day refresh tokens
    store.ts             owner password (scrypt), clients, refresh-token hashes (0600 JSON)
    tools.ts             MCP tools → the same Dispatcher/Safety as Google Home
config.example.yaml           default config (English device names)
presets/sv.yaml               Swedish device names
docs/routines/                Google Home script-editor routines per preset
systemd/archnest.service.in   user unit template (rendered by bootstrap.sh)
bootstrap.sh                  gum installer
```

## 4. systemd service

- **A user unit, not a system unit.** Every action needs the desktop session: Hyprland IPC,
  PipeWire, D-Bus notifications. Shutdown and reboot go through logind's D-Bus API, which
  allows them for the active local user, so no root is needed.
- `WantedBy=graphical-session.target` and `PartOf=graphical-session.target`: it starts after
  Hyprland (Omarchy's uwsm exports `HYPRLAND_INSTANCE_SIGNATURE`/`WAYLAND_DISPLAY` to the user
  manager) and stops with the session, so nothing acts on a desktop that's half torn down.
- `Restart=on-failure` with a start limit (5 per 5 min), `NoNewPrivileges=yes`, and
  `MATTER_LOG_LEVEL=notice` to keep the journal readable.
- Rendered from `systemd/archnest.service.in` with absolute paths to `/usr/bin/node` (preferred
  over version-manager shims) and the checkout.

## 5. Lessons from bringing it up (keep these)

- **Pairing:** the Google Home app's generic "search for devices" only looks for Cast devices.
  Matter devices must be added via **Matter-kompatibel enhet + QR code**. The phone found the
  bridge over mDNS long before that but never connected.
- **Developer Console:** test VID `0xFFF1` / PID `0x8000`. The device type there (Outlet) didn't
  matter for a bridge.
- **ufw** on Omarchy blocks 5353/5540 by default.
- **Hyprland 0.56** switched dispatchers to Lua syntax (`hl.dsp.dpms({...})`). Old-style
  `dispatch dpms off` exits 7. Actions try the new syntax and fall back to the old.
- **"Turn off PC" = shutdown was a mistake.** Gemini matched a loose phrase to it and powered the
  machine off. That's why the repeat-confirm rule exists and power actions are restricted to
  buttons.
- **Subscriptions after restart:** the Nest hub resumes its session immediately but may take
  minutes to re-subscribe if it dropped the old subscription; devices show "offline" until then.
- **Free text never leaves Google.** Neither the Nest nor Gemini on the phone forwards your words,
  so free-form control goes through the Claude app instead (the connector). A token check must
  answer `401`, not `400`: Claude only refreshes or signs in again on a `401`.
- **Gemini wording:** device names that sound like "a program on the PC" get "I can't run
  programs on your PC". Device types Gemini knows (lock/light) and routines avoid that.

## 6. Feature research → decisions

| Idea | Mechanism | Decision |
|---|---|---|
| Lock the screen | Matter DoorLock; probe `omarchy-hyprland-session-locked` | ✅ lock only, unlock refused |
| Screens on/off | OnOffLight + Hyprland DPMS | ✅ |
| Volume / mute | DimmableLight ↔ `pactl` on `omarchy-audio-output-sink` | ✅ debounced 400 ms |
| Play/pause/next | `playerctl` (MPRIS) | ✅ plug with "is playing" probe + buttons |
| Do not disturb | `omarchy-shell notifications setDnd/isDnd` | ✅ |
| Night light | `omarchy-toggle-nightlight` (toggle-only → check state first) | ✅ |
| Keep awake | `omarchy-toggle-idle stay-awake/allow-idle/status` | ✅ |
| Open apps on a screen | launch → wait for the new window → `hl.dsp.window.move({monitor})` | ✅ focuses if already open |
| Scenes | list of safe actions | ✅ power actions not allowed in lists |
| Shutdown/reboot/sleep | momentary + repeat + countdown | ✅ |
| Spotify "play X on the PC" | Spotify Web API: follow playback started on the Nest, transfer to the PC | Phase 3 |
| Theme switching | `omarchy-theme-set <name>` via a ModeSelect device | Later: Google's Matter ModeSelect support is unverified |
| Wake the PC | Wake-on-LAN from an always-on device | Out of scope (archnest is off when the PC is) |
| Announce on the PC ("tell the computer…") | No inbound free text from Google | Not possible via Nest |
| Free-form commands | Own mic → Whisper → LLM tool calls into the registry | Phase 5 |

## 7. Roadmap

1. ✅ **Core:** registry, dispatcher, safety, executor, notifier, YAML config, CLI, tests.
2. ✅ **Matter devices:** plug, light, momentary, lock, dimmer; probes; en/sv presets; apps on
   screens; scenes; systemd user service; gum bootstrap.
3. **Spotify handoff:** `archnest spotify login` (OAuth PKCE, token in `~/.local/state`), a
   "Spotify on computer" plug that, while on, moves any playback started on the Nest to the PC's
   Spotify Connect device. Needs Premium.
4. **Faster recovery after boot:** start earlier (before the graphical session, with actions
   deferred until it's up), so the hub never sees the bridge as gone.
5. ✅ **Claude connector:** the Claude apps call archnest as a remote MCP server (Tailscale
   Funnel → localhost). Next: an optional Anthropic IP allowlist for `/mcp` and `/token`
   (`160.79.104.0/21`), and per-tool permission levels.
6. **Optional local voice front end:** local wake word + Whisper + an LLM with the registry exposed as
   tools, through a localhost HTTP adapter. The only route to truly free-form commands.
7. **Packaging:** PKGBUILD (`/usr/lib/archnest`, `archnest` in `/usr/bin`, unit in
   `/usr/lib/systemd/user`).
