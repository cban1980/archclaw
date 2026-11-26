# archnest

Control your Arch/Omarchy PC by voice with Google Home and Nest speakers.

archnest runs as a systemd user service and shows up in Google Home as a **Matter bridge**.
Its devices are types that Gemini already understands, so most commands work without any
setup in Google:

> "Hey Google, lock the computer" · "turn off the screens" · "set computer volume to 30 percent" ·
> "time to work" (browser left, terminal in the middle, Spotify right) ·
> "play The Weeknd on Spotify" → it plays on the PC · "shut down the computer"

Everything runs on your LAN, with no cloud service and no port forwarding. Device names
come in English or Swedish, and you can add your own devices, apps, scenes and phrases.

**Requirements:** Arch Linux with [Omarchy](https://omarchy.org) (Hyprland) · Node ≥ 22.18 ·
a Google Home/Nest speaker or display (a Matter controller) · the Google Home app.

## Install

```sh
git clone https://github.com/cban1980/archnest ~/.local/share/archnest
cd ~/.local/share/archnest
./bootstrap.sh
```

The installer is interactive and safe to re-run. It:

1. checks the system and installs what's missing (`gum qrencode jq playerctl libpulse wl-clipboard`)
2. creates `~/.config/archnest/config.yaml` from your monitors, default browser and
   terminal, with a random pairing code. You choose English or Swedish device names.
3. opens mDNS (5353/udp) and Matter (5540/udp) in ufw, if ufw is active
4. installs and starts `archnest.service` and the `archnest` command
5. shows the pairing QR code, then walks you through rooms, voice phrases, Spotify and
   (optionally) the Claude connector

`./bootstrap.sh --uninstall` removes the service and the command, and keeps your config and pairing.

## Set up Google Home (once)

archnest is an uncertified Matter device, so Google needs to know about it first.

1. **Register a test product:** at <https://console.home.google.com>, create a project and choose
   **Matter → Add integration** with **Test VID `0xFFF1`** and **Product ID `0x8000`**. Use the same
   Google account as the Home app.
2. **Pair:** in the Google Home app, choose **+ → Add device → Matter-enabled device**, scan the
   QR code from `archnest pair`, and pick **Set up anyway** at the "uncertified" warning. Use the
   QR code; the generic "search for devices" only finds Cast devices.
3. **Put every archnest device in a room.** Use one room for all of them, e.g. *Desk*
   (*Datorhörnan* in the Swedish preset); `room:` in the config says which. Do it in the app:
   device → settings → Room → add a custom room.
   - Until a device has a room, Gemini answers *"configure your devices in Google Home"*.
   - A room of their own keeps "turn off the lights in the living room" from switching off
     your screens or muting the PC.
4. **Add the voice phrases:**
   1. Run `archnest routines --copy`.
   2. Go to <https://home.google.com> → **Automations → Add new → Script editor**.
   3. Paste, then click **Validate** (warnings about switches are normal), **Save** and **Activate**.

   Run it again and replace the script whenever you change phrases in the config.

## What you can say

The English preset is shown; the Swedish one has the same devices (*Datorn*, *Skärmarna*,
*Datorns volym*, *Arbetsläge*, …).

| Device (type) | Say | Does |
|---|---|---|
| **Computer** (lock) | "lock the computer" | locks the screen; shows the real lock state; **remote unlock is always refused** |
| **Screens** (light) | "turn off/on the screens" | DPMS off/on |
| **Computer volume** (dimmer) | "set computer volume to 30 percent", "mute the computer" | output volume; on/off = unmute/mute |
| **Computer music** (plug) | "play/pause the music on the computer" | plays Spotify here (takes over from the Nest, or starts Spotify); off pauses everything |
| **Music to computer** (plug) | "turn on music to computer" | while on, Spotify you start on the Nest moves to the PC |
| **Next / Previous track on computer** | "next song on the computer" | `playerctl next/previous` |
| **Do not disturb**, **Night light**, **Keep computer awake** | "turn on do not disturb" | Omarchy's toggles, with live state |
| **Spotify app** (plug) | "open/close spotify on the computer" | on the right-hand screen |
| **Browser**, **New terminal** | "open the browser", "open a terminal" | left and middle screen |
| **Work mode** (scene) | "time to work" | all three at once, each on its own screen |
| **Computer shutdown / restart / sleep** | "shut down the computer" | see [Safety](#safety) |
| **Cancel shutdown** | "cancel the shutdown" | cancels a pending power action |
| (routine) | "I'm done with the computer" | closes Spotify, locks, turns off the screens |

Phrases with "on the computer" come from routines (step 4); the rest work directly.

## Make it yours

Everything lives in `~/.config/archnest/config.yaml`. After editing, run `archnest check`, then
`systemctl --user restart archnest`.

```yaml
apps:
  discord:
    launch: omarchy-launch-webapp https://discord.com/channels/@me
    match: discord                      # window class or title (whole word)

devices:
  - name: Gaming mode                   # what you say: "turn on gaming mode"
    type: plug                          # plug, light, dimmer, lock, momentary (button)
    on:                                 # a list runs in order (a scene)
      - { open: discord, screen: left }
      - { play: spotify, screen: right }  # start Spotify there and play
      - dnd.on
    off:
      - { close: discord }
      - dnd.off
    probe: hyprctl clients -j | jq -e 'any(.[]; .class | test("discord"))' >/dev/null
    phrases:                            # extra phrases → `archnest routines`
      on: ["let's play"]
      off: ["done playing"]
```

- **Actions:**
  - built-in ids (see `archnest list`)
  - `{ run: "any shell command" }`
  - `{ open: app, screen: left, new: true }`, `{ close: app }`, `{ play: app, screen: right }`
  - a list of these, run in order
- **`probe`:** a command archnest polls every 5 s (exit 0 = on), so Google Home shows the real state.
- **`routines:`** at the top level: phrases that switch several devices at once.
- **New devices:** they appear in Google Home within a minute of the restart. **Give each one the
  room**, then regenerate the routines.

## Spotify: "play X" from the Nest, on the PC

Google never passes the song or artist to archnest, but it can play anything on Spotify on the
Nest. archnest then moves that playback to the PC with Spotify Connect.

> "Hey Google, play Blinding Lights on Spotify" → with *Music to computer* on, it plays on the PC
> a few seconds later. Or say it, then "play the music on the computer".

It needs Spotify Premium (Spotify's rule for API apps). The installer sets it up, or do it by hand:

1. Go to <https://developer.spotify.com/dashboard> and choose **Create app**. Give it any name, the
   redirect URI `http://127.0.0.1:8898/callback`, and the API **Web API**. Copy the **Client ID**;
   no secret is used.
2. Run `archnest spotify login --client-id <ID>` and approve in the browser.
3. Run `systemctl --user restart archnest`, then `archnest spotify status`.

The refresh token stays in `~/.local/state/archnest/spotify.json` (mode 600). Handoff mode polls
Spotify only while it's on, and never takes playback from phones or other computers.

## Safety

Voice assistants mishear things, so power actions have several layers:

1. **Said twice:** from Google Home, the same power command must arrive twice within 60 s, at
   least 3 s apart. The first one only shows a notification.
2. **Countdown:** a notification counts down 30 s, with a **Cancel** button. *Cancel shutdown*
   or a new power command also stops it.
3. **Buttons only:** power actions are only allowed on `momentary` devices, and never in scenes,
   so no "turn off …" or "turn off all lights" can power the machine down.
4. **Boot grace:** power commands are ignored for the first 2 minutes after boot.
5. **No remote unlock:** the lock device refuses unlocking.

## Commands

```
archnest status                 service, pairing, config
archnest pair                   QR + pairing code
archnest routines [--copy]      Google Home script-editor routines from your phrases
archnest list                   built-in actions
archnest run volume.set --percent 30
archnest trigger <device> on    act as if Google Home switched a device
archnest check                  validate the config
archnest spotify login|status|logout
journalctl --user -u archnest -f
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| The phone keeps "looking for a Matter device" | Firewall: open 5353/udp and 5540/udp. Phone and PC must be on the same network. |
| "Configure your devices in Google Home" | The device has no room. Put it in the archnest room. |
| A device shows "offline" right after a restart | The hub re-subscribes within a few minutes. |
| "Computer (2)" in Google Home | The bridge and a device share a name. `archnest check` refuses this now. |
| Gemini says "I can't run programs on your PC" | Use device names and phrases from the config, not "run …"/"start the program …". |
| A command arrives but nothing happens | Run `journalctl --user -u archnest -f` while you say it. |

## Claude connector (optional, advanced)

archnest can also act as a remote MCP server for the Claude apps, for free-form commands such as
"open Spotify on the middle screen and turn the volume down". It needs a public https address
(the installer can use Tailscale Funnel) and is off by default. It is protected by OAuth, an
owner password and Claude-only redirect URIs. See `archnest connector status` and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```sh
npm ci
npm test            # node --test, TypeScript runs natively (no build step)
npm run typecheck
ARCHNEST_CONFIG=config.example.yaml node src/cli.ts serve --dry-run
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the design, the research behind it and the
roadmap.

## License

Public domain ([Unlicense](LICENSE)).
