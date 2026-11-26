# archnest

Control an Arch/Omarchy PC with Google Home / Nest. archnest runs as a systemd user
service and shows up in Google Home as a **Matter bridge** with devices that Gemini
understands natively:

> "Hey Google, lock the computer" · "turn off the screens" · "set computer volume to 30 percent" ·
> "time to work" (Edge left, terminal in the middle, Spotify right) · "shut down the computer"

Everything runs on your LAN. No cloud service, no port forwarding.

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
| **Computer music** (plug) | "turn off computer music" | `playerctl`; shows whether something is playing |
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
