import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument } from "yaml";

type Monitor = { name: string; x: number };

const INVALID = new Set([0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321]);

/** Screen names by position, left to right. */
export function nameScreens(monitors: Monitor[]): Record<string, string> {
    const sorted = [...monitors].sort((a, b) => a.x - b.x).map(m => m.name);
    const labels =
        sorted.length === 1 ? ["main"]
        : sorted.length === 2 ? ["left", "right"]
        : sorted.length === 3 ? ["left", "middle", "right"]
        : sorted.map((_, i) => `screen${i + 1}`);
    return Object.fromEntries(sorted.map((name, i) => [labels[i], name]));
}

export function randomPasscode(): number {
    for (;;) {
        const p = randomInt(1, 99999999);
        if (!INVALID.has(p)) return p;
    }
}

/**
 * Writes a config from the example: your monitors, a random pairing passcode and
 * discriminator, and the given name. Refuses to overwrite unless `force`.
 */
export function initConfig(opts: { examplePath: string; target: string; name?: string; monitors: Monitor[]; force?: boolean }) {
    if (existsSync(opts.target) && !opts.force) return { written: false as const };
    const doc = parseDocument(readFileSync(opts.examplePath, "utf8"));
    if (opts.name) doc.setIn(["name"], opts.name);
    if (opts.monitors.length) doc.setIn(["screens"], doc.createNode(nameScreens(opts.monitors)));
    doc.setIn(["matter", "passcode"], randomPasscode());
    doc.setIn(["matter", "discriminator"], randomInt(0, 4096));
    mkdirSync(dirname(opts.target), { recursive: true });
    writeFileSync(opts.target, doc.toString(), { mode: 0o600 });
    return { written: true as const, screens: nameScreens(opts.monitors) };
}
