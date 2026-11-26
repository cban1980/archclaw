import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { DoorLockServer, LockOperationFailedError, type DoorLockBaseServer } from "@matter/main/behaviors/door-lock";
import { DoorLock } from "@matter/main/clusters/door-lock";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { DoorLockDevice } from "@matter/main/devices/door-lock";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { slug, type Config, type DeviceConfig } from "../config.ts";
import { isAppRunning } from "../actions/apps.ts";
import type { Action } from "../core/action.ts";
import { appOf, resolveRef } from "../resolve.ts";
import type { Dispatcher, Registry } from "../core/dispatcher.ts";
import type { Executor } from "../core/executor.ts";
import type { Logger } from "../core/log.ts";

const MOMENTARY_RESET_MS = 1000;
const PROBE_INTERVAL_MS = 5000;
/** Google Home sends a burst of level changes while sliding; act on where it settles. */
const LEVEL_DEBOUNCE_MS = 400;

/** Matter levels are 1–254; people (and Google Home) think in percent. */
const toPercent = (level: number) => Math.round((level / 254) * 100);
const toLevel = (percent: number) => Math.min(254, Math.max(1, Math.round((percent / 100) * 254)));

type Deps = { config: Config; registry: Registry; dispatcher: Dispatcher; exec: Executor; log: Logger };

/** Exposes each configured device behind a Matter bridge. */
export async function startMatter(deps: Deps, storagePath: string) {
    const { config } = deps;
    Environment.default.vars.set("storage.path", storagePath);

    const server = await ServerNode.create({
        id: "archnest",
        network: { port: config.matter.port },
        commissioning: { passcode: config.matter.passcode, discriminator: config.matter.discriminator },
        productDescription: { name: config.name, deviceType: AggregatorEndpoint.deviceType },
        basicInformation: {
            vendorName: "archnest",
            vendorId: VendorId(0xfff1), // Matter test vendor ID; must match the Google Home Developer Console entry
            productId: 0x8000,
            productName: "Archnest Bridge",
            productLabel: "Archnest Bridge",
            nodeLabel: config.name,
            serialNumber: "archnest-0001",
            uniqueId: "archnest-bridge",
        },
    });

    const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
    await server.add(aggregator);

    const probes: Array<() => Promise<void>> = [];
    for (const dev of config.devices) {
        const probe =
            dev.type === "lock"
                ? await addLock(aggregator, dev, deps)
                : dev.type === "dimmer"
                  ? await addDimmer(aggregator, dev, deps)
                  : await addSwitch(aggregator, dev, deps);
        if (probe) probes.push(probe);
    }

    await server.start();

    // Poll device state while online. Stops when the node goes offline (e.g. on SIGTERM), so
    // probes never touch endpoints that are being closed.
    if (probes.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;
        server.lifecycle.goingOffline.on(() => {
            stopped = true;
            clearTimeout(timer);
        });
        const tick = async () => {
            if (stopped || !server.lifecycle.isOnline) return;
            await Promise.allSettled(probes.map(p => p()));
            if (!stopped) timer = setTimeout(tick, PROBE_INTERVAL_MS);
        };
        void tick();
    }

    if (!server.lifecycle.isCommissioned) {
        const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
        deps.log.info(`not paired yet; add in Google Home with code ${manualPairingCode}`);
        deps.log.info(`QR payload ${qrPairingCode} (render: qrencode -t ansiutf8 '${qrPairingCode}')`);
    }
    return server;
}

function bridgedInfo(dev: DeviceConfig) {
    return {
        id: slug(dev.name),
        bridgedDeviceBasicInformation: {
            nodeLabel: dev.name,
            productName: dev.name,
            productLabel: dev.name,
            serialNumber: `archnest-${slug(dev.name)}`,
            reachable: true,
        },
    };
}

/** plug, light and momentary devices: the OnOff cluster. Returns a state probe, if configured. */
async function addSwitch(aggregator: Endpoint, dev: DeviceConfig, { config, registry, dispatcher, exec, log }: Deps) {
    const onAction = dev.on ? resolveRef(dev.on, registry, config) : undefined;
    const offAction = dev.off ? resolveRef(dev.off, registry, config) : undefined;
    const type = dev.type === "light" ? OnOffLightDevice : OnOffPlugInUnitDevice;

    const endpoint = new Endpoint(type.with(BridgedDeviceBasicInformationServer), bridgedInfo(dev));
    await aggregator.add(endpoint);

    // Changes we make ourselves (resets, reverts, probes) must not trigger actions.
    let expected: boolean | undefined;
    const setState = async (value: boolean) => {
        if (endpoint.state.onOff.onOff === value) return;
        expected = value;
        await endpoint.set({ onOff: { onOff: value } });
    };
    const report = (e: unknown) => log.error(`${dev.name}: ${e}`);

    endpoint.events.onOff.onOff$Changed.on(value => {
        if (value === expected) {
            expected = undefined;
            return;
        }
        expected = undefined;
        const action = value ? onAction : offAction;

        if (dev.type === "momentary" && value) setTimeout(() => setState(false).catch(report), MOMENTARY_RESET_MS);
        if (!action) return;

        dispatcher.dispatch(action, "matter").then(outcome => {
            // If a stateful device's action didn't happen, show the old state again in Google Home.
            if (dev.type !== "momentary" && outcome !== "ran") setState(!value).catch(report);
        });
    });

    if (dev.type !== "momentary") await setState(dev.initial);
    if (dev.type === "momentary") return undefined;
    const probe = dev.probe;
    if (probe) return async () => setState(await exec.test(probe)).catch(report);
    const app = appOf(dev.on, config);
    if (app) return async () => setState(await isAppRunning(exec, app)).catch(report);
    return undefined;
}

