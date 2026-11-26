import type { Action } from "../core/action.ts";

// Prefer Omarchy's scripts (they close apps cleanly first); fall back to plain systemd.
const omarchyOr = (omarchy: string, fallback: string) =>
    `if command -v ${omarchy.split(" ")[0]} >/dev/null; then ${omarchy}; else ${fallback}; fi`;

export const powerActions: Action[] = [
    {
        id: "power.shutdown",
        title: "Shutting down",
        risk: "confirm",
        run: async ({ exec }) => {
            await exec.sh(omarchyOr("omarchy-system shutdown", "systemctl poweroff"));
        },
    },
    {
        id: "power.reboot",
        title: "Restarting",
        risk: "confirm",
        run: async ({ exec }) => {
            await exec.sh(omarchyOr("omarchy-system reboot", "systemctl reboot"));
        },
    },
    {
        id: "power.suspend",
        title: "Going to sleep",
        risk: "confirm",
        countdownSeconds: 10,
        run: async ({ exec }) => {
            await exec.sh("systemctl suspend");
        },
    },
    {
        id: "power.logout",
        title: "Logging out",
        risk: "confirm",
        run: async ({ exec }) => {
            await exec.sh(omarchyOr("omarchy-system logout", "loginctl terminate-session \"$XDG_SESSION_ID\""));
        },
    },
    {
        id: "power.lock",
        title: "Locking",
        risk: "safe",
        run: async ({ exec }) => {
            await exec.sh(omarchyOr("omarchy-system-lock", "loginctl lock-session"));
        },
    },
    {
        id: "power.cancel",
        title: "Cancel pending action",
        risk: "safe",
        run: async ({ cancelPending, log }) => {
            if (!cancelPending()) log.info("nothing pending to cancel");
        },
    },
];
