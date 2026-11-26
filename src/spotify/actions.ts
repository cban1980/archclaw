import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { openApp, playApp } from "../actions/apps.ts";
import type { Config } from "../config.ts";
import type { Action, ActionContext } from "../core/action.ts";
import type { Logger } from "../core/log.ts";
import { type SpotifyClient, type SpotifyDevice, SpotifyError } from "./client.ts";

const WAIT_FOR_DEVICE_MS = 30_000;
const POLL_MS = 3_000;
const COOLDOWN_MS = 10_000;
// Never pull playback away from these unless `handoffFrom` names them explicitly.
const PERSONAL_TYPES = new Set(["computer", "smartphone", "tablet"]);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const handoffFlag = (statePath: string) => join(statePath, "spotify-handoff");

type Deps = { config: Config; client: SpotifyClient; statePath: string };

export function spotifyEnabled(config: Config) {
    return Boolean(config.apps[config.spotify.app]);
}

/**
 * Spotify Connect glue:
 * - `spotify.here`: plays on this PC. If Spotify is playing on another device (e.g. the
 *   Nest), playback moves here; otherwise the local app is started/resumed.
 * - `spotify.handoff.on|off`: while on, playback that starts on a speaker (the Nest)
 *   is moved to this PC automatically, so "Hey Google, play X on Spotify" ends up here.
 */
export function spotifyActions({ config, client, statePath }: Deps): Action[] {
    const appName = config.spotify.app;
    const app = config.apps[appName];
    const screen = config.spotify.screen;
    const monitor = screen ? (config.screens[screen] ?? screen) : undefined;
    const flag = handoffFlag(statePath);

    const here: Action = {
        id: "spotify.here",
        title: "Play Spotify on this computer",
        risk: "safe",
        async run(ctx) {
            if (client.loggedIn) {
                try {
                    const pb = await client.playback();
                    if (pb?.is_playing && pb.device && !isThisPc(pb.device, config)) {
                        await moveHere(ctx, { config, client }, `from ${pb.device.name}`);
                        return;
                    }
                } catch (err) {
                    ctx.log.warn(`spotify: ${(err as Error).message}; playing locally instead`);
                }
            }
            await playApp(appName, app, { monitor }).run(ctx);
        },
    };

    const setFlag = (on: boolean): Action => ({
        id: `spotify.handoff.${on ? "on" : "off"}`,
        title: on ? "Move Spotify from speakers to this computer" : "Stop moving Spotify to this computer",
        risk: "safe",
        async run({ log }) {
            if (on) {
                mkdirSync(dirname(flag), { recursive: true });
                writeFileSync(flag, "");
                if (!client.loggedIn) log.warn("spotify handoff is on, but archnest isn't logged in: run `archnest spotify login`");
            } else rmSync(flag, { force: true });
        },
    });

    return [here, setFlag(true), setFlag(false)];
}

export function isThisPc(d: Pick<SpotifyDevice, "name" | "type">, config: Pick<Config, "spotify">): boolean {
    return d.name.toLowerCase() === (config.spotify.device ?? hostname()).toLowerCase();
}

export function shouldHandOff(d: Pick<SpotifyDevice, "name" | "type">, config: Pick<Config, "spotify">): boolean {
    if (isThisPc(d, config)) return false;
    const from = config.spotify.handoffFrom;
    if (from?.length) return from.some(n => n.toLowerCase() === d.name.toLowerCase());
    return !PERSONAL_TYPES.has(d.type.toLowerCase());
}

/** Transfers playback to this PC, starting the Spotify app first if it isn't a Connect device yet. */
async function moveHere(ctx: ActionContext, { config, client }: Pick<Deps, "config" | "client">, why: string) {
    const find = async () => (await client.devices()).find(d => d.id && isThisPc(d, config));
    let pc = await find();
    if (!pc) {
        const app = config.apps[config.spotify.app];
        const screen = config.spotify.screen;
        await openApp(config.spotify.app, app, { monitor: screen ? (config.screens[screen] ?? screen) : undefined }).run(ctx);
        const deadline = Date.now() + WAIT_FOR_DEVICE_MS;
        while (!(pc = await find())) {
            if (Date.now() > deadline) {
                const names = (await client.devices()).map(d => `${d.name} (${d.type})`).join(", ") || "none";
                throw new SpotifyError(
                    `this PC didn't show up in Spotify Connect within ${WAIT_FOR_DEVICE_MS / 1000} s; devices: ${names}. ` +
                        `Set spotify.device in the config to this PC's name there.`,
                    404,
                );
            }
            await sleep(1000);
        }
    }
    await client.transfer(pc.id!, true);
    ctx.log.info(`spotify: moved playback ${why} to ${pc.name}`);
}

/** Background loop for handoff mode. Polls only while the mode flag exists. */
export function startHandoff(deps: Deps & { ctx: ActionContext; log: Logger }) {
    const { config, client, statePath, ctx, log } = deps;
    const flag = handoffFlag(statePath);
    let busy = false;
    let pausedUntil = 0;
    let lastMove = 0;
    let warned = "";

    const tick = async () => {
        if (busy || Date.now() < pausedUntil || !existsSync(flag)) return;
        if (!client.loggedIn) {
            if (warned !== "login") log.warn("spotify handoff is on, but archnest isn't logged in: run `archnest spotify login`");
            warned = "login";
            return;
        }
        busy = true;
        try {
            const pb = await client.playback();
            if (pb?.is_playing && pb.device && shouldHandOff(pb.device, config) && Date.now() - lastMove > COOLDOWN_MS) {
                lastMove = Date.now();
                await moveHere(ctx, { config, client }, `from ${pb.device.name}`);
            }
            warned = "";
        } catch (err) {
            const e = err as SpotifyError;
            if (e.status === 429) pausedUntil = Date.now() + (e.retryAfterS ?? 30) * 1000;
            else if (e.status === 401 || e.status === 403) pausedUntil = Date.now() + 60_000;
            if (warned !== e.message) log.warn(`spotify handoff: ${e.message}`);
            warned = e.message;
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
}
