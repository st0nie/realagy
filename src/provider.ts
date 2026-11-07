// Minimal ACP provider. Antigravity produces text/thoughts and requests tools;
// pi owns the transcript, tool execution, permissions, and rendering.

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonValue,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { conversationDbPath, firstCompactionIdx, resolveSessionAtStep } from "./acp/step-usage.js";
import type { AgyStepUsage, AgyUsage, DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "./driver-types.js";
import { familyLimits, toAgyEffort, type AgyModelEntry } from "./models.js";
import { nativeToolLine } from "./native-tools.js";
import { agyCapacityNotice } from "./acp/events.js";
import type { BridgeResult } from "./mcp-server.js";
import {
	formatToolResult,
	freshTokens,
	planTurnFrom,
	warmAfterTurn,
	type TurnPlan,
	type WarmSession,
	type WarmVeto,
} from "./transcript.js";
import { traceUsage } from "./usage-trace.js";
import { quotaExhaustion, type UsageMeter } from "./quota.js";

export const POLL_TOOL_NAME = "bridge_poll_result";
const PARK_TIMEOUT_MS = 8 * 60_000;
/** `agy acp` times out an MCP `tools/call` request after 180 s. Escalate to
 *  `bridge_poll_result` at 150 s, and hold each poll for up to 150 s so slow
 *  foreground tools never hit the 180 s cap or spin in a 0 ms poll loop. */
export const ESCALATE_AFTER_MS = 150_000;
const ESCALATED_TTL_MS = 30 * 60_000;

export interface ToolRoundTripsOptions {
	escalateAfterMs?: number;
	pollWaitMs?: number;
}

interface PendingCall {
	name: string;
	resolve: (result: BridgeResult) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	escalateTimer?: NodeJS.Timeout;
	escalated: boolean;
	signal: AbortSignal;
	onAbort: () => void;
}

interface PollResult {
	name: string;
	state: "running" | "done";
	text?: string;
	isError?: boolean;
	images: Array<{ data: string; mimeType: string }>;
	expires: number;
	waiters: Set<(result: BridgeResult) => void>;
}

/** MCP calls park into a real pi toolUse. Slow calls early-ack with a poll
 * handle so ACP's MCP request deadline cannot kill a legitimate long pi tool. */
/** pi's tool result as MCP content. Images ride as ordinary MCP image blocks;
 *  what agy shows the model is agy's decision (it can also open image files
 *  itself with its native read_file). */
function bridgeResult(text: string, isError: boolean, images: Array<{ data: string; mimeType: string }>): BridgeResult {
	return {
		content: [
			{ type: "text", text: text || (images.length > 0 ? "(image result)" : "(no output)") },
			...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
		],
		isError,
	};
}

function stillRunningResult(callId: string, initial: boolean): BridgeResult {
	const action = initial
		? `The pi tool is still executing. Call ${POLL_TOOL_NAME} with callId ${JSON.stringify(callId)} until it returns the result. Do not call other tools or end your turn while it is running.`
		: `The pi tool is still executing. Call ${POLL_TOOL_NAME} again with callId ${JSON.stringify(callId)} until it returns the result.`;
	return {
		content: [{ type: "text", text: `STILL RUNNING\n${action}` }],
	};
}

export class ToolRoundTrips {
	#pending = new Map<string, PendingCall>();
	#polls = new Map<string, PollResult>();
	#escalateAfterMs: number;
	#pollWaitMs: number;

	constructor(private readonly driver: TurnDriver, opts: ToolRoundTripsOptions = {}) {
		this.#escalateAfterMs = opts.escalateAfterMs ?? ESCALATE_AFTER_MS;
		this.#pollWaitMs = opts.pollWaitMs ?? this.#escalateAfterMs;
	}

	/** True while the bridge waits for pi's result of this call. */
	isPending(callId: string): boolean {
		return this.#pending.has(callId);
	}

	onToolCall = (callId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeResult> => {
		if (name === POLL_TOOL_NAME) return this.#poll(typeof args.callId === "string" ? args.callId : "", signal);
		// While earlier transcript parts are delivered the model only
		// acknowledges them; a pi tool call there would end pi's message early.
		if (this.driver.priming) {
			return Promise.resolve({ content: [{ type: "text", text: "Pi tools are unavailable while the pi transcript is delivered in parts. Reply with only OK." }], isError: true });
		}
		const handle = this.driver.activeHandle;
		if (!handle) return Promise.reject(new Error("no active Antigravity turn for this pi tool call"));
		this.#prunePolls();
		return new Promise<BridgeResult>((resolve, reject) => {
			const pending: PendingCall = {
				name,
				resolve,
				reject,
				escalated: false,
				signal,
				onAbort: () => this.#fail(callId, "ACP disconnected before the pi tool result arrived"),
				timer: setTimeout(() => this.#fail(callId, "pi tool round-trip timed out"), PARK_TIMEOUT_MS),
			};
			if (this.#escalateAfterMs > 0) {
				pending.escalateTimer = setTimeout(() => {
					const current = this.#pending.get(callId);
					if (!current) return;
					current.escalated = true;
					if (current.timer) clearTimeout(current.timer);
					current.timer = undefined;
					// The initial HTTP request is about to finish with STILL RUNNING;
					// its socket closing afterwards must not abort the running pi tool.
					current.signal.removeEventListener("abort", current.onAbort);
					this.#polls.set(callId, {
						name,
						state: "running",
						images: [],
						expires: Number.POSITIVE_INFINITY,
						waiters: new Set(),
					});
					resolve(stillRunningResult(callId, true));
				}, this.#escalateAfterMs);
			}
			this.#pending.set(callId, pending);
			signal.addEventListener("abort", pending.onAbort, { once: true });
			handle.pushExternal({ type: "bridge_call", callId, name, args });
		});
	};

	resolve(callId: string, text: string, isError: boolean, images: Array<{ data: string; mimeType: string }> = []): boolean {
		const pending = this.#pending.get(callId);
		if (!pending) return false;
		this.#pending.delete(callId);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.escalateTimer) clearTimeout(pending.escalateTimer);
		pending.signal.removeEventListener("abort", pending.onAbort);
		const finalResult = bridgeResult(text, isError, images);
		if (pending.escalated) {
			const waiters = this.#polls.get(callId)?.waiters;
			this.#polls.set(callId, {
				name: pending.name,
				state: "done",
				text,
				isError,
				images,
				expires: Date.now() + ESCALATED_TTL_MS,
				waiters: new Set(),
			});
			if (waiters) {
				for (const wake of waiters) wake(finalResult);
			}
		} else {
			pending.resolve(finalResult);
		}
		this.driver.kickIdle();
		return true;
	}

	failAll(reason: string, opts: { includeEscalated?: boolean } = {}): void {
		for (const id of [...this.#pending.keys()]) {
			if (opts.includeEscalated || !this.#pending.get(id)?.escalated) this.#fail(id, reason);
		}
	}

	#fail(callId: string, reason: string): void {
		const pending = this.#pending.get(callId);
		if (!pending) return;
		this.#pending.delete(callId);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.escalateTimer) clearTimeout(pending.escalateTimer);
		pending.signal.removeEventListener("abort", pending.onAbort);
		if (pending.escalated) {
			const text = `Error: ${reason}`;
			const finalResult = bridgeResult(text, true, []);
			const waiters = this.#polls.get(callId)?.waiters;
			this.#polls.set(callId, {
				name: pending.name,
				state: "done",
				text,
				isError: true,
				images: [],
				expires: Date.now() + ESCALATED_TTL_MS,
				waiters: new Set(),
			});
			if (waiters) {
				for (const wake of waiters) wake(finalResult);
			}
		} else {
			pending.reject(new Error(reason));
		}
		this.driver.kickIdle();
	}

	#poll(callId: string, signal: AbortSignal): Promise<BridgeResult> {
		this.#prunePolls();
		const result = this.#polls.get(callId);
		if (!result) {
			return Promise.resolve({ content: [{ type: "text", text: `Unknown or non-escalated callId: ${callId || "(missing)"}` }], isError: true });
		}
		if (result.state === "done") {
			return Promise.resolve(bridgeResult(result.text ?? "", result.isError ?? false, result.images));
		}
		if (signal.aborted) {
			return Promise.reject(new Error("ACP disconnected while polling pi tool result"));
		}
		if (this.#pollWaitMs <= 0) {
			return Promise.resolve(stillRunningResult(callId, false));
		}
		return new Promise<BridgeResult>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				result.waiters.delete(wake);
				signal.removeEventListener("abort", onAbort);
			};
			const wake = (settled: BridgeResult) => {
				cleanup();
				resolve(settled);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("ACP disconnected while polling pi tool result"));
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve(stillRunningResult(callId, false));
			}, this.#pollWaitMs);
			result.waiters.add(wake);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	#prunePolls(): void {
		const now = Date.now();
		for (const [id, result] of this.#polls) {
			if (result.state === "done" && result.expires <= now) this.#polls.delete(id);
		}
	}
}

