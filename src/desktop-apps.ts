import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalize } from "./config.ts";
import { classFromDesktopId } from "./init.ts";

export type DesktopApp = { id: string; name: string; wmClass?: string; exec?: string; comment?: string };

/** Desktop entry ids are file names like "spotify.desktop"; nothing a shell would interpret. */
export const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/;

function dataDirs(): string[] {
    const home = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
    const system = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(Boolean);
    return [home, ...system].map(d => join(d, "applications"));
}

function parseEntry(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    let inMain = false;
    for (const line of text.split("\n")) {
        if (line.startsWith("[")) {
            inMain = line.trim() === "[Desktop Entry]";
            continue;
        }
        if (!inMain) continue;
        const eq = line.indexOf("=");
        if (eq > 0) {
            const key = line.slice(0, eq).trim();
            if (!(key in out)) out[key] = line.slice(eq + 1).trim();
        }
    }
    return out;
}

/** Installed, visible applications. Entries in the user's directory override system ones. */
export function installedApps(dirs = dataDirs()): DesktopApp[] {
    const seen = new Map<string, DesktopApp>();
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
            if (!file.endsWith(".desktop") || seen.has(file)) continue;
            let e: Record<string, string>;
            try {
                e = parseEntry(readFileSync(join(dir, file), "utf8"));
            } catch {
                continue;
            }
            if (e.Type !== "Application" || e.NoDisplay === "true" || e.Hidden === "true" || !e.Name) {
                seen.set(file, undefined as never); // still shadows the system entry
                continue;
            }
            seen.set(file, {
                id: file,
                name: e.Name,
                ...(e.StartupWMClass ? { wmClass: e.StartupWMClass } : {}),
                ...(e.Exec ? { exec: e.Exec } : {}),
                ...(e.Comment ? { comment: e.Comment } : {}),
            });
        }
    }
    return [...seen.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

/** Apps whose name, id or description contains every word of the query. */
export function findApps(query: string, apps = installedApps()): DesktopApp[] {
    const words = normalize(query).split(" ").filter(Boolean);
    return apps.filter(a => {
        const hay = normalize(`${a.name} ${a.id} ${a.comment ?? ""} ${a.wmClass ?? ""}`);
        return words.every(w => hay.includes(w));
    });
}

/** The launch command and window match for a desktop entry, so Claude never writes shell. */
export function appFromDesktopId(id: string, apps = installedApps()) {
    if (!DESKTOP_ID.test(id)) throw new Error(`"${id}" is not a desktop entry id (like spotify.desktop)`);
    const entry = apps.find(a => a.id === id);
    if (!entry) throw new Error(`no installed app "${id}"; use find_installed_apps`);
    return { launch: `uwsm-app -- ${id}`, match: entry.wmClass ?? classFromDesktopId(id), name: entry.name };
}

/** A web app (Omarchy's omarchy-launch-webapp) for an https URL. */
export function webAppLaunch(url: string): string {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("web apps need an https:// URL");
    // Single-quote for the shell; URL() has already percent-encoded anything unusual, but be strict anyway.
    if (/['\s\\]/.test(u.href)) throw new Error("unsupported characters in the URL");
    return `omarchy-launch-webapp '${u.href}'`;
}
