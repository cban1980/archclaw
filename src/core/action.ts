import type { Executor } from "./executor.ts";
import type { Logger } from "./log.ts";

/** safe: runs immediately. confirm: announced with a cancellable countdown first. */
export type Risk = "safe" | "confirm";

export type ActionContext = {
    exec: Executor;
    log: Logger;
    /** Cancels any pending countdowns. */
    cancelPending(): number;
};

/** Extra input some actions take, e.g. a volume level. */
export type ActionParams = { percent?: number };

export type Action = {
    id: string;
    /** Human phrasing for notifications, e.g. "Shutting down". */
    title: string;
    risk: Risk;
    /** Overrides the global countdown for confirm-level actions. */
    countdownSeconds?: number;
    run(ctx: ActionContext, params?: ActionParams): Promise<void>;
};

/** Where a request came from; shown in notifications and the audit log. */
export type Source = "claude" | "cli" | "test";

export type Outcome = "ran" | "cancelled" | "blocked" | "failed";
