import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A small Philips Hue client (CLIP v2, local). The bridge serves a certificate from
 * Signify's own CA whose CN is the bridge id, so we pin that instead of trusting any cert.
 */

/** `cert` is the SHA-256 fingerprint of the bridge's certificate, pinned when pairing. */
export type HueAuth = { ip: string; bridgeId: string; key: string; cert: string };

export class HueStore {
    readonly path: string;
    constructor(path: string) {
        this.path = path;
    }
    load(): HueAuth | undefined {
        if (!existsSync(this.path)) return undefined;
        try {
            const a = JSON.parse(readFileSync(this.path, "utf8")) as HueAuth;
            return a.ip && a.bridgeId && a.key && a.cert ? a : undefined;
        } catch {
            return undefined;
        }
    }
    save(auth: HueAuth) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.path);
    }
}

/**
 * One request to the bridge. Nothing (not even the key header) is sent until the TLS
 * handshake has shown the pinned certificate, or, while pairing, a certificate whose CN is
 * the bridge id. `onCert` reports the fingerprint seen.
 */
function call<T>(opts: {
    ip: string;
    bridgeId: string;
    method: string;
    path: string;
    key?: string;
    cert?: string;
    body?: unknown;
    onCert?: (fingerprint: string) => void;
}): Promise<T> {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: opts.ip,
                port: 443,
                method: opts.method,
                path: opts.path,
                agent: false, // a fresh connection each time, so every request is checked
                headers: {
                    ...(opts.key ? { "hue-application-key": opts.key } : {}),
                    ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
                },
                rejectUnauthorized: false, // Signify's private CA; we pin the certificate below instead
                timeout: 8000,
            },
            res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", d => (data += d));
                res.on("end", () => {
                    try {
                        const json = data ? JSON.parse(data) : {};
                        if ((res.statusCode ?? 500) >= 400) {
                            const msg = (json as { errors?: Array<{ description: string }> }).errors?.map(e => e.description).join("; ");
                            return reject(new Error(`Hue ${opts.method} ${opts.path}: ${res.statusCode} ${msg ?? data}`));
                        }
                        resolve(json as T);
                    } catch (err) {
                        reject(err);
                    }
                });
            },
        );
        req.on("socket", socket => {
            const tls = socket as TLSSocket;
            tls.once("secureConnect", () => {
                const cert = tls.getPeerCertificate();
                const fingerprint = cert?.fingerprint256 ?? "";
                const cn = [cert?.subject?.CN].flat()[0] ?? "";
                const ok = opts.cert ? fingerprint === opts.cert : cn.toLowerCase() === opts.bridgeId.toLowerCase();
                if (!ok) return void req.destroy(new Error(`${opts.ip} isn't the paired Hue bridge (certificate changed); run \`archclaw hue pair\` again`));
                opts.onCert?.(fingerprint);
                if (body) req.write(body);
                req.end();
            });
        });
        req.on("timeout", () => req.destroy(new Error("Hue bridge didn't answer")));
        req.on("error", reject);
    });
}

/** Asks a device at `ip` whether it is a Hue bridge (the unauthenticated config endpoint). */
export async function probeBridge(ip: string): Promise<{ ip: string; bridgeId: string } | undefined> {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`"${ip}" isn't an IPv4 address`);
    return new Promise(resolve => {
        const req = request({ host: ip, port: 443, path: "/api/0/config", rejectUnauthorized: false, timeout: 4000, agent: false }, res => {
            let data = "";
            res.on("data", d => (data += d));
            res.on("end", () => {
                try {
                    const id = (JSON.parse(data) as { bridgeid?: string }).bridgeid;
                    resolve(id ? { ip, bridgeId: id.toLowerCase() } : undefined);
                } catch {
                    resolve(undefined);
                }
            });
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(undefined));
        req.end();
    });
}

