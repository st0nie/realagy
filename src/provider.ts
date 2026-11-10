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
import type { AgyStepUsage, AgyUsage, DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "./driver-types.js";
import { toAgyEffort, type AgyModelEntry } from "./models.js";
import { nativeToolLine } from "./native-tools.js";
import { agyCapacityNotice } from "./acp/events.js";
import type { BridgeResult } from "./mcp-server.js";
import {
	formatToolResult,
	planTurn,
	UNLOCKED_REPLAY_BUDGET_BYTES,
	warmAfterTurn,
	type TurnPlan,
	type WarmSession,
} from "./transcript.js";
import { traceUsage } from "./usage-trace.js";
import { quotaExhaustion, type UsageMeter } from "./quota.js";
import {
	formatParallelResults,
	PARALLEL_TOOL_NAME,
	parallelErrorResult,
	parseParallelCalls,
} from "./parallel.js";

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
	/** True when a Pi tool explicitly declares the metadata-named argument. */
	preserveToolSummary?: (name: string) => boolean;
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
	kickOnSettle: boolean;
	batchId?: string;
	onEscalated?: () => void;
}

interface ParkOptions {
	escalate?: boolean;
	timeout?: boolean;
	kickOnSettle?: boolean;
	batchId?: string;
	onEscalated?: () => void;
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

// toolSummary is bridge presentation metadata unless explicitly declared by the tool.
function bridgeToolArguments(args: Record<string, unknown>, preserve: boolean): Record<string, unknown> {
	if (preserve || !Object.hasOwn(args, "toolSummary")) return args;
	const { toolSummary: _toolSummary, ...nativeArgs } = args;
	return nativeArgs;
}
export class ToolRoundTrips {
	#pending = new Map<string, PendingCall>();
	#polls = new Map<string, PollResult>();
	#escalateAfterMs: number;
	#pollWaitMs: number;

	constructor(private readonly driver: TurnDriver, private readonly opts: ToolRoundTripsOptions = {}) {
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
		if (name === PARALLEL_TOOL_NAME) return this.#parallel(callId, args, signal, handle);
		const result = this.#park(callId, name, signal, {});
		handle.pushExternal({ type: "bridge_call", callId, name, args: bridgeToolArguments(args, this.opts.preserveToolSummary?.(name) ?? false) });
		return result;
	};

	#park(callId: string, name: string, signal: AbortSignal, options: ParkOptions): Promise<BridgeResult> {
		if (signal.aborted) return Promise.reject(new Error("ACP disconnected before the pi tool result arrived"));
		return new Promise<BridgeResult>((resolve, reject) => {
			const pending: PendingCall = {
				name,
				resolve,
				reject,
				escalated: false,
				signal,
				kickOnSettle: options.kickOnSettle ?? true,
				batchId: options.batchId,
				onEscalated: options.onEscalated,
				onAbort: () => this.#fail(callId, "ACP disconnected before the pi tool result arrived"),
				timer: options.timeout === false ? undefined : setTimeout(() => this.#fail(callId, "pi tool round-trip timed out"), PARK_TIMEOUT_MS),
			};
			if (options.escalate !== false && this.#escalateAfterMs > 0) {
				pending.escalateTimer = setTimeout(() => {
					const current = this.#pending.get(callId);
					if (!current) return;
					current.escalated = true;
					if (current.timer) clearTimeout(current.timer);
					current.timer = undefined;
					// The initial HTTP request is about to finish with STILL RUNNING;
					// its socket closing afterwards must not abort the running pi tool.
					current.signal.removeEventListener("abort", current.onAbort);
					current.onEscalated?.();
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
		});
	}

	#parallel(callId: string, args: Record<string, unknown>, signal: AbortSignal, handle: TurnHandle): Promise<BridgeResult> {
		const parsed = parseParallelCalls(args, [POLL_TOOL_NAME]);
		if (!parsed.ok) return Promise.resolve(parallelErrorResult(parsed.error));
		if (signal.aborted) return Promise.reject(new Error("ACP disconnected before the pi tool result arrived"));

		const innerAbort = new AbortController();
		const forwardAbort = () => innerAbort.abort();
		const cleanup = () => signal.removeEventListener("abort", forwardAbort);
		signal.addEventListener("abort", forwardAbort, { once: true });
		const calls = parsed.calls.map((call, index) => ({ ...call, callId: `${callId}:${index + 1}` }));
		const innerPromises = calls.map((call) => this.#park(call.callId, call.name, innerAbort.signal, {
			escalate: false,
			timeout: false,
			kickOnSettle: false,
			batchId: callId,
		}));
		const outer = this.#park(callId, PARALLEL_TOOL_NAME, signal, { onEscalated: cleanup });
		void outer.catch(() => {
			cleanup();
			innerAbort.abort();
		});
		void Promise.all(innerPromises).then((results) => {
			const aggregated = formatParallelResults(calls, results);
			this.resolve(callId, aggregated.text, aggregated.isError, aggregated.images);
			cleanup();
		}).catch((error: unknown) => {
			cleanup();
			innerAbort.abort();
			this.#fail(callId, error instanceof Error ? error.message : String(error));
		});
		handle.pushExternal({
			type: "bridge_call",
			callId,
			name: PARALLEL_TOOL_NAME,
			args,
			calls: calls.map((call) => ({ callId: call.callId, name: call.name, args: bridgeToolArguments(call.arguments, this.opts.preserveToolSummary?.(call.name) ?? false) })),
		});
		return outer;
	}

