import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Persistent state for the Claude connector: the owner password hash, registered
 * OAuth clients and refresh tokens. Tokens are stored only as SHA-256 hashes, so the
 * file never contains a usable credential. Access tokens live in memory (1 h) and
 * simply require a refresh after a restart.
 */
type RefreshRecord = { clientId: string; scopes: string[]; resource?: string; expiresAt: number };
type Data = {
    owner?: { salt: string; hash: string };
    clients: Record<string, OAuthClientInformationFull>;
    refresh: Record<string, RefreshRecord>;
};

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export class ConnectorStore {
    #path: string;
    #data: Data;

    constructor(path: string) {
        this.#path = path;
        try {
            this.#data = JSON.parse(readFileSync(path, "utf8")) as Data;
        } catch {
            this.#data = { clients: {}, refresh: {} };
        }
    }

    #save() {
        mkdirSync(dirname(this.#path), { recursive: true });
        const tmp = `${this.#path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
        renameSync(tmp, this.#path);
        chmodSync(this.#path, 0o600);
    }

    // ── owner password ──
    get hasPassword() {
        return Boolean(this.#data.owner);
    }

    setPassword(password: string) {
        if (password.length < 10) throw new Error("use at least 10 characters");
        const salt = randomBytes(16);
        this.#data.owner = { salt: salt.toString("hex"), hash: scryptSync(password, salt, 64).toString("hex") };
        // A new password signs every connected client out.
        this.#data.refresh = {};
        this.#save();
    }

    checkPassword(password: string): boolean {
        const owner = this.#data.owner;
        if (!owner) return false;
        const actual = scryptSync(password, Buffer.from(owner.salt, "hex"), 64);
        return timingSafeEqual(actual, Buffer.from(owner.hash, "hex"));
    }

    // ── clients ──
    getClient(id: string) {
        return this.#data.clients[id];
    }

    addClient(client: OAuthClientInformationFull) {
        this.#data.clients[client.client_id] = client;
        this.#save();
    }

    // ── refresh tokens ──
    addRefresh(token: string, record: RefreshRecord) {
        const now = Date.now();
        for (const [k, r] of Object.entries(this.#data.refresh)) if (r.expiresAt < now) delete this.#data.refresh[k];
        this.#data.refresh[hashToken(token)] = record;
        this.#save();
    }

    /** Returns and removes the record: refresh tokens are single-use (rotated). */
    takeRefresh(token: string): RefreshRecord | undefined {
        const key = hashToken(token);
        const record = this.#data.refresh[key];
        if (!record) return undefined;
        delete this.#data.refresh[key];
        this.#save();
        return record.expiresAt > Date.now() ? record : undefined;
    }

    revokeAll() {
        this.#data.refresh = {};
        this.#save();
    }

    get connectedClients() {
        return new Set(Object.values(this.#data.refresh).map(r => r.clientId)).size;
    }
}
