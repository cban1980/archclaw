import { closeApp, openApp, playApp } from "./actions/apps.ts";
import type { ActionRef, Config } from "./config.ts";
import type { Action } from "./core/action.ts";
import type { Registry } from "./core/dispatcher.ts";
import { OMARCHY_OPS, omarchyCommand } from "./omarchy.ts";
import { terminalAction } from "./terminal.ts";

/** Turns a config action reference into a runnable Action. Throws on unknown ids or apps. */
export function resolveRef(ref: ActionRef, registry: Registry, config: Pick<Config, "apps" | "screens"> & Partial<Pick<Config, "terminalPrograms">>): Action {
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
    if (typeof ref === "object" && "omarchy" in ref) return omarchyAction(ref.omarchy, ref.value);
    if (typeof ref === "object" && "terminal" in ref) {
        const monitor = ref.screen ? (config.screens[ref.screen] ?? ref.screen) : undefined;
        const req = { program: ref.terminal === "shell" ? undefined : ref.terminal, ssh: ref.ssh, dir: ref.dir, monitor };
        return {
            id: `terminal:${ref.terminal}${ref.ssh ? `@${ref.ssh}` : ""}`,
            title: `Terminal ${ref.terminal}`,
            risk: "safe",
            // Checked when it runs: what's installed and in ~/.ssh/config can change.
            run: async ctx => (await terminalAction(req, ctx.exec, config.terminalPrograms ?? {})).run(ctx),
        };
    }
    if (typeof ref === "object" && "close" in ref) {
        const app = config.apps[ref.close];
        if (!app) throw new Error(`unknown app "${ref.close}"`);
        return closeApp(ref.close, app);
    }
    return registry.resolve(ref);
}

/** The first app a reference opens (used to tell whether a scene is active). */
export function appOf(ref: ActionRef | undefined, config: Pick<Config, "apps">) {
    const refs = ref === undefined ? [] : Array.isArray(ref) ? ref : [ref];
    const open = refs.find(r => typeof r === "object" && "open" in r) as { open: string } | undefined;
    return open ? config.apps[open.open] : undefined;
}

/** An Omarchy operation as an Action; the value is validated when it runs (lists can change). */
export function omarchyAction(op: string, value?: string): Action {
    if (!OMARCHY_OPS[op]) throw new Error(`unknown Omarchy operation "${op}"`);
    return {
        id: `omarchy:${op}${value ? `=${value}` : ""}`,
        title: `${OMARCHY_OPS[op]!.description}${value ? `: ${value}` : ""}`,
        risk: "safe",
        async run(ctx) {
            const code = await ctx.exec.sh(await omarchyCommand(op, value, ctx));
            if (code) throw new Error(`exit ${code}`);
        },
    };
}
