// AcpDriver: the ACP turn engine behind the provider (src/driver-types.ts).
//
// One `agy acp` process hosts every turn; turns are serialized. Per turn:
//   - session: reuse one the process already holds, reopen a persisted one
//     (session/resume, else session/load), or create one. A remembered
//     session whose conversation store is gone, or that fails to reopen, is
//     replaced by a fresh session that receives the request's full fallback
//     input instead of a delta it never saw the start of.
//   - config: model + mode via session/set_config_option, re-applied every
//     turn (config does not survive a server restart).
//   - abort: ACP session/cancel notification; the prompt then ends
//     "cancelled" and process and session survive. Only when agy ignores the
//     cancel is the process torn down.
//   - inactivity guard: no session/update for `inactivityMin` fails the turn;
//     parked pi tool calls (bridge_call) and running native agy tools pause
//     the guard.
//   - native tools: agy's own calls are reported as native_tool activities
//     and live onNativeTool events; work still running when the prompt ends
//     is watched in agy's brain directory (src/acp/background.ts).
//   - leftovers: frames agy flushes at prompt start, before echoing the
//     prompt, belong to background work that finished meanwhile and are
//     dropped.
//   - usage: exact per-model-call tokens from agy's conversation store at
//     each bridge_call and at prompt end (src/acp/step-usage.ts).

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { BackgroundMessages, type BackgroundNotice } from "./background.js";
import { AcpConnection, type AcpExitInfo, type AcpMcpServer } from "./connection.js";
import { isAgyRetryNotice, mapStopReason, mapUpdate, TextAccumulator, type AcpEditDiff } from "./events.js";
import { conversationDbPath, lastStepIdx, readStepState, siblingUsage, summarizeSteps, type StepTokens, type StepUsage } from "./step-usage.js";
import { nativeToolLabel, PI_BRIDGE_SERVER, type NativeToolEvent } from "../native-tools.js";
import { traceUsage } from "../usage-trace.js";
import type { AgyStepUsage, DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "../driver-types.js";

export type { AcpMcpServer } from "./connection.js";

const DEFAULT_INACTIVITY_MIN = 5;
/** How long a cancelled prompt may take to settle before teardown. */
const CANCEL_GRACE_MS = 10_000;

export interface AcpDriverOptions {
	/** agy binary. A function is resolved per spawn, so `/agy setup` can
	 *  point the next spawn at a newly found binary. */
	bin: string | (() => string);
	/** argv for the binary (tests: the fake-server script). Default `acp`. */
	binArgs?: string[];
	extraEnv?: Record<string, string>;
	/** Bridge registration for every session/new, resume, and load. */
	mcpServers?: () => AcpMcpServer[];
	/** Directory holding the server's `<sessionId>.db` conversation stores,
	 *  read for exact per-model-call usage and to detect lost sessions.
	 *  undefined disables both. */
	conversationsDir?: () => string | undefined;
	/** Cancel-to-teardown grace period (tests shrink it). */
	cancelGraceMs?: number;
	log?: (msg: string, data?: unknown) => void;
	/** Appended to agy's system prompt for every session (the tool policy). */
	systemPrompt?: () => string | undefined;
	/** agy's `brain` directory, watched for background work that finishes
	 *  after a prompt ended. undefined disables the watcher. */
	brainDir?: () => string | undefined;
	/** A native call started or ended (live status). */
	onNativeTool?: (event: NativeToolEvent) => void;
	/** agy reported finished background work (command or subagent). */
	onBackgroundMessage?: (notice: BackgroundNotice) => void;
	/** Background watcher poll interval (tests shrink it). */
	backgroundPollMs?: number;
}

type TurnInput = Pick<DriverTurnRequest, "prompt" | "images" | "contextBlock">;

interface ActiveTurn {
	id: string;
	request: DriverTurnRequest;
	/** The input actually sent: the request's, or its fallback after a lost session. */
	input: TurnInput;
	/** Connection this turn runs on; teardown never touches another one. */
	conn?: AcpConnection;
	/** Conversation store of this session and the last step already reported. */
	dbPath?: string;
	stepCursor: number;
	/** Latest measured model call, for sibling tool-call messages. */
	lastStep?: StepTokens;
	stepUsageSeen: boolean;
	sessionId: string;
	buffer: DriverActivity[];
	wake: (() => void)[];
	closed: boolean;
	resolve: (o: TurnOutcome) => void;
	outcome: Promise<TurnOutcome>;
	response: TextAccumulator;
	contextUsage?: { used: number; size: number };
	/** True once the prompt RPC was issued: only then is there anything for
	 *  session/cancel to end. */
	promptStarted: boolean;
	aborted: boolean;
	parks: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	cancelTimer?: ReturnType<typeof setTimeout>;
	/** toolCallId → tool name + args + optional native diff (the diff rides
	 *  on the pending tool_call frame; updates don't repeat it). */
	toolCalls: Map<string, { name: string; args: Record<string, unknown>; diff?: AcpEditDiff; mcpServer?: string }>;
	/** agy's own calls still running: they pause the inactivity guard. */
	natives: Map<string, { name: string; label: string; startedAt: number }>;
	/** Subagents started by this prompt (they finish in the background). */
	subagents: number;
	promptStartedAt: number;
	/** agy echoes the prompt as user_message_chunk. Content frames before
	 *  that echo are leftovers of background work that finished between
	 *  prompts; they are held here and dropped once the echo arrives. */
	echoSeen: boolean;
	held: unknown[];
}

/** Recombine the provider's (base slug, effort) into the FULL ACP model slug
 *  ("gemini-3.8-flash-low"). Fixed families pass through unchanged. */
export function acpModelSlug(model: string, effort?: string): string {
	if (!effort) return model;
	if (/(?:^|-)(?:high|medium|low)$/.test(model)) return model;
	return `${model}-${effort}`;
}

/** Map our knobs onto ACP session modes. */
export function acpMode(mode: DriverTurnRequest["mode"], skipPermissions: boolean): string {
	// agy 1.5 offers only default, accept-edits, and plan.
	if (mode === "plan") return "plan";
	return skipPermissions ? "accept-edits" : "default";
}

export class AcpDriver implements TurnDriver {
	#opts: AcpDriverOptions;
	#conn: AcpConnection | undefined;
	/** Pending start of #conn: concurrent callers share one handshake. */
	#starting: Promise<AcpConnection> | undefined;
	#active: ActiveTurn | undefined;
	#queueTail: Promise<void> = Promise.resolve();
	#onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	/** Sessions held in memory by the current server process (reset on respawn). */
	#liveSessions = new Set<string>();
	/** Watches agy's brain directory for background work (created lazily). */
	#background: BackgroundMessages | undefined;

	constructor(opts: AcpDriverOptions) {
		this.#opts = opts;
	}

	/** Read the account's live catalog through the official ACP session flow. */
	async listModels(cwd: string): Promise<Array<{ modelId: string; name?: string }>> {
		const conn = await this.#ensureConnection(cwd);
		const session = await conn.newSession(cwd);
		return session.availableModels;
	}

	get activeHandle(): TurnHandle | null {
		const t = this.#active;
		return t && !t.closed ? this.#makeHandle(t) : null;
	}

	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined) {
		this.#onTurnEnd = fn;
	}

	/** Inject a synthetic activity into the live turn (bridge inbox). A
	 *  bridge_call parks the turn: the inactivity guard pauses. */
	pushExternal(activity: DriverActivity): void {
		const t = this.#active;
		if (!t || t.closed) return;
		if (activity.type === "bridge_call") {
			traceUsage("bridge-call", { sessionId: t.sessionId, callId: activity.callId, name: activity.name, parks: t.parks });
			// The model call that requested this tool has finished: report its
			// exact usage on the pi message that this bridge call completes.
			// A parallel sibling call of the same model call finds no new step
			// and gets a ratio-only placeholder instead of zero usage.
			if (!this.#collectStepUsage(t) && t.lastStep) this.#emit(t, { type: "step_usage", usage: stripIdx(siblingUsage(t.lastStep)) });
			t.parks += 1;
			this.#clearIdle(t);
		}
		this.#emit(t, activity);
	}

	kickIdle(): void {
		const t = this.#active;
		if (!t || t.closed) return;
		if (t.parks > 0) t.parks -= 1;
		if (t.parks === 0) this.#armIdle(t);
	}

	/** Turns are serialized; a parked turn stays open and its continuation
	 *  uses reentry(). */
	run(request: DriverTurnRequest): Promise<TurnHandle> {
		let release!: () => void;
		const prev = this.#queueTail;
		this.#queueTail = new Promise<void>((r) => (release = r));
		return prev
			.then(() => this.#runExclusive(request))
			.then((handle) => {
				void handle.outcome.then(release, release);
				return handle;
			})
			.catch((err) => {
				release();
				throw err;
			});
	}

	reentry(): TurnHandle | null {
		return this.activeHandle;
	}

	async cancelActive(reason: string): Promise<void> {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		this.#log("cancel-active", { reason, sessionId: turn.sessionId });
		this.#abortTurn(turn);
		await turn.outcome;
	}

	#runExclusive(request: DriverTurnRequest): Promise<TurnHandle> {
		if (request.signal?.aborted) return Promise.reject(new Error("aborted before start"));

		const turn = this.#createTurn(request);
		this.#active = turn;
		this.#log("turn-start", {
			model: request.model,
			effort: request.effort,
			conversation: request.conversationId ?? null,
			images: request.images?.length ?? 0,
			contextBlock: request.contextBlock ? true : undefined,
		});

		// Abort wiring first: an abort during session setup must still settle
		// the turn.
		if (request.signal) {
			const signal = request.signal;
			const onAbort = () => this.#abortTurn(turn);
			signal.addEventListener("abort", onAbort, { once: true });
			void turn.outcome.then(() => signal.removeEventListener("abort", onAbort));
		}

		// Execute asynchronously: the handle returns at once, and activities
		// stream through next().
		void this.#executeTurn(turn).catch((err: unknown) => {
			this.#failTurn(turn, `Antigravity turn failed: ${describe(err)}`);
		});
		return Promise.resolve(this.#makeHandle(turn));
	}

	async #executeTurn(turn: ActiveTurn): Promise<void> {
		const request = turn.request;
		const conn = await this.#ensureConnection(request.cwd);
		if (turn.closed) return;
		turn.conn = conn;

		const sessionMode = await this.#openSession(turn, conn);
		if (turn.closed || sessionMode === undefined) return;
		if (conn === this.#conn) this.#liveSessions.add(turn.sessionId);
		if (sessionMode === "fallback" && request.fallback) turn.input = { ...request.fallback };
		const dir = this.#opts.conversationsDir?.();
		turn.dbPath = dir ? conversationDbPath(dir, turn.sessionId) : undefined;
		turn.stepCursor = turn.dbPath ? lastStepIdx(turn.dbPath) : -1;
		traceUsage("turn-start", {
			sessionId: turn.sessionId,
			session: sessionMode,
			model: acpModelSlug(request.model, request.effort),
			promptChars: turn.input.prompt.length,
			contextChars: turn.input.contextBlock?.text.length ?? 0,
			images: turn.input.images?.length ?? 0,
			stepCursor: turn.stepCursor,
		});

		// Config: a model failure fails the turn (a wrong-model turn is worse
		// than none); a mode failure is logged and the turn proceeds.
		try {
			await conn.setConfigOption(turn.sessionId, "model", acpModelSlug(request.model, request.effort));
		} catch (err) {
			this.#failTurn(turn, `Antigravity model selection failed: ${describe(err)}`);
			return;
		}
		try {
			await conn.setConfigOption(turn.sessionId, "mode", acpMode(request.mode, request.skipPermissions));
		} catch (err) {
			this.#log("mode-apply-failed", { message: describe(err) });
		}
		if (turn.closed) return;

		this.#armIdle(turn);
		turn.promptStarted = true;
		turn.promptStartedAt = Date.now();
		try {
			const result = await conn.prompt(turn.sessionId, turn.input.prompt, turn.input.images, turn.input.contextBlock);
			if (turn.closed) return;
			traceUsage("prompt-result", { sessionId: turn.sessionId, stopReason: result.stopReason, usage: result.usage, usageUpdate: turn.contextUsage });
			this.#finishPrompt(turn);
			// Exact per-call steps first; the turn-cumulative total is only a
			// fallback for messages no step measurement covered.
			const maxStepIdx = this.#collectStepUsage(turn);
			if (result.usage && !turn.stepUsageSeen) this.#emit(turn, { type: "usage", usage: result.usage });
			const mapped = mapStopReason(result.stopReason);
			const aborted = mapped.aborted || turn.aborted;
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: aborted ? "OK" : mapped.status,
				response: turn.response.text,
				usage: result.usage,
				error: aborted ? undefined : mapped.error,
				aborted,
				...(maxStepIdx !== undefined && maxStepIdx >= 0 ? { maxStepIdx } : {}),
			}, { collected: true });
		} catch (err) {
			if (turn.closed) return;
			if (turn.aborted) this.#settleAborted(turn);
			else this.#failTurn(turn, `Antigravity prompt failed: ${describe(err)}`);
		}
	}

	/** Pick the turn's session. undefined = the turn already settled. */
	async #openSession(turn: ActiveTurn, conn: AcpConnection): Promise<"new" | "reused" | "resumed" | "loaded" | "fallback" | undefined> {
		const id = turn.request.conversationId;
		try {
			if (id && this.#liveSessions.has(id)) {
				turn.sessionId = id;
				this.#log("session-reuse", { sessionId: id });
				return "reused";
			}
			if (id && this.#storeMissing(id)) {
				// session/load of an unknown id silently yields an empty session:
				// never hand it a delta.
				this.#log("session-lost", { sessionId: id });
			} else if (id) {
				const mode = await conn.reopenSession(id, turn.request.cwd);
				turn.sessionId = id;
				this.#log(`session-${mode}`, { sessionId: id });
				return mode;
			}
		} catch (err) {
			if (turn.closed) return undefined;
			if (turn.aborted) {
				this.#settleAborted(turn);
				return undefined;
			}
			this.#log("session-reopen-failed", { sessionId: id, message: describe(err) });
		}
		if (turn.closed) return undefined;
		try {
			const created = await conn.newSession(turn.request.cwd);
			turn.sessionId = created.sessionId;
			this.#log("session-new", { sessionId: created.sessionId });
			return id ? "fallback" : "new";
		} catch (err) {
			if (turn.closed) return undefined;
			if (turn.aborted) this.#settleAborted(turn);
			else this.#failTurn(turn, `Antigravity session failed: ${describe(err)}`);
			return undefined;
		}
	}

	/** True when the conversation store is known and has no `<id>.db`. */
	#storeMissing(sessionId: string): boolean {
		const dir = this.#opts.conversationsDir?.();
		if (!dir) return false;
		const dbPath = conversationDbPath(dir, sessionId);
		return !dbPath || !fs.existsSync(dbPath);
	}

	#makeHandle(turn: ActiveTurn): TurnHandle {
		return {
			id: turn.id,
			outcome: turn.outcome,
			next: () => this.#nextActivity(turn),
			pushExternal: (activity) => this.pushExternal(activity),
		};
	}

	async #nextActivity(turn: ActiveTurn): Promise<DriverActivity | null> {
		for (;;) {
			if (turn.buffer.length > 0) return turn.buffer.shift() ?? null;
			if (turn.closed) return null;
			await new Promise<void>((r) => turn.wake.push(r));
		}
	}

	#emit(turn: ActiveTurn, activity: DriverActivity): void {
		if (turn.closed) return;
		turn.buffer.push(activity);
		turn.wake.shift()?.();
	}

	#onConnectionUpdate(conn: AcpConnection, sessionId: string | null, update: unknown): void {
		const turn = this.#active;
		if (!turn || turn.closed || turn.conn !== conn) return;
		if (sessionId !== null && sessionId !== turn.sessionId) return;
		turn.idleTimer?.refresh();
		const kind = record(update).sessionUpdate;
		if (turn.promptStarted && !turn.echoSeen && (kind === "user_message_chunk" || LEFTOVER_KINDS.has(String(kind)))) {
			if (kind === "user_message_chunk") {
				turn.echoSeen = true;
				if (turn.held.length > 0) this.#log("leftovers-dropped", { sessionId: turn.sessionId, frames: turn.held.length });
				turn.held = [];
			} else {
				turn.held.push(update);
			}
			return;
		}
		this.#applyUpdate(turn, update);
	}

	#applyUpdate(turn: ActiveTurn, update: unknown): void {
		const frame = record(update);
		if (frame.sessionUpdate === "usage_update" && Number.isSafeInteger(frame.used) && Number.isSafeInteger(frame.size)
			&& (frame.used as number) >= 0 && (frame.size as number) > 0) {
			const contextUsage = { used: frame.used as number, size: frame.size as number };
			turn.contextUsage = contextUsage;
			traceUsage("usage-update", { sessionId: turn.sessionId, used: contextUsage.used, size: contextUsage.size });
			this.#emit(turn, { type: "context_usage", contextUsage });
			return;
		}
		const mapped = mapUpdate(update);
		if (!mapped) return;
		switch (mapped.kind) {
			case "text": {
				if (isAgyRetryNotice(mapped.delta)) {
					// agy's own notice, not the model's reply: keep it visible
					// but out of the answer pi stores and replays.
					this.#emit(turn, { type: "thought", delta: `\n${mapped.delta.trim()} agy retries.\n` });
					return;
				}
				const emit = turn.response.append(mapped.delta);
				if (emit) this.#emit(turn, { type: "text", delta: emit });
				return;
			}
			case "thought":
				if (mapped.delta) this.#emit(turn, { type: "thought", delta: mapped.delta });
				return;
			case "tool_start": {
				turn.toolCalls.set(mapped.toolCallId, { name: mapped.name, args: mapped.args, diff: mapped.diff, mcpServer: mapped.mcpServer });
				this.#emit(turn, { type: "tool_start", name: mapped.name, args: mapped.args, mcpServer: mapped.mcpServer, toolCallId: mapped.toolCallId });
				if (mapped.mcpServer !== PI_BRIDGE_SERVER) this.#nativeStarted(turn, mapped.toolCallId, mapped.name, nativeToolLabel(mapped.name, mapped.args, mapped.title));
				return;
			}
			case "tool_done": {
				let entry = turn.toolCalls.get(mapped.toolCallId);
				if (!entry && turn.toolCalls.size === 1) {
					// The server can finish an approved tool under a different id.
					// Adopt only when exactly one call is pending: with concurrent
					// tools, guessing would attach an edit diff to the wrong file.
					entry = turn.toolCalls.values().next().value;
					turn.toolCalls.clear();
				}
				turn.toolCalls.delete(mapped.toolCallId);
				this.#emit(turn, {
					type: "tool_done",
					name: entry?.name ?? "tool",
					args: entry?.args ?? {},
					output: mapped.output,
					diff: mapped.diff ?? entry?.diff,
					mcpServer: mapped.mcpServer ?? entry?.mcpServer,
					toolCallId: mapped.toolCallId,
				});
				this.#nativeEnded(turn, mapped.toolCallId, "ok");
				return;
			}
			case "tool_error": {
				const entry = turn.toolCalls.get(mapped.toolCallId);
				turn.toolCalls.delete(mapped.toolCallId);
				this.#emit(turn, { type: "tool_error", name: entry?.name ?? "tool", message: mapped.message, mcpServer: mapped.mcpServer ?? entry?.mcpServer, toolCallId: mapped.toolCallId });
				this.#nativeEnded(turn, mapped.toolCallId, "failed");
				return;
			}
			case "replay_user":
				return; // load replay or a repeated echo: never live text
		}
	}

	/** One of agy's own tools started: show it live and pause the inactivity
	 *  guard, since a long native command produces no frames. */
	#nativeStarted(turn: ActiveTurn, id: string, name: string, label: string): void {
		if (turn.natives.has(id)) return;
		const startedAt = Date.now();
		turn.natives.set(id, { name, label, startedAt });
		this.#clearIdle(turn);
		this.#notifyNative({ type: "start", id, label, startedAt });
	}

	#nativeEnded(turn: ActiveTurn, id: string, status: "ok" | "failed"): void {
		const native = turn.natives.get(id);
		if (!native) return;
		turn.natives.delete(id);
		// invoke_subagent returns at once; the subagent keeps working.
		const background = status === "ok" && native.name === "invoke_subagent";
		if (background) turn.subagents += 1;
		this.#emit(turn, { type: "native_tool", toolCallId: id, label: native.label, status, durationMs: Date.now() - native.startedAt, background });
		this.#notifyNative({ type: "end", id });
		this.#armIdle(turn);
	}

	#notifyNative(event: NativeToolEvent): void {
		try {
			this.#opts.onNativeTool?.(event);
		} catch (err) {
			this.#log("native-tool-listener-failed", { message: describe(err) });
		}
	}

	/** Prompt ended: frames held for an echo that never came are real output;
	 *  native calls still running continue in the background. */
	#finishPrompt(turn: ActiveTurn): void {
		if (!turn.echoSeen && turn.held.length > 0) {
			this.#log("no-prompt-echo", { sessionId: turn.sessionId, frames: turn.held.length });
			const held = turn.held;
			turn.held = [];
			turn.echoSeen = true;
			for (const update of held) this.#applyUpdate(turn, update);
		}
		const taskIds = [...turn.natives.keys()];
		for (const [id, native] of turn.natives) {
			this.#emit(turn, { type: "native_tool", toolCallId: id, label: native.label, status: "running", background: true });
		}
		if (taskIds.length > 0 || turn.subagents > 0) {
			this.#backgroundWatcher()?.track(turn.sessionId, { since: turn.promptStartedAt, taskIds, subagents: turn.subagents });
		}
	}

	#backgroundWatcher(): BackgroundMessages | undefined {
		const { brainDir, onBackgroundMessage } = this.#opts;
		if (!brainDir || !onBackgroundMessage) return undefined;
		this.#background ??= new BackgroundMessages({
			brainDir,
			onMessage: onBackgroundMessage,
			log: (msg, data) => this.#log(msg, data),
			intervalMs: this.#opts.backgroundPollMs,
		});
		return this.#background;
	}

	#onConnectionExit(conn: AcpConnection, info: AcpExitInfo): void {
		if (this.#conn === conn) {
			this.#conn = undefined;
			this.#liveSessions.clear();
		}
		const turn = this.#active;
		this.#log("connection-exited", { code: info.code, signal: info.signal, ownsTurn: turn?.conn === conn });
		// A replaced connection reporting its death late must not touch the
		// turn that now runs on its successor.
		if (!turn || turn.closed || turn.conn !== conn) return;
		if (turn.aborted) {
			this.#settleAborted(turn);
			return;
		}
		this.#failTurn(turn, `Antigravity CLI exited mid-turn (${info.reason}); it restarts on the next turn`);
	}

	/** The live connection, spawning one if needed. Concurrent callers share a
	 *  pending start, so no request ever precedes the initialize handshake. */
	#ensureConnection(cwd: string): Promise<AcpConnection> {
		if (this.#starting) return this.#starting;
		if (this.#conn?.alive) return Promise.resolve(this.#conn);
		const bin = typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin;
		const conn: AcpConnection = new AcpConnection({
			bin,
			binArgs: this.#opts.binArgs,
			extraEnv: this.#opts.extraEnv,
			cwd,
			mcpServers: this.#opts.mcpServers,
			log: (msg, data) => this.#log(msg, data),
			systemPrompt: this.#opts.systemPrompt,
			// Fail-closed: only skipPermissions turns approve agy's requests.
			permissions: () => (this.#active?.request.skipPermissions ? "auto" : "deny"),
			onUpdate: (sessionId, update) => this.#onConnectionUpdate(conn, sessionId, update),
			onExit: (info) => this.#onConnectionExit(conn, info),
		});
		this.#conn = conn;
		this.#liveSessions.clear();
		this.#log("spawn", { bin });
		const starting = conn.start().then(
			() => {
				if (this.#starting === starting) this.#starting = undefined;
				return conn;
			},
			(err: unknown) => {
				if (this.#starting === starting) this.#starting = undefined;
				// A server that spawned but failed the handshake must not leak:
				// it runs in its own process group and would outlive pi.
				if (this.#conn === conn) this.#conn = undefined;
				conn.kill();
				this.#log("start-failed", { message: describe(err) });
				throw new Error(`Cannot start the Antigravity CLI (${bin}): ${describe(err)}. Run /agy setup.`);
			},
		);
		this.#starting = starting;
		return starting;
	}

	/** Abort: ACP cancel once the prompt runs (process and session survive);
	 *  before that, settle at once and let the setup steps stop at their next
	 *  check. Teardown only if the cancelled prompt does not settle in time. */
	#abortTurn(turn: ActiveTurn): void {
		if (turn.closed || turn.aborted) return;
		turn.aborted = true;
		const conn = turn.conn;
		if (!turn.promptStarted || !conn?.alive) {
			this.#settleAborted(turn);
			return;
		}
		this.#log("cancel", { sessionId: turn.sessionId });
		conn.cancel(turn.sessionId);
		turn.cancelTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log("cancel-timeout", { sessionId: turn.sessionId });
			this.#teardown(turn);
			this.#settleAborted(turn);
		}, this.#opts.cancelGraceMs ?? CANCEL_GRACE_MS);
		turn.cancelTimer.unref?.();
	}

	/** Kill the turn's own connection, never a successor's. */
	#teardown(turn: ActiveTurn): void {
		const conn = turn.conn;
		if (!conn) return;
		this.#log("teardown", { sessionId: turn.sessionId });
		if (this.#conn === conn) {
			this.#conn = undefined;
			this.#liveSessions.clear();
		}
		conn.kill();
	}

	#createTurn(request: DriverTurnRequest): ActiveTurn {
		let resolve!: (o: TurnOutcome) => void;
		const outcome = new Promise<TurnOutcome>((r) => (resolve = r));
		return {
			id: randomUUID().slice(0, 8),
			request,
			input: { prompt: request.prompt, images: request.images, contextBlock: request.contextBlock },
			stepCursor: -1,
			stepUsageSeen: false,
			sessionId: "",
			buffer: [],
			wake: [],
			closed: false,
			resolve,
			outcome,
			response: new TextAccumulator(),
			promptStarted: false,
			aborted: false,
			parks: 0,
			toolCalls: new Map(),
			natives: new Map(),
			subagents: 0,
			promptStartedAt: 0,
			echoSeen: false,
			held: [],
		};
	}

	#armIdle(turn: ActiveTurn): void {
		this.#clearIdle(turn);
		// Parked on pi, or one of agy's own tools is running: resumes after.
		if (turn.parks > 0 || turn.natives.size > 0 || turn.closed) return;
		const idleMin = turn.request.inactivityMin ?? DEFAULT_INACTIVITY_MIN;
		if (idleMin <= 0) return;
		turn.idleTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log("stall", { sessionId: turn.sessionId });
			this.#teardown(turn);
			this.#failTurn(turn, `Antigravity produced no output for ${formatMinutes(idleMin)}; the turn was stopped`);
		}, idleMin * 60_000);
		turn.idleTimer.unref?.();
	}

	#clearIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		turn.idleTimer = undefined;
	}

	// --- settling ----------------------------------------------------------------

	#settle(turn: ActiveTurn, outcome: TurnOutcome, opts: { collected?: boolean } = {}): void {
		if (turn.closed) return;
		const flushed = turn.response.flush();
		if (flushed) this.#emit(turn, { type: "text", delta: flushed });
		outcome.response = turn.response.text;
		// Tokens spent by an aborted or failed prompt are still reported.
		if (turn.promptStarted && !opts.collected) this.#collectStepUsage(turn);
		if (turn.contextUsage) outcome.contextUsage = turn.contextUsage;
		turn.closed = true;
		this.#clearIdle(turn);
		if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
		// The live status must not outlive the turn.
		for (const id of turn.natives.keys()) this.#notifyNative({ type: "end", id });
		turn.natives.clear();
		if (this.#active === turn) this.#active = undefined;
		for (const wake of turn.wake) wake();
		turn.wake = [];
		turn.resolve(outcome);
		try {
			this.#onTurnEnd?.(outcome);
		} catch (err) {
			this.#log("turn-end-listener-failed", { message: describe(err) });
		}
	}

	#settleAborted(turn: ActiveTurn): void {
		this.#settle(turn, { conversationId: turn.sessionId || undefined, status: "OK", response: "", aborted: true });
	}

	#failTurn(turn: ActiveTurn, message: string): void {
		this.#settle(turn, {
			conversationId: turn.sessionId || undefined,
			status: "ERROR",
			response: "",
			error: message,
			aborted: turn.aborted,
		});
	}

	/** Emit exact usage for model calls the server persisted since the last
	 *  report. Returns the store's highest step index (undefined when the
	 *  store is unreadable); a missing store silently reports nothing. */
	#collectStepUsage(turn: ActiveTurn): number | undefined {
		if (!turn.dbPath || turn.closed) return undefined;
		const state = readStepState(turn.dbPath, turn.stepCursor);
		if (!state) return undefined;
		const usage = summarizeSteps(state.steps);
		if (!usage) return state.maxIdx;
		turn.stepCursor = usage.lastIdx;
		turn.lastStep = state.steps.at(-1);
		turn.stepUsageSeen = true;
		traceUsage("step-usage", {
			sessionId: turn.sessionId,
			steps: state.steps.map(({ idx, input, output, cacheRead, cacheWrite }) => ({ idx, input, output, cacheRead, cacheWrite })),
			contextTokens: usage.contextTokens,
			usageUpdate: turn.contextUsage?.used,
		});
		this.#emit(turn, { type: "step_usage", usage: stripIdx(usage) });
		return state.maxIdx;
	}

	#log(msg: string, data?: unknown): void {
		this.#opts.log?.(msg, data);
	}

	/** Settle the active turn as an error and stop the process. The next
	 *  turn respawns it (pi replaces extensions on /new, /resume, /reload). */
	async close(): Promise<void> {
		this.#log("close");
		const turn = this.#active;
		if (turn && !turn.closed) this.#failTurn(turn, "Antigravity driver shut down mid-turn");
		const conn = this.#conn;
		this.#conn = undefined;
		this.#starting = undefined;
		this.#liveSessions.clear();
		conn?.kill();
		this.#background?.close();
		this.#background = undefined;
	}
}

/** Content frames that can be leftovers of background work; status frames
 *  (usage, config, commands) describe the session now and always apply. */
const LEFTOVER_KINDS = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function formatMinutes(min: number): string {
	return min >= 1 ? `${Math.round(min)} min` : `${Math.round(min * 60)} s`;
}

function stripIdx({ lastIdx: _lastIdx, ...usage }: StepUsage): AgyStepUsage {
	return usage;
}
