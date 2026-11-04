// Minimal ACP provider. Antigravity produces text/thoughts and requests tools;
// pi owns the transcript, tool execution, permissions, and rendering.

import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
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
import type { AgyUsage, DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle } from "./driver-types.js";
import { toAgyEffort, type AgyModelEntry } from "./models.js";
import type { BridgeResult } from "./mcp-server.js";

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
			pending.resolve({
				content: [...images.map((image) => ({ type: "image" as const, ...image })), { type: "text" as const, text: text || "(no output)" }],
				isError,
			});
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
		return {
			content: [...result.images.map((image) => ({ type: "image" as const, ...image })), { type: "text" as const, text: result.text || "(no output)" }],
			isError: result.isError,
		};
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
}

function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function newAssistant(model: Model<Api>): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (!block || typeof block !== "object") return [];
		const value = block as { type?: string; text?: string };
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("\n");
}

function resultImages(message: Message): Array<{ data: string; mimeType: string }> {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : []);
}

/** A fresh user turn starts a fresh ACP session, making pi's transcript the
 * single source of truth across compaction, retries, and provider switches. */
function transcriptForAcp(context: TranscriptContext): { text: string; images: Array<{ data: string; mimeType: string }> } {
	const parts: string[] = [];
	const images: Array<{ data: string; mimeType: string }> = [];
	const system = getCurrentSystemPrompt(context.messages);
	if (system) parts.push(`<pi-system>\n${system}\n</pi-system>`);
	for (const message of context.messages) {
		if (message.role === "system") continue;
		if (message.role === "user" || message.role === "toolResult") {
			const text = contentText(message.content);
			const blocks = Array.isArray(message.content) ? message.content : [];
			const references: string[] = [];
			for (const block of blocks) {
				if (block.type !== "image") continue;
				images.push({ data: block.data, mimeType: block.mimeType });
				references.push(`[Attached image ${images.length}]`);
			}
			const content = [text, ...references].filter(Boolean).join("\n");
			if (message.role === "user") {
				if (content) parts.push(`<user>\n${content}\n</user>`);
			} else {
				parts.push(`<pi-tool-result name=${JSON.stringify(message.toolName)} id=${JSON.stringify(message.toolCallId)} error=${message.isError}>\n${content}\n</pi-tool-result>`);
			}
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text" && block.text) parts.push(`<assistant>\n${block.text}\n</assistant>`);
				if (block.type === "toolCall") parts.push(`<assistant-tool-call name=${JSON.stringify(block.name)} id=${JSON.stringify(block.id)}>\n${JSON.stringify(block.arguments)}\n</assistant-tool-call>`);
			}
		}
	}
	return { text: parts.join("\n\n"), images };
}

function applyUsage(target: Usage, usage: AgyUsage): void {
	target.input = usage.input_tokens ?? 0;
	target.output = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
	target.cacheRead = usage.cache_read_tokens ?? 0;
	target.totalTokens = usage.total_tokens ?? target.input + target.output + target.cacheRead;
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
): Promise<void> {
	for (;;) {
		const activity = await handle.next();
		if (!activity) break;
		await options?.onProviderStreamEvent?.(activity, model);
		if (activity.type === "text") appendText(stream, blocks, activity.delta);
		else if (activity.type === "thought" && activity.delta) appendThinking(stream, blocks, activity.delta);
		else if (activity.type === "usage") applyUsage(blocks.partial.usage, activity.usage);
		else if (activity.type === "bridge_call") {
			emitToolUse(stream, blocks, activity);
			return;
		}
		// ACP native tool frames are deliberately ignored: native tools are
		// disabled and the pi-bridge MCP call already has a genuine pi card.
	}
	const outcome = await handle.outcome;
	if (outcome.aborted) return finish(stream, blocks, "aborted", "Operation aborted");
	if (outcome.status === "ERROR") return finish(stream, blocks, "error", outcome.error ?? "Antigravity turn failed");
	if (blocks.textIdx === null && outcome.response) appendText(stream, blocks, outcome.response);
	if (blocks.textIdx === null && blocks.thinkingIdx === null) appendText(stream, blocks, "");
	finish(stream, blocks, "stop");
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	driver: TurnDriver;
	roundTrips: ToolRoundTrips;
}

export function createStreamSimple(deps: StreamSimpleDeps) {
	return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const blocks: BlockState = { partial: newAssistant(model), textIdx: null, thinkingIdx: null, started: false };
		void (async () => {
			try {
				const results = context.messages.filter((message): message is Extract<Message, { role: "toolResult" }> =>
					message.role === "toolResult" && deps.roundTrips.pendingIds.includes(message.toolCallId),
				);
				for (const result of results) deps.roundTrips.resolve(result.toolCallId, contentText(result.content), result.isError, resultImages(result));
				const active = results.length > 0 ? deps.driver.reentry() : null;
				if (active) {
					await consumeTurn(stream, blocks, active, model, options);
					return;
				}

				const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
				const entry = deps.entries.find((candidate) => candidate.id === model.id);
				const transcript = transcriptForAcp(context);
				const request: DriverTurnRequest = {
					cwd,
					model: entry?.full ?? model.id,
					effort: entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined,
					mode: "accept-edits",
					// ACP auto-approves only its MCP transport. The actual operation is
					// executed by pi, where pi's normal permission policy applies.
					skipPermissions: true,
					conversationId: null,
					prompt: "Continue the task from the pi transcript, including any tool results or discarded previous attempt. Attached images are numbered in transcript order.",
					images: transcript.images,
					contextBlock: { uri: "pi://transcript", text: transcript.text },
					signal: options?.signal,
					timeoutMin: 0,
					inactivityMin: 5,
				};
				const replacement = await options?.onPayload?.(request, model);
				const handle = await deps.driver.run((replacement === undefined ? request : replacement) as DriverTurnRequest);
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				await consumeTurn(stream, blocks, handle, model, options);
			} catch (error) {
				finish(stream, blocks, options?.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
			}
		})();
		return stream;
	};
}
