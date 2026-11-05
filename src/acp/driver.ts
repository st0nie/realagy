// AcpDriver: the ACP turn engine. Implements the same TurnDriver surface as
// the stream-json driver (see src/driver-types.ts) so provider.ts and
// the G9 round-trip store work unchanged.
//
// Engine differences vs stream-json, all verified live (docs/ACP-PROTOCOL-REFERENCE.md):
//   - no process recycle on profile drift: one server process, sessions
//     selected per turn via session/new / session/load
//   - model/effort via session/set_config_option (configId "model", FULL slug
//     with the effort tier baked in); mode via configId "mode"
//   - config does NOT persist across server restarts: re-applied every turn
//   - session/load replays history as full-text notification pairs BEFORE its
//     response; the connection suppresses updates while loading
//   - session/cancel is unimplemented on RC01 (-32601): abort = abortAll()
//     teardown + kill, then session/load on the next turn. The method is
//     probed once per connection; when upstream ships it, abort goes graceful
//   - overall-timer pause uses remaining-budget semantics on G9 parks (never a
//     fresh cap); every park carries its own timeout (BRIDGE_TIMEOUT_MS)
//   - request_permission: skipPermissions turns answer the first allow option
//     synchronously; otherwise an optional human handler (extension dialog)
//     PARKS the request with the turn budget paused; no handler = deny
//     fail-closed. Approvals-mode parity: a permissionPolicy override maps
//     approvals.mode allow to the same synchronous auto path

import { randomUUID } from "node:crypto";
import type { UsageEstimate } from "./usage-estimate.js";
import { AcpConnection, resolveAcpBinary, type AcpMcpServer, type AcpPermissionRequest } from "./connection.js";
import type { AcpPermissionHandler } from "./connection.js";
import { mapStopReason, mapUpdate, TextAccumulator, type AcpEditDiff } from "./events.js";
import { estimateTokens, synthesizeUsage } from "./usage-estimate.js";
import { conversationDbPath, lastStepIdx, readStepTokens, siblingUsage, summarizeSteps, type StepTokens, type StepUsage } from "./step-usage.js";
import { traceUsage } from "../usage-trace.js";
import type {
	AgyStepUsage,
	AgyUsage,
	DriverActivity,
	DriverSnapshot,
	DriverState,
	DriverTurnRequest,
	TurnDriver,
	TurnHandle,
	TurnOutcome,
} from "../driver-types.js";

const LIFECYCLE_LIMIT = 24;

export interface AcpDriverOptions {
	/** Config acp.bin value (may be empty). Env AGY_ACP_BIN wins. A function
	 *  is resolved per connection: setup can install the binary and update
	 *  config mid-session, and the next turn picks it up without a restart. */
	bin: string | (() => string);
	/** Extra argv for the binary (tests: node + fake-server script). */
	binArgs?: string[];
	extraEnv?: Record<string, string>;
	/** Bridge registration for session/new AND session/load. */
	mcpServers?: () => AcpMcpServer[];
	/** [] disables all Antigravity built-ins; MCP tools remain available. */
	enabledTools?: () => string[];
	/** Additional Antigravity built-in tools disabled on session/new and load. */
	disabledTools?: () => string[];
	/** Client-side usage synthesis. Default "off": regex estimates must not
	 *  become pi's context count; pi estimates unmeasured messages itself. */
	usageEstimate?: UsageEstimate | (() => UsageEstimate);
	/** Directory holding the server's `<sessionId>.db` conversation stores,
	 *  read for exact per-model-call usage. undefined disables. */
	conversationsDir?: () => string | undefined;
	/** Human gate for ACP request_permission on non-skip turns. Forwarded to
	 *  the connection; the driver parks the turn budget around each call
	 *  (dialog time does not eat the deadline). */
	onPermissionRequest?: AcpPermissionHandler;
	/** Park budget for one permission dialog (tests shrink it). */
	permissionParkMs?: number;
	/** Standing policy consulted when the turn is not skipPermissions:
	 *  "auto" answers the first allow option synchronously, "deny" consults
	 *  the human handler or fail-closes. Default deny. */
	permissionPolicy?: () => "auto" | "deny";
	log?: (msg: string, data?: unknown) => void;
}

