import { spawn } from "node:child_process";
import type { Executor } from "./core/executor.ts";

/**
 * Omarchy's own commands, exposed to Claude as a fixed catalog. Every value Claude passes is
 * checked against an enum, a pattern or a live list (themes, fonts, outputs, devices) and then
 * single-quoted, so no request can turn into arbitrary shell.
 */

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type Ctx = { exec: Executor };
type Value = {
    /** What to pass, for the tool description. */
    hint: string;
    /** Allowed values (case-insensitive), or a pattern, or a live list. */
    oneOf?: string[];
    pattern?: RegExp;
    list?: (ctx: Ctx) => Promise<string[]>;
    optional?: boolean;
};
export type OmarchyOp = {
    description: string;
    value?: Value;
    /** The command line for a validated value. */
    command(value: string | undefined, ctx: Ctx): Promise<string> | string;
};

const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
const listThemes = async ({ exec }: Ctx) => lines(await exec.capture("omarchy-theme-list"));
const listFonts = async ({ exec }: Ctx) => lines(await exec.capture("omarchy-font-list"));

type Sink = { name: string; description: string; id: string };
async function sinks({ exec }: Ctx): Promise<Sink[]> {
    try {
        const all = JSON.parse(await exec.capture("LC_ALL=C pactl -f json list sinks")) as Array<{
            name: string;
            description?: string;
            properties?: Record<string, string>;
        }>;
        return all.map(s => ({ name: s.name, description: s.description ?? s.name, id: s.properties?.["object.id"] ?? "" }));
    } catch {
        return [];
    }
}

type BtDevice = { address: string; name: string };
async function btDevices({ exec }: Ctx, filter = ""): Promise<BtDevice[]> {
    return lines(await exec.capture(`bluetoothctl devices ${filter} 2>/dev/null`))
        .map(l => /^Device ([0-9A-F:]{17}) (.*)$/i.exec(l))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map(m => ({ address: m[1]!.toUpperCase(), name: m[2]! }));
}
const btByNameOrAddress = async (ctx: Ctx, v: string) => {
    const all = await btDevices(ctx);
    return all.find(d => d.address === v.toUpperCase()) ?? all.find(d => d.name.toLowerCase() === v.toLowerCase()) ?? all.find(d => d.name.toLowerCase().includes(v.toLowerCase()));
};

const onOff = { hint: "on or off", oneOf: ["on", "off"] } satisfies Value;

