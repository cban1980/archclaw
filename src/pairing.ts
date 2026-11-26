import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManualPairingCodeCodec, QrPairingCodeCodec, VendorId } from "@matter/main/types";
import type { Config } from "./config.ts";

/** Must match the Google Home Developer Console entry (Matter test vendor/product). */
export const VENDOR_ID = 0xfff1;
export const PRODUCT_ID = 0x8000;

/** Same codes the running bridge prints, computed offline from the config. */
export function pairingCodes(config: Pick<Config, "matter">) {
    const { passcode, discriminator } = config.matter;
    const qr = QrPairingCodeCodec.encode([
        {
            version: 0,
            vendorId: VendorId(VENDOR_ID),
            productId: PRODUCT_ID,
            flowType: 0, // standard: the device is commissionable whenever it isn't paired
            discriminator,
            passcode,
            discoveryCapabilities: 4, // on IP network (no BLE)
        },
    ]);
    const manual = ManualPairingCodeCodec.encode({ discriminator, passcode });
    return { qr, manual, manualFormatted: manual.replace(/^(\d{4})(\d{3})(\d{4})$/, "$1-$2-$3") };
}

/** Number of controllers (Google Home, …) this bridge is paired with, read from Matter storage. */
export function pairedFabrics(statePath: string): number {
    try {
        const fabrics = JSON.parse(readFileSync(join(statePath, "archnest", "fabrics.fabrics"), "utf8"));
        return Array.isArray(fabrics) ? fabrics.length : 0;
    } catch {
        return 0;
    }
}
