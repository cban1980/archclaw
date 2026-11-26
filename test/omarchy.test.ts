import assert from "node:assert/strict";
import { test } from "node:test";
import { OMARCHY_OPS, omarchyCommand } from "../src/omarchy.ts";
import { loadConfig, parseConfig } from "../src/config.ts";

const exec = {
    sh: async () => 0,
    test: async () => true,
    capture: async (cmd: string) =>
        cmd.startsWith("omarchy-theme-list")
            ? "Tokyo Night\nCatppuccin Latte\n"
            : cmd.includes("pactl -f json list sinks")
              ? JSON.stringify([{ name: "alsa_output.hdmi", description: "HDMI TV", properties: { "object.id": "57" } }])
              : cmd.startsWith("bluetoothctl devices")
                ? "Device AA:BB:CC:DD:EE:FF WH-1000XM5\n"
                : "",
};
const ctx = { exec };

test("values are checked against enums, patterns and live lists, then quoted", async () => {
    assert.equal(await omarchyCommand("theme.set", "tokyo night", ctx), "omarchy-theme-set 'Tokyo Night'");
    assert.equal(await omarchyCommand("theme.set", "latte", ctx), "omarchy-theme-set 'Catppuccin Latte'");
    await assert.rejects(omarchyCommand("theme.set", "nope", ctx), /isn't available/);
    assert.equal(await omarchyCommand("bar", "HIDE", ctx), "omarchy-toggle-bar on");
    await assert.rejects(omarchyCommand("bar", "sideways", ctx), /show or hide/);
    assert.equal(await omarchyCommand("brightness", "30%@HDMI-A-1", ctx), "omarchy-brightness-display --monitor 'HDMI-A-1' '30%'");
    await assert.rejects(omarchyCommand("brightness", "30%; rm -rf ~", ctx), /use/);
    assert.equal(await omarchyCommand("notify", "it's done\ndetails", ctx), `omarchy-notification-send 'it'\\''s done' 'details'`);
    assert.equal(await omarchyCommand("reminder", "20 take the pizza out", ctx), "omarchy-reminder 20 'take the pizza out'");
    assert.equal(await omarchyCommand("audio.output", "tv", ctx), "omarchy-audio-output-set-default '57' 'alsa_output.hdmi'");
    assert.equal(await omarchyCommand("bluetooth.connect", "wh-1000", ctx), "omarchy-bluetooth-device connect AA:BB:CC:DD:EE:FF");
    await assert.rejects(omarchyCommand("workspace.go", "11", ctx), /1-10/);
    await assert.rejects(omarchyCommand("gaps.toggle", "x", ctx), /no value/);
    await assert.rejects(omarchyCommand("rm", undefined, ctx), /unknown/);
});

test("every operation documents itself", () => {
    for (const [id, op] of Object.entries(OMARCHY_OPS)) {
        assert.ok(op.description.length > 5, id);
        if (op.value) assert.ok(op.value.hint, id);
    }
});

test("scenes can use Omarchy operations, but only known ones", () => {
    const c = parseConfig({ scenes: [{ name: "movie", start: [{ omarchy: "bar", value: "hide" }, "nightlight.on"] }] });
    assert.equal(c.scenes[0]!.name, "movie");
    assert.throws(() => parseConfig({ scenes: [{ name: "x", start: { omarchy: "format.disk" } }] }), /unknown Omarchy operation/);
    void loadConfig;
});
