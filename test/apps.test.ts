import assert from "node:assert/strict";
import { test } from "node:test";
import { matches, openApp, playApp } from "../src/actions/apps.ts";
import type { Executor } from "../src/core/executor.ts";
import { Registry } from "../src/core/dispatcher.ts";
import { resolveRef } from "../src/resolve.ts";

const quiet = { info() {}, warn() {}, error() {} };
const spotify = { launch: "omarchy-launch-spotify", match: "spotify" };

test("window matching is whole-word and case-insensitive", () => {
    assert.ok(matches(spotify, { class: "Spotify", title: "" }));
    assert.ok(matches({ launch: "", match: "ghostty" }, { class: "com.mitchellh.ghostty", title: "" }));
    assert.ok(!matches(spotify, { class: "spotifyd-helper", title: "" }));
});

test("open launches, then moves the new window to the screen", async () => {
    const cmds: string[] = [];
    let polls = 0;
    const exec: Executor = {
        sh: async c => (cmds.push(c), 0),
        test: async () => true,
        capture: async c => {
            if (c.includes("monitors")) return JSON.stringify([{ id: 0, name: "HDMI-A-2" }]);
            return JSON.stringify(polls++ < 2 ? [] : [{ address: "0xabc", class: "Spotify", title: "", monitor: 0 }]);
        },
    };
    await openApp("spotify", spotify, { monitor: "HDMI-A-2" }).run({ exec, log: quiet, cancelPending: () => 0 });
    assert.match(cmds[0], /setsid -f omarchy-launch-spotify/);
    assert.ok(cmds.some(c => c.includes('monitor = "HDMI-A-2"') && c.includes("0xabc")));
});

test("open focuses an already running app instead of starting another", async () => {
    const cmds: string[] = [];
    const exec: Executor = {
        sh: async c => (cmds.push(c), 0),
        test: async () => true,
        capture: async () => JSON.stringify([{ address: "0x1", class: "Spotify", title: "", monitor: 0 }]),
    };
    await openApp("spotify", spotify).run({ exec, log: quiet, cancelPending: () => 0 });
    assert.ok(!cmds.some(c => c.includes("setsid")));
    assert.ok(cmds.some(c => c.includes("focus")));
});

test("screen names resolve through the screens map", () => {
    const a = resolveRef({ open: "spotify", screen: "höger" }, new Registry(), {
        apps: { spotify },
        screens: { höger: "HDMI-A-2" },
    });
    assert.equal(a.id, "app.open:spotify@HDMI-A-2");
});

test("play resumes a running player without touching windows", async () => {
    const cmds: string[] = [];
    const exec: Executor = {
        sh: async c => (cmds.push(c), 0),
        test: async () => true,
        capture: async c => (c.includes("playerctl") ? "Paused\n" : "[]"),
    };
    await playApp("spotify", spotify, { monitor: "HDMI-A-2" }).run({ exec, log: quiet, cancelPending: () => 0 });
    assert.deepEqual(cmds, ["playerctl -p 'spotify' play"]);
});

test("play opens the app when no player exists, waits for it, then plays", async () => {
    const cmds: string[] = [];
    let launched = false;
    let played = false;
    const exec: Executor = {
        sh: async c => {
            cmds.push(c);
            if (c.includes("setsid")) launched = true;
            if (c.endsWith(" play")) played = true;
            return 0;
        },
        test: async () => true,
        capture: async c => {
            if (c.includes("playerctl")) return !launched ? "" : played ? "Playing\n" : "Stopped\n";
            return "[]";
        },
    };
    await playApp("spotify", spotify).run({ exec, log: quiet, cancelPending: () => 0 });
    assert.match(cmds[0], /setsid -f omarchy-launch-spotify/);
    assert.equal(cmds.at(-1), "playerctl -p 'spotify' play");
});

test("closing an app with confirmClose presses Return in windows that stay open", async () => {
    const { closeApp } = await import("../src/actions/apps.ts");
    const ran: string[] = [];
    let open = true;
    const exec = {
        sh: async (c: string) => {
            ran.push(c);
            if (c.includes("send_shortcut")) open = false;
            return 0;
        },
        test: async () => true,
        capture: async () => JSON.stringify(open ? [{ address: "0xa", class: "microsoft-edge", title: "Docs", monitor: 0 }] : []),
    };
    const log = { info() {}, warn() {}, error() {} };
    await closeApp("edge", { launch: "x", match: "microsoft-edge", confirmClose: true }).run({ exec, log, cancelPending: () => 0 });
    assert.ok(ran.some(c => c.includes("window.close")));
    assert.equal(ran.filter(c => c.includes('key = "Return"')).length, 1);

    ran.length = 0;
    open = true;
    await closeApp("term", { launch: "x", match: "microsoft-edge" }).run({ exec, log, cancelPending: () => 0 });
    assert.ok(!ran.some(c => c.includes("Return")), "never without confirmClose");
});
