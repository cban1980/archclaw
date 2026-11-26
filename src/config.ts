import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const singleRef = z.union([
    z.string(),
    z.object({ run: z.string().min(1) }).strict(),
    /** Open (or focus) an app from `apps`, optionally on a screen from `screens` (or a monitor name). */
    z.object({ open: z.string().min(1), screen: z.string().min(1).optional(), new: z.boolean().optional() }).strict(),
    z.object({ close: z.string().min(1) }).strict(),
    /** Play music in an app (MPRIS): resumes it if running, otherwise opens it (on `screen`) and starts playback. */
    z.object({ play: z.string().min(1), screen: z.string().min(1).optional() }).strict(),
]);
/** One action, or a list run in order (a "scene"). */
const actionRef = z.union([singleRef, z.array(singleRef).min(1)]);
export type SingleRef = z.infer<typeof singleRef>;
export type ActionRef = z.infer<typeof actionRef>;

const device = z
    .object({
        name: z.string().min(1),
        /**
         * plug/light: stay on/off ("turn off X").
         * momentary: a button that runs `on` and flips back off.
         * lock: runs `on` when locked ("lock X"); remote unlocking is always refused.
         * dimmer: on/off plus a 0–100 % level ("set X to 30 percent"), e.g. volume.
         */
        type: z.enum(["plug", "light", "momentary", "lock", "dimmer"]).default("plug"),
        on: actionRef.optional(),
        off: actionRef.optional(),
        /** State to report at startup, until `probe` says otherwise. */
        initial: z.boolean().default(false),
        /** Shell command polled every few seconds; exit 0 means on/locked. Keeps Google Home in sync. */
        probe: z.string().min(1).optional(),
        /** dimmer: action id that takes a percent (e.g. volume.set). */
        level: z.string().min(1).optional(),
        /** dimmer: shell command that prints the current level 0–100. */
        levelProbe: z.string().min(1).optional(),
        /**
         * Extra voice phrases for Google Home routines (`archnest routines`): saying one of
         * `on` switches the device on (locks a lock), one of `off` switches it off.
         */
        phrases: z
            .object({ on: z.array(z.string().min(1)).optional(), off: z.array(z.string().min(1)).optional() })
            .strict()
            .optional(),
    })
    .strict()
    .refine(d => d.on || d.off || d.level, "a device needs an `on`, `off` or `level` action")
    .refine(d => (d.type === "dimmer") === (d.level !== undefined), "`level` is required for, and only allowed on, dimmers")
    .refine(d => !["momentary", "lock"].includes(d.type) || !d.off, "momentary and lock devices only take `on`")
    .refine(d => !d.phrases?.off?.length || d.off || d.type === "dimmer", "`phrases.off` needs an `off` action");

/** A routine that switches several devices from one phrase ("I'm done with the computer"). */
const routine = z
    .object({
        phrases: z.array(z.string().min(1)).min(1),
        /** Device name → true (on / lock) or false (off). Run in order. */
        actions: z.array(z.record(z.string(), z.boolean())).min(1),
    })
    .strict();

// Risky actions are only allowed on momentary devices: "turn off <something>" is too easy
// for a voice assistant to match by accident, and a plug's off-state invites it.
const RISKY = /^power\.(shutdown|reboot|suspend|logout)$/;

// Matter spec 5.1.7.1: trivially guessable setup passcodes are not allowed.
const INVALID_PASSCODES = new Set([
    0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321,
]);

