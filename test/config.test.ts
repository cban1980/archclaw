import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, slug } from "../src/config.ts";

const write = (yaml: string) => {
    const p = join(mkdtempSync(join(tmpdir(), "archnest-")), "c.yaml");
    writeFileSync(p, yaml);
    return p;
};

test("example config is valid", () => {
    const c = loadConfig(new URL("../config.example.yaml", import.meta.url).pathname);
    assert.equal(c.devices[0].type, "lock");
    assert.equal(c.safety.repeatWindowSeconds, 60);
    assert.equal(c.safety.countdownSeconds, 30);
});

test("momentary devices reject off actions", () => {
    const p = write("devices:\n  - { name: X, type: momentary, on: power.lock, off: power.lock }\n");
    assert.throws(() => loadConfig(p), /momentary/);
});

test("duplicate names are rejected", () => {
    const p = write("devices:\n  - { name: PC Lock, on: power.lock }\n  - { name: pc-lock, on: power.lock }\n");
    assert.throws(() => loadConfig(p), /duplicate/);
});

test("slug is stable", () => {
    assert.equal(slug(" PC Reboot! "), "pc-reboot");
    assert.equal(slug("Avbryt avstängning"), "avbryt-avstangning");
});

test("power actions on plugs are rejected", () => {
    const p = write("devices:\n  - { name: PC, type: plug, off: power.shutdown }\n");
    assert.throws(() => loadConfig(p), /momentary/);
});

test("power actions on locks and lights are rejected", () => {
    const p = write("devices:\n  - { name: X, type: lock, on: power.shutdown }\n");
    assert.throws(() => loadConfig(p), /momentary/);
});

test("unknown apps are rejected", () => {
    const p = write("devices:\n  - { name: X, type: momentary, on: { open: nope } }\n");
    assert.throws(() => loadConfig(p), /unknown app/);
});

test("power actions can't be hidden in a scene", () => {
    const p = write("devices:\n  - { name: X, type: momentary, on: [power.lock, power.shutdown] }\n");
    assert.throws(() => loadConfig(p), /list/);
});

test("dimmers need a level action, and only dimmers may have one", () => {
    assert.throws(() => loadConfig(write("devices:\n  - { name: X, type: dimmer, on: volume.unmute }\n")), /level/);
    assert.throws(() => loadConfig(write("devices:\n  - { name: X, type: plug, on: media.play, level: volume.set }\n")), /level/);
});

test("forbidden passcodes are rejected", () => {
    const p = write("matter: { passcode: 12345678 }\ndevices:\n  - { name: X, on: media.play }\n");
    assert.throws(() => loadConfig(p), /passcode/);
});

test("play refs must name a known app", () => {
    assert.throws(() => loadConfig(write("devices:\n  - { name: X, on: { play: nope } }\n")), /unknown app/);
});

test("the Swedish preset is valid", () => {
    const c = loadConfig(new URL("../presets/sv.yaml", import.meta.url).pathname);
    assert.equal(c.room, "Datorhörnan");
});

test("the bridge may not share a name with a device", () => {
    const p = write("name: Datorn\ndevices:\n  - { name: Datorn, type: lock, on: power.lock }\n");
    assert.throws(() => loadConfig(p), /\(2\)/);
});

test("routines must name existing devices", () => {
    const p = write("devices:\n  - { name: X, on: dnd.on }\nroutines:\n  - { phrases: [hi], actions: [{ Y: true }] }\n");
    assert.throws(() => loadConfig(p), /unknown device "Y"/);
});

test("off phrases need an off action", () => {
    const p = write("devices:\n  - { name: X, type: momentary, on: dnd.on, phrases: { off: [stop] } }\n");
    assert.throws(() => loadConfig(p), /phrases.off/);
});
