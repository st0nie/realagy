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
import { resolveSessionAtStep } from "./acp/step-usage.js";
import type { AgyStepUsage, AgyUsage, DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "./driver-types.js";
import { toAgyEffort, type AgyModelEntry } from "./models.js";
import { nativeToolLine } from "./native-tools.js";
import { agyCapacityNotice } from "./acp/events.js";
import type { BridgeResult } from "./mcp-server.js";
import {
	formatToolResult,
	planTurnFrom,
	warmAfterTurn,
	type TurnPlan,
	type WarmSession,
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
	onToolCall: (handle: TurnHandle, assistant: AssistantMessage) => void,
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
			onToolCall(handle, blocks.partial);
			return;
		}
		// tool_start/tool_done/tool_error only feed onProviderStreamEvent: agy
		// runs those tools itself, and native_tool renders the visible line.
	}
	// Occupancy reported during an EARLIER message of this turn is stale here
	// (tool results were added since), so outcome.contextUsage is not applied.
	const outcome = await handle.outcome;
	if (outcome.aborted) return finish(stream, blocks, "aborted", "Operation aborted");
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

/** Per-extension ACP session continuity. `warm` is set only after a turn
 *  completes cleanly, and cleared while a turn runs. */
export interface AcpSessions {
	warm?: WarmSession;
	/** Historical warm checkpoints in chronological order, enabling `/tree`
	 *  branch switching and rewind to any earlier completed turn. */
	checkpoints?: WarmSession[];
	/** Directory holding `<sessionId>.db` stores for step-boundary forking on rewind. */
	conversationsDir?: () => string;
	/** Invoked when a turn completes and records a new `WarmSession`. */
	onWarm?: (warm: WarmSession) => void;
	/** cwd of the in-flight turn, for continuations that complete it. */
	turnCwd?: string;
	/** In-flight toolUse turn: if agy ends its prompt while an escalated pi tool
	 *  is still running, its outcome records a warm checkpoint at `assistant`. */
	parked?: { handle: TurnHandle };
}
function selectTurnPlan(context: TranscriptContext, cwd: string, sessions: AcpSessions): TurnPlan {
	const candidates: WarmSession[] = [];
	if (sessions.warm) candidates.push(sessions.warm);
	const history = sessions.checkpoints ?? [];
	for (let i = history.length - 1; i >= 0; i--) {
		const item = history[i];
		if (item && item !== sessions.warm) candidates.push(item);
	}
	const plan = planTurnFrom(context, cwd, candidates);
	if (plan.kind !== "warm") return plan;
	return { ...plan, sessionId: resolveSessionAtStep(sessions.conversationsDir?.(), plan.sessionId, plan.maxStepIdx) };
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	driver: TurnDriver;
	roundTrips: ToolRoundTrips;
	sessions?: AcpSessions;
	meter?: UsageMeter;
}

export function createStreamSimple(deps: StreamSimpleDeps) {
	const sessions = deps.sessions ?? {};
	const recordWarm = (targetContext: TranscriptContext, outcome: TurnOutcome, final: AssistantMessage): void => {
		if (outcome.status !== "OK" || outcome.aborted || !outcome.conversationId || sessions.turnCwd === undefined) return;
		const warm = warmAfterTurn(targetContext, final, outcome.conversationId, sessions.turnCwd, outcome.maxStepIdx);
		sessions.warm = warm;
		sessions.checkpoints = [...(sessions.checkpoints ?? []), warm];
		sessions.onWarm?.(warm);
	};
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const blocks: BlockState = { partial: newAssistant(model), textIdx: null, thinkingIdx: null, started: false, usage: {} };
		const onCompleted = (outcome: TurnOutcome, final: AssistantMessage): void => {
			recordWarm(context, outcome, final);
		};
		const onToolCall = (handle: TurnHandle, assistant: AssistantMessage): void => {
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
				for (let i = 0; i < results.length; i++) {
					const result = results[i];
					const trailing = i === results.length - 1 ? context.messages.slice(context.messages.lastIndexOf(result) + 1) : [];
					const payload = formatToolResult(result, trailing);
					deps.roundTrips.resolve(result.toolCallId, payload.text, result.isError, payload.images);
				}
				const active = results.length > 0 ? deps.driver.reentry() : null;
				if (active) {
					sessions.parked = undefined;
					await consumeTurn(stream, blocks, active, model, options, onCompleted, onToolCall, deps.meter);
					return;
				}
				if (results.length > 0 && sessions.parked) {
					// Flush an already-settled parked handle's outcome handler
					// before planning the continuation turn.
					await Promise.resolve();
				}
				sessions.parked = undefined;
				// A turn still parked on pi tool calls that this context does not
				// answer is orphaned (pi's loop ended after its toolUse message):
				// end it now instead of queueing behind it until its timeout.
				await deps.driver.cancelActive("superseded by a new pi turn");

				const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
				const entry = deps.entries.find((candidate) => candidate.id === model.id);
				const plan = selectTurnPlan(context, cwd, sessions);
				traceUsage("plan", plan.kind === "warm"
					? { kind: plan.kind, sessionId: plan.sessionId, deltaMessages: plan.deltaMessages, delta: plan.input.contextBlock ? "transcript" : "user" }
					: { kind: plan.kind, reason: plan.reason, messages: context.messages.length });
				// Unknown until this turn completes cleanly.
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
