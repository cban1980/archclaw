#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import { displayActions } from "./actions/display.ts";
import { powerActions } from "./actions/power.ts";
import { desktopActions, mediaActions, volumeActions } from "./actions/system.ts";
import { type Config, loadConfig, paths } from "./config.ts";
import { Dispatcher, Registry } from "./core/dispatcher.ts";
import { createExecutor } from "./core/executor.ts";
import { createLogger } from "./core/log.ts";
import { createDesktopNotifier } from "./core/notifier.ts";
import { Safety, type SafetyConfig } from "./core/safety.ts";
import { initConfig } from "./init.ts";
import { pairedFabrics, pairingCodes } from "./pairing.ts";
import { resolveRef } from "./resolve.ts";
import { SpotifyClient, SpotifyTokenStore } from "./spotify/client.ts";
import { handoffFlag, spotifyActions, spotifyEnabled, startHandoff } from "./spotify/actions.ts";

const usage = `usage: archnest <command>

  serve                          run the Matter bridge (what the systemd service runs)
  init [--preset en|sv] [--name N] [--force]
                                 create the config from your monitors, with a random pairing code
  pair                           show the QR code and pairing code for Google Home
  status                         service, pairing and config at a glance
  check                          validate the config
  list                           list built-in actions
  routines [--copy]              Google Home script-editor routines from your config's phrases
  run <action> [--dry-run]       run one action locally, with the same safety rules
  trigger <device> on|off        act as if Google Home switched a device
  spotify login [--client-id ID] log in to Spotify (for moving music from the Nest to this PC)
  spotify status                 login, Connect devices and what's playing
  spotify logout                 forget the Spotify login
  connector password             set the owner password for the Claude connector (signs everyone out)
  connector status               connector settings and connected clients
  connector revoke               sign every Claude client out
  connector enable <https-url>   turn the connector on, published at the given URL (your tunnel)
  connector disable              turn the connector off

env: ARCHNEST_CONFIG   (default ${paths.config})
     ARCHNEST_STORAGE  (default ${paths.state})
     ARCHNEST_DRY_RUN=1  log commands instead of running them
     MATTER_LOG_LEVEL    matter.js log level (debug, info, notice, warn, error)`;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = flag("--dry-run") || process.env.ARCHNEST_DRY_RUN === "1";
const VALUE_OPTIONS = new Set(["--name", "--preset", "--percent", "--client-id"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_OPTIONS.has(args[i - 1])));
const [command = "serve", ...rest] = positional;

const log = createLogger("archnest");
const spotifyStore = new SpotifyTokenStore(join(paths.state, "spotify.json"));
const spotifyClient = new SpotifyClient(spotifyStore);

/** Built-in actions, plus the ones that depend on the config (Spotify). */
function registryFor(config?: Config) {
    const registry = new Registry().add(
        ...powerActions,
        ...displayActions,
        ...mediaActions,
        ...volumeActions,
        ...desktopActions,
    );
    if (config && spotifyEnabled(config)) registry.add(...spotifyActions({ config, client: spotifyClient, statePath: paths.state }));
    return registry;
}

function tryConfig(): Config | undefined {
    try {
        return loadConfig();
    } catch {
        return undefined;
    }
}

const LOCAL_SAFETY: SafetyConfig = { countdownSeconds: 30, bootGraceSeconds: 0, repeatWindowSeconds: 0 };

function core(safetyConfig: SafetyConfig) {
    const exec = createExecutor(log, { dryRun });
    const notifier = createDesktopNotifier();
    const safety = new Safety(safetyConfig, notifier, log);
    return { exec, notifier, safety, dispatcher: new Dispatcher(safety, exec, log) };
}

const connectorStorePath = () => join(paths.state, "connector.json");

/** Reads a line from the terminal without echoing it (falls back to plain stdin when piped). */
async function readSecret(prompt: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
        process.stdout.write(prompt);
        // Mute everything the readline interface would echo back.
        (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }
    const line: string = await new Promise(resolve => rl.once("line", resolve));
    rl.close();
    if (process.stdin.isTTY) process.stdout.write("\n");
    return line;
}

