import assert from "node:assert/strict";
import { test } from "node:test";
import { isThisPc, shouldHandOff } from "../src/spotify/actions.ts";

const cfg = (spotify: Record<string, unknown> = {}) => ({ spotify: { app: "spotify", device: "tor", ...spotify } });

test("this PC is recognised by its Connect name, case-insensitively", () => {
    assert.ok(isThisPc({ name: "TOR", type: "Computer" }, cfg()));
    assert.ok(!isThisPc({ name: "Vardagsrum", type: "Speaker" }, cfg()));
});

test("handoff takes speakers and TVs, never phones, other computers or this PC", () => {
    assert.ok(shouldHandOff({ name: "Vardagsrum", type: "Speaker" }, cfg()));
    assert.ok(shouldHandOff({ name: "TV", type: "CastVideo" }, cfg()));
    assert.ok(!shouldHandOff({ name: "Galaxy S25", type: "Smartphone" }, cfg()));
    assert.ok(!shouldHandOff({ name: "laptop", type: "Computer" }, cfg()));
    assert.ok(!shouldHandOff({ name: "tor", type: "Computer" }, cfg()));
});

test("handoffFrom limits handoff to the named devices", () => {
    const c = cfg({ handoffFrom: ["Vardagsrum"] });
    assert.ok(shouldHandOff({ name: "vardagsrum", type: "Speaker" }, c));
    assert.ok(!shouldHandOff({ name: "Kök", type: "Speaker" }, c));
});
