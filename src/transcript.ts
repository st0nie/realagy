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
	/** Number of leading persistent pi messages the session holds. */
	count: number;
	/** Fingerprint of those messages. */
	hash: string;
	/** Per-message hashes of non-system, non-`<realctx-history>` messages in order,
	 *  used to match the intact suffix after `realctx` folds early turns into
	 *  `<realctx-history>` summaries. */
	keys?: string[];
	/** Highest `steps.idx` in `~/.gemini/antigravity-cli/conversations/<sessionId>.db`
	 *  when this turn completed. Used to fork a truncated store on `/tree` rewind. */
	maxStepIdx?: number;
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
			if (block.type === "text" && block.text) {
				const clean = stripForgedRealctx(block.text);
				if (clean) parts.push(`<assistant>\n${clean}\n</assistant>`);
			}
			if (block.type === "toolCall") parts.push(`<assistant-tool-call name=${JSON.stringify(block.name)} id=${JSON.stringify(block.id)}>\n${JSON.stringify(block.arguments)}\n</assistant-tool-call>`);
		}
		return { text: parts.join("\n\n"), images };
	}
	return { text: "", images };
}

const REALCTX_PLACEHOLDER_LINE = /^[ \t]*\[#\d+ (?:dropped|summarized|superseded) · [^\n]*\][ \t]*$/gm;
const REALCTX_NOTES_BLOCK = /<realctx-path-notes\b[^>]*>[\s\S]*?(?:<\/realctx-path-notes>|$)/g;
const REALCTX_SECTION_BLOCK = /<\/?realctx(?:-[\w-]+)?\b[^>]*>/g;
const REALCTX_HISTORY_BLOCK = /<realctx-history\b[^>]*>[\s\S]*?(?:<\/realctx-history>|$)/g;

/** Match realctx's §9.2 assistant-text hygiene filter so warm-session hashes
 *  stay identical before and after realctx's `context` hook cleans `final`. */
function stripForgedRealctx(text: string): string {
	if (!text.includes("[#") && !text.includes("<realctx")) return text;
	return text
		.replace(REALCTX_HISTORY_BLOCK, "")
		.replace(REALCTX_NOTES_BLOCK, "")
		.replace(REALCTX_PLACEHOLDER_LINE, "")
		.replace(REALCTX_SECTION_BLOCK, "");
}

function serializeRange(messages: Message[], imageBase = 0): { text: string; images: AcpImage[] } {
	const parts: string[] = [];
	const images: AcpImage[] = [];
	for (const message of messages) {
		const serialized = serializeMessage(message, imageBase + images.length);
		if (serialized.text) parts.push(serialized.text);
		images.push(...serialized.images);
	}
	return { text: parts.join("\n\n"), images };
}

/** Maximum UTF-8 byte size of a `pi://transcript` or `pi://transcript-delta`
 *  resource block. `agy acp` truncates a single `session/prompt` past 192 KB
 *  from the end, which would cut off recent messages and the user's prompt. */
export const MAX_TRANSCRIPT_BYTES = 160_000;

function isHistorySummary(message: Message): boolean {
	if (message.role !== "user") return false;
	return contentText(message.content).trimStart().startsWith("<realctx-history");
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function clipHeadToUtf8Bytes(text: string, maxBytes: number): string {
	if (utf8Bytes(text) <= maxBytes) return text;
	const marker = "...[older content clipped]...\n";
	const budget = Math.max(0, maxBytes - utf8Bytes(marker));
	if (budget === 0) return "";
	const buf = Buffer.from(text, "utf8");
	let start = buf.length - budget;
	while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
	return marker + buf.subarray(start).toString("utf8");
}

/** Serialize header + messages within `maxBytes`, keeping `<pi-system>`,
 *  leading `<realctx-history>` summaries, and the newest messages intact while
 *  collapsing older middle messages into `<pi-transcript-omitted>`. */
export function serializeBounded(
	header: string,
	messages: Message[],
	maxBytes = MAX_TRANSCRIPT_BYTES,
): { text: string; images: AcpImage[] } {
	const visible = messages.filter((message) => message.role !== "system");
	const full = serializeRange(visible);
	const fullText = [header, full.text].filter(Boolean).join("\n\n");
	if (utf8Bytes(fullText) <= maxBytes || visible.length === 0) {
		return { text: fullText, images: full.images };
	}

	let prefixEnd = 0;
	while (prefixEnd < visible.length - 1) {
		const candidate = visible[prefixEnd];
		if (!candidate || !isHistorySummary(candidate)) break;
		prefixEnd++;
	}

	const sizes = visible.map((message) => utf8Bytes(serializeMessage(message, 0).text));
	const headerBytes = header ? utf8Bytes(header) + 2 : 0;
	const markerReserve = 128;
	const minSuffixReserve = Math.min(32_000, Math.floor(maxBytes / 4));
	const maxPrefixBytes = Math.max(0, maxBytes - headerBytes - markerReserve - minSuffixReserve);

	let keptPrefix = 0;
	let prefixBytes = 0;
	while (keptPrefix < prefixEnd) {
		const sz = sizes[keptPrefix] ?? 0;
		const add = sz > 0 ? sz + (prefixBytes > 0 ? 2 : 0) : 0;
		if (prefixBytes + add > maxPrefixBytes) break;
		prefixBytes += add;
		keptPrefix++;
	}

	const remainingBudget = Math.max(
		Math.min(4_096, Math.floor(maxBytes / 4)),
		maxBytes - headerBytes - (prefixBytes > 0 ? prefixBytes + 2 : 0) - markerReserve,
	);
	let suffixStart = visible.length;
	let suffixBytes = 0;
	while (suffixStart > keptPrefix) {
		const sz = sizes[suffixStart - 1] ?? 0;
		const add = sz > 0 ? sz + (suffixBytes > 0 ? 2 : 0) : 0;
		if (suffixBytes + add > remainingBudget) break;
		suffixBytes += add;
		suffixStart--;
	}
	if (suffixStart === visible.length) {
		suffixStart = visible.length - 1;
	}

	const prefix = serializeRange(visible.slice(0, keptPrefix), 0);
	const omitted = suffixStart - keptPrefix;
	const marker = omitted > 0
		? `<pi-transcript-omitted messages="${omitted}">\nOlder messages omitted to fit the ACP prompt limit.\n</pi-transcript-omitted>`
		: "";
	const suffix = serializeRange(visible.slice(suffixStart), prefix.images.length);
	const suffixText = utf8Bytes(suffix.text) > remainingBudget
		? clipHeadToUtf8Bytes(suffix.text, remainingBudget)
		: suffix.text;
	const text = [header, prefix.text, marker, suffixText].filter(Boolean).join("\n\n");
	return { text, images: [...prefix.images, ...suffix.images] };
}

/** Format a pi toolResult for the MCP bridge response, attaching any user
 *  steering messages (or system updates) pi appended after the tool ran. */
export function formatToolResult(
	result: Extract<Message, { role: "toolResult" }>,
	trailing: Message[] = [],
): { text: string; images: AcpImage[] } {
	const text = contentText(result.content);
	const images = Array.isArray(result.content)
		? result.content.flatMap((block) => block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [])
		: [];
	if (trailing.length === 0) return { text, images };
	const notes: string[] = [];
	for (const message of trailing) {
		if (message.role === "system" && typeof message.content === "string" && message.content.trim()) {
			notes.push(`<pi-system-update>\n${message.content}\n</pi-system-update>`);
		}
	}
	const steered = serializeRange(trailing.filter((message) => message.role !== "system"), images.length);
	if (steered.text) notes.push(steered.text);
	if (notes.length === 0) return { text, images };
	const fallback = images.length > 0 ? "(image result)" : "(no output)";
	const base = text || fallback;
	const steering = `<pi-steering>\nThe user sent a steering message while this tool was running. Address it immediately:\n${notes.join("\n\n")}\n</pi-steering>`;
	return {
		text: `${base}\n\n${steering}`,
		images: [...images, ...steered.images],
	};
}

/** The whole transcript for a fresh ACP session. Stable and append-only, so
 *  consecutive fresh turns still share a prompt prefix. */
export function freshInput(context: TranscriptContext, maxBytes = MAX_TRANSCRIPT_BYTES): AcpInput {
	const system = getCurrentSystemPrompt(context.messages);
	const header = system ? `<pi-system>\n${system}\n</pi-system>` : "";
	const body = serializeBounded(header, context.messages, maxBytes);
	return { prompt: FRESH_PROMPT, images: body.images, contextBlock: { uri: "pi://transcript", text: body.text } };
}

/** Content fingerprint: role, visible text, tool identities, and image bytes.
 *  Thinking is excluded; it is model-private and may be redacted by pi. */
const EPHEMERAL_USER_PREFIX = /^\[pi-lens automated (?:check|context) — not a user request\]/;

/** True for transient one-request messages injected by pi-lens's `context`
 *  hook (consumed and removed on the next request, never persisted). */
export function isEphemeralMessage(message: Message): boolean {
	if (message.role !== "user") return false;
	return EPHEMERAL_USER_PREFIX.test(contentText(message.content).trimStart());
}

/** Persistent messages of a transcript, excluding transient one-request injections. */
export function persistentMessages(messages: Message[]): Message[] {
	return messages.filter((message) => !isEphemeralMessage(message));
}

function splitAtPersistentCount(messages: Message[], count: number): { prefix: Message[]; delta: Message[] } | null {
	const prefix: Message[] = [];
	let idx = 0;
	while (idx < messages.length && prefix.length < count) {
		const message = messages[idx];
		if (message && !isEphemeralMessage(message)) prefix.push(message);
		idx++;
	}
	if (prefix.length < count) return null;
	return { prefix, delta: messages.slice(idx) };
}

const REALCTX_USER_IMAGE_DROP = /\[#\d+ (?:dropped|summarized|superseded) · user images?\b/;

function messageKey(message: Message): string {
	if (message.role === "system") return JSON.stringify(["system", message.content, message.sections ?? null]);
	if (message.role === "toolResult") {
		return JSON.stringify(["toolResult", message.toolName, message.toolCallId, Boolean(message.isError)]);
	}
	if (message.role === "user") {
		const raw = contentText(message.content);
		const clean = stripForgedRealctx(raw).trim();
		const hasBlocks = Array.isArray(message.content) && message.content.some((block) => block.type === "image");
		const hasImage = hasBlocks || REALCTX_USER_IMAGE_DROP.test(raw);
		return JSON.stringify(["user", clean, hasImage]);
	}
	const serialized = serializeMessage(message, 0);
	return JSON.stringify([message.role, serialized.text]);
}

function shortMessageHash(message: Message): string {
	return createHash("sha256").update(messageKey(message)).digest("hex").slice(0, 16);
}

export function nonHistoryKeys(messages: Message[]): string[] {
	const out: string[] = [];
	for (const message of persistentMessages(messages)) {
		if (message.role === "system" || isHistorySummary(message)) continue;
		out.push(shortMessageHash(message));
	}
	return out;
}

export function fingerprint(messages: Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) hash.update(messageKey(message)).update("\0");
	return hash.digest("hex");
}

function matchKeySuffix(
	body: ReadonlyArray<{ index: number; key: string }>,
	targetKeys: readonly string[],
	allowDropPrefix: boolean,
): number | null {
	if (targetKeys.length === 0 || body.length === 0) return null;
	const maxDrop = allowDropPrefix ? targetKeys.length - 1 : 0;
	for (let drop = 0; drop <= maxDrop; drop++) {
		const kept = targetKeys.length - drop;
		if (body.length < kept) continue;
		let matches = true;
		for (let i = 0; i < kept; i++) {
			if (body[i]?.key !== targetKeys[drop + i]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			const endEntry = body[kept - 1];
			return endEntry ? endEntry.index + 1 : null;
		}
	}
	return null;
}

/** Split `messages` into the warm session's prefix and the new delta, allowing
 *  `realctx` to fold leading turns into `<realctx-history>` summaries while the
 *  remaining suffix of non-history messages stays intact. */
export function splitWarmTranscript(
	messages: Message[],
	warm: { count: number; hash: string; keys?: readonly string[] },
): { prefix: Message[]; delta: Message[] } | null {
	const direct = splitAtPersistentCount(messages, warm.count);
	if (direct && fingerprint(direct.prefix) === warm.hash) {
		return direct;
	}
	if (!warm.keys || warm.keys.length === 0) return null;

	const body: Array<{ index: number; key: string }> = [];
	let sawHistorySummary = false;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || isEphemeralMessage(message) || message.role === "system") continue;
		if (body.length === 0 && isHistorySummary(message)) {
			sawHistorySummary = true;
			continue;
		}
		body.push({ index: i, key: shortMessageHash(message) });
	}
	const splitIdx = matchKeySuffix(body, warm.keys, sawHistorySummary);
	if (splitIdx === null) return null;
	return {
		prefix: persistentMessages(messages.slice(0, splitIdx)),
		delta: messages.slice(splitIdx),
	};
}

export function toolsKey(context: TranscriptContext): string {
	return getCurrentTools(context.messages).map((tool) => tool.name).sort((a, b) => a.localeCompare(b)).join(",");
}

export type TurnPlan =
	| { kind: "fresh"; input: AcpInput; reason: string }
	| { kind: "warm"; sessionId: string; maxStepIdx?: number; input: AcpInput; fallback: AcpInput; deltaMessages: number };

export function planTurn(context: TranscriptContext, cwd: string, warm: WarmSession | undefined): TurnPlan {
	const fresh = (reason: string): TurnPlan => ({ kind: "fresh", input: freshInput(context), reason });
	if (!warm) return fresh("no-session");
	if (warm.cwd !== cwd) return fresh("cwd");
	if (warm.tools !== toolsKey(context)) return fresh("tools");
	const messages = context.messages;
	const split = splitWarmTranscript(messages, warm);
	if (!split) {
		const persistent = persistentMessages(messages);
		return fresh(persistent.length <= warm.count ? "history-shrank" : "history-diverged");
	}
	if (split.delta.length === 0) return fresh("history-shrank");
	const delta = split.delta;
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
		const header = systemChanged && systemPrompt ? `<pi-system-update>\n${systemPrompt}\n</pi-system-update>` : "";
		const body = serializeBounded(header, visible);
		input = { prompt: DELTA_PROMPT, images: body.images, contextBlock: { uri: "pi://transcript-delta", text: body.text } };
	}
	return {
		kind: "warm",
		sessionId: warm.sessionId,
		maxStepIdx: warm.maxStepIdx,
		input,
		fallback: freshInput(context),
		deltaMessages: delta.length,
	};
}

