import { closeApp, openApp, playApp } from "./actions/apps.ts";
import type { ActionRef, Config } from "./config.ts";
import type { Action } from "./core/action.ts";
import type { Registry } from "./core/dispatcher.ts";

/** Turns a config action reference into a runnable Action. Throws on unknown ids or apps. */
export function resolveRef(ref: ActionRef, registry: Registry, config: Pick<Config, "apps" | "screens">): Action {
    if (Array.isArray(ref)) {
        const steps = ref.map(r => resolveRef(r, registry, config));
        if (steps.some(s => s.risk !== "safe")) throw new Error("lists can only contain safe actions");
        return {
            id: `scene:${steps.map(s => s.id).join("+")}`,
            title: steps.map(s => s.title).join(", "),
            risk: "safe",
            async run(ctx) {
                for (const step of steps) {
                    try {
                        await step.run(ctx);
                    } catch (err) {
                        ctx.log.error(`${step.id} failed: ${(err as Error).message}`);
                    }
                }
            },
        };
    }
    if (typeof ref === "object" && "open" in ref) {
        const app = config.apps[ref.open];
        if (!app) throw new Error(`unknown app "${ref.open}"`);
        const monitor = ref.screen ? (config.screens[ref.screen] ?? ref.screen) : undefined;
        return openApp(ref.open, app, { monitor, alwaysNew: ref.new });
    }
    if (typeof ref === "object" && "play" in ref) {
        const app = config.apps[ref.play];
        if (!app) throw new Error(`unknown app "${ref.play}"`);
        const monitor = ref.screen ? (config.screens[ref.screen] ?? ref.screen) : undefined;
        return playApp(ref.play, app, { monitor });
    }
    if (typeof ref === "object" && "close" in ref) {
        const app = config.apps[ref.close];
        if (!app) throw new Error(`unknown app "${ref.close}"`);
        return closeApp(ref.close, app);
    }
    return registry.resolve(ref);
}

/** The app a device opens, if its `on` is a single open action (used for live state). */
export function appOf(ref: ActionRef | undefined, config: Pick<Config, "apps">) {
    return ref && typeof ref === "object" && !Array.isArray(ref) && "open" in ref ? config.apps[ref.open] : undefined;
}
