import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clients, closeApp, closeWindow, focus, matches, moveToMonitor, openApp } from "../../actions/apps.ts";
import { type Config, type SingleRef, findScene, RISKY } from "../../config.ts";
import type { ConfigStore } from "../../config-store.ts";
import type { Action } from "../../core/action.ts";
import type { Dispatcher, Registry } from "../../core/dispatcher.ts";
import type { Executor } from "../../core/executor.ts";
import type { Safety } from "../../core/safety.ts";
import { appFromDesktopId, findApps, webAppLaunch } from "../../desktop-apps.ts";
import { omarchyAction, resolveRef } from "../../resolve.ts";
import { INFO_TOPICS, OMARCHY_OPS, omarchyCommand, omarchyInfo, screenshot } from "../../omarchy.ts";
import { monitors } from "../../actions/apps.ts";
import { availablePrograms, sshHosts, terminalAction } from "../../terminal.ts";
import type { SpotifyClient } from "../../spotify/client.ts";
import type { HueClient } from "../../hue/client.ts";
import { applyChange, recallScene, summarize } from "../../hue/control.ts";
import { playUriHere } from "../../spotify/actions.ts";
import { computerStatus } from "../../status.ts";

export type ToolDeps = {
    store: ConfigStore;
    registry: Registry;
    dispatcher: Dispatcher;
    exec: Executor;
    safety: Pick<Safety, "pending">;
    spotify?: SpotifyClient;
    hue?: HueClient;
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** What Claude is told about this computer up front (MCP server instructions). */
export function instructionsFor(config: Config): string {
    const lines = [
        `archclaw controls "${config.name}", a Linux desktop (Arch/Omarchy, Hyprland) with ${Object.keys(config.screens).length || "one or more"} screens.`,
        "You can check its state, open/close/move apps, run scenes, control music, volume, screens and power, and change archclaw's own setup (apps, scenes, screen names, notes).",
        "Act directly on clear requests; call get_status first when the request depends on the current state. Keep replies short: the user is often talking by voice from their phone.",
        "Shutdown, restart, sleep and logout start a countdown on the computer's screen with a Cancel button; only use them when the user clearly asked, and mention they can say cancel (run_action power.cancel).",
        "Remote unlocking doesn't exist on purpose. Locking is fine.",
        "For Omarchy itself (theme, wallpaper, fonts, text size, bar, transparency, workspaces, audio outputs, Bluetooth, brightness, power profile, reminders, notifications, screen recording, repairs) use omarchy_info and omarchy_do. Use screenshot to see what's on a screen.",
        "When the user wants a new setup remembered (\"when I say X, open Y on the left screen\"), save it as a scene with save_scene; give it the words they use as aliases.",
    ];
    if (config.scenes.length) {
        lines.push("", "Scenes (start_scene / stop_scene; match the user's words to a name or alias):");
        for (const s of config.scenes) {
            lines.push(`- ${s.name}${s.aliases.length ? ` (also: ${s.aliases.join(", ")})` : ""}${s.description ? `: ${s.description}` : ""}`);
        }
    }
    const apps = Object.entries(config.apps);
    if (apps.length) {
        lines.push("", `Apps: ${apps.map(([k, a]) => (a.description ? `${k} (${a.description})` : k)).join(", ")}.`);
    }
    if (Object.keys(config.screens).length) {
        lines.push(`Screens: ${Object.entries(config.screens).map(([n, m]) => `${n} = ${m}`).join(", ")}.`);
    }
    if (config.notes.trim()) lines.push("", "Notes from the owner:", config.notes.trim());
    return lines.join("\n");
}

const step = z.union([
    z.object({ open: z.string().describe("App key"), screen: z.string().optional().describe("Screen name"), new: z.boolean().optional() }).strict(),
    z.object({ close: z.string().describe("App key") }).strict(),
    z.object({ play: z.string().describe("App key of a music player, e.g. spotify"), screen: z.string().optional() }).strict(),
    z.object({ action: z.string().describe("Built-in action id from list_capabilities, e.g. display.off, volume.mute, power.lock") }).strict(),
    z.object({ omarchy: z.string().describe("Operation from omarchy_do, e.g. theme.set, bar, animations"), value: z.string().optional() }).strict(),
    z
        .object({
            hue: z.string().describe("Hue room, zone, light or 'all'"),
            on: z.boolean().optional(),
            brightness: z.number().min(0).max(100).optional(),
            color: z.string().optional(),
            temperature: z.union([z.string(), z.number()]).optional(),
            fade: z.number().min(0).max(60).optional(),
        })
        .strict(),
    z.object({ hueScene: z.string().describe("Hue scene name"), room: z.string().optional() }).strict(),
    z
        .object({
            terminal: z.string().describe("Program from list_capabilities terminal.programs, or 'shell'"),
            ssh: z.string().optional().describe("Host from list_capabilities terminal.sshHosts (with terminal: 'shell')"),
            dir: z.string().optional().describe("Working directory inside home, e.g. ~/Work/project"),
            screen: z.string().optional(),
        })
        .strict(),
]);
type Step = z.infer<typeof step>;

/** Claude's scene steps → config refs. No shell commands, no power actions. */
function toRefs(steps: Step[], registry: Registry): SingleRef[] {
    return steps.map(s => {
        if ("action" in s) {
            if (RISKY.test(s.action)) throw new Error(`${s.action} can't be part of a scene (it needs its own countdown)`);
            if (!registry.get(s.action)) throw new Error(`unknown action ${s.action}`);
            return s.action;
        }
        if ("omarchy" in s && !OMARCHY_OPS[s.omarchy]) throw new Error(`unknown Omarchy operation ${s.omarchy}`);
        return s;
    });
}

/** The tools Claude gets. Everything goes through the dispatcher and its safety rules. */
export function registerTools(server: McpServer, deps: ToolDeps) {
    const { store, registry, dispatcher, exec } = deps;
    const config = store.config;
    const actionIds = registry.list().map(a => a.id) as [string, ...string[]];
    const appNames = Object.keys(config.apps);
    const screenNames = Object.keys(config.screens);
    const sceneWords = config.scenes.flatMap(s => [s.name, ...s.aliases]);
    const monitorOf = (screen?: string) => (screen ? (config.screens[screen] ?? screen) : undefined);

    /** Risky actions start a countdown; reply right away instead of blocking the tool call. */
    async function run(action: Action, params?: { percent?: number }) {
        if (action.risk === "confirm") {
            void dispatcher.dispatch(action, "claude", params);
            return text(
                `${action.title}: started a ${action.countdownSeconds ?? config.safety.countdownSeconds} s countdown with a Cancel button ` +
                    `on the computer's screen. run_action power.cancel stops it.`,
            );
        }
        const outcome = await dispatcher.dispatch(action, "claude", params);
        return outcome === "ran" ? text(`${action.title}: done`) : fail(`${action.title}: ${outcome}`);
    }

    async function edit(what: string, change: () => Config) {
        try {
            change();
            return text(`${what}. Saved; it works right away (undo_config_change reverts it).`);
        } catch (err) {
            return fail((err as Error).message);
        }
    }

    // ── state ────────────────────────────────────────────────────────────────

    server.registerTool(
        "get_status",
        {
            title: "Computer status",
            description:
                "Current state: locked, screens on, volume/mute, what's playing, do-not-disturb, night light, keep-awake, " +
                "active scenes, open apps, monitors and every window (with its address for move_window).",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => json(await computerStatus(exec, store.config, { pendingCountdown: deps.safety.pending })),
    );

    server.registerTool(
        "list_capabilities",
        {
            title: "What archclaw can do",
            description: "Built-in actions (with risk), configured apps, scenes with their aliases and steps, named screens and the owner's notes.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () =>
            json({
                actions: registry.list().map(a => ({ id: a.id, title: a.title, risk: a.risk })),
                apps: config.apps,
                scenes: config.scenes,
                screens: config.screens,
                notes: config.notes,
                terminal: { programs: await availablePrograms(exec, config.terminalPrograms), sshHosts: sshHosts() },
                spotify: deps.spotify?.loggedIn ? "logged in" : "not logged in (archclaw spotify login on the computer)",
            }),
    );

    // ── doing things ─────────────────────────────────────────────────────────

    server.registerTool(
        "run_action",
        {
            title: "Run a built-in action",
            description:
                "volume.set (with percent), volume.mute/unmute, media.play/pause/next/previous, display.on/off, power.lock, " +
                "dnd.on/off, nightlight.on/off, awake.on/off, spotify.here (move/start Spotify here), spotify.handoff.on/off. " +
                "power.shutdown, power.reboot, power.suspend and power.logout start a cancellable countdown on screen; " +
                "power.cancel stops it.",
            inputSchema: {
                action: z.enum(actionIds).describe("Action id"),
                percent: z.number().min(0).max(100).optional().describe("For volume.set: 0-100"),
            },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ action, percent }) => run(registry.get(action)!, percent === undefined ? undefined : { percent }),
    );

    if (config.scenes.length) {
        const sceneTool = (start: boolean) => async ({ scene }: { scene: string }) => {
            const s = findScene(store.config, scene);
            if (!s) return fail(`no scene "${scene}"; scenes: ${store.config.scenes.map(x => x.name).join(", ")}`);
            if (!start && !s.stop) return fail(`scene "${s.name}" has no stop steps`);
            return run(resolveRef(start ? s.start : s.stop!, registry, store.config));
        };
        const words = `Scenes and aliases: ${sceneWords.join(", ")}.`;
        server.registerTool(
            "start_scene",
            {
                title: "Start a scene",
                description: `Starts a saved setup (opens its apps on their screens, etc.). ${words}`,
                inputSchema: { scene: z.string().describe("Scene name or alias") },
                annotations: { destructiveHint: false, openWorldHint: false },
            },
            sceneTool(true),
        );
        server.registerTool(
            "stop_scene",
            {
                title: "Stop a scene",
                description: `Stops a scene (usually closes its apps). ${words}`,
                inputSchema: { scene: z.string().describe("Scene name or alias") },
                annotations: { destructiveHint: true, openWorldHint: false },
            },
            sceneTool(false),
        );
    }

    if (appNames.length) {
        server.registerTool(
            "open_app",
            {
                title: "Open an app",
                description: "Opens a configured app, or focuses it if it's already open, optionally on a named screen. new_window always opens another window.",
                inputSchema: {
                    app: z.enum(appNames as [string, ...string[]]),
                    screen: (screenNames.length ? z.enum(screenNames as [string, ...string[]]) : z.string()).optional(),
                    new_window: z.boolean().optional(),
                },
                annotations: { destructiveHint: false, openWorldHint: false },
            },
            async ({ app, screen, new_window }) => run(openApp(app, config.apps[app]!, { monitor: monitorOf(screen), alwaysNew: new_window })),
        );
        server.registerTool(
            "close_app",
            {
                title: "Close an app",
                description: "Closes every window of a configured app. Unsaved work may be lost, so only close what the user asked for.",
                inputSchema: { app: z.enum(appNames as [string, ...string[]]) },
                annotations: { destructiveHint: true, openWorldHint: false },
            },
            async ({ app }) => run(closeApp(app, config.apps[app]!)),
        );
    }

    server.registerTool(
        "move_window",
        {
            title: "Move a window",
            description: "Moves a window to a screen and focuses it. `window` is an app key or a window address from get_status.",
            inputSchema: {
                window: z.string(),
                screen: (screenNames.length ? z.enum(screenNames as [string, ...string[]]) : z.string()).describe("Screen name or monitor"),
            },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ window, screen }) => {
            const target = await findWindow(window);
            if (!target) return fail(`no window "${window}"`);
            await moveToMonitor(exec, target, monitorOf(screen)!);
            await focus(exec, target);
            return text(`moved to ${screen}`);
        },
    );

    server.registerTool(
        "focus_window",
        {
            title: "Focus a window",
            description: "Brings a window to the front. `window` is an app key or a window address from get_status.",
            inputSchema: { window: z.string() },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ window }) => {
            const target = await findWindow(window);
            if (!target) return fail(`no window "${window}"`);
            await focus(exec, target);
            return text("focused");
        },
    );

    server.registerTool(
        "close_window",
        {
            title: "Close one window",
            description: "Closes one window by its address from get_status. Unsaved work may be lost.",
            inputSchema: { address: z.string().regex(/^0x[0-9a-f]+$/i) },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ address }) => {
            if (!(await clients(exec)).some(c => c.address === address)) return fail(`no window ${address}`);
            await closeWindow(exec, address);
            return text("closed");
        },
    );

    async function findWindow(window: string): Promise<string | undefined> {
        const wins = await clients(exec);
        if (/^0x[0-9a-f]+$/i.test(window)) return wins.find(w => w.address === window)?.address;
        const app = config.apps[window];
        return app ? wins.find(w => matches(app, w))?.address : undefined;
    }

    // ── Spotify ──────────────────────────────────────────────────────────────

    const spotify = deps.spotify;
    if (spotify?.loggedIn) {
        const kinds = ["track", "album", "playlist", "artist"] as const;
        server.registerTool(
            "spotify_search",
            {
                title: "Search Spotify",
                description: "Finds tracks, albums, playlists or artists. mine=true searches the user's own playlists instead.",
                inputSchema: {
                    query: z.string().min(1),
                    kind: z.enum(kinds).optional().describe("Default: all kinds"),
                    mine: z.boolean().optional(),
                },
                annotations: { readOnlyHint: true, openWorldHint: true },
            },
            async ({ query, kind, mine }) => {
                try {
                    if (mine) {
                        const words = query.toLowerCase();
                        return json((await spotify.myPlaylists()).filter(p => p.name.toLowerCase().includes(words)));
                    }
                    return json(await spotify.search(query, kind ? [kind] : [...kinds], 5));
                } catch (err) {
                    return fail((err as Error).message);
                }
            },
        );
        server.registerTool(
            "spotify_play",
            {
                title: "Play on Spotify",
                description:
                    "Plays on this computer (starts Spotify if needed). Give a spotify: URI from spotify_search, or a query: " +
                    "the best match of `kind` (default track) is played. mine=true plays the user's own playlist by name.",
                inputSchema: {
                    uri: z.string().regex(/^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/).optional(),
                    query: z.string().optional(),
                    kind: z.enum(kinds).optional(),
                    mine: z.boolean().optional(),
                },
                annotations: { destructiveHint: false, openWorldHint: true },
            },
            async ({ uri, query, kind, mine }) => {
                try {
                    let target = uri ? { uri, name: uri } : undefined;
                    if (!target && query && mine) {
                        const q = query.toLowerCase();
                        const mineList = await spotify.myPlaylists();
                        target = mineList.find(p => p.name.toLowerCase() === q) ?? mineList.find(p => p.name.toLowerCase().includes(q));
                    } else if (!target && query) {
                        target = (await spotify.search(query, [kind ?? "track"], 1))[0];
                    }
                    if (!target) return fail(uri || query ? `nothing found for "${query}"` : "give a uri or a query");
                    const ctx = { exec, log: { info() {}, warn() {}, error() {} }, cancelPending: () => 0 };
                    await playUriHere(ctx, { config: store.config, client: spotify }, target.uri);
                    return text(`playing ${"by" in target && target.by ? `${target.name} by ${target.by}` : target.name}`);
                } catch (err) {
                    return fail((err as Error).message);
                }
            },
        );
    }

    server.registerTool(
        "open_terminal",
        {
            title: "Open a terminal",
            description:
                "Opens a new terminal window, optionally running a program (installed TUIs like btop, nvim, lazygit, yazi, " +
                "or the owner's own from list_capabilities terminal.programs), or ssh to a host from terminal.sshHosts, " +
                "in a directory inside home, on a screen. Programs take no arguments; use `directory` for where they start.",
            inputSchema: {
                program: z.string().optional(),
                ssh_host: z.string().optional(),
                directory: z.string().optional().describe("e.g. ~/Work/archclaw"),
                screen: (screenNames.length ? z.enum(screenNames as [string, ...string[]]) : z.string()).optional(),
            },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ program, ssh_host, directory, screen }) => {
            try {
                return run(await terminalAction({ program, ssh: ssh_host, dir: directory, monitor: monitorOf(screen) }, exec, config.terminalPrograms));
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );

    // ── Philips Hue ──────────────────────────────────────────────────────────

    const hue = deps.hue;
    if (hue?.paired) {
        server.registerTool(
            "hue_status",
            {
                title: "Hue lights",
                description: "Philips Hue rooms and zones with their lights (on, brightness) and scenes.",
                annotations: { readOnlyHint: true, openWorldHint: false },
            },
            async () => {
                try {
                    return json(summarize(await hue.state()));
                } catch (err) {
                    return fail((err as Error).message);
                }
            },
        );
        server.registerTool(
            "hue_set",
            {
                title: "Change Hue lights",
                description:
                    "Changes a Hue room, zone, light, or 'all' (names match loosely, any language): on/off, brightness 0-100 " +
                    "(0 = off), color (red, blue, warm white… or #rrggbb), temperature (2000-6500 K or warm/neutral/cool/daylight), " +
                    "fade in seconds.",
                inputSchema: {
                    target: z.string(),
                    on: z.boolean().optional(),
                    brightness: z.number().min(0).max(100).optional(),
                    color: z.string().optional(),
                    temperature: z.union([z.string(), z.number()]).optional(),
                    fade_seconds: z.number().min(0).max(60).optional(),
                },
                annotations: { destructiveHint: false, openWorldHint: false },
            },
            async ({ target, fade_seconds, ...change }) => {
                try {
                    return text(await applyChange(hue, target, { ...change, fadeSeconds: fade_seconds }));
                } catch (err) {
                    return fail((err as Error).message);
                }
            },
        );
        server.registerTool(
            "hue_scene",
            {
                title: "Hue scene",
                description: "Recalls a Hue scene by name (from hue_status), optionally in a given room or zone.",
                inputSchema: { scene: z.string(), room: z.string().optional() },
                annotations: { destructiveHint: false, openWorldHint: false },
            },
            async ({ scene, room }) => {
                try {
                    return text(await recallScene(hue, scene, room));
                } catch (err) {
                    return fail((err as Error).message);
                }
            },
        );
    }

    // ── Omarchy ──────────────────────────────────────────────────────────────

    const ops = Object.keys(OMARCHY_OPS) as [string, ...string[]];
    server.registerTool(
        "omarchy_info",
        {
            title: "Omarchy state",
            description:
                "Read Omarchy state. overview: theme, wallpaper, font, text size, CPU/memory, weather, battery, network, version. " +
                "themes/fonts: current and available. audio: outputs and mic mute. bluetooth: power and paired devices. " +
                "network, power (profiles, battery), reminders, updates.",
            inputSchema: { topic: z.enum(INFO_TOPICS) },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ topic }) => json(await omarchyInfo(topic, { exec })),
    );

    server.registerTool(
        "omarchy_do",
        {
            title: "Change Omarchy",
            description:
                "Runs one Omarchy operation. Operations and values:\n" +
                Object.entries(OMARCHY_OPS)
                    .map(([id, o]) => `- ${id}: ${o.description}${o.value ? ` (value: ${o.value.hint}${o.value.optional ? ", optional" : ""})` : ""}`)
                    .join("\n"),
            inputSchema: { operation: z.enum(ops), value: z.string().optional() },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ operation, value }) => {
            try {
                await omarchyCommand(operation, value, { exec }); // validate first, for a clear error
            } catch (err) {
                return fail((err as Error).message);
            }
            return run(omarchyAction(operation, value));
        },
    );

    server.registerTool(
        "screenshot",
        {
            title: "See a screen",
            description: "Takes a screenshot of one monitor (screen name or monitor name), or of all of them side by side, so you can see what's on it.",
            inputSchema: { screen: z.string().optional() },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ screen }) => {
            try {
                const image = await screenshot(monitorOf(screen), await monitors(exec));
                return { content: [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" }] };
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );

    // ── setup: Claude manages archclaw's own config ──────────────────────────

    server.registerTool(
        "find_installed_apps",
        {
            title: "Find installed apps",
            description: "Searches installed desktop applications (name, desktop id, window class) to add with add_app.",
            inputSchema: { query: z.string().min(1) },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ query }) => json(findApps(query).slice(0, 15).map(({ exec: _e, ...a }) => a)),
    );

    server.registerTool(
        "add_app",
        {
            title: "Add or change an app",
            description:
                "Makes an app available to open_app and scenes. Give either desktop_id (from find_installed_apps) or webapp_url " +
                "(an https site opened as its own app window). `match` (window class or title word) defaults sensibly; " +
                "check get_status windows if open_app can't find the window afterwards. Apps that need a custom command " +
                "must be added by the owner in the config file.",
            inputSchema: {
                key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Short id, e.g. discord"),
                desktop_id: z.string().optional(),
                webapp_url: z.string().url().optional(),
                match: z.string().min(1).optional(),
                description: z.string().optional(),
                confirm_close: z.boolean().optional().describe("Accept 'Leave site?'-style prompts when closing (browsers, web apps)"),
            },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ key, desktop_id, webapp_url, match, description, confirm_close }) =>
            edit(`app ${key} saved`, () => {
                if (Boolean(desktop_id) === Boolean(webapp_url)) throw new Error("give exactly one of desktop_id or webapp_url");
                if (config.apps[key] && !/^(uwsm-app -- [\w.-]+\.desktop|omarchy-launch-webapp '[^']+')$/.test(config.apps[key]!.launch)) {
                    throw new Error(`app "${key}" was set up by hand with a custom command; ask the owner to change it in the config file`);
                }
                const launch = desktop_id ? appFromDesktopId(desktop_id).launch : webAppLaunch(webapp_url!);
                const defMatch = desktop_id ? appFromDesktopId(desktop_id).match : new URL(webapp_url!).hostname.split(".").at(-2)!;
                return store.saveApp(key, {
                    launch,
                    match: match ?? defMatch,
                    ...(confirm_close !== undefined ? { confirmClose: confirm_close } : {}),
                    ...(description ? { description } : {}),
                });
            }),
    );

    server.registerTool(
        "remove_app",
        {
            title: "Remove an app",
            description: "Removes an app from archclaw (the program itself stays installed).",
            inputSchema: { key: z.string() },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ key }) => edit(`app ${key} removed`, () => store.deleteApp(key)),
    );

    server.registerTool(
        "save_scene",
        {
            title: "Save a scene",
            description:
                "Creates or replaces a named setup the user can start and stop by name. Steps run in order: " +
                "{open: app, screen?}, {close: app}, {play: app, screen?}, {action: id}, {omarchy: operation, value?}, " +
                "{terminal: program|'shell', ssh?, dir?, screen?}, {hue: room|zone|light|'all', on?, brightness?, color?, temperature?, fade?}, " +
                "{hueScene: name, room?} " +
                "(any omarchy_do operation, e.g. theme.set). Without stop steps, stopping " +
                "closes every app the scene opens. Put the words the user says for it in aliases (any language). " +
                "Power actions can't be in scenes.",
            inputSchema: {
                name: z.string().min(1),
                aliases: z.array(z.string().min(1)).optional(),
                description: z.string().optional(),
                start: z.array(step).min(1),
                stop: z.array(step).optional(),
            },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ name, aliases, description, start, stop }) =>
            edit(`scene ${name} saved`, () => {
                const existing = findScene(store.config, name);
                if (existing && JSON.stringify([existing.start, existing.stop]).includes('"run"')) {
                    throw new Error(`scene "${existing.name}" runs custom commands set up by the owner; change it in the config file`);
                }
                const startRefs = toRefs(start, registry);
                const stopRefs = stop?.length
                    ? toRefs(stop, registry)
                    : [...new Set(start.flatMap(s => ("open" in s ? [s.open] : [])))].map(app => ({ close: app }));
                return store.saveScene({
                    name,
                    aliases: aliases ?? [],
                    ...(description ? { description } : {}),
                    start: startRefs,
                    ...(stopRefs.length ? { stop: stopRefs } : {}),
                });
            }),
    );

    server.registerTool(
        "remove_scene",
        {
            title: "Remove a scene",
            description: "Deletes a saved scene.",
            inputSchema: { scene: z.string() },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ scene }) =>
            edit(`scene ${scene} removed`, () => {
                const s = findScene(store.config, scene);
                if (!s) throw new Error(`no scene "${scene}"`);
                return store.deleteScene(s.name);
            }),
    );

    server.registerTool(
        "name_screen",
        {
            title: "Name a screen",
            description: "Gives a monitor (from get_status monitors) a friendly name such as left or tv. Omit monitor to remove the name.",
            inputSchema: { name: z.string().regex(/^[\p{L}0-9-]+$/u), monitor: z.string().optional() },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ name, monitor }) => edit(`screen ${name} ${monitor ? `= ${monitor}` : "removed"}`, () => store.setScreen(name, monitor)),
    );

    server.registerTool(
        "set_notes",
        {
            title: "Update notes",
            description:
                "Replaces the owner's notes that you see in your instructions every time (preferences, words they use, habits). " +
                "Read the current notes with list_capabilities first and keep what's still true.",
            inputSchema: { notes: z.string() },
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async ({ notes }) => edit("notes updated", () => store.setNotes(notes)),
    );

    server.registerTool(
        "undo_config_change",
        {
            title: "Undo the last setup change",
            description: "Restores archclaw's config from before the latest change (apps, scenes, screens or notes).",
            annotations: { destructiveHint: false, openWorldHint: false },
        },
        async () => {
            try {
                return text(`undid: ${store.undo()}`);
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );
}