/** State after a completed turn: the session holds pi's persistent messages
 *  plus the final assistant message pi is about to record. */
export function warmAfterTurn(
	context: TranscriptContext,
	final: AssistantMessage,
	sessionId: string,
	cwd: string,
	maxStepIdx?: number,
): WarmSession {
	const messages = [...persistentMessages(context.messages), final];
	const warm: WarmSession = {
		sessionId,
		cwd,
		count: messages.length,
		hash: fingerprint(messages),
		keys: nonHistoryKeys(messages),
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: toolsKey(context),
	};
	if (maxStepIdx !== undefined && maxStepIdx >= 0) warm.maxStepIdx = maxStepIdx;
	return warm;
}

export const WARM_SESSION_ENTRY = "realagy-warm-session";

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: Partial<WarmSession> | null;
}

function toWarmSession(data: Partial<WarmSession> | null | undefined): WarmSession | null {
	if (!data) return null;
	if (!data.sessionId || !data.cwd || !data.hash) return null;
	if (data.count === undefined || data.systemPrompt === undefined || data.tools === undefined) return null;
	const warm: WarmSession = {
		sessionId: String(data.sessionId),
		cwd: String(data.cwd),
		count: Number(data.count),
		hash: String(data.hash),
		systemPrompt: String(data.systemPrompt),
		tools: String(data.tools),
	};
	if (Array.isArray(data.keys)) warm.keys = data.keys.map((key) => String(key));
	if (data.maxStepIdx !== undefined && Number.isFinite(data.maxStepIdx)) {
		warm.maxStepIdx = Number(data.maxStepIdx);
	}
	return warm;
}

