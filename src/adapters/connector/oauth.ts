import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
    InvalidClientMetadataError,
    InvalidGrantError,
    InvalidRequestError,
    InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Logger } from "../../core/log.ts";
import type { Notifier } from "../../core/notifier.ts";
import { type ConnectorStore, hashToken, newToken } from "./store.ts";

export const SCOPE = "archclaw";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Only Claude may register: the hosted apps' fixed callback, and Claude Code's loopback
 * redirect on any port. Anything else is refused at registration time.
 */
export function isAllowedRedirect(uri: string): boolean {
    if (uri === "https://claude.ai/api/mcp/auth_callback") return true;
    try {
        const u = new URL(uri);
        return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.pathname === "/callback";
    } catch {
        return false;
    }
}

type Pending = { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number };
type Code = { clientId: string; params: AuthorizationParams; expiresAt: number };
type Access = { clientId: string; scopes: string[]; resource?: string; expiresAt: number };

/**
 * A single-user OAuth authorization server for the Claude connector. Claude registers
 * itself (DCR), the owner approves on a consent page with the owner password, and
 * Claude gets a 1 h access token plus a rotating 30-day refresh token.
 */
export class ArchclawOAuthProvider implements OAuthServerProvider {
    #store: ConnectorStore;
    #log: Logger;
    #notifier: Notifier;
    #name: string;
    #pending = new Map<string, Pending>();
    #codes = new Map<string, Code>();
    #access = new Map<string, Access>();
    #failures: number[] = [];

    constructor(store: ConnectorStore, opts: { log: Logger; notifier: Notifier; name: string }) {
        this.#store = store;
        this.#log = opts.log;
        this.#notifier = opts.notifier;
        this.#name = opts.name;
    }

    get clientsStore(): OAuthRegisteredClientsStore {
        return {
            getClient: id => this.#store.getClient(id),
            registerClient: client => {
                const uris = client.redirect_uris ?? [];
                if (!uris.length || !uris.every(u => isAllowedRedirect(String(u)))) {
                    this.#log.warn(`connector: refused client registration for ${uris.join(", ")}`);
                    throw new InvalidClientMetadataError("only Claude's redirect URIs are accepted");
                }
                const full = {
                    ...client,
                    client_id: randomUUID(),
                    client_id_issued_at: Math.floor(Date.now() / 1000),
                } as OAuthClientInformationFull;
                this.#store.addClient(full);
                return full;
            },
        };
    }

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
        if (!client.redirect_uris.map(String).includes(params.redirectUri)) {
            throw new InvalidRequestError("unregistered redirect_uri");
        }
        const id = randomBytes(18).toString("base64url");
        this.#pending.set(id, { client, params, expiresAt: Date.now() + PENDING_TTL_MS });
        res.setHeader("Cache-Control", "no-store");
        // No form-action directive: Chrome applies it to the redirect back to claude.ai.
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
        res.type("html").send(consentPage({ id, name: this.#name, redirectHost: new URL(params.redirectUri).host }));
    }

    /** POST /consent from the consent page. */
    async handleConsent(req: Request, res: Response) {
        const { id, password, decision } = (req.body ?? {}) as Record<string, string>;
        const pending = id ? this.#pending.get(id) : undefined;
        if (!pending || pending.expiresAt < Date.now()) {
            res.status(400).type("html").send(messagePage("This sign-in request has expired. Start again from Claude."));
            return;
        }
        const redirect = new URL(pending.params.redirectUri);
        if (pending.params.state !== undefined) redirect.searchParams.set("state", pending.params.state);

        if (decision !== "allow") {
            this.#pending.delete(id!);
            redirect.searchParams.set("error", "access_denied");
            res.redirect(redirect.toString());
            return;
        }

        const now = Date.now();
        this.#failures = this.#failures.filter(t => now - t < LOCKOUT_MS);
        if (this.#failures.length >= MAX_FAILURES) {
            res.status(429).type("html").send(messagePage("Too many wrong passwords. Try again in 15 minutes."));
            return;
        }
        if (!password || !this.#store.checkPassword(password)) {
            this.#failures.push(now);
            this.#log.warn(`connector: wrong owner password (${this.#failures.length}/${MAX_FAILURES})`);
            res.status(401).type("html").send(
                consentPage({ id: id!, name: this.#name, redirectHost: redirect.host, error: "Wrong password." }),
            );
            return;
        }

        this.#pending.delete(id!);
        const code = newToken();
        this.#codes.set(hashToken(code), {
            clientId: pending.client.client_id,
            params: pending.params,
            expiresAt: now + CODE_TTL_MS,
        });
        this.#log.info(`connector: approved ${pending.client.client_name ?? pending.client.client_id}`);
        this.#notifier.info("archclaw", `Claude was connected to ${this.#name}.`);
        redirect.searchParams.set("code", code);
        res.redirect(redirect.toString());
    }

    async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string) {
        const c = this.#codes.get(hashToken(code));
        if (!c || c.expiresAt < Date.now()) throw new InvalidGrantError("invalid or expired code");
        return c.params.codeChallenge;
    }

    async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) {
        const key = hashToken(code);
        const c = this.#codes.get(key);
        this.#codes.delete(key); // single use, even on failure
        if (!c || c.expiresAt < Date.now() || c.clientId !== client.client_id) throw new InvalidGrantError("invalid code");
        if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
        return this.#issue(client.client_id, c.params.scopes ?? [SCOPE], c.params.resource?.toString());
    }