/** A settled turn's parked calls (TurnDriver.onTurnEnd). An aborted turn
 *  fails all of them, escalated ones too: nothing will poll them any more and
 *  pi's own tools were aborted with it. A failed turn fails the calls agy
 *  still waits on; escalated ones keep running for pi, whose late result
 *  continues the session as a delta. */
export function failParkedCalls(roundTrips: ToolRoundTrips, outcome: TurnOutcome): void {
	if (outcome.aborted) roundTrips.failAll(outcome.error ?? "Antigravity turn aborted", { includeEscalated: true });
	else if (outcome.status === "ERROR") roundTrips.failAll(outcome.error ?? "Antigravity turn ended");
}

interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
	usage: UsageState;
}

/** Usage evidence for one pi assistant message, folded by syncUsage. */
interface UsageState {
	/** Exact per-call usage of the model calls this message covers. */
	step?: AgyStepUsage;
	/** Latest ACP usage_update occupancy received during this message. */
	occupancy?: number;
	/** Turn-cumulative PromptResponse.usage. */
	cumulative?: AgyUsage;
}

function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function newAssistant(model: Model<Api>): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
}


// Pi reads usage.totalTokens (else input + output + cache) of the latest
// assistant message as the CURRENT context size, and input/cacheRead as that
// call's prompt split (cache-hit rate). One ACP prompt spans many internal
// model calls, so its cumulative usage must never become totalTokens. Without
// a measured occupancy the message reports zero usage, and pi estimates it
// from the transcript like any unmeasured message.
type AgyPiUsage = Usage & { agyContextTokens?: number; agyCumulativeTotalTokens?: number };