export const OMARCHY_OPS: Record<string, OmarchyOp> = {
    // ── look and feel ──
    "theme.set": { description: "Switch the desktop theme", value: { hint: "a theme name from omarchy_info themes", list: listThemes }, command: v => `omarchy-theme-set ${q(v!)}` },
    "background.next": { description: "Next wallpaper of the current theme", command: () => "omarchy-theme-bg-next" },
    "font.set": { description: "Set the monospace font (terminals, bar)", value: { hint: "a font from omarchy_info fonts", list: listFonts }, command: v => `omarchy-font-set ${q(v!)}` },
    "text.size": {
        description: "Text size everywhere (shell, GTK apps, terminals)",
        value: { hint: "9-20 (px; 12 is default) or reset", pattern: /^(9|1\d|20|reset)$/ },
        command: v => `omarchy-display-text-size ${v}`,
    },
    "windows.transparency": { description: "How see-through windows are", value: { hint: "opaque, transparent or glassy", oneOf: ["opaque", "transparent", "glassy"] }, command: v => `omarchy-hyprland-window-transparency ${v}` },
    animations: { description: "Animations, blur and shadows", value: onOff, command: v => `omarchy-toggle-animations ${v}` },
    // omarchy-toggle-bar's flag means "hidden": on hides, off shows.
    bar: { description: "Show or hide the top bar", value: { hint: "show or hide", oneOf: ["show", "hide"] }, command: v => `omarchy-toggle-bar ${v === "hide" ? "on" : "off"}` },
    "fullscreen.desktop": { description: "Hide the bar and remove gaps together (or back)", value: onOff, command: v => `omarchy-toggle-fullscreen-desktop ${v}` },
    "gaps.toggle": { description: "Toggle window gaps", command: () => "omarchy-hyprland-window-gaps-toggle" },
    screensaver: { description: "Start the screensaver now", command: () => "omarchy-launch-screensaver" },

    // ── windows and workspaces ──
    "window.fullscreen": { description: "Toggle fullscreen for the focused window (focus one first with focus_window)", command: () => "omarchy-hyprland-window-tiled-fullscreen-toggle" },
    "window.float": { description: "Toggle floating for the focused window", command: () => `hyprctl dispatch 'hl.dsp.window.float({ action = "toggle" })' >/dev/null || hyprctl dispatch togglefloating` },
    "window.minimize": { description: "Minimize a window to the dock", value: { hint: "window address from get_status", pattern: /^0x[0-9a-f]+$/i }, command: v => `omarchy-hyprland-window-minimize ${v}` },
    "windows.close_all": { description: "Close every open window (unsaved work may be lost)", command: () => "omarchy-hyprland-window-close-all" },
    "workspace.go": {
        description: "Switch to a workspace",
        value: { hint: "workspace number 1-10", pattern: /^([1-9]|10)$/ },
        command: v => `hyprctl dispatch 'hl.dsp.focus({ workspace = "${v}" })' >/dev/null || hyprctl dispatch workspace ${v}`,
    },
    "window.to_workspace": {
        description: "Move the focused window to a workspace",
        value: { hint: "workspace number 1-10", pattern: /^([1-9]|10)$/ },
        command: v => `hyprctl dispatch 'hl.dsp.window.move({ workspace = "${v}" })' >/dev/null || hyprctl dispatch movetoworkspace ${v}`,
    },
    "workspace.layout": { description: "Cycle the current workspace's layout (dwindle, scrolling, floating)", command: () => "omarchy-hyprland-workspace-layout-toggle" },

    // ── sound ──
    "audio.output": {
        description: "Use another audio output (speakers, headset, HDMI)",
        value: { hint: "an output name or description from omarchy_info audio, or next", optional: true },
        async command(v, ctx) {
            if (!v || v === "next") return "omarchy-audio-output-switch";
            const all = await sinks(ctx);
            const s = all.find(x => x.name === v) ?? all.find(x => x.description.toLowerCase().includes(v.toLowerCase()));
            if (!s) throw new Error(`no audio output "${v}"; outputs: ${all.map(x => x.description).join(", ")}`);
            return `omarchy-audio-output-set-default ${q(s.id)} ${q(s.name)}`;
        },
    },
    "mic.mute_toggle": { description: "Toggle microphone mute", command: () => "omarchy-audio-input-mute" },

    // ── displays ──
    brightness: {
        description: "Screen brightness (external monitors over DDC). Optionally for one monitor",
        value: { hint: "e.g. 50%, +10%, 10%- (append @MONITOR for one, e.g. 30%@HDMI-A-1)", pattern: /^(\+?\d{1,3}%|\d{1,3}%-)(@[A-Za-z0-9-]+)?$/ },
        command: v => {
            const [level, monitor] = v!.split("@");
            return `omarchy-brightness-display ${monitor ? `--monitor ${q(monitor)} ` : ""}${q(level!)}`;
        },
    },

    // ── connectivity ──
    bluetooth: { description: "Bluetooth power", value: onOff, command: v => `omarchy-bluetooth-power ${v}` },
    "bluetooth.connect": {
        description: "Connect a paired Bluetooth device (headphones, controller…)",
        value: { hint: "device name or address from omarchy_info bluetooth" },
        async command(v, ctx) {
            const d = await btByNameOrAddress(ctx, v!);
            if (!d) throw new Error(`no paired device "${v}"`);
            return `omarchy-bluetooth-device connect ${d.address}`;
        },
    },
    "bluetooth.disconnect": {
        description: "Disconnect a Bluetooth device",
        value: { hint: "device name or address" },
        async command(v, ctx) {
            const d = await btByNameOrAddress(ctx, v!);
            if (!d) throw new Error(`no paired device "${v}"`);
            return `omarchy-bluetooth-device disconnect ${d.address}`;
        },
    },
    "power_profile": {
        description: "Power profile while on AC power",
        value: { hint: "power-saver, balanced or performance", oneOf: ["power-saver", "balanced", "performance"] },
        command: v => `omarchy-powerprofiles-set ac ${v}`,
    },

    // ── on screen ──
    notify: {
        description: "Show a notification on the computer's screen",
        value: { hint: "the text (first line is the headline)", pattern: /^[^\0]{1,500}$/ },
        command: v => {
            const [head, ...rest] = v!.split("\n");
            return `omarchy-notification-send ${q(head!)}${rest.length ? ` ${q(rest.join("\n"))}` : ""}`;
        },
    },
    reminder: {
        description: "A reminder notification after N minutes",
        value: { hint: "minutes, a space and the message, e.g. '20 take the pizza out'", pattern: /^\d{1,4}( [^\0]{1,300})?$/ },
        command: v => {
            const [, minutes, msg] = /^(\d+)(?: (.*))?$/s.exec(v!)!;
            return `omarchy-reminder ${minutes}${msg ? ` ${q(msg)}` : ""}`;
        },
    },
    "reminders.clear": { description: "Clear all reminders", command: () => "omarchy-reminder clear" },
    "notifications.dismiss": { description: "Dismiss all notifications", command: () => "makoctl dismiss -a 2>/dev/null || omarchy-shell -q notifications dismissAll" },
    "screen_recording": {
        description: "Start a fullscreen screen recording with desktop audio, or stop the running one (saved to ~/Videos)",
        command: () => "omarchy-capture-screenrecording --fullscreen --with-desktop-audio",
    },

    // ── repairs ──
    "restart.audio": { description: "Restart audio (no sound, stuck USB headset)", command: () => "omarchy-restart-audio" },
    "restart.bluetooth": { description: "Restart Bluetooth", command: () => "omarchy-restart-bluetooth" },
    "restart.wifi": { description: "Restart Wi-Fi", command: () => "omarchy-restart-wifi" },
    "restart.shell": { description: "Restart the Omarchy shell (bar, notifications) if it hangs", command: () => "omarchy-restart-shell" },
};

