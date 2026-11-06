// Loopback-only MCP transport exposing pi's tools (src/bridge-catalog.ts) to
// the official ACP server. No global agy config, approval hooks, or tool execution happens here:
// every call is parked into provider.ts and executed by pi itself.

import http from "node:http";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

export const TOKEN_HEADER = "x-bridge-token";
const MAX_BODY_BYTES = 1_000_000;

export interface BridgeResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError?: boolean;
}

export interface McpBridgeDeps {
	listTools(): Array<{ name: string; description: string; inputSchema: object }>;
	onToolCall(callId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeResult>;
}

export interface McpServerHandle {
	port: number;
	token: string;
	close: () => Promise<void>;
}

export type McpStartResult = { ok: true; handle: McpServerHandle } | { ok: false; reason: string };

/** agy may negotiate a newer MCP version than our SDK. The stateless transport
 * cannot remember a negotiated version, so clamp unsupported request headers. */
function clampProtocolVersion(req: http.IncomingMessage): void {
	const sent = req.headers["mcp-protocol-version"];
	if (typeof sent !== "string" || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return;
	req.headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
	for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
		if (req.rawHeaders[i].toLowerCase() === "mcp-protocol-version") req.rawHeaders[i + 1] = LATEST_PROTOCOL_VERSION;
	}
}

export async function startMcpServer(deps: McpBridgeDeps): Promise<McpStartResult> {
	const token = crypto.randomUUID();
	const tokenOk = (req: http.IncomingMessage): boolean => {
		const received = req.headers[TOKEN_HEADER];
		return typeof received === "string" && received.length === token.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(token));
	};

	const httpServer = http.createServer(async (req, res) => {
		try {
			if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/mcp") {
				res.writeHead(404).end();
				return;
			}
			if (!tokenOk(req)) {
				res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
				return;
			}
			// Decode once the body is complete: a multi-byte character split
			// across network chunks must not turn into U+FFFD.
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of req as AsyncIterable<Buffer>) {
				bytes += chunk.length;
				if (bytes > MAX_BODY_BYTES) {
					res.writeHead(413, { connection: "close" }).end();
					return;
				}
				chunks.push(chunk);
			}
			let parsed: object;
			try {
				parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as object;
			} catch {
				res.writeHead(400).end("invalid json");
				return;
			}
			clampProtocolVersion(req);
			const abort = new AbortController();
			req.on("aborted", () => abort.abort());
			res.on("close", () => { if (!res.writableEnded) abort.abort(); });

			const server = new Server({ name: "realagy", version: "2.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: deps.listTools() }));
			server.setRequestHandler(CallToolRequestSchema, async (request) => {
				const name = request.params.name;
				const args = request.params.arguments;
				const callId = crypto.randomUUID();
				try {
					const result = await deps.onToolCall(callId, name, (args && typeof args === "object" ? args : {}) as Record<string, unknown>, abort.signal);
					return { content: result.content, isError: result.isError ?? false };
				} catch (error) {
					return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
				}
			});
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			await server.connect(transport);
			await transport.handleRequest(req, res, parsed);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500).end(error instanceof Error ? error.message : String(error));
			else res.end();
		}
	});

	return new Promise<McpStartResult>((resolve) => {
		httpServer.once("error", (error) => resolve({ ok: false, reason: error.message }));
		httpServer.listen(0, "127.0.0.1", () => {
			const address = httpServer.address();
			if (!address || typeof address === "string") {
				resolve({ ok: false, reason: "MCP server did not bind a TCP port" });
				return;
			}
			resolve({
				ok: true,
				handle: {
					port: address.port,
					token,
					close: () => new Promise<void>((done) => {
						httpServer.closeAllConnections();
						httpServer.close(() => done());
					}),
				},
			});
		});
	});
}
