import { normalize } from "../config.ts";
import type { HueClient, HueGroup, HueState } from "./client.ts";

/** What to change. Everything optional; only given fields are sent. */
export type HueChange = {
    on?: boolean;
    /** 0–100 %. 0 turns the light off. */
    brightness?: number;
    /** A color name (red, warm white…) or #rrggbb. */
    color?: string;
    /** Kelvin 2000–6500, or warm / neutral / cool / daylight. */
    temperature?: string | number;
    /** Fade time in seconds. */
    fadeSeconds?: number;
};

const NAMED: Record<string, string> = {
    red: "#ff0000", röd: "#ff0000", orange: "#ff7f00", yellow: "#ffd000", gul: "#ffd000", green: "#00ff00", grön: "#00ff00",
    cyan: "#00ffff", turkos: "#00ffff", blue: "#0000ff", blå: "#0000ff", purple: "#8000ff", lila: "#8000ff", violet: "#8000ff",
    pink: "#ff3fa0", rosa: "#ff3fa0", magenta: "#ff00ff", white: "#ffffff", vit: "#ffffff",
};
const TEMPS: Record<string, number> = {
    candle: 2000, warm: 2700, varm: 2700, "warm white": 2700, varmvit: 2700, neutral: 4000, cool: 5000, kall: 5000, "cool white": 5000, kallvit: 5000, daylight: 6500, dagsljus: 6500,
};

/** sRGB hex → CIE 1931 xy (Hue's recommended conversion, wide gamut D65). */
export function hexToXy(hex: string): { x: number; y: number } {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`"${hex}" isn't a color; use a name (${Object.keys(NAMED).filter(n => /^[a-z]+$/.test(n)).join(", ")}) or #rrggbb`);
    const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map(c => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92)) as [number, number, number];
    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z;
    if (sum === 0) return { x: 0.3127, y: 0.329 };
    const round = (n: number) => Math.round(n * 10000) / 10000;
    return { x: round(X / sum), y: round(Y / sum) };
}

export function toMirek(t: string | number): number {
    const kelvin = typeof t === "number" ? t : (TEMPS[normalize(t)] ?? Number.parseInt(String(t).replace(/k$/i, ""), 10));
    if (!Number.isFinite(kelvin) || kelvin < 1500 || kelvin > 7000) throw new Error(`"${t}" isn't a color temperature; use 2000–6500 (K) or warm, neutral, cool, daylight`);
    return Math.min(500, Math.max(153, Math.round(1_000_000 / kelvin)));
}

/** The CLIP v2 body for a change. */
export function changeBody(c: HueChange): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (c.brightness !== undefined) {
        const pct = Math.max(0, Math.min(100, c.brightness));
        if (pct === 0) body.on = { on: false };
        else {
            body.dimming = { brightness: pct };
            body.on = { on: true };
        }
    }
    if (c.on !== undefined) body.on = { on: c.on };
    if (c.color) {
        const key = normalize(c.color);
        body.color = { xy: hexToXy(NAMED[key] ?? NAMED[c.color.toLowerCase()] ?? c.color) };
        body.on ??= { on: true };
    }
    if (c.temperature !== undefined) {
        body.color_temperature = { mirek: toMirek(c.temperature) };
        body.on ??= { on: true };
    }
    if (c.fadeSeconds !== undefined) body.dynamics = { duration: Math.round(Math.max(0, Math.min(60, c.fadeSeconds)) * 1000) };
    if (!Object.keys(body).length) throw new Error("say what to change: on, brightness, color or temperature");
    return body;
}

type Target = { kind: "room" | "zone" | "light" | "all"; name: string; resource: "grouped_light" | "light"; id: string };

const groupedOf = (g: { services: Array<{ rid: string; rtype: string }> }) => g.services.find(s => s.rtype === "grouped_light")?.rid;

