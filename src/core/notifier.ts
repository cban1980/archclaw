import { spawn } from "node:child_process";

export type Countdown = {
    /** Resolves true if the user pressed Cancel in the notification. */
    cancelled: Promise<boolean>;
    close(): void;
};

export type Notifier = {
    info(summary: string, body?: string): void;
    countdown(summary: string, body: string, seconds: number): Countdown;
};

/** Desktop notifications via notify-send (mako/swaync both support actions). */
export function createDesktopNotifier(): Notifier {
    return {
        info(summary, body = "") {
            spawn("notify-send", ["-a", "archclaw", summary, body], { stdio: "ignore" }).on("error", () => {});
        },
        countdown(summary, body, seconds) {
            const child = spawn(
                "notify-send",
                ["-a", "archclaw", "-u", "critical", "-t", String(seconds * 1000), "-A", "cancel=Cancel", summary, body],
                { stdio: ["ignore", "pipe", "ignore"] },
            );
            let out = "";
            child.stdout.on("data", d => (out += d));
            const cancelled = new Promise<boolean>(resolve => {
                child.on("exit", () => resolve(out.trim() === "cancel"));
                child.on("error", () => resolve(false));
            });
            return { cancelled, close: () => child.kill() };
        },
    };
}
