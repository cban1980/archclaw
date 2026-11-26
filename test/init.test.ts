import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { initConfig, nameScreens } from "../src/init.ts";

const example = new URL("../config.example.yaml", import.meta.url).pathname;

test("screens are named left to right", () => {
    assert.deepEqual(nameScreens([{ name: "B", x: 1920 }, { name: "A", x: 0 }, { name: "C", x: 5000 }]), {
        left: "A",
        middle: "B",
        right: "C",
    });
    assert.deepEqual(nameScreens([{ name: "A", x: 0 }]), { main: "A" });
});

test("init writes a valid config and never overwrites", () => {
    const target = join(mkdtempSync(join(tmpdir(), "archclaw-")), "config.yaml");
    const r = initConfig({ examplePath: example, target, name: "Testdatorn", monitors: [{ name: "DP-1", x: 0 }] });
    assert.ok(r.written);
    const c = loadConfig(target);
    assert.equal(c.name, "Testdatorn");
    assert.deepEqual(c.screens, { main: "DP-1" });
    assert.match(readFileSync(target, "utf8"), /# Scenes: named setups/); // comments kept

    writeFileSync(target, "name: mine\n");
    assert.equal(initConfig({ examplePath: example, target, monitors: [] }).written, false);
    assert.equal(readFileSync(target, "utf8"), "name: mine\n");
});