function syncUsage(target: Usage, state: UsageState): void {
	const piUsage = target as AgyPiUsage;
	Object.assign(target, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	if (state.step) {
		target.input = state.step.input;
		target.output = state.step.output;
		target.cacheRead = state.step.cacheRead;
		target.cacheWrite = state.step.cacheWrite;
		target.totalTokens = state.step.contextTokens;
	} else if (state.occupancy !== undefined) {
		if (state.cumulative) {
			// ACP inputTokens includes the cached read/write tokens; pi counts them separately.
			const c = state.cumulative;
			target.cacheRead = c.cache_read_tokens ?? 0;
			target.cacheWrite = c.cache_write_tokens ?? 0;
			target.input = Math.max(0, (c.input_tokens ?? 0) - target.cacheRead - target.cacheWrite);
			target.output = (c.output_tokens ?? 0) + (c.thinking_tokens ?? 0);
		}
		target.totalTokens = state.occupancy;
	}
	if (state.occupancy !== undefined) piUsage.agyContextTokens = state.occupancy;
	if (state.cumulative) {
		const c = state.cumulative;
		piUsage.agyCumulativeTotalTokens = c.total_tokens ?? (c.input_tokens ?? 0) + (c.output_tokens ?? 0) + (c.thinking_tokens ?? 0);
	}
}

function addStepUsage(state: UsageState, usage: AgyStepUsage): void {
	const prev = state.step;
	state.step = prev
		? {
			input: prev.input + usage.input,
			output: prev.output + usage.output,
			cacheRead: prev.cacheRead + usage.cacheRead,
			cacheWrite: prev.cacheWrite + usage.cacheWrite,
			contextTokens: usage.contextTokens,
			steps: prev.steps + usage.steps,
		}
		: { ...usage };
}

function ensureStarted(stream: AssistantMessageEventStream, blocks: BlockState): void {
	if (blocks.started) return;
	blocks.started = true;
	stream.push({ type: "start", partial: blocks.partial });
}

function closeText(stream: AssistantMessageEventStream, blocks: BlockState): void {
	if (blocks.textIdx === null) return;
	const index = blocks.textIdx;
	blocks.textIdx = null;
	const block = blocks.partial.content[index] as { type: "text"; text: string };
	stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: blocks.partial });
}

function closeThinking(stream: AssistantMessageEventStream, blocks: BlockState): void {
	if (blocks.thinkingIdx === null) return;
	const index = blocks.thinkingIdx;
	blocks.thinkingIdx = null;
	const block = blocks.partial.content[index] as { type: "thinking"; thinking: string };
	stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: blocks.partial });
}