/** A room, zone or light by name (loose match), or "all". */
export function findTarget(state: HueState, name: string): Target {
    const key = normalize(name);
    if (["all", "alla", "allt", "everything", "hela hemmet", "home", "hemma"].includes(key)) {
        const id = state.home && groupedOf(state.home);
        if (!id) throw new Error("the bridge has no all-lights group");
        return { kind: "all", name: "all lights", resource: "grouped_light", id };
    }
    const candidates: Array<{ kind: Target["kind"]; name: string; resource: Target["resource"]; id?: string }> = [
        ...state.rooms.map(r => ({ kind: "room" as const, name: r.metadata?.name ?? "", resource: "grouped_light" as const, id: groupedOf(r) })),
        ...state.zones.map(z => ({ kind: "zone" as const, name: z.metadata?.name ?? "", resource: "grouped_light" as const, id: groupedOf(z) })),
        ...state.lights.map(l => ({ kind: "light" as const, name: l.metadata?.name ?? "", resource: "light" as const, id: l.id })),
    ];
    const hit =
        candidates.find(c => normalize(c.name) === key) ??
        candidates.find(c => normalize(c.name).includes(key) || key.includes(normalize(c.name)));
    if (!hit?.id) throw new Error(`no Hue room, zone or light "${name}"; rooms: ${state.rooms.map(r => r.metadata?.name).join(", ")}`);
    return { ...hit, id: hit.id } as Target;
}

function lightsIn(state: HueState, g: HueGroup): string[] {
    const ids = new Set<string>();
    for (const c of g.children) {
        if (c.rtype === "light") ids.add(c.rid);
        if (c.rtype === "device") for (const s of state.devices.find(d => d.id === c.rid)?.services ?? []) if (s.rtype === "light") ids.add(s.rid);
    }
    return [...ids];
}

/** A compact overview for Claude: rooms and zones with their lights, on/brightness, and scenes. */
export function summarize(state: HueState) {
    const light = (id: string) => {
        const l = state.lights.find(x => x.id === id);
        if (!l) return undefined;
        return {
            name: l.metadata?.name,
            on: l.on.on,
            ...(l.dimming ? { brightness: Math.round(l.dimming.brightness) } : {}),
            ...(l.color ? { color: true } : {}),
        };
    };
    const group = (g: HueGroup) => {
        const gl = state.groupedLights.find(x => x.id === groupedOf(g));
        return {
            name: g.metadata?.name,
            on: gl?.on?.on ?? false,
            ...(gl?.dimming ? { brightness: Math.round(gl.dimming.brightness) } : {}),
            lights: lightsIn(state, g).map(light).filter(Boolean),
            scenes: state.scenes.filter(s => s.group.rid === g.id).map(s => s.metadata?.name),
        };
    };
    return { rooms: state.rooms.map(group), zones: state.zones.map(group) };
}

/** Applies a change to a room, zone, light or all lights. Returns what was changed. */
export async function applyChange(client: HueClient, target: string, change: HueChange): Promise<string> {
    const state = await client.state();
    const t = findTarget(state, target);
    await client.put(t.resource, t.id, changeBody(change));
    return `${t.kind === "all" ? "all lights" : `${t.kind} ${t.name}`}: ${describe(change)}`;
}

/** Recalls a Hue scene by name, optionally within a room/zone. */
export async function recallScene(client: HueClient, scene: string, room?: string): Promise<string> {
    const state = await client.state();
    let scenes = state.scenes;
    if (room) {
        const t = findTarget(state, room);
        const group = [...state.rooms, ...state.zones].find(g => groupedOf(g) === t.id);
        if (group) scenes = scenes.filter(s => s.group.rid === group.id);
    }
    const key = normalize(scene);
    const hit = scenes.find(s => normalize(s.metadata?.name ?? "") === key) ?? scenes.find(s => normalize(s.metadata?.name ?? "").includes(key));
    if (!hit) throw new Error(`no Hue scene "${scene}"${room ? ` in ${room}` : ""}; scenes: ${scenes.map(s => s.metadata?.name).join(", ")}`);
    await client.put("scene", hit.id, { recall: { action: "active" } });
    const where = [...state.rooms, ...state.zones].find(g => g.id === hit.group.rid)?.metadata?.name;
    return `scene ${hit.metadata?.name}${where ? ` in ${where}` : ""}`;
}

function describe(c: HueChange): string {
    const parts: string[] = [];
    if (c.on !== undefined) parts.push(c.on ? "on" : "off");
    if (c.brightness !== undefined) parts.push(c.brightness === 0 ? "off" : `${c.brightness}%`);
    if (c.color) parts.push(c.color);
    if (c.temperature !== undefined) parts.push(`${c.temperature}`);
    return parts.join(", ");
}

let shared: HueClient | undefined;
/** The service's Hue client, for scene steps (set once at startup). */
export const setHueClient = (c: HueClient) => void (shared = c);
export const hueClient = () => {
    if (!shared?.paired) throw new Error("not paired with a Hue bridge; run `archclaw hue pair` on the computer");
    return shared;
};
