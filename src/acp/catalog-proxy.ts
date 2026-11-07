// Loopback Cloud Code reverse proxy. Agy is started with
// `--cloud_code_endpoint http://127.0.0.1:<port>`, so no CA or HTTPS MITM is
// needed. Only fetchAvailableModels is buffered and rewritten; generation,
// auth, quota, and SSE traffic stream through unchanged.

import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fetch, Headers, ProxyAgent } from "undici";

const CATALOG_SUFFIX = "/v1internal:fetchAvailableModels";
const CHECKPOINTER_PREFIX = "CASCADE_USE_EXPERIMENT_CHECKPOINTER";
const DISABLED_MAX_TOKEN_LIMIT = "2147483647";
const DISABLED_MODEL_MAX_TOKENS = 1_000_000_000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM = "https://daily-cloudcode-pa.googleapis.com";

type JsonObject = Record<string, unknown>;
type Log = (msg: string, data?: unknown) => void;

function object(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function disableConfig(value: unknown): boolean {
	const config = object(value);
	if (!config) return false;
	let changed = false;
	if (config.enabled !== false) {
		config.enabled = false;
		changed = true;
	}
	if (config.max_token_limit !== DISABLED_MAX_TOKEN_LIMIT) {
		config.max_token_limit = DISABLED_MAX_TOKEN_LIMIT;
		changed = true;
	}
	return changed;
}

function rewriteExperiment(value: unknown): { changed: boolean; value: unknown } {
	if (typeof value === "string") {
		try {
			const config = JSON.parse(value) as unknown;
			const changed = disableConfig(config);
			return { changed, value: changed ? JSON.stringify(config) : value };
		} catch {
			return { changed: false, value };
		}
	}
	const wrapper = object(value);
	if (!wrapper) return { changed: false, value };
	for (const key of ["stringValue", "string_value"]) {
		if (typeof wrapper[key] !== "string") continue;
		const rewritten = rewriteExperiment(wrapper[key]);
		if (rewritten.changed) wrapper[key] = rewritten.value;
		return { changed: rewritten.changed, value: wrapper };
	}
	return { changed: disableConfig(wrapper), value: wrapper };
}

function hasCheckpointer(modelExperiments: unknown): boolean {
	const experiments = object(object(modelExperiments)?.experiments);
	return experiments !== undefined && Object.keys(experiments).some((key) => key.startsWith(CHECKPOINTER_PREFIX));
}

/** Rewrite Agy's local checkpointer controls in-place. Returns the number of
 * changed experiment configurations (not the number of changed fields). */
export function rewriteModelCatalog(payload: unknown): number {
	let changed = 0;
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const value of node) visit(value);
			return;
		}
		const record = object(node);
		if (!record) return;
		if (hasCheckpointer(record.modelExperiments)) {
			if (typeof record.maxTokens === "number") record.maxTokens = DISABLED_MODEL_MAX_TOKENS;
			if (typeof record.max_tokens === "number") record.max_tokens = DISABLED_MODEL_MAX_TOKENS;
		}
		for (const [key, value] of Object.entries(record)) {
			if (key.startsWith(CHECKPOINTER_PREFIX)) {
				const rewritten = rewriteExperiment(value);
				if (rewritten.changed) {
					record[key] = rewritten.value;
					changed += 1;
				}
			} else {
				visit(value);
			}
		}
	};
	visit(payload);
	return changed;
}

export function isModelCatalogPath(path: string): boolean {
	return path.split("?", 1)[0].endsWith(CATALOG_SUFFIX);
}

export interface CatalogProxyOptions {
	upstream?: string;
	env?: NodeJS.ProcessEnv;
	log?: Log;
}

/** One loopback server can be reused across Agy process respawns. */
export class CatalogProxy {
	#opts: CatalogProxyOptions;
	#server: Server | undefined;
	#endpoint: string | undefined;
	#starting: Promise<string> | undefined;
	#requests = new Set<AbortController>();
	#dispatchers = new Map<string, ProxyAgent>();

	constructor(opts: CatalogProxyOptions = {}) {
		this.#opts = opts;
	}

	get endpoint(): string | undefined {
		return this.#endpoint;
	}

	start(): Promise<string> {
		if (this.#endpoint) return Promise.resolve(this.#endpoint);
		if (this.#starting) return this.#starting;
		this.#starting = new Promise<string>((resolve, reject) => {
			const server = http.createServer((req, res) => void this.#handle(req, res));
			this.#server = server;
			server.on("clientError", (_err, socket) => socket.destroy());
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (typeof address !== "object" || address === null) {
					reject(new Error("loopback catalog proxy has no TCP address"));
					return;
				}
				this.#endpoint = `http://127.0.0.1:${address.port}`;
				resolve(this.#endpoint);
			});
		});
		return this.#starting;
	}

