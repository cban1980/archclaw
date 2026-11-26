import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action } from "../src/core/action.ts";
import { Dispatcher, Registry } from "../src/core/dispatcher.ts";
import type { Executor } from "../src/core/executor.ts";
import type { Logger } from "../src/core/log.ts";
import type { Notifier } from "../src/core/notifier.ts";
import { Safety } from "../src/core/safety.ts";
import { powerActions } from "../src/actions/power.ts";

const quiet: Logger = { info() {}, warn() {}, error() {} };

function fakeNotifier() {
    let pressCancel: (() => void) | undefined;
    const notifier: Notifier = {
        info() {},
        countdown() {
            let resolve!: (v: boolean) => void;
            const cancelled = new Promise<boolean>(r => (resolve = r));
            pressCancel = () => resolve(true);
            return { cancelled, close: () => resolve(false) };
        },
    };
    return { notifier, pressCancel: () => pressCancel?.() };
}

function setup(opts: { countdown?: number; grace?: number; uptime?: number; repeat?: number; clock?: { now: number } } = {}) {
    const ran: string[] = [];
    const exec: Executor = { sh: async cmd => (ran.push(cmd), 0), test: async () => true, capture: async () => "[]" };
    const { notifier, pressCancel } = fakeNotifier();
    const safety = new Safety(
        { countdownSeconds: opts.countdown ?? 0.05, bootGraceSeconds: opts.grace ?? 0, repeatWindowSeconds: opts.repeat ?? 60 },
        notifier,
        quiet,
        () => opts.uptime ?? 10_000,
        () => opts.clock?.now ?? Date.now(),
    );
    const registry = new Registry().add(...powerActions);
    const dispatcher = new Dispatcher(safety, exec, quiet);
    return { ran, safety, registry, dispatcher, pressCancel };
}

test("safe actions run immediately", async () => {
    const { ran, registry, dispatcher } = setup({ countdown: 60 });
    assert.equal(await dispatcher.dispatch(registry.get("power.lock")!, "test"), "ran");
    assert.equal(ran.length, 1);
});

test("confirm actions run after the countdown", async () => {
    const { ran, registry, dispatcher } = setup();
    assert.equal(await dispatcher.dispatch(registry.get("power.shutdown")!, "test"), "ran");
    assert.match(ran[0], /shutdown|poweroff/);
});

test("pressing Cancel in the notification stops the action", async () => {
    const { ran, registry, dispatcher, pressCancel } = setup({ countdown: 5 });
    const pending = dispatcher.dispatch(registry.get("power.shutdown")!, "test");
    setTimeout(pressCancel, 10);
    assert.equal(await pending, "cancelled");
    assert.deepEqual(ran, []);
});

test("power.cancel aborts a pending shutdown", async () => {
    const { ran, registry, dispatcher } = setup({ countdown: 5 });
    const pending = dispatcher.dispatch(registry.get("power.shutdown")!, "test");
    await new Promise(r => setTimeout(r, 10));
    assert.equal(await dispatcher.dispatch(registry.get("power.cancel")!, "test"), "ran");
    assert.equal(await pending, "cancelled");
    assert.deepEqual(ran, []);
});

test("a new risky request replaces the pending one", async () => {
    const { ran, registry, dispatcher } = setup({ countdown: 0.1 });
    const first = dispatcher.dispatch(registry.get("power.shutdown")!, "test");
    await new Promise(r => setTimeout(r, 10));
    const second = dispatcher.dispatch(registry.get("power.reboot")!, "test");
    assert.equal(await first, "cancelled");
    assert.equal(await second, "ran");
    assert.equal(ran.length, 1);
    assert.match(ran[0], /reboot/);
});

test("risky actions are blocked during the boot grace period", async () => {
    const { ran, registry, dispatcher } = setup({ grace: 120, uptime: 30 });
    assert.equal(await dispatcher.dispatch(registry.get("power.reboot")!, "test"), "blocked");
    assert.deepEqual(ran, []);
    assert.equal(await dispatcher.dispatch(registry.get("power.lock")!, "test"), "ran");
});

test("unknown action ids fail loudly; shell refs resolve", () => {
    const { registry } = setup();
    assert.throws(() => registry.resolve("power.explode"), /unknown action/);
    const a: Action = registry.resolve({ run: "echo hi" });
    assert.equal(a.risk, "safe");
});

test("a single voice request for shutdown does nothing", async () => {
    const { ran, registry, dispatcher } = setup();
    assert.equal(await dispatcher.dispatch(registry.get("power.shutdown")!, "matter"), "awaiting-repeat");
    assert.deepEqual(ran, []);
});

test("a repeated voice request within the window proceeds", async () => {
    const clock = { now: 1_000_000 };
    const { ran, registry, dispatcher } = setup({ clock });
    const shutdown = registry.get("power.shutdown")!;
    assert.equal(await dispatcher.dispatch(shutdown, "matter"), "awaiting-repeat");
    clock.now += 10_000;
    assert.equal(await dispatcher.dispatch(shutdown, "matter"), "ran");
    assert.equal(ran.length, 1);
});

test("a duplicate delivered within seconds does not confirm", async () => {
    const clock = { now: 1_000_000 };
    const { ran, registry, dispatcher } = setup({ clock });
    const shutdown = registry.get("power.shutdown")!;
    await dispatcher.dispatch(shutdown, "matter");
    clock.now += 500;
    assert.equal(await dispatcher.dispatch(shutdown, "matter"), "awaiting-repeat");
    assert.deepEqual(ran, []);
});

test("the repeat must be the same action and inside the window", async () => {
    const clock = { now: 1_000_000 };
    const { ran, registry, dispatcher } = setup({ clock });
    await dispatcher.dispatch(registry.get("power.reboot")!, "matter");
    clock.now += 10_000;
    assert.equal(await dispatcher.dispatch(registry.get("power.shutdown")!, "matter"), "awaiting-repeat");
    clock.now += 61_000;
    assert.equal(await dispatcher.dispatch(registry.get("power.shutdown")!, "matter"), "awaiting-repeat");
    assert.deepEqual(ran, []);
});

test("cancel also clears a half-confirmed request", async () => {
    const clock = { now: 1_000_000 };
    const { ran, registry, dispatcher } = setup({ clock });
    const shutdown = registry.get("power.shutdown")!;
    await dispatcher.dispatch(shutdown, "matter");
    await dispatcher.dispatch(registry.get("power.cancel")!, "matter");
    clock.now += 10_000;
    assert.equal(await dispatcher.dispatch(shutdown, "matter"), "awaiting-repeat");
    assert.deepEqual(ran, []);
});
