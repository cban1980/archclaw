#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import { displayActions } from "./actions/display.ts";
import { powerActions } from "./actions/power.ts";
import { desktopActions, mediaActions, volumeActions } from "./actions/system.ts";
import { type Config, findScene, loadConfig, paths } from "./config.ts";
import { ConfigStore } from "./config-store.ts";
import { Dispatcher, Registry } from "./core/dispatcher.ts";
import { createExecutor } from "./core/executor.ts";
import { createLogger } from "./core/log.ts";
import { createDesktopNotifier } from "./core/notifier.ts";
import { Safety, type SafetyConfig } from "./core/safety.ts";
import { initConfig } from "./init.ts";
import { resolveRef } from "./resolve.ts";
import { SpotifyClient, SpotifyTokenStore } from "./spotify/client.ts";
import { handoffFlag, spotifyActions, spotifyEnabled, startHandoff } from "./spotify/actions.ts";

const usage = `usage: archclaw <command>

  serve                          run archclaw (what the systemd service runs): the Claude connector
  init [--name N] [--force]      create the config from your monitors and default apps
  status                         service, connector and config at a glance
  check                          validate the config
  list                           list built-in actions
  run <action> [--percent N]     run one action locally, with the same safety rules
  scene <name> start|stop        start or stop a scene (by name or alias)
  connector password             set the owner password Claude signs in with (signs everyone out)
  connector url <https-url>      the public address your tunnel publishes
  connector status               address, password and connected Claude clients
  connector revoke               sign every Claude client out
  spotify login [--client-id ID] log in to Spotify (play anything on this PC from Claude)
  spotify status                 login, Connect devices and what's playing
  spotify logout                 forget the Spotify login

env: ARCHCLAW_CONFIG   (default ${paths.config})
     ARCHCLAW_STORAGE  (default ${paths.state})
     ARCHCLAW_DRY_RUN=1  log commands instead of running them`;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = flag("--dry-run") || process.env.ARCHCLAW_DRY_RUN === "1";
const VALUE_OPTIONS = new Set(["--name", "--percent", "--client-id"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_OPTIONS.has(args[i - 1])));
const [command = "serve", ...rest] = positional;

const log = createLogger("archclaw");
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

