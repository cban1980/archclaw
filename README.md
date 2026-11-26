# archnest

Control an Arch/Omarchy PC with Google Home / Nest. archnest runs as a systemd user
service and shows up in Google Home as a **Matter bridge** with devices that Gemini
understands natively:

> "Hey Google, lock the computer" · "turn off the screens" · "set computer volume to 30 percent" ·
> "time to work" (Edge left, terminal in the middle, Spotify right) · "shut down the computer"

The Google Home part runs entirely on your LAN, with no cloud service and no port forwarding.
The optional [Claude connector](#claude-connector-free-form-commands-from-the-claude-app) adds
free-form control from the Claude app.

## Install

```sh
git clone <this repo> ~/Work/archnest
cd ~/Work/archnest
./bootstrap.sh
```

The bootstrap is an interactive (gum) installer that is safe to re-run. It:

1. checks the system (Arch, Hyprland, Omarchy, Node ≥ 22.18)
2. installs missing tools: `gum qrencode jq playerctl libpulse` (+ `nodejs npm` if needed)
3. runs `npm ci`
4. creates `~/.config/archnest/config.yaml` from your monitors, with a random pairing passcode.
   Device names come in **English** or **Swedish** (`presets/sv.yaml`); the installer asks which.
5. opens 5353/udp (mDNS) and 5540/udp (Matter) in ufw, if ufw is active
6. installs and starts `archnest.service` (systemd user unit, starts with the desktop)
7. installs the `archnest` command in `~/.local/bin`
8. shows the pairing QR code if Google Home isn't paired yet

`./bootstrap.sh --uninstall` removes the service and the command. It keeps your config
and pairing.

### Pairing with Google Home (once)

archnest is an uncertified Matter device, so Google needs to know about it first:

1. <https://console.home.google.com> → create a project → **Matter → Add integration**,
   with **Test VID `0xFFF1`** and **Product ID `0x8000`**. Use the same Google account as the app.
2. Google Home app → **+ → Add device → Matter-enabled device** → scan the QR code
   from `archnest pair`, then choose **Set up anyway** at the "uncertified" warning.
   Use the QR code, not the generic device search: the search only looks for Cast devices.
3. Put the devices in a room. Then paste `docs/routines/google-home.<en|sv>.yaml` into the
   script editor at home.google.com (Automations → Add new → Script editor) for natural
   phrases. Fix the room name in the file first (`<device> - <room>`).

## Devices

Default names (English preset). The Swedish preset has the same devices, e.g. *Datorn*,
*Skärmarna*, *Datorns volym*, *Arbetsläge*.

| Device (type) | Say | Does |
|---|---|---|
| **Computer** (lock) | "lock the computer" | `omarchy-system-lock`. Shows the real lock state. **Remote unlock is always refused.** |
| **Screens** (light) | "turn off/on the screens" | DPMS off/on (Hyprland 0.56 syntax with fallback) |
| **Computer volume** (dimmer) | "set computer volume to 30 percent" | `pactl` on Omarchy's output sink; on/off = unmute/mute |
| **Computer music** (plug) | "turn on/off computer music" | on: plays Spotify, starting it on the right-hand screen if needed; off: pauses everything. Shows whether something is playing |
| **Next / Previous track on computer** | via routines | `playerctl next/previous` |
| **Do not disturb**, **Night light**, **Keep computer awake** (plugs) | "turn on do not disturb" | Omarchy's toggles, with live state |
| **Spotify app** (plug) | "open spotify on the computer" (routine) | opens Spotify on the right-hand screen, or closes it |
| **Browser**, **New terminal** | "open the browser" (routine) | Edge on the left, a new terminal in the middle |
| **Work mode** (scene) | "time to work" (routine) | all three at once, each on its own screen |
| **Computer shutdown / restart / sleep** | "shut down the computer" (routine) | see Safety |
| **Cancel shutdown** | "cancel the shutdown" (routine) | cancels a pending power action |

Everything is configured in `~/.config/archnest/config.yaml`: names, screens, apps, scenes
and your own shell commands. Run `archnest check` after editing, then
`systemctl --user restart archnest`.

### Safety

Voice assistants mishear things, so power actions have three layers:

1. **Said twice:** from Google Home, the same power command has to arrive twice within 60 s,
   at least 3 s apart. The first one only shows a notification.
2. **Countdown:** a critical notification counts down 30 s, with a **Cancel** button.
   The *Cancel shutdown* device or a new power command also stops it.
3. **Buttons only:** power actions are only allowed on `momentary` devices, so no
   "turn off …" or "turn off all lights" can ever power the machine down. Scenes can't contain
   them either.

On top of that, power commands are ignored for the first 2 minutes after boot, and the lock
device refuses remote unlocking.

## Claude connector (free-form commands from the Claude app)

Google Home only passes typed device commands to archnest, never your words. For anything
free-form, archnest can also act as a **remote MCP server** that the Claude apps call. This
works with a normal Claude subscription; no API account or key is needed:

> *(side button → Claude)* "Open Spotify on the middle screen, turn the volume down to 20 and
> close the browser"

```
Claude app ──▶ Anthropic cloud ──https──▶ Tailscale Funnel ──▶ 127.0.0.1:8765 (archnest) ──▶ actions
```

**Set up:** run `./bootstrap.sh` and answer yes at *Claude connector*. It asks for an owner
password, installs and signs in to Tailscale, publishes the connector with Funnel, and prints
the URL. Then, in Claude: **Settings → Connectors → Add custom connector**, use URL
`https://<your-pc>.<tailnet>.ts.net/mcp`, and sign in with the owner password. Connectors added
on claude.ai are available in the mobile apps too. To use Claude by voice from the side button,
set Claude as the phone's **digital assistant app**. A "Hey Claude" wake word isn't possible on
Android today.

**Tools Claude gets:** `get_status`, `list_capabilities`, `run_action` (any built-in action, e.g.
`volume.set`), `open_app` / `close_app` (on a named screen), `switch_device` (any Google Home
device, including scenes).

**Security:**
- It listens on `127.0.0.1` only; the tunnel is the only way in.
- OAuth 2.1 with PKCE. Only Claude's redirect URIs may register.
- Sign-in requires the owner password: scrypt-hashed, with a lockout after 5 wrong attempts
  (15 min), and a desktop notification when a client connects.
- Access tokens last 1 h and live only in memory. Refresh tokens last 30 days, rotate on every
  use, and are stored only as hashes in `~/.local/state/archnest/connector.json` (mode 600).
- No free shell access: Claude only gets archnest's actions. Power actions still show the 30 s
  countdown with **Cancel**.

`archnest connector status | password | revoke | enable <url> | disable`

## Commands

```
archnest status                 service, pairing, config
archnest pair                   QR + pairing code
archnest trigger <device> on    act as if Google Home switched a device
archnest run volume.set --percent 30
archnest list                   built-in actions
archnest check                  validate the config
journalctl --user -u archnest -f
```

## Development

```sh
npm test            # unit tests (node --test, TypeScript runs natively)
npm run typecheck
ARCHNEST_CONFIG=config.example.yaml node src/cli.ts serve --dry-run
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the research behind it,
and the roadmap.
