# archclaw: architecture

## Shape

```
 Claude (phone/desktop/web, Anthropic's cloud)
        │ https: OAuth 2.1 (DCR + PKCE) and MCP over Streamable HTTP
        ▼
 Cloudflare Tunnel ──► 127.0.0.1:8765  adapters/connector (express)
                                          │ oauth.ts: Claude-only registration, owner-password consent
                                          │ tools.ts: MCP tools, rebuilt from the live config per request
                                          ▼
          core/dispatcher → core/safety → action.run(ctx) → core/executor (sh, test, capture)
                              │ countdown + boot grace                   │
                              ▼                                          ▼
                       core/notifier (notify-send + Cancel)     Omarchy scripts / hyprctl /
                                                                pactl / playerctl / systemd
 archclaw CLI (run, scene, …) ─► the same dispatcher
 config-store.ts ◄── Claude's setup tools (validated edits, history, undo) and hand edits (file watch)
```

Rules that keep it sane:

- **Claude never writes shell.** Tools take app keys, screen names, action ids, desktop entry ids
  and https URLs; archclaw builds the commands. `{ run: … }` steps and custom `launch:` commands
  exist only in hand-written config, and Claude's tools refuse to overwrite them.
- **Every action goes through `Safety`**: power actions get a cancellable countdown and are
  refused right after boot; they can't hide inside scenes.
- **The config is the single source of truth** and stays human-readable: edits go through
  `ConfigStore`, which validates the result, keeps comments (yaml `Document`), writes atomically,
  and saves the previous version to `config-history/` for `undo_config_change`.
- **Stateless MCP.** Each request builds a fresh `McpServer` with tools and instructions from the
  current config, so a scene Claude just saved is usable on the next call, with no restart.

## Modules

```
src/
  cli.ts                 serve | init | status | check | list | run | scene | connector | spotify
  config.ts              YAML schema (zod), semantic checks, scene lookup by name/alias (accent-insensitive)
  config-store.ts        live config + validated edits (apps, scenes, screens, notes), history, undo
  status.ts              computer snapshot for get_status: lock, screens, volume, media, windows, scenes
  desktop-apps.ts        installed .desktop entries → safe launch commands; web app URLs
  init.ts                config from the example: monitors → left/middle/right, default browser/terminal
  resolve.ts             action refs → Action: ids, { run }, { open, screen, new }, { close }, { play, screen }, lists
  core/                  action types, dispatcher/registry, safety, executor, notifier, log
  actions/               power, display, media/volume/desktop toggles, apps (open/focus/move/close via hyprctl)
  spotify/               PKCE login, Web API client (player, search, playlists), spotify.here, handoff loop
  adapters/connector/
    server.ts            express app: OAuth router, consent route, bearer-protected /mcp
    oauth.ts             single-user OAuth AS: DCR limited to Claude redirects, password consent,
                         PKCE, 1 h access tokens (memory), rotating 30-day refresh tokens
    store.ts             owner password (scrypt), clients, refresh-token hashes (0600 JSON)
    tools.ts             the MCP tools and the server instructions Claude gets
```

## Why not Google Home

This project started as **archnest**, a Matter bridge for Google Home/Nest. It worked, but:

- Gemini never passes your words to third-party code, only device commands, so every custom
  phrase needed a hand-maintained routine (household script) that only matched exact text.
- Gemini's speech recognition turned made-up names into other words ("Mirc", "Mirk"), took
  "chattläge" as its own chat mode, and renaming a Matter device created a new device without a
  room, which Gemini then refused to control.

A Claude connector receives the request as Claude understands it and maps it to tools, in any
language, and Claude can change the setup itself. The cost is a public https endpoint, which the
tunnel and the OAuth layer handle.

## Testing

`npm test` runs node's test runner on TypeScript directly: config and config-store edits, desktop
entry parsing, safety (countdown, cancel, boot grace), app helpers, Spotify handoff decisions, and
a full OAuth + MCP flow against the real express app (registration, consent, PKCE, refresh
rotation, tools, scene by alias, Claude editing and undoing the config).
