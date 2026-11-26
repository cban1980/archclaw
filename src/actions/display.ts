import type { Action } from "../core/action.ts";

// Hyprland 0.56 moved dispatchers to Lua syntax; keep the old form as a fallback.
const dpms = (on: boolean) =>
    `hyprctl dispatch 'hl.dsp.dpms({ action = "${on ? "enable" : "disable"}" })' >/dev/null 2>&1 || hyprctl dispatch dpms ${on ? "on" : "off"}`;

export const displayActions: Action[] = [
    { id: "display.on", title: "Screens on", risk: "safe", run: async ({ exec }) => void (await exec.sh(dpms(true))) },
    { id: "display.off", title: "Screens off", risk: "safe", run: async ({ exec }) => void (await exec.sh(dpms(false))) },
];