function appendText(stream: AssistantMessageEventStream, blocks: BlockState, delta: string): void {
	if (blocks.textIdx === null) {
		closeThinking(stream, blocks);
		ensureStarted(stream, blocks);
		blocks.partial.content.push({ type: "text", text: "" });
		blocks.textIdx = blocks.partial.content.length - 1;
		stream.push({ type: "text_start", contentIndex: blocks.textIdx, partial: blocks.partial });
	}
	(blocks.partial.content[blocks.textIdx] as { text: string }).text += delta;
	stream.push({ type: "text_delta", contentIndex: blocks.textIdx, delta, partial: blocks.partial });
}

function appendThinking(stream: AssistantMessageEventStream, blocks: BlockState, delta: string): void {
	if (blocks.thinkingIdx === null) {
		closeText(stream, blocks);
		ensureStarted(stream, blocks);
		blocks.partial.content.push({ type: "thinking", thinking: "" });
		blocks.thinkingIdx = blocks.partial.content.length - 1;
		stream.push({ type: "thinking_start", contentIndex: blocks.thinkingIdx, partial: blocks.partial });
	}
	(blocks.partial.content[blocks.thinkingIdx] as { thinking: string }).thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: blocks.thinkingIdx, delta, partial: blocks.partial });
}

/** One of agy's own tool calls as its own line in the thinking block. */
function appendNativeLine(stream: AssistantMessageEventStream, blocks: BlockState, line: string): void {
	const open = blocks.thinkingIdx === null ? "" : (blocks.partial.content[blocks.thinkingIdx] as { thinking: string }).thinking;
	appendThinking(stream, blocks, `${open && !open.endsWith("\n") ? "\n" : ""}${line}\n`);
}

function finish(stream: AssistantMessageEventStream, blocks: BlockState, reason: "stop" | "error" | "aborted", message?: string): void {
	closeText(stream, blocks);
	closeThinking(stream, blocks);
	if (reason === "stop") {
		blocks.partial.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: blocks.partial });
	} else {
		blocks.partial.stopReason = reason;
		if (message) blocks.partial.errorMessage = message;
		stream.push({ type: "error", reason, error: blocks.partial });
	}
	stream.end();
}

function emitToolUse(stream: AssistantMessageEventStream, blocks: BlockState, activity: Extract<DriverActivity, { type: "bridge_call" }>): void {
	closeText(stream, blocks);
	closeThinking(stream, blocks);
	ensureStarted(stream, blocks);
	const toolCall = { type: "toolCall" as const, id: activity.callId, name: activity.name, arguments: activity.args as Record<string, JsonValue> };
	blocks.partial.content.push(toolCall);
	const contentIndex = blocks.partial.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial: blocks.partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: blocks.partial });
	blocks.partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: blocks.partial });
	stream.end();
}

async function consumeTurn(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	handle: TurnHandle,
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	onCompleted: (outcome: TurnOutcome, final: AssistantMessage) => void,
	onToolCall: (handle: TurnHandle, assistant: AssistantMessage, call: Extract<DriverActivity, { type: "bridge_call" }>) => void,
	meter: UsageMeter | undefined,
): Promise<void> {
	const usage = blocks.usage;
	for (;;) {
		const activity = await handle.next();
		if (!activity) break;
		await options?.onProviderStreamEvent?.(activity, model);
		if (activity.type === "text") appendText(stream, blocks, activity.delta);
		else if (activity.type === "thought" && activity.delta) appendThinking(stream, blocks, activity.delta);
		else if (activity.type === "native_tool") appendNativeLine(stream, blocks, nativeToolLine(activity));
		else if (activity.type === "step_usage") {
			addStepUsage(usage, activity.usage);
			meter?.addSteps(activity.usage);
			syncUsage(blocks.partial.usage, usage);
		} else if (activity.type === "usage") {
			usage.cumulative = activity.usage;
			syncUsage(blocks.partial.usage, usage);
		} else if (activity.type === "context_usage") {
			usage.occupancy = activity.contextUsage.used;
			syncUsage(blocks.partial.usage, usage);
		} else if (activity.type === "bridge_call") {
			emitToolUse(stream, blocks, activity);
			onToolCall(handle, blocks.partial, activity);
			return;
		}
		// tool_start/tool_done/tool_error only feed onProviderStreamEvent: agy
		// runs those tools itself, and native_tool renders the visible line.
	}
	// Occupancy reported during an EARLIER message of this turn is stale here
	// (tool results were added since), so outcome.contextUsage is not applied.
	const outcome = await handle.outcome;
	if (outcome.aborted) {
		// The session keeps what agy recorded before the cancel, including
		// this partial reply's turn: `continue` resumes it warm.
		onCompleted(outcome, blocks.partial);
		return finish(stream, blocks, "aborted", "Operation aborted");
	}
	if (outcome.status === "ERROR") return finish(stream, blocks, "error", outcome.error ?? "Antigravity turn failed");
	// agy reports an exhausted plan as ordinary model text; surface it as an
	// error so pi's retry/fallback logic and the status line see it.
	const exhausted = quotaExhaustion(outcome.response);
	if (exhausted) {
		meter?.setExhausted(exhausted);
		return finish(stream, blocks, "error", `Antigravity quota exhausted for ${model.id}.${exhausted.resetAt ? ` Resets at ${exhausted.resetAt}.` : ""}`);
	}
	// agy's capacity notice is not an answer either. "overloaded" makes it
	// match pi's retryable-provider-error pattern, so pi retries the turn.
	const capacity = agyCapacityNotice(outcome.response);
	if (capacity) return finish(stream, blocks, "error", `Antigravity servers are overloaded: ${capacity}`);
	// Every response character already streamed as a text delta (the driver
	// flushes its sanitizer before settling); only an empty message needs a block.
	if (blocks.partial.content.length === 0) appendText(stream, blocks, "");
	onCompleted(outcome, blocks.partial);
	finish(stream, blocks, "stop");
}