interface ActiveTurn {
	id: string;
	request: DriverTurnRequest;
	/** The input actually sent: the request's, or its fallback after a lost session. */
	input: { prompt: string; images?: Array<{ data: string; mimeType: string }>; contextBlock?: { uri: string; text: string } };
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
	/** Usage-synthesis counters: per-delta token sums (estimate mode) and
	 *  delta counts (direct mode). Sums are taken per delta, never over the
	 *  joined text, so a word split across chunks stays two words. */
	textTokens: number;
	thoughtTokens: number;
	textDeltas: number;
	thoughtDeltas: number;
	/** Estimated once, not re-tokenized for every streaming delta. */
	estimatedInputTokens: number;
	contextUsage?: { used: number; size: number };
	sawResult: boolean;
	/** True once the prompt RPC was issued. Abort before this point has
	 *  nothing to cancel: probing would risk a success-as-noop answer from a
	 *  future cancel-capable server stranding the turn in the safety-net
	 *  wait, so the driver tears down instead. */
	promptStarted: boolean;
	aborted: boolean;
	abortedBy: "signal" | "timer" | null;
	parks: number;
	/** Wall-clock deadline of the overall timer; null while paused. */
	overallDeadline: number | null;
	overallRemainingMs: number | null;
	overallTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	/** toolCallId → tool name + args + optional native diff (diff rides on
	 *  the pending tool_call frame; updates don't repeat it). */
	toolCalls: Map<string, { name: string; args: Record<string, unknown>; diff?: AcpEditDiff; mcpServer?: string }>;
}

/** Recombine the provider's (base slug, effort) into the FULL ACP model slug.
 *  Fixed families (no effort) pass through unchanged. Verified against the
 *  run-5 catalog: session/set_config_option wants "gemini-3.8-flash-low"-style
 *  full slugs. */
export function acpModelSlug(model: string, effort?: string): string {
	if (!effort) return model;
	if (/(?:^|-)(?:high|medium|low)$/.test(model)) return model;
	return `${model}-${effort}`;
}

/** Map our config knobs onto ACP session modes. skipPermissions=false also
 *  fail-closes the in-connection permission handler (reject options), so the
 *  modes keep their server-side meaning. Known gap: the CLI's `--mode plan`
 *  has no ACP equivalent (review 4, finding 4) — plan + acp is refused at the
 *  command level and fails the turn visibly. */
export function acpMode(mode: string, skipPermissions: boolean): string {
	if (skipPermissions) return "yolo";
	return mode === "plan" ? "default" : "auto_edit";
}

