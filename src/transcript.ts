// Pi transcript → ACP prompt input, with warm ACP session reuse.
//
// A completed turn leaves the ACP session holding the same conversation pi
// recorded: the input it was sent, plus the text, tool calls, and tool results
// it produced natively. The next user turn reuses that session and sends only
// the messages pi added since, so the server's native history stays a stable
// prompt prefix (provider prompt caching) instead of being re-serialized.
// Any divergence (compaction, branch navigation, edits, cwd or tool-set
// change, a failed or aborted turn) falls back to a fresh session that receives
// the whole transcript, keeping pi the source of truth.

import { createHash } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Message, type TranscriptContext } from "@earendil-works/pi-ai";

export type AcpImage = { data: string; mimeType: string };

export interface AcpInput {
	prompt: string;
	images: AcpImage[];
	contextBlock?: { uri: string; text: string };
}

/** What a reusable ACP session is known to hold. */
export interface WarmSession {
	sessionId: string;
	cwd: string;
	/** Number of leading pi messages the session holds. */
	count: number;
	/** Fingerprint of those messages. */
	hash: string;
	systemPrompt: string;
	tools: string;
}

export const FRESH_PROMPT = "Continue the task from the pi transcript, including any tool results or discarded previous attempt. Attached images are numbered in transcript order.";

export const DELTA_PROMPT = "Continue the task. The pi transcript delta lists, in order, the messages pi recorded after your last reply (other models' replies, tool results, user messages, or updated pi system instructions). Attached images are numbered in delta order. The same tool rules as before apply.";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (!block || typeof block !== "object") return [];
		const value = block as { type?: string; text?: string };
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("\n");
}

/** One message as transcript text. Images are numbered from `imageBase + 1`. */
function serializeMessage(message: Message, imageBase: number): { text: string; images: AcpImage[] } {
	const images: AcpImage[] = [];
	if (message.role === "user" || message.role === "toolResult") {
		const text = contentText(message.content);
		const references: string[] = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type !== "image") continue;
			images.push({ data: block.data, mimeType: block.mimeType });
			references.push(`[Attached image ${imageBase + images.length}]`);
		}
		const content = [text, ...references].filter(Boolean).join("\n");
		if (message.role === "user") return { text: content ? `<user>\n${content}\n</user>` : "", images };
		return {
			text: `<pi-tool-result name=${JSON.stringify(message.toolName)} id=${JSON.stringify(message.toolCallId)} error=${message.isError}>\n${content}\n</pi-tool-result>`,
			images,
		};
	}
	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text" && block.text) parts.push(`<assistant>\n${block.text}\n</assistant>`);
			if (block.type === "toolCall") parts.push(`<assistant-tool-call name=${JSON.stringify(block.name)} id=${JSON.stringify(block.id)}>\n${JSON.stringify(block.arguments)}\n</assistant-tool-call>`);
		}
		return { text: parts.join("\n\n"), images };
	}
	return { text: "", images };
}

function serializeRange(messages: Message[]): { text: string; images: AcpImage[] } {
	const parts: string[] = [];
	const images: AcpImage[] = [];
	for (const message of messages) {
		const serialized = serializeMessage(message, images.length);
		if (serialized.text) parts.push(serialized.text);
		images.push(...serialized.images);
	}
	return { text: parts.join("\n\n"), images };
}

/** The whole transcript for a fresh ACP session. Stable and append-only, so
 *  consecutive fresh turns still share a prompt prefix. */
export function freshInput(context: TranscriptContext): AcpInput {
	const system = getCurrentSystemPrompt(context.messages);
	const body = serializeRange(context.messages);
	const text = [system ? `<pi-system>\n${system}\n</pi-system>` : "", body.text].filter(Boolean).join("\n\n");
	return { prompt: FRESH_PROMPT, images: body.images, contextBlock: { uri: "pi://transcript", text } };
}

/** Content fingerprint: role, visible text, tool identities, and image bytes.
 *  Thinking is excluded; it is model-private and may be redacted by pi. */
function messageKey(message: Message): string {
	const serialized = serializeMessage(message, 0);
	const images = serialized.images.map((image) => createHash("sha256").update(image.data).digest("hex").slice(0, 16));
	if (message.role === "system") return JSON.stringify(["system", message.content, message.sections ?? null]);
	return JSON.stringify([message.role, serialized.text, images]);
}

export function fingerprint(messages: Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) hash.update(messageKey(message)).update("\u0000");
	return hash.digest("hex");
}

export function toolsKey(context: TranscriptContext): string {
	return getCurrentTools(context.messages).map((tool) => tool.name).sort().join(",");
}

export type TurnPlan =
	| { kind: "fresh"; input: AcpInput; reason: string }
	| { kind: "warm"; sessionId: string; input: AcpInput; fallback: AcpInput; deltaMessages: number };

export function planTurn(context: TranscriptContext, cwd: string, warm: WarmSession | undefined): TurnPlan {
	const fresh = (reason: string): TurnPlan => ({ kind: "fresh", input: freshInput(context), reason });
	if (!warm) return fresh("no-session");
	if (warm.cwd !== cwd) return fresh("cwd");
	if (warm.tools !== toolsKey(context)) return fresh("tools");
	const messages = context.messages;
	if (messages.length <= warm.count) return fresh("history-shrank");
	if (fingerprint(messages.slice(0, warm.count)) !== warm.hash) return fresh("history-diverged");
	const delta = messages.slice(warm.count);
	if (!delta.some((message) => message.role === "user")) return fresh("no-user-message");

	const systemPrompt = getCurrentSystemPrompt(messages);
	const systemChanged = systemPrompt !== warm.systemPrompt;
	const visible = delta.filter((message) => message.role !== "system");
	let input: AcpInput;
	if (!systemChanged && visible.every((message) => message.role === "user")) {
		// The common case: plain user turns, sent the way an ACP client would.
		const images: AcpImage[] = [];
		const texts: string[] = [];
		for (const message of visible) {
			const text = contentText(message.content);
			if (text) texts.push(text);
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
			}
		}
		input = { prompt: texts.join("\n\n") || "See the attached images.", images };
	} else {
		const body = serializeRange(visible);
		const text = [systemChanged && systemPrompt ? `<pi-system-update>\n${systemPrompt}\n</pi-system-update>` : "", body.text].filter(Boolean).join("\n\n");
		input = { prompt: DELTA_PROMPT, images: body.images, contextBlock: { uri: "pi://transcript-delta", text } };
	}
	return { kind: "warm", sessionId: warm.sessionId, input, fallback: freshInput(context), deltaMessages: delta.length };
}

/** State after a completed turn: the session holds pi's messages plus the
 *  final assistant message pi is about to record. */
export function warmAfterTurn(context: TranscriptContext, final: AssistantMessage, sessionId: string, cwd: string): WarmSession {
	const messages = [...context.messages, final];
	return {
		sessionId,
		cwd,
		count: messages.length,
		hash: fingerprint(messages),
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: toolsKey(context),
	};
}