const schema = z
    .object({
        /** The bridge's name in Google Home. Keep it different from every device name. */
        name: z.string().min(1).default("archnest"),
        /**
         * The Google Home room you put archnest's devices in (do it once in the app). Routines
         * refer to devices as "<name> - <room>". Use a room of their own, so "turn off the
         * lights in the living room" doesn't switch off the screens.
         */
        room: z.string().min(1).default("Desk"),
        /** Friendly screen names → Hyprland monitor names (`hyprctl monitors`). */
        screens: z.record(z.string(), z.string()).default({}),
        apps: z
            .record(
                z.string(),
                z
                    .object({
                        launch: z.string().min(1),
                        match: z.string().min(1),
                        /** MPRIS player name for `play` (`playerctl -l`); defaults to the app's key. */
                        player: z.string().min(1).optional(),
                    })
                    .strict(),
            )
            .default({}),
        matter: z
            .object({
                port: z.number().int().default(5540),
                passcode: z
                    .number()
                    .int()
                    .min(1)
                    .max(99999998)
                    .refine(p => !INVALID_PASSCODES.has(p), "this passcode is forbidden by the Matter spec")
                    .default(20202021),
                discriminator: z.number().int().min(0).max(4095).default(3840),
            })
            .strict()
            .default({ port: 5540, passcode: 20202021, discriminator: 3840 }),
        safety: z
            .object({
                countdownSeconds: z.number().int().min(0).default(30),
                bootGraceSeconds: z.number().int().min(0).default(120),
                repeatWindowSeconds: z.number().int().min(0).default(60),
            })
            .strict()
            .default({ countdownSeconds: 30, bootGraceSeconds: 120, repeatWindowSeconds: 60 }),
        /** Remote MCP server for the Claude apps (see README → Claude connector). */
        connector: z
            .object({
                enabled: z.boolean().default(false),
                /** Local port; the tunnel forwards to it. Only bound on 127.0.0.1. */
                port: z.number().int().min(0).max(65535).default(8765),
                /** The public https URL the tunnel publishes, e.g. https://pc.tail1234.ts.net */
                publicUrl: z.string().url().startsWith("https://").optional(),
            })
            .strict()
            .default({ enabled: false, port: 8765 }),
        /** Spotify Connect: move playback from the Nest to this PC (`archnest spotify login`). */
        spotify: z
            .object({
                /** Client ID of your app at developer.spotify.com (no secret needed). */
                clientId: z.string().min(1).optional(),
                /** Key in `apps` to start when this PC isn't a Spotify Connect device yet. */
                app: z.string().min(1).default("spotify"),
                /** Screen to open Spotify on. */
                screen: z.string().min(1).optional(),
                /** This PC's name in Spotify Connect; defaults to the hostname. */
                device: z.string().min(1).optional(),
                /** Device names handoff mode moves from; default: any speaker/TV (not phones or computers). */
                handoffFrom: z.array(z.string().min(1)).optional(),
            })
            .strict()
            .default({ app: "spotify" }),
        devices: z.array(device).min(1),
        /** Multi-device phrases for `archnest routines`. */
        routines: z.array(routine).default([]),
    })
    .strict();

export type Config = z.infer<typeof schema>;
export type DeviceConfig = Config["devices"][number];

const xdg = (name: string, fallback: string) => process.env[name] ?? join(homedir(), fallback);

export const paths = {
    config: process.env.ARCHNEST_CONFIG ?? join(xdg("XDG_CONFIG_HOME", ".config"), "archnest", "config.yaml"),
    state: process.env.ARCHNEST_STORAGE ?? join(xdg("XDG_STATE_HOME", ".local/state"), "archnest"),
};

export function loadConfig(path = paths.config): Config {
    let raw: unknown;
    try {
        raw = parse(readFileSync(path, "utf8"));
    } catch (err) {
        throw new Error(`cannot read config ${path}: ${(err as Error).message}`);
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map(i => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        throw new Error(`invalid config ${path}:\n${issues}`);
    }
    for (const d of result.data.devices) {
        if (d.type !== "momentary" && refsOf(d).some(a => typeof a === "string" && RISKY.test(a))) {
            throw new Error(`invalid config ${path}: "${d.name}" uses a power action on a ${d.type}; use type: momentary`);
        }
        if ([d.on, d.off].some(r => Array.isArray(r) && r.some(a => typeof a === "string" && RISKY.test(a)))) {
            throw new Error(`invalid config ${path}: "${d.name}": power actions can't be part of a list`);
        }
        for (const r of refsOf(d)) {
            const app =
                typeof r === "object" && ("open" in r ? r.open : "close" in r ? r.close : "play" in r ? r.play : undefined);
            if (app && !result.data.apps[app]) throw new Error(`invalid config ${path}: "${d.name}" uses unknown app "${app}"`);
        }
    }
    const names = new Set<string>();
    for (const d of result.data.devices) {
        const key = slug(d.name);
        if (names.has(key)) throw new Error(`invalid config ${path}: duplicate device name "${d.name}"`);
        names.add(key);
    }
    if (names.has(slug(result.data.name))) {
        throw new Error(
            `invalid config ${path}: the bridge name "${result.data.name}" is also a device name; ` +
                `Google Home would call one of them "${result.data.name} (2)". Rename the bridge (top-level \`name\`).`,
        );
    }
    for (const r of result.data.routines) {
        for (const step of r.actions) {
            for (const name of Object.keys(step)) {
                if (!names.has(slug(name))) throw new Error(`invalid config ${path}: routine "${r.phrases[0]}" uses unknown device "${name}"`);
            }
        }
    }
    return result.data;
}

function refsOf(d: DeviceConfig): SingleRef[] {
    return [d.on, d.off].flatMap(r => (r === undefined ? [] : Array.isArray(r) ? r : [r]));
}

/** Stable endpoint id from a device name, so Google Home keeps the pairing across restarts. */
export function slug(name: string): string {
    return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // å, ä, ö → a, a, o
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