export class AcpDriver implements TurnDriver {
	#opts: AcpDriverOptions;
	#state: DriverState = "idle";
	#conn: AcpConnection | undefined;
	#active: ActiveTurn | undefined;
	#queueTail: Promise<void> = Promise.resolve();
	#lifecycle: string[] = [];
	#onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	#stats = {
		spawns: 0,
		turns: 0,
		sessionsCreated: 0,
		sessionsLoaded: 0,
		kills: 0,
	};
	#serverVersion: string | undefined;
	#lastSessionId: string | undefined;
	/** Sessions held in memory by the current server process (reset on respawn). */
	#liveSessions = new Set<string>();
	#lastCancelSupported: boolean | null = null;
	#agentInfo: { name?: string; title?: string } | undefined;

	constructor(opts: AcpDriverOptions) {
		this.#opts = opts;
		this.#log("driver-created", { bin: typeof opts.bin === "function" ? "(resolved per turn)" : resolveAcpBinary(opts.bin) });
	}

	/** Read the account's live catalog through the official ACP session flow. */
	async listModels(cwd: string): Promise<Array<{ modelId: string; name?: string }>> {
		const conn = await this.#ensureConnection({ cwd, model: "", mode: "accept-edits", skipPermissions: true, prompt: "" });
		const session = await conn.newSession(cwd);
		return session.availableModels;
	}

	get state(): DriverState {
		return this.#state;
	}

	get activeHandle(): TurnHandle | null {
		const t = this.#active;
		return t && !t.closed ? this.#makeHandle(t) : null;
	}

	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined) {
		this.#onTurnEnd = fn;
	}

	/** Inject a synthetic activity into the live turn (bridge inbox). Parks the
	 *  turn: suspends the idle timer and pauses the overall deadline. */
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
			this.#pauseOverall(t);
		}
		this.#emit(t, activity);
	}

	/** Run the human permission dialog with the turn parked: same budget
	 *  semantics as bridge parks (dialog time does not consume the deadline).
	 *  The finally unparks the CAPTURED turn, never whatever is active at
	 *  exit: the turn can close mid-dialog (abort, server death) and a new
	 *  turn must not inherit this park's accounting. */
	async #parkForPermission(req: AcpPermissionRequest): Promise<string | null | undefined> {
		const t = this.#active;
		const parked = t !== undefined && !t.closed;
		if (parked) {
			t.parks += 1;
			this.#clearIdle(t);
			this.#pauseOverall(t);
		}
		try {
			return await this.#opts.onPermissionRequest!(req);
		} finally {
			if (parked && !t.closed && t.parks > 0) {
				t.parks -= 1;
				if (t.parks === 0) {
					this.#armIdle(t);
					this.#resumeOverall(t);
					this.#log("unparked");
				}
			}
		}
	}

	kickIdle(): void {
		const t = this.#active;
		if (!t || t.closed) return;
		if (t.parks > 0) t.parks -= 1;
		if (t.parks === 0) {
			this.#armIdle(t);
			this.#resumeOverall(t);
			this.#log("unparked");
		}
	}

	/** Turns are serialized; a parked turn stays open and the continuation
	 *  path uses reentry() (same contract as the stream-json driver). */
	run(request: DriverTurnRequest): Promise<TurnHandle> {
		let release!: () => void;
		const prev = this.#queueTail;
		this.#queueTail = new Promise<void>((r) => (release = r));
		return prev
			.then(() => this.#runExclusive(request))
			.then((handle) => {
				void handle.outcome.catch(() => {}).then(() => release());
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

	#runExclusive(request: DriverTurnRequest): Promise<TurnHandle> {
		// No shutdown latch here: pi fires session_shutdown on /new, /resume and
		// /fork (not only process exit), so a closed driver must respawn on the
		// next turn instead of rejecting forever. Regression 2026-09-07:
		// /compact after a model switch failed with "ACP driver is shut down."
		if (request.signal?.aborted) return Promise.reject(new Error("aborted before start"));

		const turn = this.#createTurn(request);
		this.#active = turn;
		this.#state = "running";
		this.#stats.turns += 1;
		this.#log("turn-start", {
			model: request.model,
			effort: request.effort,
			mode: request.mode,
			conversation: request.conversationId ?? null,
			images: request.images?.length ?? 0,
			contextBlock: request.contextBlock ? true : undefined,
		});

		// Abort wiring first: a kill during session setup must still settle the
		// turn (Gate D teardown applies from the first request).
		if (request.signal) {
			const onAbort = () => void this.#abortTurn(turn);
			if (request.signal.aborted) {
				onAbort();
			} else {
				request.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Execute asynchronously: the handle returns as soon as the prompt is
		// dispatched, and activities stream through next() (stream-json contract).
		void this.#executeTurn(turn).catch((err: unknown) => {
			this.#failTurn(turn, `ACP turn failed: ${describe(err)}`);
		});
		return Promise.resolve(this.#makeHandle(turn));
	}

	async #executeTurn(turn: ActiveTurn): Promise<void> {
		const request = turn.request;
		const conn = await this.#ensureConnection(request);

		// Session: reuse a session this server process already holds, load
		// (resume) one it persisted, or create. A missing conversation must not
		// fail the turn (9.4): the fresh session gets the request's complete
		// fallback input instead of a delta it could not interpret.
		let sessionMode: "new" | "reused" | "loaded" | "fallback" = "new";
		try {
			if (request.conversationId && this.#liveSessions.has(request.conversationId)) {
				turn.sessionId = request.conversationId;
				sessionMode = "reused";
				this.#log("session-reuse", { sessionId: request.conversationId });
			} else if (request.conversationId) {
				this.#log("session-load", { sessionId: request.conversationId });
				this.#stats.sessionsLoaded += 1;
				await conn.loadSession(request.conversationId, request.cwd);
				turn.sessionId = request.conversationId;
				sessionMode = "loaded";
			} else {
				const created = await conn.newSession(request.cwd);
				turn.sessionId = created.sessionId;
				this.#stats.sessionsCreated += 1;
				this.#log("session-new", { sessionId: created.sessionId });
			}
		} catch (err) {
			if (turn.aborted) {
				this.#settle(turn, {
					conversationId: turn.sessionId,
					status: "OK",
					response: turn.response.text,
					finished: true,
					aborted: true,
				});
				return;
			}
			if (request.conversationId) {
				this.#log("session-load-failed-creating-fresh", {
					sessionId: request.conversationId,
					message: err instanceof Error ? err.message : String(err),
				});
				try {
					const created = await conn.newSession(request.cwd);
					turn.sessionId = created.sessionId;
					this.#stats.sessionsCreated += 1;
					sessionMode = "fallback";
				} catch (err2) {
					this.#failTurn(turn, `ACP session failed: ${describe(err2)}`);
					return;
				}
			} else {
				this.#failTurn(turn, `ACP session failed: ${describe(err)}`);
				return;
			}
		}
		if (conn === this.#conn) this.#liveSessions.add(turn.sessionId);
		if (sessionMode === "fallback" && request.fallback) {
			turn.input = { prompt: request.fallback.prompt, images: request.fallback.images, contextBlock: request.fallback.contextBlock };
		}
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
		if (turn.closed) return;

		// Config: model + mode. Model failure fails the turn (wrong-model turns
		// are a parity break); mode failure is best-effort (auto policy makes
		// the modes converge anyway).
		try {
			await conn.setConfigOption(turn.sessionId, "model", acpModelSlug(request.model, request.effort));
		} catch (err) {
			this.#failTurn(turn, `ACP model selection failed: ${describe(err)}`);
			return;
		}
		try {
			await conn.setConfigOption(turn.sessionId, "mode", acpMode(request.mode, request.skipPermissions));
		} catch (err) {
			this.#log("mode-apply-failed", { message: describe(err) });
		}
		if (turn.closed) return;

		// Timers: overall (turn deadline, pause-aware) + idle (inactivity).
		this.#armOverall(turn);
		this.#armIdle(turn);
		// Optional client estimate (usageEstimate "estimate"/"direct"; default
		// off). Exact counts come from step_usage, read from the server's
		// conversation store as each model call finishes.
		this.#emitLiveEstimate(turn);

		// Prompt. Updates stream through the connection's onUpdate callback.
		try {
			// Nothing to cancel before the prompt RPC exists; see promptStarted.
			turn.promptStarted = true;
			const result = await conn.prompt(turn.sessionId, turn.input.prompt, turn.input.images, turn.input.contextBlock);
			if (turn.closed) return;
			turn.sawResult = true;
			const usage = result.usage;
			traceUsage("prompt-result", { sessionId: turn.sessionId, stopReason: result.stopReason, usage, usageUpdate: turn.contextUsage });
			// Exact per-call steps first; the turn-cumulative total is only a
			// fallback for messages no step measurement covered.
			this.#collectStepUsage(turn);
			if (usage && !turn.stepUsageSeen) this.#emit(turn, { type: "usage", usage });
			const mapped = mapStopReason(result.stopReason);
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: mapped.status,
				response: turn.response.text,
				usage,
				error: mapped.error,
				finished: true,
				aborted: mapped.aborted,
			});
		} catch (err) {
			if (turn.closed) return;
			const aborted = turn.aborted;
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: aborted ? "OK" : "ERROR",
				response: turn.response.text,
				error: aborted ? undefined : `ACP prompt failed: ${describe(err)}`,
				finished: true,
				aborted,
			});
		}
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
		if (turn.wake.length > 0) turn.wake.shift()!();
		turn.buffer.push(activity);
	}

	#onConnectionUpdate(sessionId: string | null, update: unknown): void {
		const turn = this.#active;
		if (!turn || turn.closed) return;
		if (sessionId !== null && sessionId !== turn.sessionId) return;
		if (turn.idleTimer) turn.idleTimer.refresh();
		if (typeof update === "object" && update !== null && !Array.isArray(update)) {
			const frame = update as Record<string, unknown>;
			if (frame.sessionUpdate === "usage_update" && Number.isSafeInteger(frame.used) && Number.isSafeInteger(frame.size)
				&& (frame.used as number) >= 0 && (frame.size as number) > 0) {
				const contextUsage = { used: frame.used as number, size: frame.size as number };
				turn.contextUsage = contextUsage;
				traceUsage("usage-update", { sessionId: turn.sessionId, used: contextUsage.used, size: contextUsage.size });
				this.#emit(turn, { type: "context_usage", contextUsage });
			}
		}
		const mapped = mapUpdate(update);
		if (!mapped) return;
		switch (mapped.kind) {
			case "text": {
				const emit = turn.response.append(mapped.delta);
				if (emit) {
					turn.textDeltas += 1;
					turn.textTokens += estimateTokens(emit);
					this.#emitLiveEstimate(turn);
					this.#emit(turn, { type: "text", delta: emit });
				}
				return;
			}
			case "thought": {
				if (!mapped.delta) return;
				turn.thoughtDeltas += 1;
				turn.thoughtTokens += estimateTokens(mapped.delta);
				this.#emitLiveEstimate(turn);
				this.#emit(turn, { type: "thought", delta: mapped.delta });
				return;
			}
			case "tool_start": {
				const entry = { name: mapped.name, args: mapped.args, diff: mapped.diff, mcpServer: mapped.mcpServer };
				turn.toolCalls.set(mapped.toolCallId, entry);
				this.#emit(turn, { type: "tool_start", name: mapped.name, args: mapped.args, mcpServer: mapped.mcpServer, toolCallId: mapped.toolCallId });
				return;
			}
			case "tool_done": {
				let entry = turn.toolCalls.get(mapped.toolCallId);
				if (!entry && turn.toolCalls.size === 1) {
					// The server can finish an approved tool under a different id.
					// Adopt only when exactly one call is pending: with concurrent
					// tools, guessing would attach an edit diff to the wrong file.
					// Residual: an unrelated done with an unknown id still pairs
					// with the pending entry; strictly better than guessing ANY id.
					entry = turn.toolCalls.values().next().value;
					turn.toolCalls.clear();
				}
				turn.toolCalls.delete(mapped.toolCallId);
				const name = entry?.name ?? "tool";
				const args = entry?.args ?? {};
				// Native diff from the stored tool_call frame; the update's own
				// diff (future builds) wins when present.
				this.#emit(turn, { type: "tool_done", name, args, output: mapped.output, diff: mapped.diff ?? entry?.diff, mcpServer: mapped.mcpServer ?? entry?.mcpServer, toolCallId: mapped.toolCallId });
				return;
			}
			case "tool_error": {
				const entry = turn.toolCalls.get(mapped.toolCallId);
				turn.toolCalls.delete(mapped.toolCallId);
				const name = entry?.name ?? "tool";
				this.#emit(turn, { type: "tool_error", name, message: mapped.message, mcpServer: mapped.mcpServer ?? entry?.mcpServer, toolCallId: mapped.toolCallId });
				return;
			}
			case "replay_user":
				return; // load replay: history, never live text
		}
	}

	#onConnectionExit(conn: AcpConnection, info: { stderrTail: string }): void {
		if (this.#conn !== conn) {
			// A replaced connection reporting its death late (RC01's signal
			// handler intercepts SIGTERM and can outlive its replacement by
			// seconds): its turn is long gone and the new connection owns the
			// driver state. Clobbering #conn here would orphan the live one.
			this.#log("stale-connection-exited", { tail: info.stderrTail.slice(-200) });
			return;
		}
		const turn = this.#active;
		this.#conn = undefined;
		this.#state = "dead";
		// Teardown exits (abort kill, shutdown, idle recycle) are deliberate:
		// their stderr tail must never reach the UI. Only a live turn dying
		// mid-flight is user-reportable, and it surfaces as a normal turn
		// error, not as raw console noise.
		const turnActive = Boolean(turn && !turn.closed && !turn.aborted && !turn.sawResult);
		this.#log("connection-exited", { expected: !turnActive, tail: info.stderrTail.slice(-200) });
		if (!turn || turn.closed) return;
		if (turn.aborted || turn.sawResult) {
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: turn.response.text.length > 0 || turn.sawResult ? "OK" : "UNKNOWN",
				response: turn.response.text,
				finished: true,
				aborted: turn.aborted,
			});
			return;
		}
		this.#failTurn(turn, "Antigravity session exited unexpectedly; it restarts on the next turn");
	}

	#ensureConnection(request: DriverTurnRequest): Promise<AcpConnection> {
		if (this.#conn?.alive) return Promise.resolve(this.#conn);
		this.#state = "starting";
		this.#stats.spawns += 1;
		const conn = new AcpConnection({
			bin: resolveAcpBinary(typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin),
			binArgs: this.#opts.binArgs,
			extraEnv: this.#opts.extraEnv,
			cwd: request.cwd,
			mcpServers: this.#opts.mcpServers,
			enabledTools: this.#opts.enabledTools,
			disabledTools: this.#opts.disabledTools,
			log: (msg, data) => this.#log(msg, data),
			// Fail-closed permissions: skipPermissions answers allow; a standing
			// policy override (approvals.mode allow) may widen that; everything
			// else goes to the human handler or denies.
			permissions: () =>
				this.#active?.request.skipPermissions
					? "auto"
					: (this.#opts.permissionPolicy?.() ?? "deny"),
			onPermissionRequest: this.#opts.onPermissionRequest
				? (req) => this.#parkForPermission(req)
				: undefined,
			permissionParkMs: this.#opts.permissionParkMs,
			onUpdate: (sessionId, update) => this.#onConnectionUpdate(sessionId, update),
			onExit: (info) => this.#onConnectionExit(conn, info),
		});
		this.#conn = conn;
		this.#liveSessions.clear();
		this.#log("spawn", { bin: resolveAcpBinary(typeof this.#opts.bin === "function" ? this.#opts.bin() : this.#opts.bin) });
		return conn
			.start()
			.then(() => {
				this.#serverVersion = conn.serverVersion();
				const info = conn.agentInfo as { name?: unknown; title?: unknown } | undefined;
				this.#agentInfo = {
					name: typeof info?.name === "string" ? info.name : undefined,
					title: typeof info?.title === "string" ? info.title : undefined,
				};
				this.#state = "ready";
				return conn;
			})
			.catch((err) => {
				// A server that spawned but failed the handshake (init timeout,
				// auth hang) must not leak: it is detached, so it outlives pi.
				this.#state = "dead";
				this.#conn = undefined;
				conn.kill();
				this.#log("start-failed", { message: describe(err) });
				throw err;
			});
	}

	/** Gate D abort. RC01 has no session/cancel: probe it once per connection,
	 *  then either wait for the cancelled result or tear down. */
	async #abortTurn(turn: ActiveTurn): Promise<void> {
		if (turn.closed) return;
		turn.aborted = true;
		turn.abortedBy = "signal";
		const conn = this.#conn;
		// No session yet (killed during setup), no live connection, or a server
		// already known not to implement cancel: teardown directly.
		if (!conn?.alive || turn.sessionId === "" || !turn.promptStarted || this.#cancelUnsupported()) {
			this.#teardownAbort(turn);
			return;
		}
		try {
			const probe = await conn.cancel(turn.sessionId);
			conn.cancelSupported = probe.supported;
			this.#lastCancelSupported = probe.supported;
			if (!probe.supported) {
				this.#log("cancel-unsupported", { build: this.#serverVersion });
				this.#teardownAbort(turn);
				return;
			}
			// Cancel accepted: the prompt result (stopReason cancelled) settles
			// the turn through the normal path. Safety net below in case the
			// server never answers.
			const started = this.#nowMs();
			const check = setInterval(() => {
				if (turn.closed) {
					clearInterval(check);
					return;
				}
				if (this.#nowMs() - started > 10_000) {
					clearInterval(check);
					this.#teardownAbort(turn);
				}
			}, 250);
		} catch (err) {
			this.#log("cancel-failed", { message: describe(err) });
			this.#teardownAbort(turn);
		}
	}

	#cancelUnsupported(): boolean {
		return this.#conn?.cancelSupported === false;
	}

	/** Gate D teardown: reject everything pending, kill the process. The turn
	 *  settles through the connection-exit path as aborted. */
	#teardownAbort(turn: ActiveTurn): void {
		this.#stats.kills += 1;
		this.#log("teardown-abort", { sessionId: turn.sessionId });
		turn.aborted = true;
		this.#conn?.abortAll("abort: connection torn down");
		this.#conn?.kill();
	}

	#createTurn(request: DriverTurnRequest): ActiveTurn {
		let resolve!: (o: TurnOutcome) => void;
		const outcome = new Promise<TurnOutcome>((r) => (resolve = r));
		const turn: ActiveTurn = {
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
			textTokens: 0,
			thoughtTokens: 0,
			textDeltas: 0,
			thoughtDeltas: 0,
			estimatedInputTokens: estimateTokens(request.contextBlock?.text ? `${request.prompt}\n${request.contextBlock.text}` : request.prompt),
			sawResult: false,
		promptStarted: false,
			aborted: false,
			abortedBy: null,
			parks: 0,
			overallDeadline: null,
			overallRemainingMs: null,
			toolCalls: new Map(),
		};
		return turn;
	}

	// --- timers ----------------------------------------------------------------

	#overallBudgetMs(turn: ActiveTurn): number {
		return (turn.request.timeoutMin ?? 10) * 60_000;
	}

	#idleBudgetMs(turn: ActiveTurn): number {
		return (turn.request.inactivityMin ?? 5) * 60_000;
	}

	#nowMs(): number {
		return Date.now();
	}

	#armOverall(turn: ActiveTurn): void {
		const budget = this.#overallBudgetMs(turn);
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		// Parked before timers armed (setup-time park): the turn is PAUSED from
		// birth. Keep the pause invariant (deadline === null) and store the full
		// budget; kickIdle() resumes the timer on unpark. A stale non-null
		// deadline here would make the next #pauseOverall recompute the
		// remaining budget against a wall-clock instant that never ran.
		if (turn.parks > 0) {
			turn.overallDeadline = null;
			turn.overallRemainingMs = budget;
			return;
		}
		turn.overallRemainingMs = null;
		this.#startOverallTimer(turn, budget);
	}

	#startOverallTimer(turn: ActiveTurn, ms: number): void {
		// 0 disables the deadline (config turnTimeoutMin: 0). setTimeout(fn, 0)
		// would fire instantly and kill every turn, guard or not.
		if (ms <= 0) return;
		// The deadline lives HERE, not just in the callers: the running branch
		// of #armOverall never assigns it, and #pauseOverall keys off
		// `deadline !== null` to do anything at all. Without this line every
		// post-arm park is a silent no-op and the timer ticks through the park.
		turn.overallDeadline = this.#nowMs() + ms;
		turn.overallTimer = setTimeout(() => {
			if (turn.closed) return;
			turn.abortedBy = "timer";
			this.#log("timeout", { sessionId: turn.sessionId });
			this.#conn?.abortAll("turn deadline");
			this.#conn?.kill();
			this.#failTurn(turn, `ACP turn exceeded the ${(this.#overallBudgetMs(turn) / 60_000) | 0}m deadline`);
		}, ms);
	}

	/** Pause WITHOUT resetting the deadline (remaining-budget semantics: the
	 *  overall timer is a turn deadline, not an inactivity guard). */
	#pauseOverall(turn: ActiveTurn): void {
		if (turn.overallDeadline === null) return;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		turn.overallTimer = undefined;
		turn.overallRemainingMs = Math.max(0, turn.overallDeadline - this.#nowMs());
		// Null the deadline: a nested park (parks > 1) must not recompute the
		// remaining budget against a stale wall-clock instant — parked time does
		// not consume budget.
		turn.overallDeadline = null;
	}

	#resumeOverall(turn: ActiveTurn): void {
		if (turn.overallRemainingMs === null) return;
		const remaining = turn.overallRemainingMs;
		turn.overallRemainingMs = null;
		this.#startOverallTimer(turn, remaining);
	}

	#armIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		if (turn.parks > 0) return; // parked: idle timer resumes on unpark
		const idleMs = this.#idleBudgetMs(turn);
		// 0 disables the stall guard (config inactivityTimeoutMin: 0).
		if (idleMs <= 0) return;
		turn.idleTimer = setTimeout(() => {
			if (turn.closed) return;
			this.#log("stall", { sessionId: turn.sessionId });
			this.#conn?.abortAll("idle stall");
			this.#conn?.kill();
			this.#failTurn(turn, `ACP stalled for ${(idleMs / 60_000) | 0}m with no output`);
		}, idleMs);
	}

	#clearIdle(turn: ActiveTurn): void {
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		turn.idleTimer = undefined;
	}

	// --- settling ----------------------------------------------------------------

	#settle(turn: ActiveTurn, outcome: TurnOutcome): void {
		if (turn.closed) return;
		const flushed = turn.response.flush();
		if (flushed) {
			turn.textDeltas += 1;
			turn.textTokens += estimateTokens(flushed);
			this.#emit(turn, { type: "text", delta: flushed });
		}
		outcome.response = turn.response.text;
		if (turn.promptStarted) this.#collectStepUsage(turn);
		if (turn.contextUsage) outcome.contextUsage = turn.contextUsage;
		// Gate B stopgap: synthesize usage on clean turns while the server sends
		// none. Runs BEFORE close so the usage activity drains through the
		// normal #nextActivity loop (provider maps it onto partial.usage).
		if (outcome.status === "OK" && !outcome.aborted && outcome.usage === undefined) {
			const usage = this.#syntheticUsage(turn);
			if (usage) {
				outcome.usage = usage;
				this.#emit(turn, { type: "usage", usage });
			}
		}
		turn.closed = true;
		if (turn.overallTimer) clearTimeout(turn.overallTimer);
		if (turn.idleTimer) clearTimeout(turn.idleTimer);
		this.#active = undefined;
		this.#state = this.#conn?.alive ? "ready" : "dead";
		if (outcome.conversationId) this.#lastSessionId = outcome.conversationId;
		for (const wake of turn.wake) wake();
		turn.wake = [];
		if (outcome.aborted && turn.abortedBy === null) turn.abortedBy = "signal";
		turn.resolve(outcome);
		try {
			this.#onTurnEnd?.(outcome);
		} catch {
			/* listener errors must not break settling */
		}
	}

	#failTurn(turn: ActiveTurn, message: string): void {
		this.#settle(turn, {
			conversationId: turn.sessionId,
			status: "ERROR",
			response: turn.response.text,
			error: message,
			finished: true,
			aborted: turn.aborted,
		});
	}

	/** Usage synthesis mode, resolved per turn (follows live config). */
	#usageMode(): UsageEstimate {
		const opt = this.#opts.usageEstimate;
		return (typeof opt === "function" ? opt() : opt) ?? "off";
	}

	/** Emit exact usage for model calls the server persisted since the last
	 *  report. Missing or unreadable stores silently report nothing. */
	#collectStepUsage(turn: ActiveTurn): boolean {
		if (!turn.dbPath || turn.closed) return false;
		const steps = readStepTokens(turn.dbPath, turn.stepCursor);
		const usage = steps ? summarizeSteps(steps) : undefined;
		if (!usage) return false;
		turn.stepCursor = usage.lastIdx;
		turn.lastStep = steps!.at(-1);
		turn.stepUsageSeen = true;
		traceUsage("step-usage", { sessionId: turn.sessionId, steps: steps!.map(({ idx, input, output, cacheRead, cacheWrite }) => ({ idx, input, output, cacheRead, cacheWrite })), contextTokens: usage.contextTokens, usageUpdate: turn.contextUsage?.used });
		this.#emit(turn, { type: "step_usage", usage: stripIdx(usage) });
		return true;
	}

	/** Update Pi's partial usage before the next visible text/thought delta.
	 *  This is not provider-reported billing or an exact context-window count. */
	#emitLiveEstimate(turn: ActiveTurn): void {
		const usage = this.#syntheticUsage(turn);
		if (usage) this.#emit(turn, { type: "usage", usage });
	}

	#syntheticUsage(turn: ActiveTurn): AgyUsage | undefined {
		const mode = this.#usageMode();
		if (mode === "off") return undefined;
		// Superseded only by EXACT PromptResponse.usage. Diagnostic usage-shaped
		// frames (context windows, occupancy) must not silence the estimates:
		// the connection outlives turns and no exact data ever replaces them
		// on ACP 1.1.1 (peer review 2026-09-23).
		if (this.#conn?.exactUsageSeen) return undefined;
		return synthesizeUsage({
			mode,
			prompt: turn.request.prompt,
			contextText: turn.request.contextBlock?.text,
			inputTokens: turn.estimatedInputTokens,
			textTokens: turn.textTokens,
			thoughtTokens: turn.thoughtTokens,
			textDeltas: turn.textDeltas,
			thoughtDeltas: turn.thoughtDeltas,
		});
	}

	#log(msg: string, data?: unknown): void {
		const line = `${new Date().toISOString().slice(11, 19)} ${msg}${data !== undefined ? ` ${JSON.stringify(data)}` : ""}`;
		this.#lifecycle.push(line);
		if (this.#lifecycle.length > LIFECYCLE_LIMIT) this.#lifecycle.shift();
		this.#opts.log?.(msg, data);
	}

	// --- TurnDriver surface ----------------------------------------------------

	async close(reason: "recycle" | "shutdown", cause?: string): Promise<void> {
		this.#log(`close:${reason}${cause ? `:${cause}` : ""}`);
		const turn = this.#active;
		if (turn && !turn.closed) {
			this.#settle(turn, {
				conversationId: turn.sessionId,
				status: "ERROR",
				response: turn.response.text,
				error: `ACP driver ${reason === "recycle" ? "recycled" : "shut down"} mid-turn${cause ? ` (${cause})` : ""}`,
				finished: true,
				aborted: false,
			});
		}
		this.#conn?.abortAll(`driver ${reason}`);
		this.#conn?.kill();
		this.#conn = undefined;
		this.#state = "dead";
	}

	snapshot(): DriverSnapshot {
		return {
			state: this.#state,
			pid: this.#conn?.pid,
			conversationId: this.#active?.sessionId ?? this.#lastSessionId,
			stats: {
				spawns: this.#stats.spawns,
				turns: this.#stats.turns,
				reused: 0,
				recycles: this.#stats.kills,
				lastRecycleReason: undefined,
				recycleReasons: {},
			},
			lifecycle: [...this.#lifecycle],
			engine: "acp",
			acp: {
				sessionId: this.#active?.sessionId ?? this.#lastSessionId,
				prompts: this.#stats.turns,
				sessionsCreated: this.#stats.sessionsCreated,
				sessionsLoaded: this.#stats.sessionsLoaded,
				kills: this.#stats.kills,
				cancelSupported: this.#conn?.cancelSupported ?? this.#lastCancelSupported,
				serverVersion: this.#serverVersion,
				// Connections beyond the first are server restarts (Gate D kills,
				// stale-exit replacements) = reconnects.
				reconnects: Math.max(0, this.#stats.spawns - 1),
				agentName: this.#agentInfo?.name,
				agentTitle: this.#agentInfo?.title,
				usageSeen: this.#conn?.usageSeen ?? false,
			},
		};
	}
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

// re-exported for the extension's doctor (server version display)
export type { AcpMcpServer } from "./connection.js";

function stripIdx({ lastIdx: _lastIdx, ...usage }: StepUsage): AgyStepUsage {
	return usage;
}