/** Finds bridges on the LAN: mDNS, then Philips' discovery service, then the last known address. */
export async function discoverBridges(sh: (cmd: string) => Promise<string>, lastKnown?: string): Promise<Array<{ ip: string; bridgeId: string }>> {
    const found = new Map<string, string>();
    for (const line of (await sh("timeout 10 avahi-browse -rpt _hue._tcp 2>/dev/null")).split("\n")) {
        const f = line.split(";");
        const id = /bridgeid=([0-9a-f]{16})/i.exec(line)?.[1];
        if (f[0] === "=" && f[2] === "IPv4" && f[7] && id) found.set(id.toLowerCase(), f[7]);
    }
    if (!found.size) {
        try {
            const res = await fetch("https://discovery.meethue.com/", { signal: AbortSignal.timeout(5000) });
            for (const b of (await res.json()) as Array<{ id: string; internalipaddress: string }>) found.set(b.id.toLowerCase(), b.internalipaddress);
        } catch {}
    }
    if (!found.size && lastKnown) {
        const b = await probeBridge(lastKnown);
        if (b) found.set(b.bridgeId, b.ip);
    }
    return [...found].map(([bridgeId, ip]) => ({ ip, bridgeId }));
}

/** Asks the bridge for an application key; resolves once the link button has been pressed. */
export async function pairBridge(ip: string, bridgeId: string, deviceName: string, timeoutMs = 60_000): Promise<HueAuth> {
    const deadline = Date.now() + timeoutMs;
    let cert = "";
    for (;;) {
        const res = await call<Array<{ success?: { username: string }; error?: { type: number; description: string } }>>({
            ip,
            bridgeId,
            method: "POST",
            path: "/api",
            body: { devicetype: `archclaw#${deviceName}`.slice(0, 40), generateclientkey: true },
            onCert: f => (cert = f),
        });
        const key = res[0]?.success?.username;
        if (key) return { ip, bridgeId, key, cert };
        if (res[0]?.error?.type !== 101) throw new Error(`Hue: ${res[0]?.error?.description ?? "pairing failed"}`);
        if (Date.now() > deadline) throw new Error("the link button wasn't pressed in time");
        await new Promise(r => setTimeout(r, 2000));
    }
}

type Ref = { rid: string; rtype: string };
type Named = { id: string; metadata?: { name: string; archetype?: string } };
export type HueLight = Named & {
    on: { on: boolean };
    dimming?: { brightness: number };
    color?: { xy: { x: number; y: number } };
    color_temperature?: { mirek: number | null };
    owner: Ref;
};
export type HueGroup = Named & { children: Ref[]; services: Ref[] };
export type HueGroupedLight = { id: string; on?: { on: boolean }; dimming?: { brightness: number } };
export type HueScene = Named & { group: Ref };
type HueDevice = Named & { services: Ref[] };
type BridgeHome = { id: string; services: Ref[] };

export type HueState = {
    lights: HueLight[];
    rooms: HueGroup[];
    zones: HueGroup[];
    groupedLights: HueGroupedLight[];
    scenes: HueScene[];
    devices: HueDevice[];
    home?: BridgeHome;
};

export class HueClient {
    #store: HueStore;
    constructor(store: HueStore) {
        this.#store = store;
    }
    get paired() {
        return this.#store.load() !== undefined;
    }
    #auth(): HueAuth {
        const a = this.#store.load();
        if (!a) throw new Error("not paired with a Hue bridge; run `archclaw hue pair` on the computer");
        return a;
    }
    async #get<T>(resource: string): Promise<T[]> {
        const a = this.#auth();
        return (await call<{ data: T[] }>({ ...a, method: "GET", path: `/clip/v2/resource/${resource}` })).data;
    }
    async put(resource: string, id: string, body: unknown) {
        const a = this.#auth();
        await call({ ...a, method: "PUT", path: `/clip/v2/resource/${resource}/${id}`, body });
    }
    async state(): Promise<HueState> {
        const [lights, rooms, zones, groupedLights, scenes, devices, homes] = await Promise.all([
            this.#get<HueLight>("light"),
            this.#get<HueGroup>("room"),
            this.#get<HueGroup>("zone"),
            this.#get<HueGroupedLight>("grouped_light"),
            this.#get<HueScene>("scene"),
            this.#get<HueDevice>("device"),
            this.#get<BridgeHome>("bridge_home"),
        ]);
        return { lights, rooms, zones, groupedLights, scenes, devices, home: homes[0] };
    }
}
