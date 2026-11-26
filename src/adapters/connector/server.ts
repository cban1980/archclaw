import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Logger } from "../../core/log.ts";
import type { Notifier } from "../../core/notifier.ts";
import { ArchclawOAuthProvider, SCOPE } from "./oauth.ts";
import type { ConnectorStore } from "./store.ts";
import { instructionsFor, registerTools, type ToolDeps } from "./tools.ts";
import { handleModern, isModern } from "./modern.ts";

const VERSION = "2.1.0";

type Deps = ToolDeps & { log: Logger; notifier: Notifier; auth: ConnectorStore };

/**
 * The Claude connector: a remote MCP server (Streamable HTTP, stateless) behind its own
 * OAuth authorization server. It listens on localhost only; a tunnel (Cloudflare Tunnel)
 * publishes it at `connector.publicUrl`, because Claude connects from Anthropic's cloud.
 */
export async function startConnector(deps: Deps) {
    const { log, auth: authStore } = deps;
    const config = deps.store.config;
    const c = config.connector;
    if (!c.publicUrl) throw new Error("connector.publicUrl is not set (the https URL your tunnel publishes): archclaw connector url https://…");
    if (!authStore.hasPassword) throw new Error("no connector owner password; run `archclaw connector password`");

    const base = new URL(c.publicUrl);
    const mcpUrl = new URL("/mcp", base);
    const provider = new ArchclawOAuthProvider(authStore, { log, notifier: deps.notifier, name: config.name });

    const app = createMcpExpressApp({ host: c.listen, allowedHosts: [base.host, base.hostname, "localhost", "127.0.0.1"] });
    // Only the tunnel may connect; everything else on the network is turned away before any route.
    const allowed = new Set(c.allowFrom.flatMap(ip => [ip, `::ffff:${ip}`]));
    app.use((req, res, next) => {
        const from = req.socket.remoteAddress ?? "";
        if (allowed.has(from)) return next();
        log.warn(`connector: refused a connection from ${from}`);
        res.status(403).end();
    });
    // Log the OAuth steps (path and status only, never query strings or bodies), so a sign-in
    // that stalls can be followed in the journal.
    app.use((req, res, next) => {
        res.on("finish", () => {
            if (req.path !== "/mcp" || res.statusCode >= 400) log.info(`connector: ${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode}`);
        });
        next();
    });
    // Requests arrive through the tunnel daemon, which sets X-Forwarded-For.
    app.set("trust proxy", c.allowFrom);
    app.use(express.urlencoded({ extended: false }));

    app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, scopesSupported: [SCOPE], resourceName: `archclaw (${config.name})` }));
    app.post("/consent", (req, res) => void provider.handleConsent(req, res));

    const auth = requireBearerAuth({
        verifier: provider,
        requiredScopes: [SCOPE],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    });

    app.post("/mcp", auth, async (req, res) => {
        for (const m of [req.body].flat() as Array<{ method?: string; params?: { name?: string; arguments?: unknown } }>) {
            if (m?.method === "tools/call") log.info(`claude: ${m.params?.name} ${JSON.stringify(m.params?.arguments ?? {})}`);
            else if (m?.method && !m.method.startsWith("notifications/")) log.info(`claude: ${m.method}`);
        }
        // Stateless: a fresh server + transport per request; nothing to clean up between calls.
        // The config can change between requests (Claude edits it), so build tools and instructions each time.
        const build = () => {
            const s = new McpServer({ name: "archclaw", version: VERSION }, { instructions: instructionsFor(deps.store.config) });
            registerTools(s, deps);
            return s;
        };
        // MCP 2026-07-28 (stateless, server/discover) is answered here; older revisions go to the SDK.
        if (isModern(req.body)) {
            try {
                await handleModern(req, res, { build, instructions: () => instructionsFor(deps.store.config), name: "archclaw", version: VERSION, log });
            } catch (err) {
                log.error(`connector: ${(err as Error).message}`);
                if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
            }
            return;
        }
        const server = build();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            log.error(`connector: ${(err as Error).message}`);
            if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
        }
    });
    // Stateless servers have no session stream to GET or session to DELETE.
    app.get("/mcp", auth, (_req, res) => void res.status(405).set("Allow", "POST").end());
    app.delete("/mcp", auth, (_req, res) => void res.status(405).set("Allow", "POST").end());

    const listener = await new Promise<import("node:http").Server>((resolve, reject) => {
        const l = app.listen(c.port, c.listen, () => resolve(l));
        l.on("error", reject);
    });
    const port = (listener.address() as import("node:net").AddressInfo).port;
    log.info(`connector: listening on ${c.listen}:${port} (from ${c.allowFrom.join(", ")}), published as ${mcpUrl}`);
    return { provider, port, close: () => listener.close() };
}