/** Reconstruct `warm` and chronological `checkpoints` from pi's session entries.
 *  Branch entries take priority at the tail; off-branch entries (such as a
 *  custom entry immediately following an assistant message selected in `/tree`
 *  or checkpoints on sibling branches) are included earlier in `checkpoints`
 *  so `selectTurnPlan` can match any turn across `/reload`, `/resume`, or `/tree`. */
export function restoreWarmSessions(
	branchEntries: readonly SessionEntryLike[],
	allEntries: readonly SessionEntryLike[] = branchEntries,
): { warm: WarmSession | undefined; checkpoints: WarmSession[] } {
	const extract = (entries: readonly SessionEntryLike[]): WarmSession[] => {
		const out: WarmSession[] = [];
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== WARM_SESSION_ENTRY) continue;
			const warm = toWarmSession(entry.data);
			if (warm) out.push(warm);
		}
		return out;
	};
	const onBranch = extract(branchEntries);
	const fromAll = extract(allEntries);
	const seen = new Set<string>();
	const keyOf = (w: WarmSession) => `${w.sessionId}:${w.count}:${w.hash}:${w.maxStepIdx ?? -1}`;
	for (const w of onBranch) seen.add(keyOf(w));
	const offBranch = fromAll.filter((w) => {
		const k = keyOf(w);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const checkpoints = [...offBranch, ...onBranch];
	return {
		warm: onBranch.at(-1) ?? checkpoints.at(-1),
		checkpoints,
	};
}
