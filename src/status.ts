import { clients, isAppRunning, matches, monitors } from "./actions/apps.ts";
import type { Config } from "./config.ts";
import type { Executor } from "./core/executor.ts";
import { appOf } from "./resolve.ts";

const sink = `"$(omarchy-audio-output-sink 2>/dev/null || echo @DEFAULT_SINK@)"`;

/** Scenes that are on right now: their probe passes, or (without one) the first app they open is running. */
export async function activeScenes(exec: Executor, config: Pick<Config, "scenes" | "apps">): Promise<string[]> {
    const on = await Promise.all(
        config.scenes.map(async s => {
            if (s.probe) return exec.test(s.probe);
            const app = appOf(s.start, config);
            return app ? isAppRunning(exec, app) : false;
        }),
    );
    return config.scenes.filter((_, i) => on[i]).map(s => s.name);
}

/** A snapshot of the computer for Claude: what's on, what's playing, which windows are where. */
export async function computerStatus(exec: Executor, config: Config, extra: { pendingCountdown?: string } = {}) {
    const [locked, mons, wins, volume, muted, players, dnd, nightlight, awake, scenes] = await Promise.all([
        exec.test("omarchy-hyprland-session-locked 2>/dev/null || pgrep -x hyprlock >/dev/null"),
        monitors(exec),
        clients(exec),
        exec.capture(`LC_ALL=C pactl get-sink-volume ${sink} | awk 'NR==1{for(i=1;i<=NF;i++) if($i ~ /%$/){sub("%","",$i); print $i; exit}}'`),
        exec.test(`LC_ALL=C pactl get-sink-mute ${sink} | grep -q 'Mute: yes'`),
        exec.capture(`playerctl -a metadata --format '{{playerName}}\t{{status}}\t{{artist}}\t{{title}}' 2>/dev/null`),
        exec.capture("omarchy-shell notifications isDnd 2>/dev/null"),
        exec.test("omarchy-toggle-nightlight --status 2>/dev/null | jq -e .enabled >/dev/null"),
        exec.test("omarchy-toggle-idle status 2>/dev/null | jq -e .enabled >/dev/null"),
        activeScenes(exec, config),
    ]);
    const monitorName = new Map(mons.map(m => [m.id, m.name]));
    const screenName = (monitor: string) => Object.entries(config.screens).filter(([, m]) => m === monitor).map(([n]) => n);
    return {
        computer: config.name,
        locked,
        screensOn: mons.length > 0 && mons.every(m => m.dpmsStatus !== false),
        volumePercent: Number.parseInt(volume.trim(), 10) || 0,
        muted,
        media: players
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(line => {
                const [player, status, artist, title] = line.split("\t");
                return { player, status, artist, title };
            }),
        doNotDisturb: dnd.trim() === "on",
        nightLight: nightlight,
        keepAwake: awake,
        activeScenes: scenes,
        appsOpen: Object.entries(config.apps)
            .filter(([, a]) => wins.some(w => matches(a, w)))
            .map(([k]) => k),
        monitors: mons.map(m => ({ name: m.name, screens: screenName(m.name), width: m.width, height: m.height, x: m.x, focused: m.focused })),
        windows: wins.map(w => ({
            address: w.address,
            class: w.class,
            title: w.title,
            monitor: monitorName.get(w.monitor),
            app: Object.entries(config.apps).find(([, a]) => matches(a, w))?.[0],
        })),
        ...(extra.pendingCountdown ? { pendingCountdown: extra.pendingCountdown } : {}),
    };
}
