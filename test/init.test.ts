import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { initConfig, nameScreens, randomPasscode } from "../src/init.ts";
import { pairingCodes } from "../src/pairing.ts";

const example = new URL("../config.example.yaml", import.meta.url).pathname;

test("screens are named left to right", () => {
    assert.deepEqual(nameScreens([{ name: "B", x: 1920 }, { name: "A", x: 0 }, { name: "C", x: 5000 }]), {
        left: "A",
        middle: "B",
        right: "C",
    });
    assert.deepEqual(nameScreens([{ name: "A", x: 0 }]), { main: "A" });
});

test("init writes a valid config with a fresh passcode and never overwrites", () => {
    const target = join(mkdtempSync(join(tmpdir(), "archnest-")), "config.yaml");
    const r = initConfig({ examplePath: example, target, name: "Testdatorn", monitors: [{ name: "DP-1", x: 0 }] });
    assert.ok(r.written);
    const c = loadConfig(target);
    assert.equal(c.name, "Testdatorn");
    assert.deepEqual(c.screens, { main: "DP-1" });
    assert.notEqual(c.matter.passcode, 20202021);
    assert.match(readFileSync(target, "utf8"), /# Device types/); // comments kept

    writeFileSync(target, "name: mine\n");
    assert.equal(initConfig({ examplePath: example, target, monitors: [] }).written, false);
    assert.equal(readFileSync(target, "utf8"), "name: mine\n");
});

test("random passcodes are in range", () => {
    for (let i = 0; i < 100; i++) {
        const p = randomPasscode();
        assert.ok(p >= 1 && p <= 99999998);
    }
});

test("pairing codes match what matter.js advertises", () => {
    // Values printed by the running bridge for the default test passcode.
    const codes = pairingCodes({ matter: { port: 5540, passcode: 20202021, discriminator: 3840 } });
    assert.equal(codes.qr, "MT:Y.K90AFN00KA0648G00");
    assert.equal(codes.manualFormatted, "3497-011-2332");
});

test("the Swedish preset uses the same screen and app keys as the default", () => {
    const en = loadConfig(example);
    const sv = loadConfig(new URL("../presets/sv.yaml", import.meta.url).pathname);
    assert.deepEqual(Object.keys(sv.screens), Object.keys(en.screens));
    assert.deepEqual(Object.keys(sv.apps), Object.keys(en.apps));
    assert.equal(sv.devices.length, en.devices.length);
    assert.deepEqual(sv.devices.map(d => d.type), en.devices.map(d => d.type));
});
