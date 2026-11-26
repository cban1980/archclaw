import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findScene, loadConfig, normalize } from "../src/config.ts";
import { ConfigStore } from "../src/config-store.ts";
import { appFromDesktopId, findApps, installedApps, webAppLaunch } from "../src/desktop-apps.ts";

const example = new URL("../config.example.yaml", import.meta.url).pathname;

const write = (yaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), "archclaw-"));
    const p = join(dir, "c.yaml");
    writeFileSync(p, yaml);
    return { path: p, dir };
};

test("example config is valid", () => {
    const c = loadConfig(example);
    assert.equal(c.safety.countdownSeconds, 30);
    assert.ok(c.scenes.length >= 2);
    assert.equal(findScene(c, "Focus Mode")?.name, "focus");
});

test("an empty config is valid", () => {
    const c = loadConfig(write("").path);
    assert.deepEqual(c.scenes, []);
    assert.equal(c.name, "archclaw");
});

test("scene names and aliases match loosely and must be unique", () => {
    assert.equal(normalize("Chattläge!"), "chattlage");
    const c = loadConfig(write("apps: { d: { launch: x, match: d } }\nscenes:\n  - { name: mirc, aliases: [Chattläge], start: { open: d } }\n").path);
    assert.equal(findScene(c, "chattlage")?.name, "mirc");
    assert.equal(findScene(c, "MIRC")?.name, "mirc");
    assert.throws(
        () => loadConfig(write("scenes:\n  - { name: a, aliases: [x], start: dnd.on }\n  - { name: b, aliases: [X], start: dnd.on }\n").path),
        /names both/,
    );
});

test("scenes can't contain power actions or unknown apps", () => {
    assert.throws(() => loadConfig(write("scenes:\n  - { name: a, start: [dnd.on, power.shutdown] }\n").path), /power actions/);
    assert.throws(() => loadConfig(write("scenes:\n  - { name: a, start: { open: nope } }\n").path), /unknown app/);
});

test("unknown keys are rejected (old Google Home configs fail loudly)", () => {
    assert.throws(() => loadConfig(write("devices: []\n").path), /devices/);
});

test("config edits are validated, keep comments, and can be undone", () => {
    const { path, dir } = write(readFileSync(example, "utf8"));
    const store = new ConfigStore(path, join(dir, "state"));
    store.saveApp("discord", { launch: "omarchy-launch-webapp 'https://discord.com/'", match: "discord" });
    store.saveScene({ name: "chat", aliases: ["mirc"], start: [{ open: "discord", screen: "left" }], stop: [{ close: "discord" }] });
    assert.equal(loadConfig(path).apps.discord?.match, "discord");
    assert.equal(findScene(loadConfig(path), "mirc")?.name, "chat");
    assert.match(readFileSync(path, "utf8"), /# Scenes: named setups/);

    // Replacing by name, not adding a duplicate.
    store.saveScene({ name: "Chat", aliases: ["mirc"], start: [{ open: "discord" }] });
    assert.equal(loadConfig(path).scenes.filter(s => normalize(s.name) === "chat").length, 1);

    // Invalid edits are refused and leave the file alone.
    const before = readFileSync(path, "utf8");
    assert.throws(() => store.saveScene({ name: "bad", aliases: [], start: [{ open: "nope" }] }), /unknown app/);
    assert.throws(() => store.deleteApp("discord"), /used by scene/);
    assert.equal(readFileSync(path, "utf8"), before);

    store.setNotes("I speak Swedish.");
    assert.equal(store.config.notes, "I speak Swedish.");
    assert.match(store.undo(), /notes/);
    assert.notEqual(loadConfig(path).notes, "I speak Swedish.");
    assert.ok(store.history().length >= 2);
});

test("desktop apps are found and turned into safe launch commands", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "archclaw-")), "applications");
    mkdirSync(dir);
    writeFileSync(join(dir, "dev.vencord.Vesktop.desktop"), "[Desktop Entry]\nType=Application\nName=Vesktop\nExec=vesktop %U\nStartupWMClass=vesktop\n");
    writeFileSync(join(dir, "hidden.desktop"), "[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n");
    const apps = installedApps([dir]);
    assert.deepEqual(apps.map(a => a.id), ["dev.vencord.Vesktop.desktop"]);
    assert.equal(findApps("vesk", apps).length, 1);
    assert.deepEqual(appFromDesktopId("dev.vencord.Vesktop.desktop", apps), { launch: "uwsm-app -- dev.vencord.Vesktop.desktop", match: "vesktop", name: "Vesktop" });
    assert.throws(() => appFromDesktopId("x; rm -rf ~.desktop", apps), /not a desktop entry id/);
    assert.equal(webAppLaunch("https://discord.com/channels/@me"), "omarchy-launch-webapp 'https://discord.com/channels/@me'");
    assert.throws(() => webAppLaunch("http://example.com"), /https/);
    assert.throws(() => webAppLaunch("https://example.com/'$(id)'"), /unsupported/);
});
