import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Executor } from "./core/executor.ts";

/**
 * Arch Linux for Claude: a fixed catalog of read-only topics and user-level operations.
 * Every argument is validated (package and unit names by pattern and by asking pacman or
 * systemd, paths must be inside $HOME) and single-quoted. Anything that needs root (updates,
 * installing, removing) only opens a terminal on the computer, where the owner types the
 * sudo password; Claude can never complete it alone.
 */

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
type Ctx = { exec: Executor };
const cap = async ({ exec }: Ctx, cmd: string, max = 6000) => {
    const out = (await exec.capture(`${cmd} 2>&1`)).trim();
    return out.length > max ? `${out.slice(0, max)}\n… (${out.length - max} more characters)` : out;
};

const PKG = /^[a-z0-9@._+-]{1,100}$/;
const UNIT = /^[A-Za-z0-9@._:-]{1,120}$/;

function homePath(p: string, kind: "file" | "dir" | "any" = "any"): string {
    const home = realpathSync(homedir());
    const raw = p.startsWith("~") ? join(homedir(), p.slice(1)) : p.startsWith("/") ? p : join(homedir(), p);
    if (!existsSync(raw)) throw new Error(`${p} doesn't exist`);
    const full = realpathSync(raw);
    if (full !== home && !full.startsWith(`${home}/`)) throw new Error("only paths inside your home directory");
    const st = statSync(full);
    if (kind === "file" && !st.isFile()) throw new Error(`${p} isn't a file`);
    if (kind === "dir" && !st.isDirectory()) throw new Error(`${p} isn't a directory`);
    return full;
}

type Topic = { description: string; arg?: { hint: string; pattern?: RegExp; optional?: boolean }; run(ctx: Ctx, arg?: string): Promise<string> };