const LOCAL_SAFETY: SafetyConfig = { countdownSeconds: 30, bootGraceSeconds: 0 };

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
            const store = new ConfigStore(paths.config, paths.state);
            const config = store.config;
            const registry = registryFor(config);
            const { dispatcher, exec, notifier, safety } = core(config.safety);
            if (dryRun) log.warn("dry-run: commands will be logged, not run");
            if (spotifyEnabled(config)) {
                startHandoff({ config, client: spotifyClient, statePath: paths.state, log, ctx: { exec, log, cancelPending: () => 0 } });
            }
            // Hand edits apply without a restart; an invalid file keeps the last good config.
            let timer: ReturnType<typeof setTimeout> | undefined;
            watch(paths.config, () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    try {
                        store.reload();
                        log.info("config reloaded");
                    } catch (err) {
                        log.error(`config not reloaded: ${(err as Error).message}`);
                        notifier.info("archclaw: config has an error", (err as Error).message.split("\n").slice(0, 3).join("\n"));
                    }
                }, 300);
            });
            const { ConnectorStore } = await import("./adapters/connector/store.ts");
            const auth = new ConnectorStore(connectorStorePath());
            if (!config.connector.publicUrl || !auth.hasPassword) {
                log.warn("the Claude connector isn't set up yet: run `archclaw connector password` and `archclaw connector url https://…`");
                return;
            }
            const { startConnector } = await import("./adapters/connector/server.ts");
            await startConnector({ store, registry, dispatcher, exec, safety, spotify: spotifyEnabled(config) ? spotifyClient : undefined, log, notifier, auth });
            return;
        }
        case "init": {
            let monitors: Array<{ name: string; x: number }> = [];
            try {
                monitors = JSON.parse(sh("hyprctl", ["monitors", "-j"]) || "[]");
            } catch {
                log.warn("could not read monitors from hyprctl; screens left as in the example");
            }
            const { detectApps } = await import("./init.ts");
            const result = initConfig({
                examplePath: fileURLToPath(new URL("../config.example.yaml", import.meta.url)),
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
        case "status": {
            const active = sh("systemctl", ["--user", "is-active", "archclaw.service"]) || "unknown";
            const enabled = sh("systemctl", ["--user", "is-enabled", "archclaw.service"]) || "not installed";
            const tunnel = sh("systemctl", ["--user", "is-active", "archclaw-tunnel.service"]) || "not installed";
            let configLine: string;
            let url = "(not set - archclaw connector url https://…)";
            try {
                const c = loadConfig();
                configLine = `OK, ${Object.keys(c.apps).length} apps, ${c.scenes.length} scenes`;
                if (c.connector.publicUrl) url = `${c.connector.publicUrl.replace(/\/$/, "")}/mcp`;
            } catch (err) {
                configLine = (err as Error).message.split("\n")[0]!;
            }
            const { ConnectorStore } = await import("./adapters/connector/store.ts");
            const auth = new ConnectorStore(connectorStorePath());
            console.log(`service:   ${active} (${enabled})`);
            console.log(`tunnel:    ${tunnel}`);
            console.log(`connector: ${url}`);
            console.log(`password:  ${auth.hasPassword ? "set" : "not set - run `archclaw connector password`"}`);
            console.log(`claude:    ${auth.connectedClients} client(s) signed in`);
            console.log(`spotify:   ${spotifyClient.loggedIn ? "logged in" : "not logged in (optional: archclaw spotify login)"}`);
            console.log(`config:    ${paths.config}: ${configLine}`);
            console.log(`logs:      journalctl --user -u archclaw -f`);
            return;
        }
        case "run": {
            const id = rest[0];
            if (!id) throw new Error("run needs an action id; see `archclaw list`");
            const action = registryFor(tryConfig()).get(id);
            if (!action) throw new Error(`unknown action ${id}; see \`archclaw list\``);
            const percent = option("--percent");
            const { dispatcher } = core(LOCAL_SAFETY);
            const outcome = await dispatcher.dispatch(action, "cli", percent ? { percent: Number(percent) } : undefined);
            log.info(`${id}: ${outcome}`);
            process.exitCode = outcome === "ran" ? 0 : 1;
            return;
        }
        case "scene": {
            const [name, state] = rest;
            if (!name || (state !== "start" && state !== "stop")) throw new Error("usage: archclaw scene <name> start|stop");
            const config = loadConfig();
            const scene = findScene(config, name);
            if (!scene) throw new Error(`no scene "${name}"; scenes: ${config.scenes.map(s => s.name).join(", ") || "none"}`);
            const ref = state === "start" ? scene.start : scene.stop;
            if (!ref) throw new Error(`scene "${scene.name}" has no stop steps`);
            const { dispatcher } = core({ ...config.safety, bootGraceSeconds: 0 });
            const outcome = await dispatcher.dispatch(resolveRef(ref, registryFor(config), config), "cli");
            log.info(`${scene.name} ${state}: ${outcome}`);
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
                console.log("Saved. Claude clients were signed out; restart the service: systemctl --user restart archclaw");
            } else if (sub === "revoke") {
                store.revokeAll();
                console.log("Signed every Claude client out. Restart the service to drop live access tokens: systemctl --user restart archclaw");
            } else if (sub === "status") {
                const c = loadConfig().connector;
                console.log(`url:       ${c.publicUrl ? `${c.publicUrl.replace(/\/$/, "")}/mcp` : "(not set - archclaw connector url https://…)"}`);
                console.log(`local:     http://${c.listen}:${c.port} (allowed from ${c.allowFrom.join(", ")})`);
                console.log(`password:  ${store.hasPassword ? "set" : "not set - run `archclaw connector password`"}`);
                console.log(`clients:   ${store.connectedClients} signed in`);
            } else if (sub === "url") {
                const url = rest[1];
                if (!url?.startsWith("https://")) throw new Error("usage: archclaw connector url https://<your public host>");
                const doc = parseDocument(readFileSync(paths.config, "utf8"));
                doc.setIn(["connector", "publicUrl"], url.replace(/\/+$/, ""));
                writeFileSync(paths.config, doc.toString());
                loadConfig(); // validate before telling the user it worked
                console.log(`Saved. Restart: systemctl --user restart archclaw\nIn Claude: Settings → Connectors → Add custom connector → ${url.replace(/\/+$/, "")}/mcp`);
            } else throw new Error("usage: archclaw connector password|url <https-url>|status|revoke");
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
                            "http://127.0.0.1:8898/callback), then run: archclaw spotify login --client-id <ID>",
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
                console.log("Restart the service to pick it up: systemctl --user restart archclaw");
            } else if (sub === "logout") {
                spotifyStore.clear();
                console.log("Forgot the Spotify login. Also remove archclaw at https://www.spotify.com/account/apps/ if you like.");
            } else if (sub === "status") {
                const config = loadConfig();
                console.log(`client id: ${config.spotify.clientId ?? "(not set)"}`);
                console.log(`logged in: ${spotifyClient.loggedIn ? "yes" : "no - run `archclaw spotify login`"}`);
                console.log(`handoff:   ${existsSync(handoffFlag(paths.state)) ? "on" : "off"}`);
                if (spotifyClient.loggedIn) {
                    const { isThisPc } = await import("./spotify/actions.ts");
                    for (const d of await spotifyClient.devices()) {
                        console.log(`device:    ${d.name} (${d.type})${isThisPc(d, config) ? "  <- this PC" : ""}${d.is_active ? "  [active]" : ""}`);
                    }
                    const pb = await spotifyClient.playback();
                    console.log(`playing:   ${pb?.is_playing ? `${pb.item?.name ?? "?"} on ${pb.device?.name}` : "nothing"}`);
                }
            } else throw new Error("usage: archclaw spotify login|status|logout");
            return;
        }
        case "list":
            for (const a of registryFor(tryConfig()).list()) console.log(`${a.id.padEnd(20)} ${a.risk.padEnd(8)} ${a.title}`);
            return;
        case "check": {
            const config = loadConfig();
            const registry = registryFor(config);
            for (const scene of config.scenes) {
                resolveRef(scene.start, registry, config);
                if (scene.stop) resolveRef(scene.stop, registry, config);
            }
            console.log(`${paths.config}: OK, ${Object.keys(config.apps).length} apps, ${config.scenes.length} scenes`);
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