function sh(cmd: string, argv: string[]): string {
    try {
        return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (err) {
        return ((err as { stdout?: string }).stdout ?? "").trim();
    }
}

async function main() {
    switch (command) {
        case "serve": {
            const config = loadConfig();
            const registry = registryFor(config);
            const { dispatcher, exec, notifier } = core(config.safety);
            if (dryRun) log.warn("dry-run: commands will be logged, not run");
            if (spotifyEnabled(config)) {
                startHandoff({ config, client: spotifyClient, statePath: paths.state, log, ctx: { exec, log, cancelPending: () => 0 } });
            }
            const { startMatter } = await import("./adapters/matter.ts");
            await startMatter({ config, registry, dispatcher, exec, log }, paths.state);
            if (config.connector.enabled) {
                // A broken connector must not take the Google Home bridge down with it.
                try {
                    const { startConnector } = await import("./adapters/connector/server.ts");
                    const { ConnectorStore } = await import("./adapters/connector/store.ts");
                    await startConnector({ config, registry, dispatcher, exec, log, notifier, store: new ConnectorStore(connectorStorePath()) });
                } catch (err) {
                    log.error(`connector not started: ${(err as Error).message}`);
                }
            }
            return;
        }
        case "init": {
            let monitors: Array<{ name: string; x: number }> = [];
            try {
                monitors = JSON.parse(sh("hyprctl", ["monitors", "-j"]) || "[]");
            } catch {
                log.warn("could not read monitors from hyprctl; screens left as in the example");
            }
            const preset = option("--preset") ?? "en";
            const presets: Record<string, string> = { en: "../config.example.yaml", sv: "../presets/sv.yaml" };
            if (!presets[preset]) throw new Error(`unknown preset ${preset}; choose ${Object.keys(presets).join(" or ")}`);
            const { detectApps } = await import("./init.ts");
            const result = initConfig({
                examplePath: fileURLToPath(new URL(presets[preset], import.meta.url)),
                target: paths.config,
                name: option("--name"),
                monitors,
                apps: detectApps(sh),
                force: flag("--force"),
            });
            if (!result.written) {
                console.log(`${paths.config} already exists; kept it (use --force to replace)`);
                return;
            }
            console.log(`wrote ${paths.config}`);
            for (const [label, monitor] of Object.entries(result.screens)) console.log(`  screen ${label} = ${monitor}`);
            for (const [key, app] of Object.entries(result.apps)) console.log(`  app ${key} = ${app.launch} (window: ${app.match})`);
            return;
        }
        case "pair": {
            const config = loadConfig();
            const { qr, manualFormatted } = pairingCodes(config);
            const paired = pairedFabrics(paths.state);
            if (paired) console.log(`Already paired with ${paired} controller(s). New controllers need a fresh pairing window.\n`);
            const art = sh("qrencode", ["-t", "ansiutf8", qr]);
            if (art) console.log(art);
            console.log(`Pairing code: ${manualFormatted}`);
            console.log(`QR payload:   ${qr}`);
            return;
        }
        case "status": {
            const active = sh("systemctl", ["--user", "is-active", "archnest.service"]) || "unknown";
            const enabled = sh("systemctl", ["--user", "is-enabled", "archnest.service"]) || "not installed";
            let configLine: string;
            try {
                configLine = `OK, ${loadConfig().devices.length} devices`;
            } catch (err) {
                configLine = (err as Error).message.split("\n")[0];
            }
            console.log(`service:  ${active} (${enabled})`);
            console.log(`paired:   ${pairedFabrics(paths.state) ? "yes" : "no - run `archnest pair`"}`);
            console.log(`config:   ${paths.config}: ${configLine}`);
            console.log(`logs:     journalctl --user -u archnest -f`);
            return;
        }
        case "run": {
            const id = rest[0];
            if (!id) throw new Error("run needs an action id; see `archnest list`");
            const action = registryFor(tryConfig()).get(id);
            if (!action) throw new Error(`unknown action ${id}; see \`archnest list\``);
            const percent = option("--percent");
            const { dispatcher } = core(LOCAL_SAFETY);
            const outcome = await dispatcher.dispatch(action, "cli", percent ? { percent: Number(percent) } : undefined);
            log.info(`${id}: ${outcome}`);
            process.exitCode = outcome === "ran" ? 0 : 1;
            return;
        }
        case "trigger": {
            const [name, state] = rest;
            if (!name || (state !== "on" && state !== "off")) throw new Error("usage: archnest trigger <device> on|off");
            const config = loadConfig();
            const dev = config.devices.find(d => d.name.toLowerCase() === name.toLowerCase());
            if (!dev) throw new Error(`no device "${name}"; devices: ${config.devices.map(d => d.name).join(", ")}`);
            const ref = state === "on" ? dev.on : dev.off;
            if (!ref) throw new Error(`"${dev.name}" has no ${state} action`);
            const { dispatcher } = core({ ...config.safety, bootGraceSeconds: 0, repeatWindowSeconds: 0 });
            const outcome = await dispatcher.dispatch(resolveRef(ref, registryFor(config), config), "cli");
            log.info(`${dev.name} ${state}: ${outcome}`);
            process.exitCode = outcome === "ran" ? 0 : 1;
            return;
        }
        case "connector": {
            const { ConnectorStore } = await import("./adapters/connector/store.ts");
            const store = new ConnectorStore(connectorStorePath());
            const sub = rest[0] ?? "status";
            if (sub === "password") {
                const pw = await readSecret("New owner password (10+ characters): ");
                if (process.stdin.isTTY && (await readSecret("Repeat: ")) !== pw) throw new Error("passwords don't match");
                store.setPassword(pw);
                console.log("Saved. Connected Claude clients were signed out; restart the service: systemctl --user restart archnest");
            } else if (sub === "revoke") {
                store.revokeAll();
                console.log("Signed every Claude client out. Restart the service to drop live access tokens: systemctl --user restart archnest");
            } else if (sub === "status") {
                const c = loadConfig().connector;
                console.log(`enabled:   ${c.enabled}`);
                console.log(`url:       ${c.publicUrl ? `${c.publicUrl.replace(/\/$/, "")}/mcp` : "(connector.publicUrl not set)"}`);
                console.log(`local:     http://127.0.0.1:${c.port}`);
                console.log(`password:  ${store.hasPassword ? "set" : "not set - run `archnest connector password`"}`);
                console.log(`clients:   ${store.connectedClients} signed in`);
            } else if (sub === "enable" || sub === "disable") {
                const doc = parseDocument(readFileSync(paths.config, "utf8"));
                if (sub === "enable") {
                    const url = rest[1];
                    if (!url?.startsWith("https://")) throw new Error("usage: archnest connector enable https://<your public host>");
                    doc.setIn(["connector", "publicUrl"], url.replace(/\/+$/, ""));
                }
                doc.setIn(["connector", "enabled"], sub === "enable");
                writeFileSync(paths.config, doc.toString());
                loadConfig(); // validate before telling the user it worked
                console.log(`connector ${sub}d in ${paths.config}; apply with: systemctl --user restart archnest`);
            } else throw new Error("usage: archnest connector password|status|revoke|enable <url>|disable");
            return;
        }
        case "spotify": {
            const sub = rest[0] ?? "status";
            if (sub === "login") {
                const config = loadConfig();
                const clientId = option("--client-id") ?? config.spotify.clientId;
                if (!clientId) {
                    throw new Error(
                        "no Spotify client ID. Create an app at https://developer.spotify.com/dashboard (Web API, redirect URI " +
                            "http://127.0.0.1:8898/callback), then run: archnest spotify login --client-id <ID>",
                    );
                }
                if (clientId !== config.spotify.clientId) {
                    const doc = parseDocument(readFileSync(paths.config, "utf8"));
                    doc.setIn(["spotify", "clientId"], clientId);
                    writeFileSync(paths.config, doc.toString());
                }
                const { spotifyLogin } = await import("./spotify/login.ts");
                await spotifyLogin(clientId, spotifyStore, url => {
                    try {
                        execFileSync("xdg-open", [url], { stdio: "ignore" });
                    } catch {}
                });
                const pc = (await spotifyClient.devices()).map(d => `${d.name} (${d.type})`).join(", ");
                console.log(`Logged in. Spotify Connect devices right now: ${pc || "none (open Spotify somewhere)"}`);
                console.log("Restart the service to pick it up: systemctl --user restart archnest");
            } else if (sub === "logout") {
                spotifyStore.clear();
                console.log("Forgot the Spotify login. Also remove archnest at https://www.spotify.com/account/apps/ if you like.");
            } else if (sub === "status") {
                const config = loadConfig();
                console.log(`client id: ${config.spotify.clientId ?? "(not set)"}`);
                console.log(`logged in: ${spotifyClient.loggedIn ? "yes" : "no - run `archnest spotify login`"}`);
                console.log(`handoff:   ${existsSync(handoffFlag(paths.state)) ? "on" : "off"}`);
                if (spotifyClient.loggedIn) {
                    const { isThisPc } = await import("./spotify/actions.ts");
                    for (const d of await spotifyClient.devices()) {
                        console.log(`device:    ${d.name} (${d.type})${isThisPc(d, config) ? "  <- this PC" : ""}${d.is_active ? "  [active]" : ""}`);
                    }
                    const pb = await spotifyClient.playback();
                    console.log(`playing:   ${pb?.is_playing ? `${pb.item?.name ?? "?"} on ${pb.device?.name}` : "nothing"}`);
                }
            } else throw new Error("usage: archnest spotify login|status|logout");
            return;
        }
        case "routines": {
            const { generateRoutines } = await import("./routines.ts");
            const yaml = generateRoutines(loadConfig());
            if (flag("--copy")) {
                execFileSync("wl-copy", [], { input: yaml });
                console.error("Copied. Paste it at home.google.com → Automations → Add new → Script editor.");
            } else process.stdout.write(yaml);
            return;
        }
        case "list":
            for (const a of registryFor(tryConfig()).list()) console.log(`${a.id.padEnd(20)} ${a.risk.padEnd(8)} ${a.title}`);
            return;
        case "check": {
            const config = loadConfig();
            const registry = registryFor(config);
            for (const d of config.devices) {
                if (d.on) resolveRef(d.on, registry, config);
                if (d.off) resolveRef(d.off, registry, config);
                if (d.level) registry.resolve(d.level);
            }
            console.log(`${paths.config}: OK, ${config.devices.length} devices`);
            return;
        }
        case "help":
        case "-h":
            console.log(usage);
            return;
        default:
            throw new Error(`unknown command ${command}\n\n${usage}`);
    }
}

if (flag("--help")) console.log(usage);
else
    main().catch(err => {
        log.error((err as Error).message);
        process.exit(1);
    });
