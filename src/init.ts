import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument } from "yaml";

type Monitor = { name: string; x: number };
type App = { launch: string; match: string };

/** Screen names by position, left to right. */
export function nameScreens(monitors: Monitor[]): Record<string, string> {
    const sorted = [...monitors].sort((a, b) => a.x - b.x).map(m => m.name);
    const labels =
        sorted.length === 1 ? ["main"]
        : sorted.length === 2 ? ["left", "right"]
        : sorted.length === 3 ? ["left", "middle", "right"]
        : sorted.map((_, i) => `screen${i + 1}`);
    return Object.fromEntries(sorted.map((name, i) => [labels[i], name]));
}

/** Window class guess from a desktop file id: "com.mitchellh.ghostty.desktop" → "ghostty". */
export function classFromDesktopId(id: string): string {
    const base = id.replace(/\.desktop$/, "").replace(/-(stable|beta|dev)$/, "");
    return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
}

/**
 * The user's default browser and terminal (Omarchy's own helpers), so the preset's
 * "browser" and "terminal" apps match what is actually installed.
 */
export function detectApps(sh: (cmd: string, argv: string[]) => string): Record<string, App> {
    const apps: Record<string, App> = {};
    const browser = sh("omarchy-cmd-default-browser", []) || sh("xdg-settings", ["get", "default-web-browser"]);
    if (browser) apps.browser = { launch: "omarchy-launch-browser", match: classFromDesktopId(browser) };
    const terminal = sh("xdg-terminal-exec", ["--print-id"]);
    if (terminal) apps.terminal = { launch: "uwsm-app -- xdg-terminal-exec", match: classFromDesktopId(terminal) };
    return apps;
}

/** Writes a config from the example with your monitors, apps and name. Refuses to overwrite unless `force`. */
export function initConfig(opts: {
    examplePath: string;
    target: string;
    name?: string;
    monitors: Monitor[];
    apps?: Record<string, App>;
    force?: boolean;
}) {
    if (existsSync(opts.target) && !opts.force) return { written: false as const };
    const doc = parseDocument(readFileSync(opts.examplePath, "utf8"));
    if (opts.name) doc.setIn(["name"], opts.name);
    if (opts.monitors.length) doc.setIn(["screens"], doc.createNode(nameScreens(opts.monitors)));
    for (const [key, app] of Object.entries(opts.apps ?? {})) {
        if (doc.hasIn(["apps", key])) {
            doc.setIn(["apps", key, "launch"], app.launch);
            doc.setIn(["apps", key, "match"], app.match);
        }
    }
    mkdirSync(dirname(opts.target), { recursive: true });
    writeFileSync(opts.target, doc.toString(), { mode: 0o600 });
    return { written: true as const, screens: nameScreens(opts.monitors), apps: opts.apps ?? {} };
}
