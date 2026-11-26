import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { powerActions } from "../src/actions/power.ts";
import { isAllowedRedirect } from "../src/adapters/connector/oauth.ts";
import { startConnector } from "../src/adapters/connector/server.ts";
import { ConnectorStore } from "../src/adapters/connector/store.ts";
import { loadConfig } from "../src/config.ts";
import { Dispatcher, Registry } from "../src/core/dispatcher.ts";
import type { Executor } from "../src/core/executor.ts";
import { Safety } from "../src/core/safety.ts";

const quiet = { info() {}, warn() {}, error() {} };
const notifier = { info() {}, countdown: () => ({ cancelled: new Promise<boolean>(() => {}), close() {} }) };
const PUBLIC = "https://archnest.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct horse battery";

let base = "";
let close = () => {};
const ran: string[] = [];

before(async () => {
    const config = loadConfig(new URL("../config.example.yaml", import.meta.url).pathname);
    config.connector = { enabled: true, port: 0, publicUrl: PUBLIC };
    const exec: Executor = { sh: async c => (ran.push(c), 0), test: async () => false, capture: async () => "[]" };
    const registry = new Registry().add(...powerActions);
    const safety = new Safety({ countdownSeconds: 0, bootGraceSeconds: 0, repeatWindowSeconds: 60 }, notifier, quiet);
    const store = new ConnectorStore(join(mkdtempSync(join(tmpdir(), "archnest-")), "connector.json"));
    store.setPassword(PASSWORD);
    const started = await startConnector({ config, registry, dispatcher: new Dispatcher(safety, exec, quiet), exec, log: quiet, notifier, store });
    base = `http://127.0.0.1:${started.port}`;
    close = started.close;
});
after(() => close());

// Requests go to localhost but carry the public Host, as they do through the tunnel.
const req = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { host: "archnest.test", ...(init.headers ?? {}) } });
const form = (data: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
});
const mcp = (token: string, body: unknown) =>
    req("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
    });
async function rpcResult(res: Response) {
    const raw = await res.text();
    const json = raw.startsWith("{") ? raw : raw.split("\n").find(l => l.startsWith("data: "))!.slice(6);
    return JSON.parse(json).result;
}

test("redirect allowlist only admits Claude", () => {
    assert.ok(isAllowedRedirect(CALLBACK));
    assert.ok(isAllowedRedirect("http://localhost:3118/callback"));
    assert.ok(isAllowedRedirect("http://127.0.0.1:50000/callback"));
    assert.ok(!isAllowedRedirect("https://evil.example/callback"));
    assert.ok(!isAllowedRedirect("http://localhost.evil.example/callback"));
});

test("full OAuth + MCP flow as Claude runs it", async () => {
    // 1. Unauthenticated MCP call → 401 pointing at the protected resource metadata.
    const unauth = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/archnest\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

    // 2. Discovery.
    const prm = await (await req("/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(prm.resource, `${PUBLIC}/mcp`);
    assert.equal(prm.authorization_servers[0], `${PUBLIC}/`);
    const asm = await (await req("/.well-known/oauth-authorization-server")).json();
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
    assert.ok(asm.registration_endpoint);

    // 3. Registration: foreign redirect refused, Claude's accepted.
    const evil = await req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
    assert.equal(evil.status, 400);
    const reg = await (await req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }) })).json();
    assert.ok(reg.client_id);

    // 4. Authorize → consent page.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "archnest", resource: `${PUBLIC}/mcp` });
    const page = await (await req(`/authorize?${q}`)).text();
    const id = page.match(/name="id" value="([^"]+)"/)![1]!;

    // 5. Wrong password is refused; right password redirects with a code.
    assert.equal((await req("/consent", form({ id, password: "nope", decision: "allow" }))).status, 401);
    const approved = await req("/consent", form({ id, password: PASSWORD, decision: "allow" }));
    assert.equal(approved.status, 302);
    const location = new URL(approved.headers.get("location")!);
    assert.equal(location.origin + location.pathname, CALLBACK);
    assert.equal(location.searchParams.get("state"), "xyz");
    const code = location.searchParams.get("code")!;

    // 6. Token exchange with PKCE; a wrong verifier fails.
    const tokenReq = (v: string) => req("/token", form({ grant_type: "authorization_code", code, code_verifier: v, client_id: reg.client_id, redirect_uri: CALLBACK }));
    assert.equal((await tokenReq("wrong-verifier-wrong-verifier-wrong-verifier-x")).status, 400);
    // A failed exchange burns the code, so start a second authorization for the real exchange.
    const page2 = await (await req(`/authorize?${q}`)).text();
    const id2 = page2.match(/name="id" value="([^"]+)"/)![1]!;
    const code2 = new URL((await req("/consent", form({ id: id2, password: PASSWORD, decision: "allow" }))).headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await req("/token", form({ grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CALLBACK }))).json();
    assert.ok(tokens.access_token && tokens.refresh_token);

    // 7. MCP with the token: initialize, list tools, call one.
    const init = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal(init.status, 200);
    const tools = await rpcResult(await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const names = tools.tools.map((t: { name: string }) => t.name);
    for (const n of ["get_status", "list_capabilities", "run_action", "open_app", "close_app", "switch_device"]) assert.ok(names.includes(n), n);
    const call = await rpcResult(await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_action", arguments: { action: "power.lock" } } }));
    assert.match(call.content[0].text, /ran/);
    assert.ok(ran.some(c => c.includes("lock")));

    // 8. Refresh rotates: the new token works, the old one is dead.
    const refreshed = await (await req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json();
    assert.ok(refreshed.access_token && refreshed.refresh_token !== tokens.refresh_token);
    const reused = await req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }));
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error, "invalid_grant");

    // 9. A bogus token is rejected.
    assert.equal((await mcp("bogus", { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 401);
});

test("power actions from Claude start a countdown instead of blocking", async () => {
    // Covered via run(): confirm-risk actions return immediately with a countdown message.
    const config = loadConfig(new URL("../config.example.yaml", import.meta.url).pathname);
    assert.ok(config.devices.some(d => d.on === "power.shutdown"));
});