    async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string) {
        const r = this.#store.takeRefresh(refreshToken);
        if (!r || r.clientId !== client.client_id) throw new InvalidGrantError("invalid refresh token");
        return this.#issue(client.client_id, r.scopes, r.resource);
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const a = this.#access.get(hashToken(token));
        // InvalidTokenError maps to 401, which is what makes Claude refresh or sign in again.
        if (!a || a.expiresAt < Date.now()) throw new InvalidTokenError("invalid or expired token");
        return {
            token,
            clientId: a.clientId,
            scopes: a.scopes,
            expiresAt: Math.floor(a.expiresAt / 1000),
            ...(a.resource ? { resource: new URL(a.resource) } : {}),
        };
    }

    /** Signs every client out: drops all access and refresh tokens. */
    revokeAll() {
        this.#access.clear();
        this.#store.revokeAll();
    }

    #issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
        const access = newToken();
        const refresh = newToken();
        const now = Date.now();
        for (const [k, v] of this.#access) if (v.expiresAt < now) this.#access.delete(k);
        this.#access.set(hashToken(access), { clientId, scopes, resource, expiresAt: now + ACCESS_TTL_S * 1000 });
        this.#store.addRefresh(refresh, { clientId, scopes, resource, expiresAt: now + REFRESH_TTL_MS });
        return {
            access_token: access,
            token_type: "bearer",
            expires_in: ACCESS_TTL_S,
            refresh_token: refresh,
            scope: scopes.join(" "),
        };
    }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const STYLE = `body{font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:#1c1c1c;border:1px solid #333;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 12px}p{color:#bbb;line-height:1.5}.err{color:#ff7b72}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;font-size:16px;margin:8px 0 16px}
.row{display:flex;gap:8px}button{flex:1;padding:10px;border-radius:8px;border:0;font-size:16px;cursor:pointer}
.allow{background:#3b82f6;color:#fff}.deny{background:#333;color:#eee}`;

function consentPage(o: { id: string; name: string; redirectHost: string; error?: string }) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>archclaw – connect Claude</title><style>${STYLE}</style></head><body><main>
<h1>Connect Claude to ${esc(o.name)}</h1>
<p>Claude will be able to control this computer through archclaw: open and close apps, change volume and screens,
lock it, and (with a countdown on screen) shut it down or restart it. You will be sent back to <b>${esc(o.redirectHost)}</b>.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form method="post" action="consent">
<input type="hidden" name="id" value="${esc(o.id)}">
<label for="pw">archclaw owner password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
<div class="row"><button class="deny" name="decision" value="deny">Deny</button>
<button class="allow" name="decision" value="allow">Allow</button></div>
</form></main></body></html>`;
}

function messagePage(text: string) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>archclaw</title><style>${STYLE}</style></head><body><main><p>${esc(text)}</p></main></body></html>`;
}
