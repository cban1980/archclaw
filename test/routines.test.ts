import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { loadConfig } from "../src/config.ts";
import { classFromDesktopId } from "../src/init.ts";
import { generateRoutines } from "../src/routines.ts";

const config = (yaml: string) => {
    const p = join(mkdtempSync(join(tmpdir(), "archnest-")), "c.yaml");
    writeFileSync(p, yaml);
    return loadConfig(p);
};

test("routines come from device phrases and multi-device routines", () => {
    const c = config(`room: Desk
devices:
  - { name: Computer, type: lock, on: power.lock, phrases: { on: ["lock it"] } }
  - { name: Screens, type: light, on: display.on, off: display.off, phrases: { off: ["Screens off"] } }
routines:
  - phrases: ["i'm done"]
    actions: [{ Screens: false }, { Computer: true }]
`);
    const doc = parse(generateRoutines(c));
    assert.equal(doc.automations.length, 3);
    assert.deepEqual(doc.automations[0].actions, [{ type: "device.command.LockUnlock", devices: "Computer - Desk", lock: true }]);
    assert.equal(doc.automations[1].starters[0].is, "screens off");
    assert.deepEqual(doc.automations[1].actions, [{ type: "device.command.OnOff", devices: "Screens - Desk", on: false }]);
    assert.equal(doc.automations[2].starters[0].is, "i'm done");
    assert.equal(doc.automations[2].actions.length, 2);
});

test("the presets produce valid routine YAML", () => {
    for (const f of ["../config.example.yaml", "../presets/sv.yaml"]) {
        const doc = parse(generateRoutines(loadConfig(new URL(f, import.meta.url).pathname)));
        assert.ok(doc.automations.length > 10, f);
        for (const a of doc.automations) assert.ok(a.starters.length && a.actions.length, f);
    }
});

test("window classes are guessed from desktop ids", () => {
    assert.equal(classFromDesktopId("com.mitchellh.ghostty.desktop"), "ghostty");
    assert.equal(classFromDesktopId("microsoft-edge.desktop"), "microsoft-edge");
    assert.equal(classFromDesktopId("google-chrome-stable.desktop"), "google-chrome");
    assert.equal(classFromDesktopId("Alacritty.desktop"), "Alacritty");
});
