#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { displayActions } from "./actions/display.ts";
import { powerActions } from "./actions/power.ts";
import { desktopActions, mediaActions, volumeActions } from "./actions/system.ts";
import { loadConfig, paths } from "./config.ts";
import { Dispatcher, Registry } from "./core/dispatcher.ts";
import { createExecutor } from "./core/executor.ts";
import { createLogger } from "./core/log.ts";
import { createDesktopNotifier } from "./core/notifier.ts";
import { Safety, type SafetyConfig } from "./core/safety.ts";
import { initConfig } from "./init.ts";
import { pairedFabrics, pairingCodes } from "./pairing.ts";
import { resolveRef } from "./resolve.ts";

const usage = `usage: archnest <command>

  serve                          run the Matter bridge (what the systemd service runs)
  init [--preset en|sv] [--name N] [--force]
                                 create the config from your monitors, with a random pairing code
  pair                           show the QR code and pairing code for Google Home
  status                         service, pairing and config at a glance
  check                          validate the config
  list                           list built-in actions
  run <action> [--dry-run]       run one action locally, with the same safety rules
  trigger <device> on|off        act as if Google Home switched a device

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
const VALUE_OPTIONS = new Set(["--name", "--preset", "--percent"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_OPTIONS.has(args[i - 1])));
const [command = "serve", ...rest] = positional;

const log = createLogger("archnest");
const registry = new Registry().add(
    ...powerActions,
    ...displayActions,
    ...mediaActions,
    ...volumeActions,
    ...desktopActions,
);

const LOCAL_SAFETY: SafetyConfig = { countdownSeconds: 30, bootGraceSeconds: 0, repeatWindowSeconds: 0 };

function core(safetyConfig: SafetyConfig) {
    const exec = createExecutor(log, { dryRun });
    const safety = new Safety(safetyConfig, createDesktopNotifier(), log);
    return { exec, safety, dispatcher: new Dispatcher(safety, exec, log) };
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
            const { dispatcher, exec } = core(config.safety);
            if (dryRun) log.warn("dry-run: commands will be logged, not run");
            const { startMatter } = await import("./adapters/matter.ts");
            await startMatter({ config, registry, dispatcher, exec, log }, paths.state);
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
            const result = initConfig({
                examplePath: fileURLToPath(new URL(presets[preset], import.meta.url)),
                target: paths.config,
                name: option("--name"),
                monitors,
                force: flag("--force"),
            });
            if (!result.written) {
                console.log(`${paths.config} already exists; kept it (use --force to replace)`);
                return;
            }
            console.log(`wrote ${paths.config}`);
            for (const [label, monitor] of Object.entries(result.screens)) console.log(`  screen ${label} = ${monitor}`);
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
            const action = registry.get(id);
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
            const outcome = await dispatcher.dispatch(resolveRef(ref, registry, config), "cli");
            log.info(`${dev.name} ${state}: ${outcome}`);
            process.exitCode = outcome === "ran" ? 0 : 1;
            return;
        }
        case "list":
            for (const a of registry.list()) console.log(`${a.id.padEnd(18)} ${a.risk.padEnd(8)} ${a.title}`);
            return;
        case "check": {
            const config = loadConfig();
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