/** lock devices: the DoorLock cluster. Locking runs `on`; unlocking remotely is refused. */
async function addLock(aggregator: Endpoint, dev: DeviceConfig, { config, registry, dispatcher, exec, log }: Deps) {
    const lockAction: Action = resolveRef(dev.on!, registry, config);

    class ArchnestLockServer extends DoorLockServer {
        override async handleLockOperation(operation: DoorLockBaseServer.LockOperation) {
            if (operation.actuation !== "lock") {
                log.warn(`${dev.name}: refused remote ${operation.actuation}`);
                throw new LockOperationFailedError(DoorLock.OperationError.Unspecified, "remote unlocking is disabled");
            }
            const outcome = await dispatcher.dispatch(lockAction, "matter");
            if (outcome !== "ran") throw new LockOperationFailedError(DoorLock.OperationError.Unspecified, outcome);
        }
    }

    const endpoint = new Endpoint(DoorLockDevice.with(BridgedDeviceBasicInformationServer, ArchnestLockServer), {
        ...bridgedInfo(dev),
        doorLock: {
            lockType: DoorLock.LockType.Other,
            lockState: dev.initial ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked,
            actuatorEnabled: true,
            operatingMode: DoorLock.OperatingMode.Normal,
        },
    });
    await aggregator.add(endpoint);

    const probe = dev.probe;
    if (!probe) return undefined;
    return async () => {
        const state = (await exec.test(probe)) ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;
        if (endpoint.state.doorLock.lockState !== state) {
            await endpoint.set({ doorLock: { lockState: state } }).catch(e => log.error(`${dev.name}: ${e}`));
        }
    };
}

/** dimmer devices: OnOff + LevelControl. On/off run `on`/`off`; level changes run `level` with a percent. */
async function addDimmer(aggregator: Endpoint, dev: DeviceConfig, { config, registry, dispatcher, exec, log }: Deps) {
    const onAction = dev.on ? resolveRef(dev.on, registry, config) : undefined;
    const offAction = dev.off ? resolveRef(dev.off, registry, config) : undefined;
    const levelAction = registry.resolve(dev.level!);
    const report = (e: unknown) => log.error(`${dev.name}: ${e}`);

    const endpoint = new Endpoint(DimmableLightDevice.with(BridgedDeviceBasicInformationServer), {
        ...bridgedInfo(dev),
        onOff: { onOff: dev.initial },
        levelControl: { currentLevel: 254, minLevel: 1, maxLevel: 254 },
    });
    await aggregator.add(endpoint);

    let expectedOnOff: boolean | undefined;
    let expectedLevel: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    endpoint.events.onOff.onOff$Changed.on(value => {
        if (value === expectedOnOff) return void (expectedOnOff = undefined);
        expectedOnOff = undefined;
        const action = value ? onAction : offAction;
        if (action) dispatcher.dispatch(action, "matter").catch(report);
    });

    endpoint.events.levelControl.currentLevel$Changed.on(level => {
        if (level === null) return;
        if (level === expectedLevel) return void (expectedLevel = undefined);
        expectedLevel = undefined;
        clearTimeout(timer);
        timer = setTimeout(() => {
            dispatcher.dispatch(levelAction, "matter", { percent: toPercent(level) }).catch(report);
        }, LEVEL_DEBOUNCE_MS);
    });

    const probe = dev.probe;
    const levelProbe = dev.levelProbe;
    if (!probe && !levelProbe) return undefined;
    return async () => {
        if (probe) {
            const on = await exec.test(probe);
            if (endpoint.state.onOff.onOff !== on) {
                expectedOnOff = on;
                await endpoint.set({ onOff: { onOff: on } }).catch(report);
            }
        }
        if (levelProbe) {
            const percent = Number.parseInt((await exec.capture(levelProbe)).trim(), 10);
            if (Number.isNaN(percent)) return;
            const level = toLevel(percent);
            // Ignore 1-step rounding noise so we don't fight Google Home's own value.
            if (Math.abs((endpoint.state.levelControl.currentLevel ?? 0) - level) > 2) {
                expectedLevel = level;
                await endpoint.set({ levelControl: { currentLevel: level } }).catch(report);
            }
        }
    };
}