	/** A native Pi parallel batch must not re-enter ACP with partial results. */
	hasPendingBatchCalls(): boolean {
		for (const pending of this.#pending.values()) if (pending.batchId !== undefined) return true;
		return false;
	}

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
		if (pending.kickOnSettle) this.driver.kickIdle();
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
		if (pending.kickOnSettle) this.driver.kickIdle();
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
    // Pi reads input + cacheRead of a "stop" message as one call's prompt
    // (silent-overflow check). Summed multi-call splits can exceed the context
    // window, so scale them down to the measured context, keeping the hit ratio.
    const split = target.input + target.output + target.cacheRead + target.cacheWrite;
    if (split > target.totalTokens) {
        const scale = target.totalTokens / split;
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) target[key] = Math.floor(target[key] * scale);
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
	const calls = activity.calls ?? [{ callId: activity.callId, name: activity.name, args: activity.args }];
	for (const call of calls) {
		const toolCall = { type: "toolCall" as const, id: call.callId, name: call.name, arguments: call.args as Record<string, JsonValue> };
		blocks.partial.content.push(toolCall);
		const contentIndex = blocks.partial.content.length - 1;
		stream.push({ type: "toolcall_start", contentIndex, partial: blocks.partial });
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: blocks.partial });
	}
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

/** Per-extension ACP session continuity. Only the latest exact-prefix session
 *  is reusable; tree navigation and compaction clear it before the next turn. */
export interface AcpSessions {
	warm?: WarmSession;
	/** Former checkpoints awaiting a successful persisted replacement. */
	retirementCandidates?: Set<string>;
	/** Invoked when a turn settles and records a WarmSession worth persisting. */
	onWarm?: (warm: WarmSession, canRetire: boolean) => void;
	/** cwd of the in-flight turn, for continuations that complete it. */
	turnCwd?: string;
	/** In-flight toolUse turn whose escalated pi tool is still running. */
	parked?: { handle: TurnHandle };
}


function selectTurnPlan(context: TranscriptContext, cwd: string, sessions: AcpSessions, replayBudgetBytes: number): TurnPlan {
	// Only the current session is a cache candidate. Tree navigation clears it;
	// older native snapshots are never forked or treated as authoritative.
	return planTurn(context, cwd, sessions.warm, replayBudgetBytes);
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	driver: TurnDriver;
	roundTrips: ToolRoundTrips;
	sessions?: AcpSessions;
	meter?: UsageMeter;
	/** Live replay budget: 2.2 MB unlocked, 160 KB with native context gates. */
	replayBudgetBytes?: () => number;
}

export function createStreamSimple(deps: StreamSimpleDeps) {
	const sessions = deps.sessions ?? {};
	const remember = (warm: WarmSession, settled: boolean, canRetire = false): void => {
		sessions.warm = warm;
		if (settled) sessions.onWarm?.(warm, canRetire);
	};
	/** Record a settled turn after completion, or after an abort once agy
	 *  recorded its prompt. A failed turn leaves no reusable native cache. */
	const recordWarm = (targetContext: TranscriptContext, outcome: TurnOutcome, final: AssistantMessage): void => {
		if (outcome.status !== "OK" || !outcome.conversationId || sessions.turnCwd === undefined) return;
		if (outcome.aborted && outcome.promptDelivered !== true) return;
		remember(warmAfterTurn(targetContext, final, outcome.conversationId, sessions.turnCwd), true, !outcome.aborted && !quotaExhaustion(outcome.response) && !agyCapacityNotice(outcome.response));
	};
	/** At a pi tool call the native session holds the transcript through toolUse;
	 *  retain that exact prefix in memory if Esc interrupts the running tool. */
	const recordStep = (targetContext: TranscriptContext, call: Extract<DriverActivity, { type: "bridge_call" }>, assistant: AssistantMessage): void => {
		if (!call.sessionId || sessions.turnCwd === undefined) return;
		remember(warmAfterTurn(targetContext, assistant, call.sessionId, sessions.turnCwd), false);
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
				const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
				const previousSession = sessions.warm?.sessionId;
				if (previousSession) (sessions.retirementCandidates ??= new Set()).add(previousSession);
				const plan = selectTurnPlan(context, cwd, sessions, deps.replayBudgetBytes?.() ?? UNLOCKED_REPLAY_BUDGET_BYTES);
				// Settle completed Pi calls before cancelling the old model turn.
				// Otherwise its generic abort handler can reject an already-completed
				// MCP request before the native continuation consumes its result.
				for (const result of results) {
					const trailing = plan.kind === "warm" && result === results.at(-1)
						? context.messages.slice(context.messages.lastIndexOf(result) + 1)
						: [];
					const payload = formatToolResult(result, trailing);
					deps.roundTrips.resolve(result.toolCallId, payload.text, result.isError, payload.images);
				}
				// Exact-prefix reuse can continue the parked native turn. A fresh
				// replay already contains these tool results, so the old turn is cancelled below.
			const active = results.length > 0 && plan.kind === "warm" && !options?.signal?.aborted && !deps.roundTrips.hasPendingBatchCalls() ? deps.driver.reentry() : null;
				if (active) {
					sessions.parked = undefined;
					await consumeTurn(stream, blocks, active, model, options, onCompleted, onToolCall, deps.meter);
					return;
				}
				if (options?.signal?.aborted) {
					// Esc: pi hands back its aborted tool results with the run's
					// signal already aborted. The turn they belonged to was cancelled
					// by that signal (or is orphaned and is cancelled here) and
					// records its warm snapshot as it settles; nothing new starts.
					void deps.driver.cancelActive("aborted in pi");
					finish(stream, blocks, "aborted", "Operation aborted");
					return;
				}
				if (results.length > 0 && deps.roundTrips.hasPendingBatchCalls()) {
					const reason = "parallel tool results are incomplete; the batch was aborted";
					deps.roundTrips.failAll(reason, { includeEscalated: true });
					await deps.driver.cancelActive(reason);
					finish(stream, blocks, "error", reason);
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
				// parked handler records the warm snapshot its session reached.
				await deps.driver.cancelActive("superseded by a new pi turn");
				sessions.parked = undefined;

				const entry = deps.entries.find((candidate) => candidate.id === model.id);
				traceUsage("plan", plan.kind === "warm"
					? { kind: plan.kind, sessionId: plan.sessionId, deltaMessages: plan.deltaMessages, delta: plan.input.contextBlock ? "transcript" : "user", parts: plan.input.parts?.length ?? 0 }
					: { kind: plan.kind, reason: plan.reason, messages: context.messages.length, replayBytes: Buffer.byteLength(plan.input.prompt, "utf8") });
				sessions.warm = undefined;
				sessions.turnCwd = cwd;
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
