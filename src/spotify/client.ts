import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";

/** What we keep on disk (mode 600): the refresh token. Access tokens live in memory only. */
type Saved = { clientId: string; refreshToken: string };

export type SpotifyDevice = { id: string | null; name: string; type: string; is_active: boolean; is_restricted: boolean };
export type PlaybackState = {
    is_playing: boolean;
    device?: SpotifyDevice;
    shuffle_state?: boolean;
    repeat_state?: string;
    item?: { name?: string; uri?: string; artists?: Array<{ name: string }>; album?: { name?: string } } | null;
};

export type SearchKind = "track" | "album" | "playlist" | "artist";
export type SearchHit = { kind: SearchKind; name: string; uri: string; by?: string };

export class SpotifyError extends Error {
    readonly status: number;
    readonly retryAfterS?: number;
    constructor(message: string, status: number, retryAfterS?: number) {
        super(message);
        this.status = status;
        this.retryAfterS = retryAfterS;
    }
}

/** Refresh-token storage shared by the CLI (`archclaw spotify login`) and the service. */
export class SpotifyTokenStore {
    readonly path: string;
    constructor(path: string) {
        this.path = path;
    }

    load(): Saved | undefined {
        if (!existsSync(this.path)) return undefined;
        try {
            const s = JSON.parse(readFileSync(this.path, "utf8")) as Saved;
            return s.refreshToken && s.clientId ? s : undefined;
        } catch {
            return undefined;
        }
    }

    save(saved: Saved) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.path);
    }

    clear() {
        if (existsSync(this.path)) writeFileSync(this.path, "{}", { mode: 0o600 });
    }
}

export async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new SpotifyError(`token request failed: ${json.error_description ?? json.error ?? res.status}`, res.status);
    return json as { access_token: string; expires_in: number; refresh_token?: string };
}

/**
 * A minimal Spotify Web API client for the player endpoints. Refreshes its access token
 * from the stored refresh token (re-reading the file each time, since the CLI and the
 * service share it and Spotify may rotate it).
 */
export class SpotifyClient {
    #access?: { token: string; expiresAt: number };
    #store: SpotifyTokenStore;

    constructor(store: SpotifyTokenStore) {
        this.#store = store;
    }

    get loggedIn() {
        return this.#store.load() !== undefined;
    }

    async #token(force = false): Promise<string> {
        if (!force && this.#access && this.#access.expiresAt > Date.now() + 30_000) return this.#access.token;
        const saved = this.#store.load();
        if (!saved) throw new SpotifyError("not logged in to Spotify; run `archclaw spotify login`", 401);
        let t;
        try {
            t = await tokenRequest({ grant_type: "refresh_token", refresh_token: saved.refreshToken, client_id: saved.clientId });
        } catch (err) {
            if (err instanceof SpotifyError && err.status === 400) {
                throw new SpotifyError("the Spotify login has expired or was revoked; run `archclaw spotify login`", 401);
            }
            throw err;
        }
        if (t.refresh_token && t.refresh_token !== saved.refreshToken) this.#store.save({ ...saved, refreshToken: t.refresh_token });
        this.#access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
        return t.access_token;
    }

    async #call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T | undefined> {
        const res = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${await this.#token(retried)}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 && !retried) return this.#call(method, path, body, true);
        if (res.status === 204 || res.status === 202) return undefined;
        const text = await res.text();
        if (!res.ok) {
            let msg = text;
            try {
                const j = JSON.parse(text) as { error?: { message?: string; reason?: string } };
                msg = [j.error?.message, j.error?.reason].filter(Boolean).join(" / ") || text;
            } catch {}
            const retry = Number(res.headers.get("retry-after")) || undefined;
            throw new SpotifyError(`Spotify ${method} ${path}: ${res.status} ${msg}`.trim(), res.status, retry);
        }
        return text ? (JSON.parse(text) as T) : undefined;
    }

    /** Current playback, or undefined when nothing is playing anywhere. */
    playback() {
        return this.#call<PlaybackState>("GET", "/me/player");
    }

    async devices(): Promise<SpotifyDevice[]> {
        return (await this.#call<{ devices: SpotifyDevice[] }>("GET", "/me/player/devices"))?.devices ?? [];
    }

    transfer(deviceId: string, play: boolean) {
        return this.#call<void>("PUT", "/me/player", { device_ids: [deviceId], play });
    }

    /** Resumes, or plays `uris` (tracks) or a `context_uri` (album, playlist, artist) on the device. */
    play(deviceId: string, what?: { uris?: string[]; context_uri?: string }) {
        return this.#call<void>("PUT", `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, what);
    }

    /** The user's own and followed playlists (needs playlist-read-private for private ones). */
    async myPlaylists(): Promise<SearchHit[]> {
        const out: SearchHit[] = [];
        for (let offset = 0; offset < 500; offset += 50) {
            type Page = { items: Array<{ name: string; uri: string; owner?: { display_name?: string } } | null>; next: string | null };
            const page = await this.#call<Page>("GET", `/me/playlists?limit=50&offset=${offset}`);
            for (const p of page?.items ?? []) if (p) out.push({ kind: "playlist", name: p.name, uri: p.uri, ...(p.owner?.display_name ? { by: p.owner.display_name } : {}) });
            if (!page?.next) break;
        }
        return out;
    }

    async search(query: string, kinds: SearchKind[], limit = 5): Promise<SearchHit[]> {
        const q = new URLSearchParams({ q: query, type: kinds.join(","), limit: String(limit) });
        type Item = { name: string; uri: string; artists?: Array<{ name: string }>; owner?: { display_name?: string } } | null;
        const res = await this.#call<Record<string, { items: Item[] }>>("GET", `/search?${q}`);
        const hits: SearchHit[] = [];
        for (const kind of kinds) {
            for (const item of res?.[`${kind}s`]?.items ?? []) {
                if (!item) continue; // Spotify returns null for some unavailable playlists
                const by = item.artists?.map(a => a.name).join(", ") || item.owner?.display_name;
                hits.push({ kind, name: item.name, uri: item.uri, ...(by ? { by } : {}) });
            }
        }
        return hits;
    }
}
