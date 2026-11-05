// Newline-delimited JSON-RPC 2.0 session over a stdio transport.
//
// Transport-agnostic by design: the caller supplies a `send` sink (writes one
// serialized frame + newline to the child's stdin) and feeds incoming bytes to
// `feed()`. Everything ACP-specific lives in connection.ts.
//
//   - requests are correlated by numeric id; JSON-RPC `error` results reject
//     the pending promise with a JsonRpcResponseError (code + data kept);
//   - server-to-client REQUESTS (session/request_permission, fs/*, terminal/*)
//     carry both `method` and `id` and are answered through `onRequest`;
//   - notifications carry no id, in both directions (`notify()` sends one);
//   - malformed lines are reported and dropped, never fatal: a chatty banner
//     must not kill the reader loop;
//   - `abortAll()` rejects every pending request: no promise survives a dead
//     connection.

import { isKnownNoiseLine, MAX_FRAME_BYTES, stripGluedNoise } from "../frame-guard.js";

export interface JsonRpcErrorShape {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcIncoming {
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcErrorShape;
}

export type SendFn = (frame: string) => void;

export interface JsonRpcSessionOptions {
	send: SendFn;
	/** Server-to-client request (has method + id). Return the result value, or
	 *  throw to answer with a JSON-RPC error. */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Server-to-client notification (method, no id). */
	onNotification?: (method: string, params: unknown) => void;
	/** Unparseable line (logged, never fatal). */
	onParseError?: (line: string) => void;
	/** Frame-cap breach: the peer flooded stdout with no newline. The session
	 *  aborts itself; the transport must kill the process. */
	onOverflow?: (detail: string) => void;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	method: string;
}

export class JsonRpcSession {
	#send: SendFn;
	#opts: JsonRpcSessionOptions;
	#pending = new Map<number, Pending>();
	#nextId = 1;
	#aborted = false;
	#overflowed = false;
	#lineBuf = "";

	constructor(opts: JsonRpcSessionOptions) {
		this.#opts = opts;
		this.#send = opts.send;
	}

	/** Feed raw transport bytes. Stdio chunks are NOT newline-aligned: bytes
	 *  are buffered and only complete lines are parsed (a frame split across a
	 *  64KB pipe boundary must never be dropped). Only the new chunk is scanned
	 *  for a newline, so a multi-megabyte frame costs linear time, not one
	 *  rescan of the whole buffer per chunk. The buffer is capped: a peer
	 *  flooding stdout with no newline breaches the cap and the session dies
	 *  (onOverflow + abortAll), it never grows without bound. */
	feed(chunk: string): void {
		if (this.#overflowed) return;
		const lastNewline = chunk.lastIndexOf("\n");
		if (lastNewline === -1) {
			this.#lineBuf += chunk;
			this.#checkOverflow();
			return;
		}
		const complete = this.#lineBuf + chunk.slice(0, lastNewline);
		this.#lineBuf = chunk.slice(lastNewline + 1);
		for (const raw of complete.split("\n")) {
			if (this.#overflowed) return;
			this.#parseLine(raw.trim());
		}
		this.#checkOverflow();
	}

	#checkOverflow(): void {
		if (this.#lineBuf.length <= MAX_FRAME_BYTES) return;
		const detail = `${this.#lineBuf.length} bytes buffered with no newline (cap ${MAX_FRAME_BYTES})`;
		this.#overflowed = true;
		this.#lineBuf = "";
		// Aborting first gives pending requests the typed overflow reason; the
		// transport's own teardown afterwards is a no-op on the empty map.
		this.abortAll(`stdout frame overflow: ${detail}`);
		this.#opts.onOverflow?.(detail);
	}

	#parseLine(line: string): void {
		if (!line) return;
		// Known foreign noise (e.g. the Chromium launcher behind a browser
		// login) is dropped before parsing, not reported as a parse error.
		if (isKnownNoiseLine(line)) return;
		let msg: JsonRpcIncoming;
		try {
			msg = JSON.parse(line) as JsonRpcIncoming;
		} catch {
			// A noise FRAGMENT without its newline glued itself onto the next
			// real frame; strip everything up to the marker and re-parse.
			const repaired = stripGluedNoise(line);
			try {
				if (repaired === null) throw new Error("unparseable");
				msg = JSON.parse(repaired) as JsonRpcIncoming;
			} catch {
				this.#opts.onParseError?.(line.slice(0, 200));
				return;
			}
		}
		if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
			this.#opts.onParseError?.(line.slice(0, 200));
			return;
		}
		this.#handleMessage(msg);
	}

	#handleMessage(msg: JsonRpcIncoming): void {
		// Response to one of our requests.
		if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
			const id = Number(msg.id);
			const pending = this.#pending.get(id);
			if (!pending) return; // late response to a timed-out or aborted request: drop
			this.#pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			if (msg.error) {
				pending.reject(new JsonRpcResponseError(msg.error));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}
		if (typeof msg.method !== "string") return;
		const method = msg.method;
		// Server-to-client request: must be answered with the same id. The
		// handler is always invoked through Promise.resolve() so a synchronous
		// throw can never escape into the reader loop.
		if (msg.id !== undefined && msg.id !== null) {
			const id = msg.id;
			const handler = this.#opts.onRequest;
			if (!handler) {
				this.#sendError(id, -32601, `client does not support method: ${method}`);
				return;
			}
			void Promise.resolve()
				.then(() => handler(method, msg.params))
				.then((result) => {
					if (this.#aborted) return;
					this.#send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? {} }));
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					this.#sendError(id, -32000, message);
				});
			return;
		}
		this.#opts.onNotification?.(method, msg.params);
	}

	#sendError(id: number | string, code: number, message: string): void {
		if (this.#aborted) return;
		this.#send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	}

	/** Send a request. Resolves with the result value; rejects on error
	 *  responses (JsonRpcResponseError), timeouts, or abortAll(). A timeout of
	 *  0 (the default) waits indefinitely. */
	request(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
		if (this.#aborted) return Promise.reject(new Error(`connection aborted (request: ${method})`));
		const id = this.#nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const pending: Pending = { resolve, reject, method };
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.#pending.delete(id);
					reject(new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`));
				}, timeoutMs);
			}
			this.#pending.set(id, pending);
			this.#send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
		});
	}

	/** Send a notification (no id, no reply). Dropped once aborted. */
	notify(method: string, params?: unknown): void {
		if (this.#aborted) return;
		this.#send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
	}

	/** Reject every pending request. The transport is going away; nothing will
	 *  ever be written again. */
	abortAll(reason: string): void {
		this.#aborted = true;
		for (const [id, pending] of this.#pending) {
			if (pending.timer) clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(new Error(`${reason} (request: ${pending.method})`));
		}
	}
}

/** A JSON-RPC `error` result, preserving code + data: callers branch on the
 *  code (-32000 authentication, -32601 method not found, -32602 params). */
export class JsonRpcResponseError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(error: JsonRpcErrorShape) {
		super(typeof error.message === "string" && error.message ? error.message : `JSON-RPC error ${error.code}`);
		this.name = "JsonRpcResponseError";
		this.code = error.code;
		this.data = error.data;
	}
}
