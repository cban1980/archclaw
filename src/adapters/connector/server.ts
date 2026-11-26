import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "../../config.ts";
import type { Dispatcher, Registry } from "../../core/dispatcher.ts";
import type { Executor } from "../../core/executor.ts";
import type { Logger } from "../../core/log.ts";
import type { Notifier } from "../../core/notifier.ts";
import { ArchnestOAuthProvider, SCOPE } from "./oauth.ts";
import type { ConnectorStore } from "./store.ts";
import { registerTools } from "./tools.ts";

type Deps = {
    config: Config;
    registry: Registry;
    dispatcher: Dispatcher;
    exec: Executor;
    log: Logger;
    notifier: Notifier;
    store: ConnectorStore;
};

/**
 * The Claude connector: a remote MCP server (Streamable HTTP, stateless) behind its own
 * OAuth authorization server. It listens on localhost only; a tunnel such as Tailscale
 * Funnel publishes it at `connector.publicUrl`, because Claude connects from Anthropic's cloud.
 */
export async function startConnector(deps: Deps) {
    const { config, log, store } = deps;
    const c = config.connector;
    if (!c.publicUrl) throw new Error("connector.publicUrl is not set (the https URL your tunnel publishes)");
    if (!store.hasPassword) throw new Error("no connector owner password; run `archnest connector password`");

    const base = new URL(c.publicUrl);
    const mcpUrl = new URL("/mcp", base);
    const provider = new ArchnestOAuthProvider(store, { log, notifier: deps.notifier, name: config.name });

    const app = createMcpExpressApp({ host: "127.0.0.1", allowedHosts: [base.host, base.hostname, "localhost", "127.0.0.1"] });
    // Requests arrive through the local tunnel daemon, which sets X-Forwarded-For.
    app.set("trust proxy", "loopback");
    app.use(express.urlencoded({ extended: false }));

    app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, scopesSupported: [SCOPE], resourceName: `archnest (${config.name})` }));
    app.post("/consent", (req, res) => void provider.handleConsent(req, res));

    const auth = requireBearerAuth({
        verifier: provider,
        requiredScopes: [SCOPE],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    });

    app.post("/mcp", auth, async (req, res) => {
        // Stateless: a fresh server + transport per request; nothing to clean up between calls.
        const server = new McpServer({ name: "archnest", version: "0.1.0" });
        registerTools(server, deps);
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
        const l = app.listen(c.port, "127.0.0.1", () => resolve(l));
        l.on("error", reject);
    });
    const port = (listener.address() as import("node:net").AddressInfo).port;
    log.info(`connector: listening on 127.0.0.1:${port}, published as ${mcpUrl}`);
    return { provider, port, close: () => listener.close() };
}