/** Per-extension ACP session continuity. `warm` is the latest checkpoint:
 *  cleared when a turn starts, set at each pi tool boundary of the turn and
 *  when it completes or is aborted after agy recorded its prompt. */
export interface AcpSessions {
	warm?: WarmSession;
	/** Historical warm checkpoints in chronological order, enabling `/tree`
	 *  branch switching and rewind to any earlier turn, and `continue` after
	 *  an aborted one. */
	checkpoints?: WarmSession[];
	/** The in-flight turn's latest tool-boundary checkpoint (memory only):
	 *  replaced by the turn's next checkpoint, kept if the turn fails. */
	step?: WarmSession;
	/** Directory holding `<sessionId>.db` stores for step-boundary forking on rewind. */
	conversationsDir?: () => string;
	/** Invoked when a turn settles (completed or aborted) and records a
	 *  `WarmSession` worth persisting. */
	onWarm?: (warm: WarmSession) => void;
	/** cwd of the in-flight turn, for continuations that complete it. */
	turnCwd?: string;
	/** In-flight toolUse turn: if agy ends its prompt while an escalated pi tool
	 *  is still running, its outcome records a warm checkpoint at `assistant`. */
	parked?: { handle: TurnHandle };
	/** agy sessions that must not be continued past a step: agy compacted them,
	 *  or realagy moved the conversation to a fresh session (sessionId → first
	 *  retired step; −1 = every step). */
	retired?: Map<string, number>;
	/** Set when pi compacted its transcript while an agy turn is still parked
	 *  on pi tools: the next continuation moves to a fresh session seeded with
	 *  the compacted transcript instead of feeding agy's full session. */
	rotateActive?: string;
	/** The in-flight turn's session overhead (see WarmSession.overhead), or
	 *  the estimate of its fresh seed until the first measurement. */
	turnOverhead?: number;
	turnSeedTokens?: number;
	/** Called when realagy leaves an agy session for a fresh one. */
	onRotate?: (event: { reason: string; sessionId: string; contextTokens?: number; midTurn: boolean }) => void;
}

/** Fresh-plan reasons that leave a usable-looking session behind on purpose. */
const ROTATION_REASONS = new Set(["agy-compacted", "agy-context-limit", "pi-context-smaller"]);

/** Share of the model's compaction limit (pi's contextWindow) from which a
 *  session is moved to a fresh one when pi's transcript is smaller. */
export const ROTATE_FLOOR = 0.5;
/** Share of the limit from which agy is about to compact: a smaller gain
 *  already justifies a fresh session. */
export const ROTATE_PRESSURE = 0.8;
/** agy's prompt, tool declarations, and tokenizer bias over pi's estimate,
 *  when no session measured them yet (~15k measured for agy 1.5.2's default
 *  agent on a fresh session). */
export const DEFAULT_SESSION_OVERHEAD = 15_000;
/** Cap on a calibrated overhead: a fresh turn's first measurement can include
 *  outputs of agy's own tools that ran before it. */
export const MAX_SESSION_OVERHEAD = 40_000;

