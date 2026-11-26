import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { type SpotifyTokenStore, tokenRequest } from "./client.ts";

export const LOGIN_PORT = 8898;
export const REDIRECT_URI = `http://127.0.0.1:${LOGIN_PORT}/callback`;
const SCOPES = "user-read-playback-state user-modify-playback-state";

/**
 * Authorization Code with PKCE (no client secret). Opens a one-shot listener on
 * 127.0.0.1, prints the Spotify login URL (and tries to open it), and stores the
 * refresh token when Spotify redirects back.
 */
export async function spotifyLogin(clientId: string, store: SpotifyTokenStore, open: (url: string) => void): Promise<void> {
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");
    const url = new URL("https://accounts.spotify.com/authorize");
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
    }).toString();

    const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => (server.close(), reject(new Error("timed out waiting for the Spotify login (5 min)"))), 5 * 60_000);
        const server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", REDIRECT_URI);
            if (u.pathname !== "/callback") return void res.writeHead(404).end();
            const page = (msg: string) =>
                res
                    .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
                    .end(`<!doctype html><meta charset="utf-8"><title>archnest</title><body style="font:16px system-ui;background:#111;color:#eee;padding:32px"><p>${msg}</p>`);
            if (u.searchParams.get("state") !== state) return page("Unexpected login response; start again with <code>archnest spotify login</code>.");
            const err = u.searchParams.get("error");
            const got = u.searchParams.get("code");
            clearTimeout(timer);
            server.close();
            if (err || !got) {
                page(`Spotify login failed: ${err ?? "no code"}. You can close this tab.`);
                return reject(new Error(`Spotify login failed: ${err ?? "no code"}`));
            }
            page("archnest is connected to Spotify. You can close this tab.");
            resolve(got);
        });
        server.on("error", err => (clearTimeout(timer), reject(err)));
        server.listen(LOGIN_PORT, "127.0.0.1", () => {
            console.log(`Open this URL to log in to Spotify (opening it in your browser):\n\n  ${url}\n`);
            open(url.toString());
        });
    });

    const t = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
    });
    if (!t.refresh_token) throw new Error("Spotify returned no refresh token");
    store.save({ clientId, refreshToken: t.refresh_token });
}
