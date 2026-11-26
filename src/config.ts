import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { OMARCHY_OPS } from "./omarchy.ts";

const singleRef = z.union([
    /** A built-in action id (`archclaw list`), e.g. display.off. */
    z.string(),
    /** Any shell command. Only allowed in a hand-edited config, never from Claude. */
    z.object({ run: z.string().min(1) }).strict(),
    /** Open (or focus) an app from `apps`, optionally on a screen from `screens` (or a monitor name). */
    z.object({ open: z.string().min(1), screen: z.string().min(1).optional(), new: z.boolean().optional() }).strict(),
    z.object({ close: z.string().min(1) }).strict(),
    /** Play music in an app (MPRIS): resumes it if running, otherwise opens it (on `screen`) and starts playback. */
    z.object({ play: z.string().min(1), screen: z.string().min(1).optional() }).strict(),
    /** A terminal running a program (built-in TUI or `terminalPrograms`), or ssh to a host from ~/.ssh/config. */
    z
        .object({
            terminal: z.string().min(1).describe("program, or 'shell'"),
            ssh: z.string().min(1).optional(),
            dir: z.string().min(1).optional(),
            screen: z.string().min(1).optional(),
        })
        .strict(),
    /** An Omarchy operation (see omarchy.ts), e.g. { omarchy: theme.set, value: Tokyo Night }. */
    z.object({ omarchy: z.string().min(1), value: z.string().optional() }).strict(),
]);
/** One action, or a list run in order. */
const actionRef = z.union([singleRef, z.array(singleRef).min(1)]);
export type SingleRef = z.infer<typeof singleRef>;
export type ActionRef = z.infer<typeof actionRef>;

const app = z
    .object({
        /** Command that starts the app, e.g. "omarchy-launch-spotify". */
        launch: z.string().min(1),
        /** Matched (case-insensitive, whole word) against window class and title. */
        match: z.string().min(1),
        /** MPRIS player name for `play` (`playerctl -l`); defaults to the app's key. */
        player: z.string().min(1).optional(),
        /**
         * Accept "Leave site?" / "Close anyway?" when closing: if a window is still there right
         * after closing it, archclaw presses Return in it. Only for apps whose default button closes.
         */
        confirmClose: z.boolean().optional(),
        /** What it is, for Claude ("RDP session to the work PC"). */
        description: z.string().min(1).optional(),
    })
    .strict();

/** A named setup Claude can start and stop ("mirc", "work mode"). */
const scene = z
    .object({
        name: z.string().min(1),
        /** Other words for it, in any language ("chat mode", "chattläge"). */
        aliases: z.array(z.string().min(1)).default([]),
        description: z.string().min(1).optional(),
        start: actionRef,
        stop: actionRef.optional(),
        /** Shell command; exit 0 means the scene is active. Default: the first app it opens is running. */
        probe: z.string().min(1).optional(),
    })
    .strict();

export const appSchema = app;
export const sceneSchema = scene;

const ip = z.union([z.ipv4(), z.ipv6()]);

// Power actions run after an on-screen countdown; bundling them into scenes would hide that.
export const RISKY = /^power\.(shutdown|reboot|suspend|logout)$/;

const schema = z
    .object({
        /** This computer's name, shown to Claude and on the sign-in page. */
        name: z.string().min(1).default("archclaw"),
        /** Free-form notes for Claude: who uses it, language, habits ("I say mirc for the chat setup"). */
        notes: z.string().default(""),
        /** Friendly screen names → Hyprland monitor names (`hyprctl monitors`). */
        screens: z.record(z.string(), z.string()).default({}),
        apps: z.record(z.string(), app).default({}),
        /**
         * Your own terminal programs: name → command line (run with `-e` in a new terminal).
         * Claude can start these by name but can't add or change them.
         */
        terminalPrograms: z.record(z.string(), z.string().min(1)).default({}),
        scenes: z.array(scene).default([]),
        safety: z
            .object({
                /** Shutdown, reboot, suspend and logout show a notification with Cancel for this long first. */
                countdownSeconds: z.number().int().min(0).default(30),
                /** Refuse those right after boot (guards against replayed requests). */
                bootGraceSeconds: z.number().int().min(0).default(120),
            })
            .strict()
            .default({ countdownSeconds: 30, bootGraceSeconds: 120 }),
        /** The remote MCP server the Claude apps connect to. */
        connector: z
            .object({
                /** Port the tunnel forwards to. */
                port: z.number().int().min(0).max(65535).default(8765),
                /**
                 * Address to listen on. Keep 127.0.0.1 when the tunnel runs on this computer; use this
                 * computer's LAN address when cloudflared runs elsewhere (another host, LXC, VM).
                 */
                listen: ip.default("127.0.0.1"),
                /** Remote addresses allowed to connect (your tunnel host). Default: localhost only. */
                allowFrom: z.array(ip).default(["127.0.0.1", "::1"]),
                /** The public https URL your tunnel publishes, e.g. https://pc.example.com */
                publicUrl: z.string().url().startsWith("https://").optional(),
            })
            .strict()
            .default({ port: 8765, listen: "127.0.0.1", allowFrom: ["127.0.0.1", "::1"] }),
        /** Spotify Web API (`archclaw spotify login`): play anything on this PC, move playback here. */
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
    })
    .strict();

