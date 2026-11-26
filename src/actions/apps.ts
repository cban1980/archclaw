import type { Action } from "../core/action.ts";
import type { Executor } from "../core/executor.ts";

export type AppConfig = {
    /** Command that starts the app, e.g. "omarchy-launch-spotify". */
    launch: string;
    /** Matched (case-insensitive, whole word) against window class and title. */
    match: string;
};

type Client = { address: string; class: string; title: string; monitor: number };
type Monitor = { id: number; name: string };

const WAIT_FOR_WINDOW_MS = 20_000;
const POLL_MS = 400;

async function clients(exec: Executor): Promise<Client[]> {
    try {
        return JSON.parse(await exec.capture("hyprctl clients -j")) as Client[];
    } catch {
        return [];
    }
}

async function monitors(exec: Executor): Promise<Monitor[]> {
    try {
        return JSON.parse(await exec.capture("hyprctl monitors -j")) as Monitor[];
    } catch {
        return [];
    }
}

export function matches(app: AppConfig, c: Pick<Client, "class" | "title">): boolean {
    const re = new RegExp(`\\b${app.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(c.class) || re.test(c.title);
}

/** True while at least one window of the app exists. Used to keep Google Home in sync. */
export async function isAppRunning(exec: Executor, app: AppConfig): Promise<boolean> {
    return (await clients(exec)).some(c => matches(app, c));
}

const dispatch = (exec: Executor, lua: string, legacy: string) =>
    exec.sh(`hyprctl dispatch '${lua.replace(/'/g, `'\\''`)}' >/dev/null || hyprctl dispatch ${legacy}`);

const moveToMonitor = (exec: Executor, address: string, monitor: string) =>
    dispatch(
        exec,
        `hl.dsp.window.move({ monitor = "${monitor}", window = "address:${address}" })`,
        `movewindow mon:${monitor},address:${address}`,
    );

const focus = (exec: Executor, address: string) =>
    dispatch(exec, `hl.dsp.focus({ window = "address:${address}" })`, `focuswindow address:${address}`);

/**
 * Opens an app (or focuses it if already running, unless `alwaysNew`), then moves its
 * window to `monitor` when given.
 */
export function openApp(name: string, app: AppConfig, opts: { monitor?: string; alwaysNew?: boolean } = {}): Action {
    return {
        id: `app.open:${name}${opts.monitor ? `@${opts.monitor}` : ""}`,
        title: `Open ${name}`,
        risk: "safe",
        async run({ exec, log }) {
            if (opts.monitor && !(await monitors(exec)).some(m => m.name === opts.monitor)) {
                log.warn(`${name}: screen ${opts.monitor} not connected; opening on the current screen`);
                opts = { ...opts, monitor: undefined };
            }
            const before = (await clients(exec)).filter(c => matches(app, c));
            const existing = before[0];
            if (existing && !opts.alwaysNew) {
                if (opts.monitor) await moveToMonitor(exec, existing.address, opts.monitor);
                await focus(exec, existing.address);
                return;
            }

            await exec.sh(`setsid -f ${app.launch} >/dev/null 2>&1 </dev/null`);
            if (!opts.monitor) return;

            const known = new Set(before.map(c => c.address));
            const deadline = Date.now() + WAIT_FOR_WINDOW_MS;
            while (Date.now() < deadline) {
                const fresh = (await clients(exec)).find(c => matches(app, c) && !known.has(c.address));
                if (fresh) {
                    await moveToMonitor(exec, fresh.address, opts.monitor);
                    await focus(exec, fresh.address);
                    return;
                }
                await new Promise(r => setTimeout(r, POLL_MS));
            }
            log.warn(`${name}: no window appeared within ${WAIT_FOR_WINDOW_MS / 1000} s; left where it opened`);
        },
    };
}

/** Closes every window of an app. */
export function closeApp(name: string, app: AppConfig): Action {
    return {
        id: `app.close:${name}`,
        title: `Close ${name}`,
        risk: "safe",
        async run({ exec }) {
            for (const c of (await clients(exec)).filter(c => matches(app, c))) {
                await dispatch(exec, `hl.dsp.window.close({ window = "address:${c.address}" })`, `closewindow address:${c.address}`);
            }
        },
    };
}
