import assert from "node:assert/strict";
import { test } from "node:test";
import { changeBody, findTarget, hexToXy, summarize, toMirek } from "../src/hue/control.ts";
import type { HueState } from "../src/hue/client.ts";

const state: HueState = {
    lights: [
        { id: "l1", metadata: { name: "Taklampa" }, on: { on: true }, dimming: { brightness: 80 }, owner: { rid: "d1", rtype: "device" } },
        { id: "l2", metadata: { name: "Golvlampa" }, on: { on: false }, owner: { rid: "d2", rtype: "device" } },
    ],
    rooms: [{ id: "r1", metadata: { name: "Vardagsrum" }, children: [{ rid: "d1", rtype: "device" }, { rid: "d2", rtype: "device" }], services: [{ rid: "g1", rtype: "grouped_light" }] }],
    zones: [{ id: "z1", metadata: { name: "Soffhörnan" }, children: [{ rid: "l2", rtype: "light" }], services: [{ rid: "g2", rtype: "grouped_light" }] }],
    groupedLights: [{ id: "g1", on: { on: true }, dimming: { brightness: 40 } }, { id: "g2", on: { on: false } }],
    scenes: [{ id: "s1", metadata: { name: "Läsljus" }, group: { rid: "r1", rtype: "room" } }],
    devices: [
        { id: "d1", services: [{ rid: "l1", rtype: "light" }] },
        { id: "d2", services: [{ rid: "l2", rtype: "light" }] },
    ],
    home: { id: "h", services: [{ rid: "gall", rtype: "grouped_light" }] },
};

test("colors and temperatures convert to Hue's units", () => {
    const red = hexToXy("#ff0000");
    assert.ok(red.x > 0.69 && red.y < 0.31, JSON.stringify(red));
    assert.throws(() => hexToXy("nope"), /isn't a color/);
    assert.equal(toMirek("warm"), 370);
    assert.equal(toMirek(6500), 154);
    assert.equal(toMirek("2700K"), 370);
    assert.throws(() => toMirek("hot"), /temperature/);
});

test("changes become CLIP v2 bodies", () => {
    assert.deepEqual(changeBody({ brightness: 0 }), { on: { on: false } });
    assert.deepEqual(changeBody({ brightness: 30, fadeSeconds: 2 }), { dimming: { brightness: 30 }, on: { on: true }, dynamics: { duration: 2000 } });
    assert.deepEqual(changeBody({ color: "röd" }).on, { on: true });
    assert.throws(() => changeBody({}), /say what/);
});

test("targets match rooms, zones, lights and all, loosely", () => {
    assert.deepEqual(findTarget(state, "vardagsrummet".slice(0, 10)), { kind: "room", name: "Vardagsrum", resource: "grouped_light", id: "g1" });
    assert.equal(findTarget(state, "soffhornan").id, "g2");
    assert.equal(findTarget(state, "golvlampan").id, "l2");
    assert.equal(findTarget(state, "alla").id, "gall");
    assert.throws(() => findTarget(state, "garage"), /no Hue room/);
});

test("the summary lists lights per room and scenes", () => {
    const s = summarize(state);
    assert.equal(s.rooms[0]!.lights.length, 2);
    assert.deepEqual(s.rooms[0]!.scenes, ["Läsljus"]);
    assert.equal(s.zones[0]!.lights[0]!.name, "Golvlampa");
});
