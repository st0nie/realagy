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
import type { BridgeResult } from "./mcp-server.js";
import { fingerprint, formatToolResult, persistentMessages, planTurn, warmAfterTurn, type WarmSession } from "./transcript.js";
import { traceUsage } from "./usage-trace.js";
import { quotaExhaustion, type UsageMeter } from "./quota.js";

export const POLL_TOOL_NAME = "bridge_poll_result";
const PARK_TIMEOUT_MS = 8 * 60_000;
const ESCALATE_AFTER_MS = 20_000;
const ESCALATED_TTL_MS = 30 * 60_000;

interface PendingCall {
	name: string;
	resolve: (result: BridgeResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
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

export class ToolRoundTrips {
	#pending = new Map<string, PendingCall>();
	#polls = new Map<string, PollResult>();

	constructor(private readonly driver: TurnDriver) {}

	get pendingIds(): string[] {
		return [...this.#pending.keys()];
	}

	onToolCall = (callId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeResult> => {
		if (name === POLL_TOOL_NAME) return Promise.resolve(this.#poll(typeof args.callId === "string" ? args.callId : ""));
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
			pending.escalateTimer = setTimeout(() => {
				const current = this.#pending.get(callId);
				if (!current) return;
				current.escalated = true;
				clearTimeout(current.timer);
				current.timer = setTimeout(() => this.#fail(callId, "escalated pi tool timed out"), ESCALATED_TTL_MS);
				this.#polls.set(callId, { name, state: "running", images: [], expires: Date.now() + ESCALATED_TTL_MS });
				resolve({
					content: [{ type: "text", text: `STILL RUNNING\nThe pi tool is still executing. Call ${POLL_TOOL_NAME} with callId ${JSON.stringify(callId)} until it returns the result.` }],
				});
			}, ESCALATE_AFTER_MS);
			this.#pending.set(callId, pending);
			signal.addEventListener("abort", pending.onAbort, { once: true });
			handle.pushExternal({ type: "bridge_call", callId, name, args });
		});
	};

	resolve(callId: string, text: string, isError: boolean, images: Array<{ data: string; mimeType: string }> = []): boolean {
		const pending = this.#pending.get(callId);
		if (!pending) return false;
		this.#pending.delete(callId);
		clearTimeout(pending.timer);
		if (pending.escalateTimer) clearTimeout(pending.escalateTimer);
		pending.signal.removeEventListener("abort", pending.onAbort);
		if (pending.escalated) {
			this.#polls.set(callId, { name: pending.name, state: "done", text, isError, images, expires: Date.now() + ESCALATED_TTL_MS });
		} else {
			pending.resolve(bridgeResult(text, isError, images));
		}
		this.driver.kickIdle();
		return true;
	}

	failAll(reason: string): void {
		for (const id of [...this.#pending.keys()]) {
			if (!this.#pending.get(id)?.escalated) this.#fail(id, reason);
		}
	}

	#fail(callId: string, reason: string): void {
		const pending = this.#pending.get(callId);
		if (!pending) return;
		this.#pending.delete(callId);
		clearTimeout(pending.timer);
		if (pending.escalateTimer) clearTimeout(pending.escalateTimer);
		pending.signal.removeEventListener("abort", pending.onAbort);
		if (pending.escalated) {
			this.#polls.set(callId, { name: pending.name, state: "done", text: `Error: ${reason}`, isError: true, images: [], expires: Date.now() + ESCALATED_TTL_MS });
		} else {
			pending.reject(new Error(reason));
		}
		this.driver.kickIdle();
	}

	#poll(callId: string): BridgeResult {
		const result = this.#polls.get(callId);
		if (!result) return { content: [{ type: "text", text: `Unknown or non-escalated callId: ${callId || "(missing)"}` }], isError: true };
		if (result.state === "running") return { content: [{ type: "text", text: `STILL RUNNING\nCall ${POLL_TOOL_NAME} again with the same callId.` }] };
		return bridgeResult(result.text ?? "", result.isError ?? false, result.images);
	}

	#prunePolls(): void {
		const now = Date.now();
		for (const [id, result] of this.#polls) if (result.expires <= now) this.#polls.delete(id);
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
	/** Turn-cumulative PromptResponse.usage (or a client estimate). */
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
			// ACP inputTokens includes cachedReadTokens; pi counts them separately.
			target.input = Math.max(0, (state.cumulative.input_tokens ?? 0) - (state.cumulative.cache_read_tokens ?? 0));
			target.output = (state.cumulative.output_tokens ?? 0) + (state.cumulative.thinking_tokens ?? 0);
			target.cacheRead = state.cumulative.cache_read_tokens ?? 0;
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
	meter: UsageMeter | undefined,
): Promise<void> {
	const usage = blocks.usage;
	for (;;) {
		const activity = await handle.next();
		if (!activity) break;
		await options?.onProviderStreamEvent?.(activity, model);
		if (activity.type === "text") appendText(stream, blocks, activity.delta);
		else if (activity.type === "thought" && activity.delta) appendThinking(stream, blocks, activity.delta);
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
			return;
		}
		// agy's native tool frames need no pi tool card: agy runs them itself.
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
	if (blocks.textIdx === null && outcome.response) appendText(stream, blocks, outcome.response);
	if (blocks.textIdx === null && blocks.thinkingIdx === null) appendText(stream, blocks, "");
	onCompleted(outcome, blocks.partial);
	finish(stream, blocks, "stop");
}

/** Per-extension ACP session continuity. `warm` is set only after a turn
 *  completes cleanly, and cleared while a turn runs. */
export interface AcpSessions {
	warm?: WarmSession;
	/** cwd of the in-flight turn, for continuations that complete it. */
	turnCwd?: string;
	/** Verified message prefix of the in-flight turn. Cleared if a context
	 *  manager (e.g. realctx) rewrites or compacts earlier messages mid-turn. */
	turnPrefix?: { count: number; hash: string };
}

function prefixSnapshot(messages: Message[]): { count: number; hash: string } {
	const persistent = persistentMessages(messages);
	return { count: persistent.length, hash: fingerprint(persistent) };
}

function prefixIntact(messages: Message[], prefix: { count: number; hash: string } | undefined): boolean {
	if (!prefix) return false;
	const persistent = persistentMessages(messages);
	if (persistent.length < prefix.count) return false;
	return fingerprint(persistent.slice(0, prefix.count)) === prefix.hash;
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
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const blocks: BlockState = { partial: newAssistant(model), textIdx: null, thinkingIdx: null, started: false, usage: {} };
		const onCompleted = (outcome: TurnOutcome, final: AssistantMessage): void => {
			if (outcome.status !== "OK" || !outcome.conversationId || sessions.turnCwd === undefined) return;
			if (!prefixIntact(context.messages, sessions.turnPrefix)) return;
			sessions.warm = warmAfterTurn(context, final, outcome.conversationId, sessions.turnCwd);
		};
		void (async () => {
			try {
				const results = context.messages.filter((message): message is Extract<Message, { role: "toolResult" }> =>
					message.role === "toolResult" && deps.roundTrips.pendingIds.includes(message.toolCallId),
				);
				for (let i = 0; i < results.length; i++) {
					const result = results[i];
					const trailing = i === results.length - 1 ? context.messages.slice(context.messages.lastIndexOf(result) + 1) : [];
					const payload = formatToolResult(result, trailing);
					deps.roundTrips.resolve(result.toolCallId, payload.text, result.isError, payload.images);
				}
				const active = results.length > 0 ? deps.driver.reentry() : null;
				if (active) {
					sessions.turnPrefix = prefixIntact(context.messages, sessions.turnPrefix)
						? prefixSnapshot(context.messages)
						: undefined;
					await consumeTurn(stream, blocks, active, model, options, onCompleted, deps.meter);
					return;
				}

				const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
				const entry = deps.entries.find((candidate) => candidate.id === model.id);
				const plan = planTurn(context, cwd, sessions.warm);
				traceUsage("plan", plan.kind === "warm"
					? { kind: plan.kind, sessionId: plan.sessionId, deltaMessages: plan.deltaMessages, delta: plan.input.contextBlock ? "transcript" : "user" }
					: { kind: plan.kind, reason: plan.reason, messages: context.messages.length });
				// Unknown until this turn completes cleanly.
				sessions.warm = undefined;
				sessions.turnCwd = cwd;
				sessions.turnPrefix = prefixSnapshot(context.messages);
				const request: DriverTurnRequest = {
					cwd,
					model: entry?.full ?? model.id,
					effort: entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined,
					mode: "accept-edits",
					// ACP transport and its native viewer are auto-approved. Original
					// pi tool execution still goes through pi's permission policy.
					skipPermissions: true,
					conversationId: plan.kind === "warm" ? plan.sessionId : null,
					prompt: plan.input.prompt,
					images: plan.input.images,
					...(plan.input.contextBlock ? { contextBlock: plan.input.contextBlock } : {}),
					...(plan.kind === "warm" ? { fallback: plan.fallback } : {}),
					signal: options?.signal,
					timeoutMin: 0,
					inactivityMin: 5,
				};
				const replacement = await options?.onPayload?.(request, model);
				const handle = await deps.driver.run((replacement === undefined ? request : replacement) as DriverTurnRequest);
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				await consumeTurn(stream, blocks, handle, model, options, onCompleted, deps.meter);
			} catch (error) {
				finish(stream, blocks, options?.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
			}
		})();
		return stream;
	};
}
