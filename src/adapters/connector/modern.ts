import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * MCP revision 2026-07-28 ("modern", stateless) on top of the SDK, which only speaks the
 * initialize-based protocol. Every modern request carries its protocol version in
 * params._meta; there is no initialize. We answer server/discover ourselves and run
 * tools/list and tools/call against a fresh in-process McpServer (the same tools the
 * legacy path serves), adding the required cache hints so clients refresh the tool list.
 */

export const MODERN = "2026-07-28";
/** Legacy revisions the SDK path still serves. */
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
/** How long clients may reuse discover and tools/list results. Short: the tools follow the config. */
export const TTL_MS = 60_000;

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: { _meta?: Record<string, unknown>; name?: string; uri?: string; [k: string]: unknown } };

/** True when a POST body is a modern-era request (it declares its version in _meta). */
export function isModern(body: unknown): body is RpcRequest {
    const b = body as RpcRequest | undefined;
    return Boolean(b && !Array.isArray(b) && typeof b.params?._meta?.[META_VERSION] === "string");
}

const rpcError = (res: Response, http: number, id: RpcRequest["id"], code: number, message: string, data?: unknown) =>
    void res.status(http).json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Connects an in-process client to a server built for this request. */
async function connect(build: () => McpServer) {
    const server = build();
    const client = new Client({ name: "archclaw-modern-bridge", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, close: () => Promise.allSettled([client.close(), server.close()]) };
}

export async function handleModern(
    req: Request,
    res: Response,
    opts: { build: () => McpServer; instructions: () => string; name: string; version: string; log: { info(m: string): void } },
) {
    const body = req.body as RpcRequest;
    const version = body.params!._meta![META_VERSION] as string;
    const method = body.method ?? "";

    if (version !== MODERN) {
        return rpcError(res, 400, body.id, -32022, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: version });
    }
    // Standard headers must agree with the body (Streamable HTTP, 2026-07-28).
    const header = (name: string) => {
        const v = req.get(name);
        const b64 = v && /^=\?base64\?(.*)\?=$/.exec(v);
        return b64 ? Buffer.from(b64[1]!, "base64").toString("utf8") : v;
    };
    const hv = header("mcp-protocol-version");
    const hm = header("mcp-method");
    const hn = header("mcp-name");
    if ((hv && hv !== version) || (hm && hm !== method) || (hn && hn !== (body.params?.name ?? body.params?.uri))) {
        return rpcError(res, 400, body.id, -32020, "Header mismatch");
    }
    // Notifications get no response body.
    if (body.id === undefined || body.id === null) return void res.status(202).end();

    const cache = { ttlMs: TTL_MS, cacheScope: "private" as const }; // tools reflect this owner's config
    switch (method) {
        case "server/discover":
            return void res.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                    resultType: "complete",
                    supportedVersions: [MODERN],
                    capabilities: { tools: { listChanged: false } },
                    _meta: { "io.modelcontextprotocol/serverInfo": { name: opts.name, version: opts.version } },
                    instructions: opts.instructions(),
                    ...cache,
                },
            });
        case "ping":
            return void res.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete" } });
        case "tools/list":
        case "tools/call": {
            const { client, close } = await connect(opts.build);
            try {
                if (method === "tools/list") {
                    const { tools } = await client.listTools();
                    return void res.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", tools, ...cache } });
                }
                const { name, arguments: args } = body.params as { name: string; arguments?: Record<string, unknown> };
                const result = await client.callTool({ name, arguments: args ?? {} });
                return void res.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...result } });
            } catch (err) {
                const e = err as { code?: number; message: string };
                return rpcError(res, 200, body.id, typeof e.code === "number" ? e.code : -32603, e.message);
            } finally {
                void close();
            }
        }
        default:
            return rpcError(res, 404, body.id, -32601, `Method not found: ${method}`);
    }
}