/** Why a session holding `warm.contextTokens` should give way to a fresh one
 *  seeded with pi's transcript (`freshTokens` estimated), given the model's
 *  compaction limit; undefined to keep it.
 *  - agy-context-limit: agy would soon compact the session, and pi's
 *    transcript is at least 10% smaller.
 *  - pi-context-smaller: pi's transcript is much smaller than agy's session
 *    (a context extension such as realctx dropped old tool outputs, or pi
 *    compacted), so agy's context and usage reports would stay inflated. */
export function rotationReason(
	warm: Pick<WarmSession, "contextTokens" | "overhead">,
	fresh: () => number,
	limit: number,
): string | undefined {
	const used = warm.contextTokens;
	if (!used || !(limit > 0) || used < limit * ROTATE_FLOOR) return undefined;
	const projected = fresh() + Math.max(0, warm.overhead ?? DEFAULT_SESSION_OVERHEAD);
	const saved = used - projected;
	if (used >= limit * ROTATE_PRESSURE) return saved >= used * 0.1 ? "agy-context-limit" : undefined;
	return saved >= Math.max(used * 0.25, 16_000) ? "pi-context-smaller" : undefined;
}

/** Vetoes candidate sessions agy compacted or realagy retired, and those
 *  worth rotating. A checkpoint before the retired step survives only while
 *  it is well below the limit (a `/tree` rewind far back). */
function warmVeto(sessions: AcpSessions, limit: number): WarmVeto {
	const dir = sessions.conversationsDir?.();
	const compactions = new Map<string, number | null>();
	const compactedAt = (sessionId: string): number | null => {
		if (!compactions.has(sessionId)) {
			const dbPath = dir ? conversationDbPath(dir, sessionId) : undefined;
			compactions.set(sessionId, dbPath ? (firstCompactionIdx(dbPath) ?? null) : null);
		}
		return compactions.get(sessionId) ?? null;
	};
	const survives = (warm: WarmSession, from: number): boolean =>
		from >= 0 &&
		warm.maxStepIdx !== undefined &&
		warm.maxStepIdx < from &&
		warm.contextTokens !== undefined &&
		warm.contextTokens < limit * ROTATE_FLOOR;
	return (warm, fresh) => {
		const compacted = compactedAt(warm.sessionId);
		if (compacted !== null && !survives(warm, compacted)) return "agy-compacted";
		const retired = sessions.retired?.get(warm.sessionId);
		if (retired !== undefined && !survives(warm, retired)) return "retired";
		return rotationReason(warm, fresh, limit);
	};
}

function retire(sessions: AcpSessions, sessionId: string, from = -1): void {
	sessions.retired ??= new Map();
	const previous = sessions.retired.get(sessionId);
	sessions.retired.set(sessionId, previous === undefined ? from : Math.min(previous, from));
}

function selectTurnPlan(context: TranscriptContext, cwd: string, sessions: AcpSessions, limit: number): TurnPlan {
	const candidates: WarmSession[] = [];
	if (sessions.warm) candidates.push(sessions.warm);
	const history = sessions.checkpoints ?? [];
	for (let i = history.length - 1; i >= 0; i--) {
		const item = history[i];
		if (item && item !== sessions.warm) candidates.push(item);
	}
	const plan = planTurnFrom(context, cwd, candidates, warmVeto(sessions, limit));
	if (plan.kind !== "warm") return plan;
	return { ...plan, sessionId: resolveSessionAtStep(sessions.conversationsDir?.(), plan.sessionId, plan.maxStepIdx) };
}

/** Why the parked in-flight turn should not continue in its session, given
 *  pi's current transcript: agy compacted the session during the turn, pi
 *  compacted its transcript, or the session should rotate. */
function midTurnRotation(context: TranscriptContext, sessions: AcpSessions, limit: number): { reason: string; step: WarmSession } | undefined {
	const step = sessions.step;
	if (!step) return undefined;
	if (sessions.rotateActive) return { reason: sessions.rotateActive, step };
	const dir = sessions.conversationsDir?.();
	const dbPath = dir ? conversationDbPath(dir, step.sessionId) : undefined;
	const compacted = dbPath ? firstCompactionIdx(dbPath) : undefined;
	if (compacted !== null && compacted !== undefined && (step.maxStepIdx === undefined || compacted <= step.maxStepIdx)) {
		return { reason: "agy-compacted", step };
	}
	const reason = rotationReason(step, () => freshTokens(context), limit);
	return reason ? { reason, step } : undefined;
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	driver: TurnDriver;
	roundTrips: ToolRoundTrips;
	sessions?: AcpSessions;
	meter?: UsageMeter;
}