	async close(): Promise<void> {
		for (const controller of this.#requests) controller.abort();
		this.#requests.clear();
		const server = this.#server;
		this.#server = undefined;
		this.#endpoint = undefined;
		this.#starting = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		const dispatchers = [...this.#dispatchers.values()];
		this.#dispatchers.clear();
		await Promise.all(dispatchers.map(async (dispatcher) => dispatcher.close()));
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const controller = new AbortController();
		this.#requests.add(controller);
		try {
			const upstream = new URL(this.#opts.upstream ?? DEFAULT_UPSTREAM);
			const catalog = req.method === "POST" && isModelCatalogPath(req.url ?? "");
			const target = new URL(req.url ?? "/", upstream);
			const headers = new Headers();
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined || ["connection", "proxy-authorization", "transfer-encoding", "expect", "trailer", "te", "upgrade"].includes(key)) continue;
				if (Array.isArray(value)) for (const item of value) headers.append(key, item);
				else headers.set(key, value);
			}
			headers.set("host", target.host);
			if (catalog) headers.set("accept-encoding", "identity");
			const proxy = proxyFor(target, this.#opts.env ?? process.env);
			let dispatcher: ProxyAgent | undefined;
			if (proxy) {
				if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
					throw new Error(`unsupported proxy protocol: ${proxy.protocol}`);
				}
				dispatcher = this.#dispatchers.get(proxy.href);
				if (!dispatcher) {
					dispatcher = new ProxyAgent(proxy.href);
					this.#dispatchers.set(proxy.href, dispatcher);
				}
			}
			res.once("close", () => {
				if (!res.writableEnded) controller.abort();
			});
			const body = req.method === "GET" || req.method === "HEAD"
				? undefined
				: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
			const upstreamResponse = await fetch(target, {
				method: req.method,
				headers,
				body,
				duplex: "half",
				signal: controller.signal,
				dispatcher,
			});
			if (catalog && upstreamResponse.status === 200) {
				await this.#rewriteResponse(upstreamResponse, res);
				return;
			}
			await this.#streamResponse(upstreamResponse, res);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#opts.log?.("catalog-proxy-error", describeError(error));
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			if (!res.writableEnded) res.end("Cloud Code upstream request failed\n");
		} finally {
			this.#requests.delete(controller);
		}
	}

	async #rewriteResponse(response: Awaited<ReturnType<typeof fetch>>, res: ServerResponse): Promise<void> {
		const length = Number(response.headers.get("content-length") ?? 0);
		if (length > MAX_CATALOG_BYTES) {
			res.writeHead(502);
			res.end("Model catalog exceeds 16 MiB\n");
			return;
		}
		// Undici transparently decompresses the body. Sending the decoded bytes
		// also avoids ever forwarding a stale Content-Encoding or length.
		const raw = Buffer.from(await response.arrayBuffer());
		if (raw.length > MAX_CATALOG_BYTES) {
			res.writeHead(502);
			res.end("Model catalog exceeds 16 MiB\n");
			return;
		}
		try {
			const payload = JSON.parse(raw.toString("utf8")) as unknown;
			const changed = rewriteModelCatalog(payload);
			if (!changed) this.#opts.log?.("catalog-rewrite-warning", { reason: "no enabled checkpointer configuration changed" });
			else this.#opts.log?.("catalog-rewrite", { configurations: changed });
			const body = changed ? Buffer.from(JSON.stringify(payload), "utf8") : raw;
			res.writeHead(response.status, responseHeaders(response, body.length));
			res.end(body);
		} catch (error) {
			// Never replace a valid upstream catalog with a local parse error.
			this.#opts.log?.("catalog-rewrite-warning", { reason: error instanceof Error ? error.message : String(error) });
			res.writeHead(response.status, responseHeaders(response, raw.length));
			res.end(raw);
		}
	}

	async #streamResponse(response: Awaited<ReturnType<typeof fetch>>, res: ServerResponse): Promise<void> {
		res.writeHead(response.status, responseHeaders(response));
		if (!response.body) {
			res.end();
			return;
		}
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(Buffer.from(value))) await new Promise<void>((resolve) => res.once("drain", resolve));
		}
		res.end();
	}
}

function describeError(error: unknown): { message: string; cause?: string; code?: string } {
	if (!(error instanceof Error)) return { message: String(error) };
	const cause = error.cause;
	return {
		message: error.message,
		...(cause instanceof Error ? { cause: cause.message } : cause !== undefined ? { cause: String(cause) } : {}),
		...(typeof (cause as { code?: unknown } | undefined)?.code === "string" ? { code: (cause as { code: string }).code } : {}),
	};
}

function responseHeaders(response: Awaited<ReturnType<typeof fetch>>, length?: number): http.OutgoingHttpHeaders {
	const headers: http.OutgoingHttpHeaders = {};
	for (const [key, value] of response.headers.entries()) headers[key] = value;
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) headers["set-cookie"] = cookies;
	delete headers.connection;
	delete headers["content-encoding"];
	delete headers["transfer-encoding"];
	if (length === undefined) delete headers["content-length"];
	else headers["content-length"] = String(length);
	return headers;
}

function proxyFor(target: URL, env: NodeJS.ProcessEnv): URL | undefined {
	if (bypassProxy(target.hostname, env.NO_PROXY ?? env.no_proxy)) return undefined;
	const value = target.protocol === "https:"
		? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
		: env.HTTP_PROXY ?? env.http_proxy;
	return value ? new URL(value) : undefined;
}

function bypassProxy(hostname: string, noProxy: string | undefined): boolean {
	const host = hostname.toLowerCase();
	for (const raw of (noProxy ?? "").split(",")) {
		const entry = raw.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		const withoutPort = entry.startsWith("[") ? entry.slice(1, entry.indexOf("]")) : entry.replace(/:\d+$/, "");
		if (withoutPort === host) return true;
		const suffix = withoutPort.replace(/^\./, "");
		if (host.endsWith(`.${suffix}`)) return true;
	}
	return false;
}
