import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openApp } from "./actions/apps.ts";
import type { Action } from "./core/action.ts";
import type { Executor } from "./core/executor.ts";

/**
 * Terminals that run a program. Claude picks a program by name; the command line is
 * fixed here (built-in TUIs) or in the owner's config (`terminalPrograms`), never written
 * by Claude. ssh only goes to hosts from ~/.ssh/config, and directories must exist
 * inside the home directory.
 */

/** Interactive terminal programs Claude may start when they're installed, with no arguments. */
export const BUILTIN_TUIS: Record<string, string> = {
    btop: "system monitor",
    htop: "process viewer",
    nvtop: "GPU monitor",
    nvim: "Neovim editor",
    hx: "Helix editor",
    nano: "simple editor",
    lazygit: "git UI (open it in a repository directory)",
    lazydocker: "Docker UI",
    yazi: "file manager",
    ranger: "file manager",
    mc: "Midnight Commander file manager",
    ncdu: "disk usage",
    gdu: "disk usage",
    k9s: "Kubernetes UI",
    tmux: "terminal multiplexer",
    herdr: "Omarchy's terminal workspace",
    impala: "Wi-Fi manager",
    wiremix: "audio mixer",
    bluetui: "Bluetooth manager",
    spotify_player: "Spotify in the terminal",
    claude: "Claude Code",
    opencode: "opencode AI coding agent",
};

export type TerminalRequest = {
    /** A built-in TUI, a key of `terminalPrograms`, or undefined for a plain shell. */
    program?: string;
    /** ssh to this host (from ~/.ssh/config) instead of running a program locally. */
    ssh?: string;
    /** Working directory, inside $HOME. */
    dir?: string;
    /** Monitor name to put the window on. */
    monitor?: string;
};

/** Concrete Host entries from ~/.ssh/config (no wildcards). */
export function sshHosts(path = join(homedir(), ".ssh/config")): string[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
        .split("\n")
        .map(l => /^\s*Host\s+(.+)$/i.exec(l)?.[1])
        .filter((h): h is string => Boolean(h))
        .flatMap(h => h.trim().split(/\s+/))
        .filter(h => !/[*?!]/.test(h));
}

/** Programs Claude may start: installed built-ins plus the owner's own. */
export async function availablePrograms(exec: Executor, custom: Record<string, string>) {
    const installed = await Promise.all(Object.keys(BUILTIN_TUIS).map(async p => [p, await exec.test(`command -v ${p} >/dev/null`)] as const));
    return {
        builtin: Object.fromEntries(installed.filter(([, ok]) => ok).map(([p]) => [p, BUILTIN_TUIS[p]!])),
        custom,
    };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shell";

function safeDir(dir: string): string {
    const home = realpathSync(homedir());
    const full = realpathSync(dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir.startsWith("/") ? dir : join(homedir(), dir));
    if (full !== home && !full.startsWith(`${home}/`)) throw new Error("the directory must be inside your home directory");
    if (!statSync(full).isDirectory()) throw new Error(`${dir} isn't a directory`);
    return full;
}

/** Builds the Action that opens the terminal. Throws on anything not allowed. */
export async function terminalAction(req: TerminalRequest, exec: Executor, custom: Record<string, string>): Promise<Action> {
    if (req.program && req.ssh) throw new Error("give either a program or an ssh host, not both");
    let command = "";
    let name = "shell";
    if (req.ssh) {
        const host = sshHosts().find(h => h.toLowerCase() === req.ssh!.toLowerCase());
        if (!host) throw new Error(`"${req.ssh}" isn't a host in ~/.ssh/config; hosts: ${sshHosts().join(", ") || "none"}`);
        command = `ssh ${q(host)}`;
        name = `ssh-${host}`;
    } else if (req.program) {
        const key = Object.keys(custom).find(k => k.toLowerCase() === req.program!.toLowerCase());
        if (key) {
            command = custom[key]!; // the owner's own command line
            name = key;
        } else if (BUILTIN_TUIS[req.program] && (await exec.test(`command -v ${req.program} >/dev/null`))) {
            command = req.program;
            name = req.program;
        } else {
            const { builtin } = await availablePrograms(exec, custom);
            throw new Error(`"${req.program}" isn't allowed or installed; programs: ${[...Object.keys(builtin), ...Object.keys(custom)].join(", ")}`);
        }
    }
    const dir = req.dir ? safeDir(req.dir) : undefined;
    // A distinct app id per program, so archclaw can find the new window and move it.
    const appId = `org.omarchy.archclaw-${slug(name)}`;
    const launch = `uwsm-app -- xdg-terminal-exec --app-id=${appId}${dir ? ` --dir=${q(dir)}` : ""}${command ? ` -e ${command}` : ""}`;
    return {
        ...openApp(`terminal:${name}`, { launch, match: `archclaw-${slug(name)}` }, { monitor: req.monitor, alwaysNew: true }),
        title: `Terminal${command ? ` running ${name}` : ""}${dir ? ` in ${dir}` : ""}`,
    };
}

/** Privilege escalation is never run from Claude, whatever the mode. */
const ELEVATE = /(^|[\s;&|(`$])(sudo|su|doas|pkexec|run0)(\s|$)/;

/**
 * A visible terminal running a free-form command as the owner. The command travels in an
 * environment variable (never spliced into shell text by us), is printed at the top, and the
 * terminal stays open afterwards with its exit status. In confirm mode it waits for Enter.
 */
export function commandAction(
    req: { command: string; dir?: string; monitor?: string; mode: "confirm" | "allow" },
): Action {
    const command = req.command.trim();
    if (!command || command.length > 2000 || command.includes("\0")) throw new Error("give a command (up to 2000 characters)");
    if (ELEVATE.test(command)) throw new Error("commands with sudo/su/doas/pkexec aren't run from here; use system_do for updates and packages");
    const dir = req.dir ? safeDir(req.dir) : realpathSync(homedir());
    const script = [
        `printf '\\033[1;33m▶ Claude runs:\\033[0m %s\\n\\033[2m  in %s\\033[0m\\n\\n' "$ARCHCLAW_CMD" "$PWD"`,
        req.mode === "confirm" ? `read -rp $'Press Enter to run it, Ctrl+C to cancel. ' || exit 1` : "",
        `bash -lc "$ARCHCLAW_CMD"; status=$?`,
        `printf '\\n\\033[2m[exit %s] This terminal stays open.\\033[0m\\n' "$status"`,
        `exec bash -l`,
    ]
        .filter(Boolean)
        .join("; ");
    const appId = "org.omarchy.archclaw-command";
    const launch = `env ARCHCLAW_CMD=${q(command)} uwsm-app -- xdg-terminal-exec --app-id=${appId} --dir=${q(dir)} -e bash -c ${q(script)}`;
    const base = openApp("terminal:command", { launch, match: "archclaw-command" }, { monitor: req.monitor, alwaysNew: true });
    return {
        ...base,
        id: `terminal.command:${command.slice(0, 60)}`,
        title: `Run in a terminal: ${command.slice(0, 80)}`,
        async run(ctx) {
            await ctx.exec.sh(`notify-send -a archclaw ${q("Claude runs a command")} ${q(command.slice(0, 300))} 2>/dev/null || true`);
            await base.run(ctx);
        },
    };
}