export const SYSTEM_TOPICS: Record<string, Topic> = {
    overview: {
        description: "Kernel, uptime, CPU, memory, disks, temperatures, GPU, failed services, pending updates",
        run: async ctx =>
            [
                `kernel: ${await cap(ctx, "uname -r")}`,
                `uptime: ${await cap(ctx, "uptime -p")}`,
                `load: ${await cap(ctx, "cut -d' ' -f1-3 /proc/loadavg")}`,
                `cpu: ${await cap(ctx, "lscpu | sed -n 's/^Model name: *//p'")}`,
                `memory:\n${await cap(ctx, "free -h")}`,
                `disks:\n${await cap(ctx, "df -h -x tmpfs -x devtmpfs -x efivarfs --output=target,size,used,avail,pcent")}`,
                `temperatures:\n${await cap(ctx, "sensors -A 2>/dev/null | grep -E '°C' | head -20")}`,
                `gpu: ${await cap(ctx, "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null || echo none")}`,
                `failed units: ${(await cap(ctx, "systemctl --failed --no-legend --plain | awk '{print $1}'; systemctl --user --failed --no-legend --plain | awk '{print $1\" (user)\"}'")) || "none"}`,
                `updates: ${(await cap(ctx, "checkupdates 2>/dev/null | wc -l"))} pending in the repos`,
            ].join("\n"),
    },
    updates: {
        description: "Packages with updates waiting (repos and AUR)",
        run: async ctx => `repos:\n${(await cap(ctx, "checkupdates 2>/dev/null")) || "none"}\n\nAUR:\n${(await cap(ctx, "yay -Qua 2>/dev/null")) || "none"}`,
    },
    "package.search": {
        description: "Search the repos (and the AUR) for a package",
        arg: { hint: "search words", pattern: /^[\w .@+-]{2,60}$/ },
        run: async (ctx, a) => `repos:\n${(await cap(ctx, `pacman -Ss ${q(a!)} | head -40`, 4000)) || "nothing"}\n\nAUR:\n${(await cap(ctx, `yay -Ssa --topdown ${q(a!)} 2>/dev/null | head -20`, 2000)) || "nothing"}`,
    },
    "package.info": {
        description: "Details about a package (installed or in the repos)",
        arg: { hint: "package name", pattern: PKG },
        run: async (ctx, a) => (await cap(ctx, `pacman -Qi ${q(a!)} 2>/dev/null || pacman -Si ${q(a!)}`)) || `no package ${a}`,
    },
    "packages.installed": {
        description: "Explicitly installed packages (optionally filtered)",
        arg: { hint: "optional filter word", pattern: /^[\w.@+-]{1,40}$/, optional: true },
        run: async (ctx, a) => {
            const list = await cap(ctx, `pacman -Qe${a ? ` | grep -i ${q(a)}` : ""}`, 8000);
            return `${list || "none"}\n\n(total installed: ${await cap(ctx, "pacman -Qq | wc -l")})`;
        },
    },
    "packages.orphans": { description: "Packages nothing depends on anymore", run: async ctx => (await cap(ctx, "pacman -Qdtq")) || "none" },
    "packages.recent": { description: "Recently installed or upgraded packages", run: async ctx => cap(ctx, "grep -E '\\] (installed|upgraded|removed) ' /var/log/pacman.log | tail -30") },
    services: {
        description: "Running systemd services (system and user)",
        run: async ctx =>
            `system:\n${await cap(ctx, "systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}'", 3000)}\n\nuser:\n${await cap(ctx, "systemctl --user list-units --type=service --state=running --no-legend --plain | awk '{print $1}'", 2000)}`,
    },
    "service.status": {
        description: "Status of one service (system or user)",
        arg: { hint: "unit name, e.g. bluetooth or docker.service", pattern: UNIT },
        run: async (ctx, a) => (await cap(ctx, `systemctl --user status --no-pager -n 15 ${q(a!)} 2>/dev/null || systemctl status --no-pager -n 15 ${q(a!)}`)) || `no unit ${a}`,
    },
    errors: { description: "Errors in the system journal since boot", run: async ctx => (await cap(ctx, "journalctl -b -p err --no-pager -q -n 40 -o short-iso")) || "no errors since boot" },
    "logs": {
        description: "Recent log lines of one service (system or user)",
        arg: { hint: "unit name", pattern: UNIT },
        run: async (ctx, a) => (await cap(ctx, `journalctl --user -u ${q(a!)} -n 40 --no-pager -q -o short-iso 2>/dev/null | grep . || journalctl -u ${q(a!)} -n 40 --no-pager -q -o short-iso`)) || `no logs for ${a}`,
    },
    processes: {
        description: "Top processes by CPU and by memory",
        run: async ctx => `by CPU:\n${await cap(ctx, "ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu | head -12")}\n\nby memory:\n${await cap(ctx, "ps -eo pid,user,pcpu,pmem,rss,comm --sort=-rss | head -12")}`,
    },
    network: {
        description: "Addresses, default route, DNS, listening ports",
        run: async ctx =>
            [
                await cap(ctx, "ip -br addr"),
                `route: ${await cap(ctx, "ip route show default")}`,
                `dns: ${await cap(ctx, "resolvectl dns 2>/dev/null | grep -v '^Link [0-9]*.*:\\s*$' | head -5")}`,
                `listening:\n${await cap(ctx, "ss -tlnH | awk '{print $4}' | sort -u | head -30")}`,
            ].join("\n"),
    },
    ping: {
        description: "Is a host reachable? (4 pings)",
        arg: { hint: "hostname or IP", pattern: /^[A-Za-z0-9.:-]{1,253}$/ },
        run: async (ctx, a) => cap(ctx, `ping -c 4 -W 2 ${q(a!)} | tail -3`),
    },
    disks: { description: "Disks, partitions and usage", run: async ctx => `${await cap(ctx, "lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS")}\n\n${await cap(ctx, "df -h -x tmpfs -x devtmpfs -x efivarfs")}` },
    "disk.usage": {
        description: "The biggest folders inside a folder in your home",
        arg: { hint: "folder, e.g. ~ or ~/Downloads", optional: true },
        run: async (ctx, a) => cap(ctx, `du -xh --max-depth=1 ${q(homePath(a ?? "~", "dir"))} 2>/dev/null | sort -rh | head -20`),
    },
    "files.find": {
        description: "Find files by name in your home",
        arg: { hint: "part of the file name", pattern: /^[^/\0]{1,80}$/ },
        run: async (ctx, a) => (await cap(ctx, `fd --hidden --exclude .git --exclude node_modules --max-results 40 --fixed-strings ${q(a!)} ${q(homedir())}`)) || "nothing found",
    },
    "files.recent": {
        description: "Newest files in a folder (default ~/Downloads)",
        arg: { hint: "folder", optional: true },
        run: async (ctx, a) => cap(ctx, `ls -lt --time-style=+%Y-%m-%d\\ %H:%M ${q(homePath(a ?? "~/Downloads", "dir"))} | head -20`),
    },
    docker: { description: "Docker containers (all)", run: async ctx => (await cap(ctx, "docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null")) || "no containers (or Docker isn't running)" },
};

