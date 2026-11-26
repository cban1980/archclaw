import type { Action } from "../core/action.ts";

// Commands lean on Omarchy's own scripts where they exist (so the bar/OSD stay in sync),
// with plain Linux fallbacks.

const sink = `"$(omarchy-audio-output-sink 2>/dev/null || echo @DEFAULT_SINK@)"`;

const safe = (id: string, title: string, command: string): Action => ({
    id,
    title,
    risk: "safe",
    run: async ({ exec }) => void (await exec.sh(command)),
});

export const mediaActions: Action[] = [
    safe("media.play", "Play", "playerctl play"),
    safe("media.pause", "Pause", "playerctl pause"),
    safe("media.playpause", "Play/pause", "playerctl play-pause"),
    safe("media.next", "Next track", "playerctl next"),
    safe("media.previous", "Previous track", "playerctl previous"),
];

export const volumeActions: Action[] = [
    {
        id: "volume.set",
        title: "Set volume",
        risk: "safe",
        run: async ({ exec, log }, params) => {
            const percent = Math.round(Math.min(100, Math.max(0, params?.percent ?? NaN)));
            if (Number.isNaN(percent)) return log.warn("volume.set needs a percent");
            await exec.sh(`pactl set-sink-mute ${sink} 0 && pactl set-sink-volume ${sink} ${percent}%`);
        },
    },
    safe("volume.mute", "Mute", `pactl set-sink-mute ${sink} 1`),
    safe("volume.unmute", "Unmute", `pactl set-sink-mute ${sink} 0`),
];

const nightlightOn = "omarchy-toggle-nightlight --status | jq -e .enabled >/dev/null";

export const desktopActions: Action[] = [
    safe("dnd.on", "Do not disturb on", "omarchy-shell notifications setDnd on"),
    safe("dnd.off", "Do not disturb off", "omarchy-shell notifications setDnd off"),
    // omarchy-toggle-nightlight only toggles, so check the state first.
    safe("nightlight.on", "Night light on", `${nightlightOn} || omarchy-toggle-nightlight`),
    safe("nightlight.off", "Night light off", `! ${nightlightOn} || omarchy-toggle-nightlight`),
    safe("awake.on", "Keep awake", "omarchy-toggle-idle stay-awake"),
    safe("awake.off", "Allow idle again", "omarchy-toggle-idle allow-idle"),
];