/** Validates the value for an operation and returns the command to run. */
export async function omarchyCommand(op: string, value: string | undefined, ctx: Ctx): Promise<string> {
    const o = OMARCHY_OPS[op];
    if (!o) throw new Error(`unknown operation ${op}`);
    const v = value?.trim() || undefined;
    if (o.value) {
        if (v === undefined) {
            if (!o.value.optional) throw new Error(`${op} needs a value: ${o.value.hint}`);
        } else if (o.value.oneOf) {
            const hit = o.value.oneOf.find(x => x.toLowerCase() === v.toLowerCase());
            if (!hit) throw new Error(`${op}: use ${o.value.hint}`);
            return o.command(hit, ctx);
        } else if (o.value.pattern && !o.value.pattern.test(v)) {
            throw new Error(`${op}: use ${o.value.hint}`);
        } else if (o.value.list) {
            const all = await o.value.list(ctx);
            const hit = all.find(x => x.toLowerCase() === v.toLowerCase()) ?? all.find(x => x.toLowerCase().includes(v.toLowerCase()));
            if (!hit) throw new Error(`${op}: "${v}" isn't available; choose one of: ${all.slice(0, 40).join(", ")}`);
            return o.command(hit, ctx);
        }
    } else if (v !== undefined) {
        throw new Error(`${op} takes no value`);
    }
    return o.command(v, ctx);
}

