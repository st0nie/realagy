// ACP connection: owns the `agy acp` process (Antigravity CLI), the JSON-RPC
// session over its stdio, and the protocol methods the driver needs.
//
// Protocol facts encoded here, verified live against `agy acp` 1.5.x:
//   - initialize: {protocolVersion:1, no fs/terminal client capabilities};
//     clientInfo.name "zed" makes agy include Claude and GPT in its catalog;
//     agentCapabilities.sessionCapabilities advertises resume/load/close
//   - auth errors are -32000 (ACP auth_required); credentials live in agy's
//     own store, shared with the CLI
//   - session/set_config_option takes `configId` ("model" value = FULL slug
//     with the effort tier baked in, e.g. gemini-3.8-flash-low; "mode")
//   - session/cancel is a NOTIFICATION: the running prompt then resolves with
//     stopReason "cancelled" and the session stays usable (sent as a request,
//     agy cancels but never answers it)
//   - session/resume restores a session without replaying its history and
//     fails for unknown ids; session/load replays the history as
//     notifications BEFORE its response (dropped here) and silently returns
//     an empty session for unknown ids
//   - session/request_permission is answered from the turn's policy
//   - _meta.antigravity.systemPrompt.append (advertised in initialize as
//     agentCapabilities._meta.antigravity.systemPrompt.append) appends to
//     agy's system prompt; honored by session/new, resume, and load.
//     _meta.antigravity.enabledTools / disabledTools are ignored
//   - mcpServers entries: {name, type:"http", url, headers:[]} — headers is a
//     LIST; a dead URL is accepted at session time (lazy connect)
//   - `--agent NAME` selects a custom agent for the whole process (there is
//     no per-session field); an unknown name falls back to the default agent
//   - agy exits by itself when its stdin closes

import { spawn, type ChildProcess } from "node:child_process";
import type { AgyUsage } from "../driver-types.js";
import { redactText } from "../redact.js";
import { JsonRpcResponseError, JsonRpcSession } from "./jsonrpc.js";

export interface AcpMcpServer {
	name: string;
	type: "http" | "sse";
	url: string;
	headers: Array<{ name: string; value: string }>;
}

export interface AcpSessionInfo {
	sessionId: string;
	availableModels: Array<{ modelId: string; name?: string }>;
}

/** Why the process went away. `reason` is redacted and user-presentable. */
export interface AcpExitInfo {
	code: number | null;
	signal: string | null;
	reason: string;
}

/** Answer to `session/request_permission`. */
export interface PermissionResponse {
	outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

/** Auth failed (-32000). The message carries the remediation the server
 *  provided plus the sign-in pointer. */
export class AcpAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpAuthError";
	}
}

export interface AcpConnectionOptions {
	/** Process working directory for the spawned server. */
	cwd: string;
	/** Resolved server binary (or the node executable when binArgs carries the
	 *  fake-server script for tests). */
	bin: string;
	/** argv for the binary; default `["acp"]`. */
	binArgs?: string[];
	/** agy custom agent for this process (`--agent`, appended to binArgs);
	 *  see src/agent-profile.ts. */
	agent?: string;
	extraEnv?: Record<string, string>;
	log: (msg: string, data?: unknown) => void;
	/** Live `session/update` payloads (load replays are dropped). */
	onUpdate: (sessionId: string | null, update: unknown) => void;
	/** Process exit or spawn failure. Fires exactly once. */
	onExit: (info: AcpExitInfo) => void;
	/** mcpServers entries for session/new, session/resume, and session/load.
	 *  Evaluated lazily per call. */
	mcpServers?: () => AcpMcpServer[];
	/** Text appended to agy's system prompt on session/new, session/resume,
	 *  and session/load (`_meta.antigravity.systemPrompt.append`). Evaluated
	 *  lazily per call with this process's agent; undefined appends nothing. */
	systemPrompt?: (agent: string | undefined) => string | undefined;
	/** Permission policy for session/request_permission, evaluated per request:
	 *  "auto" selects the first allow option, "deny" the first reject option.
	 *  Absent = deny (fail closed). */
	permissions?: () => "auto" | "deny";
}

const INIT_TIMEOUT_MS = 30_000;
const SESSION_OP_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 8192;
/** SIGTERM → SIGKILL escalation for a torn-down process group. */
const KILL_GRACE_MS = 750;
/** After `exit`, how long to wait for `close` (stdio drained) before
 *  finishing anyway: a descendant may still hold the pipes open. */
const CLOSE_GRACE_MS = 250;

