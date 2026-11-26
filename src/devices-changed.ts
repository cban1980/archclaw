import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slug, type Config } from "./config.ts";

export type DeviceChanges = { added: string[]; removed: string[] };

/**
 * Compares the devices in the config with the ones archnest exposed last time, and
 * remembers the current set. A renamed device is a new device to Google Home: it arrives
 * without a room (so Gemini won't control it by voice) and the old one lingers offline.
 * The first run after pairing reports nothing.
 */
export function diffDevices(config: Pick<Config, "devices">, statePath: string): DeviceChanges {
    const file = join(statePath, "devices.json");
    const current = config.devices.map(d => d.name);
    let previous: string[] | undefined;
    if (existsSync(file)) {
        try {
            previous = JSON.parse(readFileSync(file, "utf8")) as string[];
        } catch {}
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(current, null, 2));
    if (!previous) return { added: [], removed: [] };
    const before = new Set(previous.map(slug));
    const now = new Set(current.map(slug));
    return {
        added: current.filter(n => !before.has(slug(n))),
        removed: previous.filter(n => !now.has(slug(n))),
    };
}

/** What to tell the user, or nothing when the devices are unchanged. */
export function describeChanges(changes: DeviceChanges, room: string): string | undefined {
    const parts: string[] = [];
    if (changes.added.length) {
        parts.push(
            `New in Google Home: ${changes.added.join(", ")}. Put ${changes.added.length > 1 ? "them" : "it"} in the room "${room}" ` +
                `(Google Home app → device → settings → Room), or voice commands answer "set up your devices". ` +
                `Then run \`archnest routines --copy\` and paste it into the script editor.`,
        );
    }
    if (changes.removed.length) {
        parts.push(`Gone: ${changes.removed.join(", ")}. Remove ${changes.removed.length > 1 ? "them" : "it"} in the Google Home app if still listed.`);
    }
    return parts.length ? parts.join(" ") : undefined;
}
