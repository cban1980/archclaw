import type { Action, ActionContext, ActionParams, Outcome, Source } from "./action.ts";
import type { Executor } from "./executor.ts";
import type { Logger } from "./log.ts";
import type { Safety } from "./safety.ts";

/** Basic reference: a registered action id, or a raw shell command. See resolve.ts for the rest. */
export type BasicRef = string | { run: string };

export class Registry {
    #actions = new Map<string, Action>();

    add(...actions: Action[]): this {
        for (const a of actions) {
            if (this.#actions.has(a.id)) throw new Error(`duplicate action id ${a.id}`);
            this.#actions.set(a.id, a);
        }
        return this;
    }

    get(id: string): Action | undefined {
        return this.#actions.get(id);
    }

    list(): Action[] {
        return [...this.#actions.values()];
    }

    /** Turns a config reference into an Action, failing fast on unknown ids. */
    resolve(ref: BasicRef): Action {
        if (typeof ref === "string") {
            const action = this.get(ref);
            if (!action) throw new Error(`unknown action "${ref}" (use { run: "..." } for shell commands)`);
            return action;
        }
        return {
            id: `shell:${ref.run}`,
            title: ref.run,
            risk: "safe",
            run: async ctx => {
                await ctx.exec.sh(ref.run);
            },
        };
    }
}

export class Dispatcher {
    #safety: Safety;
    #ctx: ActionContext;
    #log: Logger;

    constructor(safety: Safety, exec: Executor, log: Logger) {
        this.#safety = safety;
        this.#log = log;
        this.#ctx = { exec, log, cancelPending: () => safety.cancelAll() };
    }

    async dispatch(action: Action, source: Source, params?: ActionParams): Promise<Outcome> {
        this.#log.info(`request ${action.id}${params?.percent !== undefined ? ` ${params.percent}%` : ""} from ${source}`);
        const verdict = await this.#safety.gate(action, source);
        if (verdict !== "proceed") return verdict;
        try {
            await action.run(this.#ctx, params);
            return "ran";
        } catch (err) {
            this.#log.error(`${action.id} failed: ${(err as Error).message}`);
            return "failed";
        }
    }
}