/** The context at which agy compacts this model's sessions: the entry's
 *  live or offline limit, and never more than pi's window for the model (a
 *  user's models.json may raise that window, but agy still compacts). */
function compactionLimit(model: Model<Api>, entry: AgyModelEntry | undefined): number {
	const agy = (entry?.limits ?? familyLimits(entry?.full ?? model.id)).contextWindow;
	return model.contextWindow > 0 ? Math.min(agy, model.contextWindow) : agy;
}

export function createStreamSimple(deps: StreamSimpleDeps) {
	const sessions = deps.sessions ?? {};
	/** Make `warm` the preferred checkpoint. A turn's tool-boundary checkpoint
	 *  is replaced by its next one, so the list grows by one per turn. */
	const remember = (warm: WarmSession, settled: boolean): void => {
		const step = sessions.step;
		const kept = (sessions.checkpoints ?? []).filter((checkpoint) => checkpoint !== step);
		sessions.checkpoints = [...kept, warm];
		sessions.warm = warm;
		sessions.step = settled ? undefined : warm;
		if (settled) sessions.onWarm?.(warm);
	};
	/** A settled turn's checkpoint: after it completed, or after an abort once
	 *  agy recorded its prompt (the session keeps everything up to the cancel). */
	const recordWarm = (targetContext: TranscriptContext, outcome: TurnOutcome, final: AssistantMessage): void => {
		if (outcome.status !== "OK" || !outcome.conversationId || sessions.turnCwd === undefined) return;
		if (outcome.aborted && outcome.promptDelivered !== true) return;
		remember(warmAfterTurn(targetContext, final, outcome.conversationId, sessions.turnCwd, outcome.maxStepIdx, measure(final)), true);
	};
	/** The context a checkpoint's session holds (the message's measured
	 *  usage) and the session's overhead, calibrated on its first measurement
	 *  against the estimate of the fresh transcript it was seeded with. */
	const measure = (message: AssistantMessage): { contextTokens?: number; overhead?: number } => {
		const contextTokens = message.usage.totalTokens > 0 ? message.usage.totalTokens : undefined;
		if (sessions.turnOverhead === undefined && contextTokens !== undefined && sessions.turnSeedTokens !== undefined) {
			sessions.turnOverhead = Math.min(MAX_SESSION_OVERHEAD, Math.max(0, contextTokens - sessions.turnSeedTokens));
			sessions.turnSeedTokens = undefined;
		}
		return { contextTokens, overhead: sessions.turnOverhead };
	};
	/** At a pi tool call the session holds the transcript up to its toolUse
	 *  message: an Esc during the tool still leaves a matching checkpoint. */
	const recordStep = (targetContext: TranscriptContext, call: Extract<DriverActivity, { type: "bridge_call" }>, assistant: AssistantMessage): void => {
		if (!call.sessionId || sessions.turnCwd === undefined) return;
		remember(warmAfterTurn(targetContext, assistant, call.sessionId, sessions.turnCwd, call.maxStepIdx, measure(assistant)), false);
	};
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const blocks: BlockState = { partial: newAssistant(model), textIdx: null, thinkingIdx: null, started: false, usage: {} };
		const onCompleted = (outcome: TurnOutcome, final: AssistantMessage): void => {
			recordWarm(context, outcome, final);
		};
		const onToolCall = (handle: TurnHandle, assistant: AssistantMessage, call: Extract<DriverActivity, { type: "bridge_call" }>): void => {
			recordStep(context, call, assistant);
			const parked = { handle };
			sessions.parked = parked;
			void handle.outcome.then((outcome) => {
				if (sessions.parked !== parked) return;
				sessions.parked = undefined;
				recordWarm(context, outcome, assistant);
			});
		};
		void (async () => {
			try {
				const results = context.messages.filter((message): message is Extract<Message, { role: "toolResult" }> =>
					message.role === "toolResult" && deps.roundTrips.isPending(message.toolCallId),
				);
				// The parked turn's session no longer matches what pi wants the
				// model to see: end it, and continue below in a fresh session that
				// gets pi's transcript, these tool results included.
				const entry = deps.entries.find((candidate) => candidate.id === model.id);
				const limit = compactionLimit(model, entry);
				const rotation = results.length > 0 && !options?.signal?.aborted && deps.driver.reentry()
					? midTurnRotation(context, sessions, limit)
					: undefined;
				sessions.rotateActive = undefined;
				if (rotation) {
					retire(sessions, rotation.step.sessionId);
					traceUsage("rotate", { reason: rotation.reason, sessionId: rotation.step.sessionId, contextTokens: rotation.step.contextTokens, midTurn: true });
					sessions.onRotate?.({ reason: rotation.reason, sessionId: rotation.step.sessionId, contextTokens: rotation.step.contextTokens, midTurn: true });
					// agy's pending MCP calls get an error, not pi's results: the
					// results reach the model through the fresh transcript instead.
					deps.roundTrips.failAll(`realagy moved to a fresh agy session (${rotation.reason})`, { includeEscalated: true });
					await deps.driver.cancelActive(`moving to a fresh session (${rotation.reason})`);
					sessions.parked = undefined;
				}
				for (let i = 0; !rotation && i < results.length; i++) {
					const result = results[i];
					const trailing = i === results.length - 1 ? context.messages.slice(context.messages.lastIndexOf(result) + 1) : [];
					const payload = formatToolResult(result, trailing);
					deps.roundTrips.resolve(result.toolCallId, payload.text, result.isError, payload.images);
				}
				const active = results.length > 0 && !rotation ? deps.driver.reentry() : null;
				if (active) {
					sessions.parked = undefined;
					await consumeTurn(stream, blocks, active, model, options, onCompleted, onToolCall, deps.meter);
					return;
				}
				if (options?.signal?.aborted) {
					// Esc: pi hands back its aborted tool results with the run's
					// signal already aborted. The turn they belonged to was cancelled
					// by that signal (or is orphaned and is cancelled here) and
					// records its checkpoint as it settles; nothing new starts.
					void deps.driver.cancelActive("aborted in pi");
					finish(stream, blocks, "aborted", "Operation aborted");
					return;
				}
				if (results.length > 0 && sessions.parked) {
					// Flush an already-settled parked handle's outcome handler
					// before planning the continuation turn.
					await Promise.resolve();
				}
				// A turn still parked on pi tool calls that this context does not
				// answer is orphaned (pi's loop ended after its toolUse message):
				// end it now instead of queueing behind it until its timeout. Its
				// parked handler records the checkpoint its session reached.
				await deps.driver.cancelActive("superseded by a new pi turn");
				sessions.parked = undefined;

				const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
				const plan = selectTurnPlan(context, cwd, sessions, limit);
				traceUsage("plan", plan.kind === "warm"
					? { kind: plan.kind, sessionId: plan.sessionId, deltaMessages: plan.deltaMessages, delta: plan.input.contextBlock ? "transcript" : "user", parts: plan.input.parts?.length ?? 0 }
					: { kind: plan.kind, reason: plan.reason, messages: context.messages.length, parts: plan.input.parts?.length ?? 0, freshTokens: plan.freshTokens });
				const previous = sessions.warm;
				if (plan.kind === "fresh" && previous && ROTATION_REASONS.has(plan.reason)) {
					retire(sessions, previous.sessionId);
					sessions.onRotate?.({ reason: plan.reason, sessionId: previous.sessionId, contextTokens: previous.contextTokens, midTurn: false });
				}
				// Unknown until this turn reaches a tool boundary or settles.
				sessions.warm = undefined;
				sessions.step = undefined;
				sessions.turnCwd = cwd;
				sessions.turnOverhead = plan.kind === "warm" ? plan.warm.overhead : undefined;
				sessions.turnSeedTokens = plan.kind === "fresh" ? plan.freshTokens : undefined;
				const request: DriverTurnRequest = {
					cwd,
					model: entry?.full ?? model.id,
					effort: entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined,
					mode: "default",
					// agy's permission requests for its native tools are
					// approved; the tool policy steers the model to pi's tools,
					// which run under pi's permission policy.
					skipPermissions: true,
					conversationId: plan.kind === "warm" ? plan.sessionId : null,
					prompt: plan.input.prompt,
					images: plan.input.images,
					...(plan.input.contextBlock ? { contextBlock: plan.input.contextBlock } : {}),
					...(plan.input.parts ? { parts: plan.input.parts } : {}),
					...(plan.kind === "warm" ? { fallback: plan.fallback } : {}),
					signal: options?.signal,
					inactivityMin: 5,
				};
				const replacement = await options?.onPayload?.(request, model);
				const handle = await deps.driver.run((replacement === undefined ? request : replacement) as DriverTurnRequest);
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				await consumeTurn(stream, blocks, handle, model, options, onCompleted, onToolCall, deps.meter);
			} catch (error) {
				finish(stream, blocks, options?.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
			}
		})();
		return stream;
	};
}