export const INFO_TOPICS = ["overview", "themes", "fonts", "audio", "bluetooth", "network", "power", "reminders", "updates"] as const;
export type InfoTopic = (typeof INFO_TOPICS)[number];

/** Read-only Omarchy state. */
export async function omarchyInfo(topic: InfoTopic, ctx: Ctx): Promise<unknown> {
    const { exec } = ctx;
    const cap = async (cmd: string) => (await exec.capture(`${cmd} 2>/dev/null`)).trim();
    switch (topic) {
        case "overview": {
            const [theme, background, font, textSize, stats, weather, battery, network, version] = await Promise.all([
                cap("omarchy-theme-current"),
                cap("omarchy-theme-bg-current"),
                cap("omarchy-font-current"),
                cap("omarchy-display-text-size"),
                cap("omarchy-system-stats"),
                cap("omarchy-weather-status"),
                cap("omarchy-battery-present && omarchy-battery-status"),
                cap("omarchy-network-status"),
                cap("omarchy-version"),
            ]);
            return { theme, background, font, textSize, system: stats, weather, battery: battery || "no battery", network, omarchyVersion: version };
        }
        case "themes":
            return { current: await cap("omarchy-theme-current"), available: await listThemes(ctx), background: await cap("omarchy-theme-bg-current") };
        case "fonts":
            return { current: await cap("omarchy-font-current"), available: await listFonts(ctx) };
        case "audio": {
            const def = await cap("pactl get-default-sink");
            return {
                outputs: (await sinks(ctx)).map(s => ({ name: s.name, description: s.description, default: s.name === def })),
                micMuted: (await cap("LC_ALL=C pactl get-source-mute @DEFAULT_SOURCE@")).includes("yes"),
            };
        }
        case "bluetooth": {
            const on = await exec.test("omarchy-bluetooth-power is-on");
            const connected = new Set((await btDevices(ctx, "Connected")).map(d => d.address));
            return { on, devices: (await btDevices(ctx)).map(d => ({ ...d, connected: connected.has(d.address) })) };
        }
        case "network":
            return { status: await cap("omarchy-network-status --verbose"), wifi: await exec.test("omarchy-network-wifi-connected") };
        case "power":
            return {
                profiles: lines(await cap("omarchy-powerprofiles-list --active-state")).map(l => {
                    const [name, active] = l.split("\t");
                    return { name, active: active === "1" };
                }),
                battery: (await cap("omarchy-battery-present && omarchy-battery-status")) || "no battery",
            };
        case "reminders":
            try {
                return JSON.parse(await cap("omarchy-reminder show --json"));
            } catch {
                return { reminders: [] };
            }
        case "updates":
            return { version: await cap("omarchy-version"), updateAvailable: await exec.test("omarchy-update-available") };
    }
}

/** A JPEG of one monitor (or all), scaled to at most `maxWidth` px wide, for Claude to look at. */
export async function screenshot(monitor: string | undefined, monitors: Array<{ name: string; width?: number }>, maxWidth = 1600): Promise<Buffer> {
    const target = monitor ? monitors.find(m => m.name === monitor) : undefined;
    if (monitor && !target) throw new Error(`no monitor ${monitor}; monitors: ${monitors.map(m => m.name).join(", ")}`);
    const width = target?.width ?? monitors.reduce((w, m) => w + (m.width ?? 0), 0);
    const scale = width > maxWidth ? Math.max(0.1, Math.floor((maxWidth / width) * 100) / 100) : 1;
    const args = ["-t", "jpeg", "-q", "70", "-s", String(scale), ...(target ? ["-o", target.name] : []), "-"];
    return new Promise((resolve, reject) => {
        const child = spawn("grim", args, { stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let err = "";
        child.stdout.on("data", d => out.push(d));
        child.stderr.on("data", d => (err += d));
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.on("error", e => (clearTimeout(timer), reject(e)));
        child.on("exit", code => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(out));
            else reject(new Error(`grim failed: ${err.trim() || `exit ${code}`}`));
        });
    });
}