export class AcpConnection {
	#opts: AcpConnectionOptions;
	#child: ChildProcess | undefined;
	#rpc: JsonRpcSession | undefined;
	#stderrTail = "";
	#exited = false;
	#killed = false;
	#suppressUpdates = false;
	#canResume = false;
	#serverVersion: string | undefined;
	#exitPromise: Promise<void>;
	#resolveExit!: () => void;
	constructor(opts: AcpConnectionOptions) {
		this.#opts = opts;
		this.#exitPromise = new Promise<void>((resolve) => { this.#resolveExit = resolve; });
	}

	get alive(): boolean {
		return this.#child !== undefined && !this.#exited && !this.#killed;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	/** The custom agent this process was started with. */
	get agent(): string | undefined {
		return this.#opts.agent;
	}

	get serverVersion(): string | undefined {
		return this.#serverVersion;
	}

	/** True when the server advertised `session/resume`. */
	get canResume(): boolean {
		return this.#canResume;
	}

	/** Spawn the server and perform the initialize handshake. Call once per
	 *  instance. */
	async start(): Promise<void> {
		if (this.#child) throw new Error("ACP connection already started");
		const args = [...(this.#opts.binArgs ?? ["acp"]), ...(this.#opts.agent ? ["--agent", this.#opts.agent] : [])];
		const child = spawn(this.#opts.bin, args, {
			cwd: this.#opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group: teardown kills agy and any helpers it spawned.
			detached: process.platform !== "win32",
			windowsHide: true,
			...(this.#opts.extraEnv ? { env: { ...process.env, ...this.#opts.extraEnv } } : {}),
		});
		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		// Pipe failures arrive asynchronously as stream 'error' events; the sync
		// try/catch in #write cannot see them. Without this listener an EPIPE
		// (server died mid-handshake) is uncaught and kills pi.
		child.stdin?.on("error", (err) => {
			this.#opts.log("stdin-error", { message: redactText(err.message) });
			this.#finish(`stdin closed: ${err.message}`, null, null);
		});

		const rpc = new JsonRpcSession({
			send: (frame) => this.#write(frame),
			onRequest: (method, params) => this.#onServerRequest(method, params),
			onNotification: (method, params) => this.#onNotification(method, params),
			onParseError: (line) => this.#opts.log("parse-error", { line: redactText(line) }),
			onOverflow: (detail) => {
				// The session already aborted its pending requests with the typed
				// reason. A flooder is broken or hostile: take the whole group down.
				this.#opts.log("frame-overflow", { detail });
				this.#finish(`stdout frame overflow: ${detail}`, null, null);
				this.#signalGroup("SIGKILL");
			},
		});
		this.#rpc = rpc;

		child.stdout?.on("data", (chunk: string) => rpc.feed(chunk));
		child.stderr?.on("data", (chunk: string) => {
			this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
		});
		child.on("error", (err) => {
			this.#opts.log("spawn-error", { message: redactText(err.message) });
			this.#finish(`cannot run ${this.#opts.bin}: ${err.message}`, null, null);
		});
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (closeTimer) clearTimeout(closeTimer);
			this.#finish(exitReason(code, signal), code, signal);
		};
		child.on("exit", (code, signal) => {
			this.#opts.log("exit", { code, signal });
			// Wait briefly for the stdio streams to drain so the last stderr
			// line (often the actual error) is part of the exit reason.
			closeTimer = setTimeout(() => exited(code, signal), CLOSE_GRACE_MS);
			closeTimer.unref?.();
		});
		child.on("close", (code, signal) => exited(code, signal));

		const result = (await this.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				// Without a Zed-family clientInfo agy filters its catalog to Gemini.
				clientInfo: { name: "zed", title: "realagy", version: "2.0.0" },
			},
			INIT_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		const info = record(result?.agentInfo);
		this.#serverVersion = typeof info.version === "string" ? info.version : undefined;
		const capabilities = record(result?.agentCapabilities);
		const sessionCaps = record(capabilities.sessionCapabilities ?? capabilities.session_capabilities);
		this.#canResume = typeof sessionCaps.resume === "object" && sessionCaps.resume !== null;
		this.#opts.log("initialized", { version: this.#serverVersion, resume: this.#canResume });
	}

	async newSession(cwd: string): Promise<AcpSessionInfo> {
		const result = (await this.request(
			"session/new",
			{ cwd, mcpServers: this.#mcpServers(), ...this.#meta() },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		const sessionId = result?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error("ACP session/new returned no sessionId");
		}
		const rawModels = record(result?.models).availableModels;
		const availableModels = Array.isArray(rawModels)
			? rawModels.flatMap((value) => {
					const model = record(value);
					return typeof model.modelId === "string"
						? [{ modelId: model.modelId, ...(typeof model.name === "string" ? { name: model.name } : {}) }]
						: [];
				})
			: [];
		return { sessionId, availableModels };
	}

	/** Reopen a persisted session: `session/resume` when advertised (no
	 *  history replay), else `session/load` with its replay dropped. */
	async reopenSession(sessionId: string, cwd: string): Promise<"resumed" | "loaded"> {
		const params = { sessionId, cwd, mcpServers: this.#mcpServers(), ...this.#meta() };
		if (this.#canResume) {
			await this.request("session/resume", params, SESSION_OP_TIMEOUT_MS);
			return "resumed";
		}
		this.#suppressUpdates = true;
		try {
			await this.request("session/load", params, SESSION_OP_TIMEOUT_MS);
			return "loaded";
		} finally {
			this.#suppressUpdates = false;
		}
	}

	async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
		await this.request("session/set_config_option", { sessionId, configId, value }, SESSION_OP_TIMEOUT_MS);
	}

	/** No request timeout on purpose: the driver's inactivity guard governs
	 *  the turn. */
	async prompt(
		sessionId: string,
		text: string,
		images: Array<{ data: string; mimeType: string }> = [],
		contextBlock?: { uri: string; text: string },
	): Promise<{ stopReason: string; usage?: AgyUsage }> {
		// Put the stable transcript first; image blocks retain transcript order.
		const blocks: Array<Record<string, unknown>> = [];
		if (contextBlock) {
			blocks.push({
				type: "resource",
				resource: { uri: contextBlock.uri, mimeType: "text/markdown", text: contextBlock.text },
			});
		}
		for (const image of images) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
		blocks.push({ type: "text", text });
		const result = (await this.request("session/prompt", { sessionId, prompt: blocks })) as Record<string, unknown> | undefined;
		const stopReason = result?.stopReason;
		if (typeof stopReason !== "string") {
			throw new Error("ACP session/prompt returned no stopReason");
		}
		// Turn-cumulative usage over all of the prompt's internal model calls.
		const usage = parseAcpTurnUsage(result?.usage);
		return { stopReason, ...(usage ? { usage } : {}) };
	}

	/** Ask the server to end the running prompt (ACP notification). */
	cancel(sessionId: string): void {
		if (!this.alive) return;
		this.#rpc?.notify("session/cancel", { sessionId });
	}

	#onServerRequest(method: string, params: unknown): Promise<unknown> {
		if (method === "session/request_permission") {
			return Promise.resolve(this.#answerPermission(record(params)));
		}
		// fs/* and terminal/* are declined: our client capabilities are off and
		// agy executes its own tools.
		this.#opts.log("unsupported-server-request", { method });
		return Promise.reject(new Error(`client capability not enabled: ${method}`));
	}

	/** "auto" selects the first allow option (any option as a last resort);
	 *  "deny" selects the first reject option, or cancels when none exists. */
	#answerPermission(params: Record<string, unknown>): PermissionResponse {
		const options = (Array.isArray(params.options) ? params.options : []).map(record);
		const policy = this.#opts.permissions?.() ?? "deny";
		const kindStarts = (prefix: string) => options.find((o) => typeof o.kind === "string" && o.kind.startsWith(prefix));
		const chosen = policy === "auto" ? (kindStarts("allow") ?? options[0]) : kindStarts("reject");
		const optionId = typeof chosen?.optionId === "string" ? chosen.optionId : undefined;
		this.#opts.log("permission", { optionId, policy });
		return optionId !== undefined
			? { outcome: { outcome: "selected", optionId } }
			: { outcome: { outcome: "cancelled" } };
	}

	#onNotification(method: string, params: unknown): void {
		if (method === "session/update") {
			if (this.#suppressUpdates) return; // load replay: history, not live text
			const p = record(params);
			// No sessionId: the driver attributes it to the running turn.
			const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
			this.#opts.onUpdate(sessionId, p.update);
			return;
		}
		this.#opts.log("notification", { method });
	}

	/** Send a request; failures arrive translated (see translateError). */
	async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (!this.#rpc || !this.alive) throw new Error(`Antigravity CLI is not running (request: ${method})`);
		try {
			return await this.#rpc.request(method, params, timeoutMs);
		} catch (err) {
			throw translateError(method, err);
		}
	}

	#mcpServers(): AcpMcpServer[] {
		try {
			return this.#opts.mcpServers?.() ?? [];
		} catch (err) {
			this.#opts.log("mcp-servers-failed", { message: err instanceof Error ? err.message : String(err) });
			return [];
		}
	}

	/** Expose pi tools directly, not through agy's lazy call_mcp_tool helper
	 *  (under realagy's agent profile agy ignores this and the profile marks
	 *  the tools eager instead), and append the tool policy to agy's system
	 *  prompt (honored by session/new, session/resume, and session/load). */
	#meta(): Record<string, unknown> {
		let append: string | undefined;
		try {
			append = this.#opts.systemPrompt?.(this.#opts.agent);
		} catch (err) {
			this.#opts.log("system-prompt-failed", { message: err instanceof Error ? err.message : String(err) });
		}
		return {
			_meta: {
				antigravity: {
					eagerMcpServers: ["pi-bridge"],
					...(append ? { systemPrompt: { append } } : {}),
				},
			},
		};
	}

	#write(frame: string): void {
		const stdin = this.#child?.stdin;
		if (!stdin || !stdin.writable || this.#exited) {
			this.abortAll("connection closed");
			return;
		}
		try {
			stdin.write(`${frame}\n`);
		} catch (err) {
			this.#opts.log("write-failed", { message: err instanceof Error ? err.message : String(err) });
			this.abortAll("connection closed");
		}
	}

	/** Reject every pending request; nothing is written afterwards. */
	abortAll(reason: string): void {
		this.#rpc?.abortAll(reason);
	}

	/** Teardown: reject everything pending, then terminate the process group
	 *  (SIGTERM, then SIGKILL after a grace period). */
	kill(): void {
		if (this.#killed) return;
		this.#killed = true;
		this.abortAll("connection killed");
		const child = this.#child;
		if (!child || this.#exited) return;
		this.#opts.log("kill", { pid: child.pid ?? "?" });
		this.#signalGroup("SIGTERM");
		if (process.platform === "win32") return;
		// unref: the escalation must never keep pi's event loop alive.
		setTimeout(() => {
			if (!this.#exited) this.#signalGroup("SIGKILL");
		}, KILL_GRACE_MS).unref?.();
	}
	/** Stop the process and wait until its exit/close handlers have run. */
	async stop(): Promise<void> {
		this.kill();
		if (this.#child) await this.#exitPromise;
	}

	#signalGroup(signal: NodeJS.Signals): void {
		const child = this.#child;
		try {
			if (child?.pid && process.platform !== "win32") process.kill(-child.pid, signal);
			else child?.kill(signal);
		} catch {
			/* already gone */
		}
	}

	#finish(reason: string, code: number | null, signal: string | null): void {
		if (this.#exited) return;
		this.#resolveExit();
		this.#exited = true;
		const detail = lastLine(this.#stderrTail);
		const full = redactText(detail ? `${reason}: ${detail}` : reason);
		this.abortAll(`Antigravity CLI exited (${full})`);
		this.#opts.onExit({ code, signal, reason: full });
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}


function exitReason(code: number | null, signal: string | null): string {
	if (signal) return `killed by ${signal}`;
	return code === null ? "process exited" : `exit code ${code}`;
}

/** Last non-empty stderr line, capped: the actual error is usually there. */
function lastLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	const last = lines.at(-1) ?? "";
	return last.length > 300 ? `${last.slice(0, 300)}…` : last;
}

/** ACP's per-turn PromptResponse.usage (cumulative over the prompt's model
 *  calls), not the session/update usage_update context occupancy. */
export function parseAcpTurnUsage(value: unknown): AgyUsage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const u = value as Record<string, unknown>;
	const count = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
	const input = count(u.inputTokens);
	const output = count(u.outputTokens);
	const total = count(u.totalTokens);
	const thought = count(u.thoughtTokens);
	const cacheRead = count(u.cachedReadTokens);
	const cacheWrite = count(u.cachedWriteTokens);
	if (input === undefined || output === undefined || total === undefined) return undefined;
	return {
		input_tokens: input,
		output_tokens: output,
		total_tokens: total,
		...(thought === undefined ? {} : { thinking_tokens: thought }),
		...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
		...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
	};
}

export function translateError(method: string, err: unknown): Error {
	if (err instanceof AcpAuthError) return err;
	if (err instanceof JsonRpcResponseError) {
		if (err.code === -32000) {
			const detail = record(err.data).message;
			const detailText = typeof detail === "string" ? detail : err.message;
			return new AcpAuthError(`Antigravity sign-in required (${method}: ${detailText}). Sign in with \`agy\` in a terminal, then run /realagy setup.`);
		}
		// Typed protocol errors survive: callers may branch on .code.
		return err;
	}
	if (err instanceof Error) return err;
	return new Error(`ACP ${method} failed: ${String(err)}`);
}
