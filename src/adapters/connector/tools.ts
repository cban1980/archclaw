import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeApp, isAppRunning, openApp } from "../../actions/apps.ts";
import type { Config } from "../../config.ts";
import type { Action } from "../../core/action.ts";
import type { Dispatcher, Registry } from "../../core/dispatcher.ts";
import type { Executor } from "../../core/executor.ts";
import { appOf, resolveRef } from "../../resolve.ts";

type Deps = { config: Config; registry: Registry; dispatcher: Dispatcher; exec: Executor };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** The tools Claude gets. Everything goes through the same dispatcher and safety rules as Google Home. */
export function registerTools(server: McpServer, { config, registry, dispatcher, exec }: Deps) {
    const actionIds = registry.list().map(a => a.id) as [string, ...string[]];
    const appNames = Object.keys(config.apps);
    const screenNames = Object.keys(config.screens);
    const deviceNames = config.devices.map(d => d.name) as [string, ...string[]];

    /** Risky actions start a countdown; reply right away instead of blocking the tool call for 30 s. */
    async function run(action: Action, params?: { percent?: number }) {
        if (action.risk === "confirm") {
            void dispatcher.dispatch(action, "claude", params);
            return text(
                `${action.title}: started a ${action.countdownSeconds ?? config.safety.countdownSeconds} s countdown with a Cancel button ` +
                    `on the computer's screen. Call run_action with power.cancel to stop it.`,
            );
        }
        const outcome = await dispatcher.dispatch(action, "claude", params);
        return text(`${action.title}: ${outcome}`);
    }

    server.registerTool(
        "get_status",
        {
            title: "Computer status",
            description:
                "Current state of the computer: lock state, screens, volume/mute, music, do-not-disturb, night light, " +
                "keep-awake, which configured apps are open, connected screens. Call this before acting when the " +
                "request depends on the current state (e.g. 'turn it down a bit').",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            const devices: Record<string, unknown> = {};
            await Promise.all(
                config.devices.map(async d => {
                    const app = appOf(d.on, config);
                    const state: Record<string, unknown> = { type: d.type };
                    if (d.probe) state[d.type === "lock" ? "locked" : "on"] = await exec.test(d.probe);
                    else if (app) state.on = await isAppRunning(exec, app);
                    if (d.levelProbe) state.percent = Number.parseInt((await exec.capture(d.levelProbe)).trim(), 10);
                    if (Object.keys(state).length > 1) devices[d.name] = state;
                }),
            );
            const apps = Object.fromEntries(
                await Promise.all(Object.entries(config.apps).map(async ([n, a]) => [n, await isAppRunning(exec, a)] as const)),
            );
            let monitors: unknown = [];
            try {
                monitors = (JSON.parse(await exec.capture("hyprctl monitors -j")) as Array<{ name: string; width: number; height: number; x: number }>).map(
                    m => ({ name: m.name, width: m.width, height: m.height, x: m.x }),
                );
            } catch {}
            return text(JSON.stringify({ devices, appsOpen: apps, screens: config.screens, monitors }, null, 2));
        },
    );

    server.registerTool(
        "list_capabilities",
        {
            title: "What archnest can do",
            description: "Lists built-in actions (with risk level), configured apps, named screens and Google Home devices.",
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () =>
            text(
                JSON.stringify(
                    {
                        actions: registry.list().map(a => ({ id: a.id, title: a.title, risk: a.risk })),
                        apps: appNames,
                        screens: config.screens,
                        devices: config.devices.map(d => ({ name: d.name, type: d.type })),
                    },
                    null,
                    2,
                ),
            ),
    );

    server.registerTool(
        "run_action",
        {
            title: "Run an action",
            description:
                "Runs a built-in action. Examples: volume.set with percent, media.next, display.off, power.lock, dnd.on. " +
                "Power actions (power.shutdown, power.reboot, power.suspend, power.logout) start a 30 s countdown the " +
                "user can cancel on screen; only use them when the user clearly asked for exactly that. power.cancel " +
                "stops a pending countdown.",
            inputSchema: {
                action: z.enum(actionIds).describe("Action id from list_capabilities"),
                percent: z.number().min(0).max(100).optional().describe("For volume.set: target volume 0-100"),
            },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ action, percent }) => run(registry.get(action)!, percent === undefined ? undefined : { percent }),
    );

    if (appNames.length) {
        server.registerTool(
            "open_app",
            {
                title: "Open an app",
                description:
                    "Opens a configured app, or focuses it if it's already running, optionally moving it to a named screen. " +
                    "Use new_window to always open another window (e.g. a second terminal).",
                inputSchema: {
                    app: z.enum(appNames as [string, ...string[]]),
                    screen: (screenNames.length ? z.enum(screenNames as [string, ...string[]]) : z.string())
                        .optional()
                        .describe("Named screen from list_capabilities"),
                    new_window: z.boolean().optional(),
                },
                annotations: { destructiveHint: false, openWorldHint: false },
            },
            async ({ app, screen, new_window }) => {
                const monitor = screen ? (config.screens[screen] ?? screen) : undefined;
                return run(openApp(app, config.apps[app]!, { monitor, alwaysNew: new_window }));
            },
        );

        server.registerTool(
            "close_app",
            {
                title: "Close an app",
                description: "Closes every window of a configured app. Unsaved work in it may be lost, so only close what the user asked to close.",
                inputSchema: { app: z.enum(appNames as [string, ...string[]]) },
                annotations: { destructiveHint: true, openWorldHint: false },
            },
            async ({ app }) => run(closeApp(app, config.apps[app]!)),
        );
    }

    server.registerTool(
        "switch_device",
        {
            title: "Switch a device",
            description:
                "Turns one of the Google Home devices on or off, exactly as Google Home would, including scenes such as a " +
                "work mode. Prefer the more specific tools when they fit.",
            inputSchema: { device: z.enum(deviceNames), on: z.boolean() },
            annotations: { destructiveHint: true, openWorldHint: false },
        },
        async ({ device, on }) => {
            const dev = config.devices.find(d => d.name === device)!;
            const ref = on ? dev.on : dev.off;
            if (!ref) return text(`${device} has no "${on ? "on" : "off"}" action.`);
            return run(resolveRef(ref, registry, config));
        },
    );
}
