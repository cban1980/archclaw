import { uptime } from "node:os";
import type { Action, Source } from "./action.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./notifier.ts";

export type SafetyConfig = {
    countdownSeconds: number;
    /** Refuse confirm-level actions this soon after boot (guards against replayed commands). */
    bootGraceSeconds: number;
};

type Pending = { actionId: string; cancel(): void };

/**
 * Gate for risky actions. Only one countdown runs at a time: a new risky request
 * replaces the pending one, and cancelAll() aborts it (e.g. "turn the PC back on").
 */
export class Safety {
    #pending: Pending | undefined;
    #config: SafetyConfig;
    #notifier: Notifier;
    #log: Logger;
    #uptime: () => number;

    constructor(
        config: SafetyConfig,
        notifier: Notifier,
        log: Logger,
        uptimeFn: () => number = uptime,
    ) {
        this.#config = config;
        this.#notifier = notifier;
        this.#log = log;
        this.#uptime = uptimeFn;
    }

    get pending(): string | undefined {
        return this.#pending?.actionId;
    }

    /** Resolves "proceed" once the countdown elapses, or why it didn't. */
    async gate(action: Action, source: Source): Promise<"proceed" | "cancelled" | "blocked"> {
        if (action.risk === "safe") return "proceed";

        const up = this.#uptime();
        if (up < this.#config.bootGraceSeconds) {
            this.#log.warn(`blocked ${action.id} from ${source}: only ${Math.round(up)} s since boot`);
            this.#notifier.info("archclaw ignored a command", `${action.title}: ignored because the computer just booted.`);
            return "blocked";
        }

        this.cancelAll();
        const seconds = action.countdownSeconds ?? this.#config.countdownSeconds;
        if (seconds <= 0) return "proceed";

        this.#log.info(`${action.id} from ${source}: countdown ${seconds} s`);
        const notice = this.#notifier.countdown(
            `${action.title} in ${seconds} seconds`,
            `Requested via ${source === "claude" ? "Claude" : source}. Press Cancel to stop.`,
            seconds,
        );

        return new Promise(resolve => {
            const finish = (result: "proceed" | "cancelled") => {
                if (this.#pending !== entry) return;
                this.#pending = undefined;
                clearTimeout(timer);
                notice.close();
                resolve(result);
            };
            const entry: Pending = { actionId: action.id, cancel: () => finish("cancelled") };
            const timer = setTimeout(() => finish("proceed"), seconds * 1000);
            this.#pending = entry;
            notice.cancelled.then(byUser => {
                if (byUser) {
                    this.#log.info(`${action.id} cancelled from notification`);
                    finish("cancelled");
                }
            });
        });
    }

    /** Aborts the pending countdown, if any. Returns how many were cancelled. */
    cancelAll(): number {
        const p = this.#pending;
        if (!p) return 0;
        this.#log.info(`cancelling pending ${p.actionId}`);
        p.cancel();
        this.#notifier.info("archclaw", "Cancelled.");
        return 1;
    }
}
