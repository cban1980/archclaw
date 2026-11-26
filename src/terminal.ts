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