export type Config = z.infer<typeof schema>;
export type AppConfig = z.infer<typeof app>;
export type SceneConfig = z.infer<typeof scene>;

const xdg = (name: string, fallback: string) => process.env[name] ?? join(homedir(), fallback);

export const paths = {
    config: process.env.ARCHCLAW_CONFIG ?? join(xdg("XDG_CONFIG_HOME", ".config"), "archclaw", "config.yaml"),
    state: process.env.ARCHCLAW_STORAGE ?? join(xdg("XDG_STATE_HOME", ".local/state"), "archclaw"),
};

/** Validates parsed YAML. Throws a readable error listing every problem. */
export function parseConfig(raw: unknown, source = "config"): Config {
    const result = schema.safeParse(raw ?? {});
    if (!result.success) {
        const issues = result.error.issues.map(i => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        throw new Error(`invalid ${source}:\n${issues}`);
    }
    const config = result.data;
    const seen = new Map<string, string>();
    for (const s of config.scenes) {
        for (const word of [s.name, ...s.aliases]) {
            const key = normalize(word);
            const other = seen.get(key);
            if (other && other !== s.name) throw new Error(`invalid ${source}: "${word}" names both scene "${other}" and "${s.name}"`);
            if (other === s.name && word === s.name) throw new Error(`invalid ${source}: duplicate scene "${s.name}"`);
            seen.set(key, s.name);
        }
        for (const r of refsOf(s)) {
            if (typeof r === "object" && "omarchy" in r && !(r.omarchy in OMARCHY_OPS)) {
                throw new Error(`invalid ${source}: scene "${s.name}" uses unknown Omarchy operation "${r.omarchy}"`);
            }
            if (typeof r === "string" && RISKY.test(r)) {
                throw new Error(`invalid ${source}: scene "${s.name}" uses ${r}; power actions can't be part of a scene`);
            }
            const appName = appOfRef(r);
            if (appName && !config.apps[appName]) throw new Error(`invalid ${source}: scene "${s.name}" uses unknown app "${appName}"`);
        }
    }
    return config;
}

export function loadConfig(path = paths.config): Config {
    let raw: unknown;
    try {
        raw = parse(readFileSync(path, "utf8"));
    } catch (err) {
        throw new Error(`cannot read config ${path}: ${(err as Error).message}`);
    }
    return parseConfig(raw, `config ${path}`);
}

export function refsOf(s: Pick<SceneConfig, "start" | "stop">): SingleRef[] {
    return [s.start, s.stop].flatMap(r => (r === undefined ? [] : Array.isArray(r) ? r : [r]));
}

export function appOfRef(r: SingleRef): string | undefined {
    if (typeof r !== "object") return undefined;
    return "open" in r ? r.open : "close" in r ? r.close : "play" in r ? r.play : undefined;
}

/** Case-, accent- and spacing-insensitive form for matching names ("Chattläge" = "chattlage"). */
export function normalize(word: string): string {
    return word
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** Finds a scene by name or alias. */
export function findScene(config: Pick<Config, "scenes">, word: string): SceneConfig | undefined {
    const key = normalize(word);
    return config.scenes.find(s => [s.name, ...s.aliases].some(w => normalize(w) === key));
}