type Op = { description: string; arg?: { hint: string; pattern?: RegExp; optional?: boolean }; command(ctx: Ctx, arg?: string): Promise<string> };

/** A terminal on the computer running a command the owner then confirms there (sudo). */
const inTerminal = (title: string, cmd: string) =>
    `uwsm-app -- xdg-terminal-exec --app-id=org.omarchy.archclaw-${title} -e bash -c ${q(`${cmd}; echo; read -rp 'Done. Press Enter to close.'`)} >/dev/null 2>&1 &`;

async function userUnit(ctx: Ctx, unit: string): Promise<string> {
    if (!UNIT.test(unit)) throw new Error(`"${unit}" isn't a unit name`);
    const name = unit.includes(".") ? unit : `${unit}.service`;
    if (!(await ctx.exec.test(`systemctl --user cat ${q(name)} >/dev/null 2>&1`))) throw new Error(`no user service ${name}; system services need root and can't be changed from here`);
    if (/^archclaw/.test(name)) throw new Error("archclaw doesn't stop itself from here");
    return name;
}

export const SYSTEM_OPS: Record<string, Op> = {
    "service.start": { description: "Start one of your user services", arg: { hint: "user unit" }, command: async (c, a) => `systemctl --user start ${q(await userUnit(c, a!))}` },
    "service.stop": { description: "Stop one of your user services", arg: { hint: "user unit" }, command: async (c, a) => `systemctl --user stop ${q(await userUnit(c, a!))}` },
    "service.restart": { description: "Restart one of your user services", arg: { hint: "user unit" }, command: async (c, a) => `systemctl --user restart ${q(await userUnit(c, a!))}` },
    "process.end": {
        description: "Ask one of your own processes to quit (SIGTERM), by PID or exact name",
        arg: { hint: "PID or process name", pattern: /^([0-9]{2,8}|[A-Za-z0-9._-]{2,40})$/ },
        command: async (c, a) => {
            const me = (await c.exec.capture("id -un")).trim();
            if (/^\d+$/.test(a!)) {
                const owner = (await c.exec.capture(`ps -o user= -p ${a}`)).trim();
                if (!owner) throw new Error(`no process ${a}`);
                if (owner !== me) throw new Error(`process ${a} belongs to ${owner}, not you`);
                return `kill -TERM ${a}`;
            }
            if (["systemd", "Hyprland", "node", "uwsm", "pipewire", "wireplumber", "sshd", "dbus-daemon", "dbus-broker"].includes(a!)) throw new Error(`won't end ${a}: the desktop depends on it`);
            if (!(await c.exec.test(`pgrep -u ${q(me)} -x ${q(a!)} >/dev/null`))) throw new Error(`no process named ${a} of yours`);
            return `pkill -TERM -u ${q(me)} -x ${q(a!)}`;
        },
    },
    open: {
        description: "Open a file or folder in your home with its default app, or an https URL in the browser",
        arg: { hint: "path inside home, or https://…" },
        command: async (_c, a) => {
            if (/^https:\/\//i.test(a!)) {
                const u = new URL(a!);
                return `setsid -f xdg-open ${q(u.href)} >/dev/null 2>&1`;
            }
            const path = homePath(a!);
            const st = statSync(path);
            // Opening these can run code (launchers, scripts, programs), so they're never opened from here.
            if (st.isFile() && ((st.mode & 0o111) !== 0 || /\.(desktop|sh|bash|zsh|fish|py|pl|rb|appimage|jar|run|bin|exe|msi|deb|rpm)$/i.test(path))) {
                throw new Error(`won't open ${a}: it could run as a program`);
            }
            return `setsid -f xdg-open ${q(path)} >/dev/null 2>&1`;
        },
    },
    clipboard: { description: "Put text on the computer's clipboard", arg: { hint: "the text", pattern: /^[^\0]{1,5000}$/ }, command: async (_c, a) => `printf %s ${q(a!)} | wl-copy` },
    "updates.install": {
        description: "Open a terminal on the computer that updates the whole system (Omarchy's updater); the owner confirms with their password there",
        command: async () => inTerminal("update", "omarchy-update"),
    },
    "package.install": {
        description: "Open a terminal on the computer that installs a package (repos, or AUR via yay); the owner confirms there",
        arg: { hint: "package name", pattern: PKG },
        command: async (c, a) => {
            if (await c.exec.test(`pacman -Si ${q(a!)} >/dev/null 2>&1`)) return inTerminal("install", `sudo pacman -S ${q(a!)}`);
            if (await c.exec.test(`yay -Si ${q(a!)} >/dev/null 2>&1`)) return inTerminal("install", `yay -S ${q(a!)}`);
            throw new Error(`no package ${a} in the repos or the AUR`);
        },
    },
    "package.remove": {
        description: "Open a terminal on the computer that removes an installed package; the owner confirms there",
        arg: { hint: "package name", pattern: PKG },
        command: async (c, a) => {
            if (!(await c.exec.test(`pacman -Qq ${q(a!)} >/dev/null 2>&1`))) throw new Error(`${a} isn't installed`);
            return inTerminal("remove", `sudo pacman -Rns ${q(a!)}`);
        },
    },
    "packages.clean": {
        description: "Open a terminal on the computer that removes orphan packages and old package caches; the owner confirms there",
        command: async () => inTerminal("clean", "orphans=$(pacman -Qdtq); [ -n \"$orphans\" ] && sudo pacman -Rns $orphans; sudo paccache -rk2"),
    },
};

const check = (spec: { arg?: { hint: string; pattern?: RegExp; optional?: boolean } }, name: string, arg?: string) => {
    const a = arg?.trim() || undefined;
    if (!spec.arg) {
        if (a) throw new Error(`${name} takes no argument`);
        return undefined;
    }
    if (!a) {
        if (spec.arg.optional) return undefined;
        throw new Error(`${name} needs ${spec.arg.hint}`);
    }
    if (spec.arg.pattern && !spec.arg.pattern.test(a)) throw new Error(`${name}: use ${spec.arg.hint}`);
    return a;
};

export async function systemInfo(topic: string, arg: string | undefined, ctx: Ctx): Promise<string> {
    const t = SYSTEM_TOPICS[topic];
    if (!t) throw new Error(`unknown topic ${topic}`);
    return t.run(ctx, check(t, topic, arg));
}

export async function systemCommand(op: string, arg: string | undefined, ctx: Ctx): Promise<string> {
    const o = SYSTEM_OPS[op];
    if (!o) throw new Error(`unknown operation ${op}`);
    return o.command(ctx, check(o, op, arg));
}
