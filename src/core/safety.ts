import { uptime } from "node:os";
import type { Action, Source } from "./action.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./notifier.ts";

export type SafetyConfig = {
    countdownSeconds: number;
    /** Refuse confirm-level actions this soon after boot (guards against replayed commands). */
    bootGraceSeconds: number;
    /**
     * Remote (voice) requests for confirm-level actions must arrive twice within this many
     * seconds before the countdown starts, so one misheard phrase can't power off the PC.
     * 0 disables the check.
     */
    repeatWindowSeconds: number;
};

const MIN_REPEAT_GAP_MS = 3000;

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
    #armed: { actionId: string; at: number; until: number } | undefined;
    #now: () => number;

    constructor(
        config: SafetyConfig,
        notifier: Notifier,
        log: Logger,
        uptimeFn: () => number = uptime,
        now: () => number = Date.now,
    ) {
        this.#config = config;
        this.#notifier = notifier;
        this.#log = log;
        this.#uptime = uptimeFn;
        this.#now = now;
    }

    get pending(): string | undefined {
        return this.#pending?.actionId;
    }

    /** Resolves "proceed" once the countdown elapses, or why it didn't. */
    async gate(action: Action, source: Source): Promise<"proceed" | "cancelled" | "blocked" | "awaiting-repeat"> {
        if (action.risk === "safe") return "proceed";

        const up = this.#uptime();
        if (up < this.#config.bootGraceSeconds) {
            this.#log.warn(`blocked ${action.id} from ${source}: only ${Math.round(up)} s since boot`);
            this.#notifier.info("archnest ignored a command", `${action.title}: ignored because the computer just booted.`);
            return "blocked";
        }

        if (source === "matter" && this.#config.repeatWindowSeconds > 0) {
            const now = this.#now();
            const armed = this.#armed;
            // A repeat that follows within a few seconds is more likely one command delivered
            // twice than a person saying it again; it neither confirms nor re-arms.
            if (armed && armed.actionId === action.id && now - armed.at < MIN_REPEAT_GAP_MS) {
                return "awaiting-repeat";
            }
            if (!armed || armed.actionId !== action.id || now > armed.until) {
                this.#armed = { actionId: action.id, at: now, until: now + this.#config.repeatWindowSeconds * 1000 };
                this.#log.info(`${action.id} from ${source}: waiting for a repeat within ${this.#config.repeatWindowSeconds} s`);
                this.#notifier.info(
                    `Google Home asked: ${action.title}`,
                    `Nothing happens unless the same command comes again within ${this.#config.repeatWindowSeconds} seconds.`,
                );
                return "awaiting-repeat";
            }
            this.#armed = undefined;
        }

        this.cancelAll();
        const seconds = action.countdownSeconds ?? this.#config.countdownSeconds;
        if (seconds <= 0) return "proceed";

        this.#log.info(`${action.id} from ${source}: countdown ${seconds} s`);
        const notice = this.#notifier.countdown(
            `${action.title} in ${seconds} seconds`,
            `Requested via ${source === "matter" ? "Google Home" : source}. Press Cancel to stop.`,
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
        this.#armed = undefined;
        const p = this.#pending;
        if (!p) return 0;
        this.#log.info(`cancelling pending ${p.actionId}`);
        p.cancel();
        this.#notifier.info("archnest", "Cancelled.");
        return 1;
    }
}
