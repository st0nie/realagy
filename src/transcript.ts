// Pi transcript → ACP prompt input, with warm ACP session reuse.
//
// A completed turn leaves the ACP session holding the same conversation pi
// recorded: the input it was sent, plus the text, tool calls, and tool results
// it produced natively. The next user turn reuses that session and sends only
// the messages pi added since, so the server's native history stays a stable
// prompt prefix (provider prompt caching) instead of being re-serialized.
// Any divergence (compaction, edits, a cwd change, a failed turn with no
// matching checkpoint) falls back to a fresh session that receives the whole
// transcript, keeping pi the source of truth. A changed active tool set is
// announced in the delta instead: the pi-bridge lists every tool an extension
// can activate, so the session can already call it.

import { createHash } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TurnPart } from "./driver-types.js";

export type AcpImage = { data: string; mimeType: string };

export interface AcpInput {
	prompt: string;
	images: AcpImage[];
	contextBlock?: { uri: string; text: string };
	/** Earlier parts of a context block too large for one `session/prompt`,
	 *  each sent as its own prompt before this one, in order. */
	parts?: TurnPart[];
}

export interface WarmItem {
	role: "user" | "assistant" | "toolResult";
	key: string;
	/** Normalized text of a `user` message, used for line-bounded prefix/suffix
	 *  matching when an extension decorates only the active turn's prompt. */
	userText?: string;
}

/** What a reusable ACP session is known to hold. */
export interface WarmSession {
	sessionId: string;
	cwd: string;
	/** Number of leading persistent pi messages the session holds. */
	count: number;
	/** Fingerprint of those messages. */
	hash: string;
	/** Per-message hashes of non-system, non-summary messages in order. */
	keys?: string[];
	/** Structured non-system message descriptors for extension-invariant matching. */
	items?: WarmItem[];
	/** Highest `steps.idx` in `~/.gemini/antigravity-cli/conversations/<sessionId>.db`
	 *  when this turn completed. Used to fork a truncated store on `/tree` rewind. */
	maxStepIdx?: number;
	/** Estimated bytes of conversation the ACP session holds (`messageBytes`
	 *  units). It can exceed pi's current view of the same messages after a
	 *  context manager (realctx drops, history summaries, sliding windows)
	 *  shrank them; that excess is what a fresh session would reclaim.
	 *  Absent on checkpoints recorded before this was tracked. */
	bytes?: number;
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
		// Text blocks separated only by thinking (agy's native-tool lines split
		// a reply mid-stream) are one reply.
		let reply = "";
		const flushReply = () => {
			const clean = reply ? stripForgedRealctx(reply) : "";
			if (clean) parts.push(`<assistant>\n${clean}\n</assistant>`);
			reply = "";
		};
		for (const block of message.content) {
			if (block.type === "text") reply += block.text;
			if (block.type === "toolCall") {
				flushReply();
				parts.push(`<assistant-tool-call name=${JSON.stringify(block.name)} id=${JSON.stringify(block.id)}>\n${JSON.stringify(block.arguments)}\n</assistant-tool-call>`);
			}
		}
		flushReply();
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

/** Most prompts one transcript is delivered in. Past
 *  MAX_TRANSCRIPT_PARTS × 90% × MAX_TRANSCRIPT_BYTES, older middle messages
 *  are omitted instead (see serializeBounded). */
export const MAX_TRANSCRIPT_PARTS = 8;

/** Every part but the last is filled to at least 90% of the cap, so a body
 *  of this size never needs more than MAX_TRANSCRIPT_PARTS parts. */
const MAX_PARTED_BYTES = Math.floor((MAX_TRANSCRIPT_PARTS * MAX_TRANSCRIPT_BYTES * 9) / 10);

/** Prompt of an earlier part: the model only acknowledges it. */
export function transcriptPartPrompt(index: number, total: number): string {
	return `Part ${index} of ${total} of the pi transcript is attached. Do not act on it yet and do not use any tools: reply with only "OK". The next part follows in the next message.`;
}

/** Split `text` into pieces of at most `maxBytes` UTF-8 bytes. A piece ends
 *  after a newline in its last tenth when there is one, else at a character
 *  boundary, so every piece but the last holds at least 90% of `maxBytes`. */
export function splitUtf8(text: string, maxBytes: number): string[] {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return [text];
	const pieces: string[] = [];
	let start = 0;
	while (buf.length - start > maxBytes) {
		let end = start + maxBytes;
		const newline = buf.lastIndexOf(0x0a, end - 1);
		if (newline >= end - Math.ceil(maxBytes / 10)) end = newline + 1;
		else while (end > start + 1 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
		pieces.push(buf.subarray(start, end).toString("utf8"));
		start = end;
	}
	pieces.push(buf.subarray(start).toString("utf8"));
	return pieces;
}

/** A transcript resource as prompt input: one block when it fits a single
 *  `session/prompt`, otherwise earlier parts sent ahead of the final prompt,
 *  so the whole transcript reaches agy instead of a truncated one. */
function transcriptInput(uri: string, prompt: string, header: string, messages: Message[]): AcpInput {
	const body = serializeBounded(header, messages, MAX_PARTED_BYTES);
	const pieces = splitUtf8(body.text, MAX_TRANSCRIPT_BYTES);
	const total = pieces.length;
	const last = pieces[total - 1] ?? "";
	if (total === 1) return { prompt, images: body.images, contextBlock: { uri, text: last } };
	return {
		prompt: `${prompt}\n\nThis message carries part ${total} of ${total} of the pi transcript; parts 1-${total - 1} came in the previous messages.`,
		images: body.images,
		contextBlock: { uri, text: last },
		parts: pieces.slice(0, -1).map((text, index) => ({ prompt: transcriptPartPrompt(index + 1, total), contextBlock: { uri, text } })),
	};
}

const COMPACTION_SUMMARY_HEADER = "The conversation history before this point was compacted into the following summary:";
const BRANCH_SUMMARY_HEADER = "The following is a summary of a branch that this conversation came back from:";

function isCompactionSummary(message: Message): boolean {
	if (message.role !== "user") return false;
	return contentText(message.content).trimStart().startsWith(COMPACTION_SUMMARY_HEADER);
}

function isHistorySummaryText(text: string): boolean {
	const trimmed = text.trimStart();
	return (
		trimmed.startsWith("<realctx-history") ||
		trimmed.startsWith("<summary>") ||
		trimmed.startsWith(COMPACTION_SUMMARY_HEADER) ||
		trimmed.startsWith(BRANCH_SUMMARY_HEADER)
	);
}

function isHistorySummary(message: Message): boolean {
	if (message.role !== "user") return false;
	return isHistorySummaryText(contentText(message.content));
}

/** When a warm session is abandoned for a fresh one because a context manager
 *  shrank pi's view of what the session holds (`/realagy settings`). */
export interface ReclaimPolicy {
	/** Least reclaimable bytes (`messageBytes` units) worth a fresh session... */
	minBytes: number;
	/** ...that are also at least this share (0-1) of what the session holds,
	 *  so a re-read of the whole (smaller) transcript pays for itself... */
	minShare: number;
	/** ...unless the latest reply is at least this old (ms): the provider's
	 *  prompt cache is cold anyway. 0 turns this rule off. */
	coldMs: number;
}

/** Rough UTF-8 bytes per token, for policies configured in tokens. */
export const BYTES_PER_TOKEN = 4;

/** 8k tokens, 10% of the session, or any such reclaim after 5 idle minutes. */
export const DEFAULT_RECLAIM_POLICY: Readonly<ReclaimPolicy> = {
	minBytes: 8_000 * BYTES_PER_TOKEN,
	minShare: 0.1,
	coldMs: 5 * 60_000,
};

/** Byte weight of one attached image (about 1.5k tokens). */
const IMAGE_BYTES = 6_000;

/** Whether `reclaim` bytes held by a session of `held` bytes, but no longer
 *  in pi's view, justify replacing the session with a fresh one. A null
 *  policy never reclaims. */
export function shouldReclaim(reclaim: number, held: number, cold: boolean, policy: Readonly<ReclaimPolicy> | null = DEFAULT_RECLAIM_POLICY): boolean {
	if (!policy || reclaim <= 0 || reclaim < policy.minBytes) return false;
	return cold || reclaim >= held * policy.minShare;
}

/** Size of one message as the ACP session sees it: serialized text plus a
 *  fixed weight per image. System messages are not part of the conversation. */
export function messageBytes(message: Message): number {
	if (message.role === "system") return 0;
	const serialized = serializeMessage(message, 0);
	return utf8Bytes(serialized.text) + serialized.images.length * IMAGE_BYTES;
}

/** Total `messageBytes` of `messages`. */
export function transcriptBytes(messages: readonly Message[]): number {
	let total = 0;
	for (const message of messages) total += messageBytes(message);
	return total;
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
 *  consecutive fresh turns still share a prompt prefix. Past
 *  MAX_TRANSCRIPT_BYTES it is delivered in parts. */
export function freshInput(context: TranscriptContext): AcpInput {
	const system = getCurrentSystemPrompt(context.messages);
	const header = system ? `<pi-system>\n${system}\n</pi-system>` : "";
	return transcriptInput("pi://transcript", FRESH_PROMPT, header, context.messages);
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


const REALCTX_USER_IMAGE_DROP = /\[#\d+ (?:dropped|summarized|superseded) · user images?\b/;
const EPHEMERAL_USER_INLINE = /(?:^|\n+)\[pi-lens automated (?:check|context) — not a user request\][\s\S]*$/;

function cleanUserBlockText(text: string): string {
	return stripForgedRealctx(text.replace(EPHEMERAL_USER_INLINE, "")).trim();
}

/** Primary user prompt text. Pi stores a user's prompt in the first `{ type: "text" }`
 *  block while extensions (`pi-lens`, `realctx` dropped-image notices, RAG hooks)
 *  append extra `{ type: "text" }` blocks. */
function primaryUserText(content: Message["content"]): string {
	if (typeof content === "string") {
		return cleanUserBlockText(content);
	}
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: string; text?: string };
		if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
		const trimmed = candidate.text.trimStart();
		if (EPHEMERAL_USER_PREFIX.test(trimmed) || REALCTX_USER_IMAGE_DROP.test(trimmed)) continue;
		const cleaned = cleanUserBlockText(candidate.text);
		if (cleaned) return cleaned;
	}
	return "";
}

function fullUserText(content: Message["content"]): string {
	if (typeof content === "string") {
		return cleanUserBlockText(content);
	}
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return false;
			const trimmed = block.text.trimStart();
			return !EPHEMERAL_USER_PREFIX.test(trimmed) && !REALCTX_USER_IMAGE_DROP.test(trimmed);
		})
		.map((block) => cleanUserBlockText(block.text))
		.filter(Boolean)
		.join("\n");
}

function messageKey(message: Message): string {
	if (message.role === "system") return JSON.stringify(["system", message.content, message.sections ?? null]);
	if (message.role === "toolResult") {
		return JSON.stringify(["toolResult", message.toolName, message.toolCallId, Boolean(message.isError)]);
	}
	if (message.role === "user") {
		return JSON.stringify(["user", primaryUserText(message.content)]);
	}
	const serialized = serializeMessage(message, 0);
	return JSON.stringify([message.role, serialized.text.trim()]);
}

function shortHash(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function toWarmItem(message: Exclude<Message, { role: "system" }>, key = messageKey(message)): WarmItem {
	const item: WarmItem = {
		role: message.role,
		key: shortHash(key),
	};
	if (message.role === "user") {
		item.userText = fullUserText(message.content);
	}
	return item;
}

export function nonHistoryKeys(messages: Message[]): string[] {
	const out: string[] = [];
	for (const message of persistentMessages(messages)) {
		if (message.role === "system" || isHistorySummary(message)) continue;
		out.push(shortHash(messageKey(message)));
	}
	return out;
}

export function warmItemsForMessages(messages: Message[]): WarmItem[] {
	const out: WarmItem[] = [];
	for (const message of persistentMessages(messages)) {
		if (message.role === "system" || isHistorySummary(message)) continue;
		out.push(toWarmItem(message));
	}
	return out;
}

export function fingerprint(messages: Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) hash.update(messageKey(message)).update("\0");
	return hash.digest("hex");
}

function userTextsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
	return (
		longer.startsWith(`${shorter}\n`) ||
		longer.endsWith(`\n${shorter}`) ||
		longer.includes(`\n${shorter}\n`)
	);
}

function itemsMatch(expected: WarmItem, actual: WarmItem): boolean {
	if (expected.role !== actual.role) return false;
	if (expected.key === actual.key) return true;
	if (expected.role === "user" && expected.userText !== undefined && actual.userText !== undefined) {
		return userTextsMatch(expected.userText, actual.userText);
	}
	return false;
}

interface BodyEntry {
	index: number;
	item: WarmItem;
	isSummary: boolean;
	isCompaction: boolean;
}

function matchSequence(
	body: ReadonlyArray<BodyEntry>,
	lead: number,
	target: ReadonlyArray<WarmItem>,
	requireNoTrailingAssistant: boolean,
): number | null {
	let b = lead;
	let matchedUserInRun = false;
	for (let w = 0; w < target.length; w++) {
		const expected = target[w];
		if (!expected) continue;
		const actual = body[b]?.item;
		if (actual && itemsMatch(expected, actual)) {
			matchedUserInRun = expected.role === "user";
			b++;
			continue;
		}
		if (expected.role === "user") {
			const nextExpected = target[w + 1];
			const nextMatches = nextExpected?.role === "user" && actual !== undefined && itemsMatch(nextExpected, actual);
			if (matchedUserInRun || nextMatches) {
				continue;
			}
		}
		return null;
	}
	if (requireNoTrailingAssistant) {
		for (let i = b; i < body.length; i++) {
			if (body[i]?.item.role === "assistant") return null;
		}
	}
	const lastMatched = b > lead ? body[b - 1] : undefined;
	return lastMatched ? lastMatched.index + 1 : null;
}

function countLeadingSummaries(body: ReadonlyArray<BodyEntry>): number {
	let count = 0;
	for (const entry of body) {
		if (!entry.isSummary) break;
		count++;
	}
	return count;
}

function countLeadingUsers(body: ReadonlyArray<BodyEntry>): number {
	let count = 0;
	for (const entry of body) {
		if (entry.item.role !== "user") break;
		count++;
	}
	return count;
}

function matchWarmItems(
	body: ReadonlyArray<BodyEntry>,
	warmItems: ReadonlyArray<WarmItem>,
): number | null {
	if (warmItems.length === 0 || body.length === 0) return null;
	if (body[0]?.isCompaction && warmItems[0]?.key !== body[0].item.key) {
		return null;
	}

	const maxSummaryLead = countLeadingSummaries(body);
	for (let lead = 0; lead <= maxSummaryLead; lead++) {
		const splitIdx = matchSequence(body, lead, warmItems, false);
		if (splitIdx !== null) return splitIdx;
	}

	const maxUserLead = countLeadingUsers(body);
	for (let drop = 2; drop <= warmItems.length - 2; drop++) {
		if (warmItems[drop]?.role !== "user") continue;
		const target = warmItems.slice(drop);
		const maxLead = Math.min(drop - 1, maxUserLead, body.length - target.length);
		for (let lead = 0; lead <= maxLead; lead++) {
			const splitIdx = matchSequence(body, lead, target, lead === 0 && maxSummaryLead === 0);
			if (splitIdx !== null) return splitIdx;
		}
	}
	return null;
}

function matchKeySuffix(
	body: ReadonlyArray<BodyEntry>,
	targetKeys: readonly string[],
): number | null {
	if (targetKeys.length === 0 || body.length === 0) return null;
	if (body[0]?.isCompaction && targetKeys[0] !== body[0].item.key) {
		return null;
	}
	const maxSummaryLead = countLeadingSummaries(body);
	const maxUserLead = countLeadingUsers(body);
	for (let drop = 0; drop < targetKeys.length; drop++) {
		const kept = targetKeys.length - drop;
		if (drop > 0 && (drop < 2 || kept < 2)) continue;
		const maxLead = drop === 0 ? maxSummaryLead : Math.min(drop - 1, maxUserLead, body.length - kept);
		for (let lead = 0; lead <= maxLead; lead++) {
			if (body.length - lead < kept) continue;
			let matches = true;
			for (let i = 0; i < kept; i++) {
				if (body[lead + i]?.item.key !== targetKeys[drop + i]) {
					matches = false;
					break;
				}
			}
			if (matches) {
				const endEntry = body[lead + kept - 1];
				return endEntry ? endEntry.index + 1 : null;
			}
		}
	}
	return null;
}

/** Split the transcript into the warm session's prefix and the new delta,
 *  tolerating extension prompt decorations, transient injected messages, and
 *  context-compression summaries that replace older turns. */
function splitWarmTranscript(
	index: TranscriptIndex,
	warm: { count: number; hash: string; keys?: readonly string[]; items?: readonly WarmItem[] },
): { prefix: Message[]; delta: Message[]; end: number } | null {
	const messages = index.messages;
	const direct = index.splitAtPersistentCount(warm.count);
	if (direct && index.prefixHash(warm.count) === warm.hash) {
		return direct;
	}

	const body = index.body();
	let splitIdx: number | null = null;
	if (warm.items && warm.items.length > 0) {
		splitIdx = matchWarmItems(body, warm.items);
	} else if (warm.keys && warm.keys.length > 0) {
		splitIdx = matchKeySuffix(body, warm.keys);
	}
	if (splitIdx === null) return null;
	return {
		prefix: persistentMessages(messages.slice(0, splitIdx)),
		delta: messages.slice(splitIdx),
		end: splitIdx,
	};
}

export function toolsKey(context: TranscriptContext): string {
	return getCurrentTools(context.messages).map((tool) => tool.name).sort((a, b) => a.localeCompare(b)).join(",");
}

interface PersistentEntry {
	index: number;
	message: Message;
	key?: string;
}
/** Per-turn memo of everything planning derives from the transcript, shared
 *  by every warm-session candidate: message keys, prefix fingerprints, the
 *  match body, the tool/system keys, and the full fresh input. Planning stays
 *  linear in transcript size however many checkpoints are compared. */
class TranscriptIndex {
	readonly context: TranscriptContext;
	readonly messages: Message[];
	#persistent: PersistentEntry[] | undefined;
	/** prefixHashes[k] = fingerprint of the first k persistent messages. */
	#prefixHashes: string[] | undefined;
	#body: BodyEntry[] | undefined;
	#fresh: AcpInput | undefined;
	#tools: string | undefined;
	#systemPrompt: string | undefined;
	/** bytesUpTo[i] = `messageBytes` of the persistent messages before persistent entry i. */
	#bytesUpTo: number[] | undefined;

	constructor(context: TranscriptContext) {
		this.context = context;
		this.messages = context.messages;
	}

	/** Persistent (non-ephemeral) messages with their transcript index; the
	 *  message key is computed on first use. */
	persistent(): PersistentEntry[] {
		this.#persistent ??= this.messages.flatMap((message, index) => (isEphemeralMessage(message) ? [] : [{ index, message }]));
		return this.#persistent;
	}

	#key(entry: PersistentEntry): string {
		entry.key ??= messageKey(entry.message);
		return entry.key;
	}

	prefixHash(count: number): string | undefined {
		const persistent = this.persistent();
		if (count > persistent.length) return undefined;
		if (!this.#prefixHashes) {
			const hash = createHash("sha256");
			const hashes = [hash.copy().digest("hex")];
			for (const entry of persistent) {
				hash.update(this.#key(entry)).update("\0");
				hashes.push(hash.copy().digest("hex"));
			}
			this.#prefixHashes = hashes;
		}
		return this.#prefixHashes[count];
	}

	/** The first `count` persistent messages, and everything after them. */
	splitAtPersistentCount(count: number): { prefix: Message[]; delta: Message[]; end: number } | null {
		const persistent = this.persistent();
		if (count > persistent.length) return null;
		const last = count > 0 ? persistent[count - 1] : undefined;
		return {
			prefix: persistent.slice(0, count).map((entry) => entry.message),
			delta: this.messages.slice(last ? last.index + 1 : 0),
			end: last ? last.index + 1 : 0,
		};
	}

	body(): BodyEntry[] {
		if (!this.#body) {
			const body: BodyEntry[] = [];
			for (const entry of this.persistent()) {
				const message = entry.message;
				if (message.role === "system") continue;
				const item = toWarmItem(message, this.#key(entry));
				body.push({ index: entry.index, item, isSummary: isHistorySummary(message), isCompaction: isCompactionSummary(message) });
			}
			this.#body = body;
		}
		return this.#body;
	}

	/** `messageBytes` of the persistent messages before transcript index `end`. */
	bytesBefore(end: number): number {
		const persistent = this.persistent();
		if (!this.#bytesUpTo) {
			const sums = [0];
			let total = 0;
			for (const entry of persistent) {
				total += messageBytes(entry.message);
				sums.push(total);
			}
			this.#bytesUpTo = sums;
		}
		let count = 0;
		while (count < persistent.length && (persistent[count]?.index ?? Infinity) < end) count++;
		return this.#bytesUpTo[count] ?? 0;
	}

	/** Whether the provider's prompt cache has gone cold since the latest reply. */
	cold(coldMs: number, now = Date.now()): boolean {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message?.role !== "assistant") continue;
			const at = message.timestamp;
			return coldMs > 0 && typeof at === "number" && at > 0 && now - at >= coldMs;
		}
		return false;
	}

	fresh(): AcpInput {
		this.#fresh ??= freshInput(this.context);
		return this.#fresh;
	}

	tools(): string {
		this.#tools ??= toolsKey(this.context);
		return this.#tools;
	}

	systemPrompt(): string {
		this.#systemPrompt ??= getCurrentSystemPrompt(this.messages);
		return this.#systemPrompt;
	}
}

export type TurnPlan =
	| { kind: "fresh"; input: AcpInput; reason: string }
	| {
		kind: "warm";
		sessionId: string;
		maxStepIdx?: number;
		input: AcpInput;
		fallback: AcpInput;
		deltaMessages: number;
		/** Bytes the session holds beyond pi's current view of its prefix
		 *  (see `WarmSession.bytes`); carried into the next checkpoint. */
		hidden: number;
	};

type WarmMatch = { warm: WarmSession; delta: Message[]; hidden: number } | { reason: string };

/** Bytes `warm` holds beyond pi's view of the messages it matched (negative
 *  when pi's view grew), or undefined for checkpoints without `bytes`. */
function hiddenBytes(index: TranscriptIndex, warm: WarmSession, end: number): number | undefined {
	return warm.bytes === undefined ? undefined : warm.bytes - index.bytesBefore(end);
}

/** Whether `warm` can continue this transcript, and with which delta. */
function matchWarm(index: TranscriptIndex, cwd: string, warm: WarmSession | undefined, policy: Readonly<ReclaimPolicy> | null): WarmMatch {
	if (!warm) return { reason: "no-session" };
	if (warm.cwd !== cwd) return { reason: "cwd" };
	// A changed active tool set (pi's `<tools>` system messages after an
	// extension activates tools, or a `/tree` restore) is announced in the
	// delta: the bridge already lists every tool that can be activated.
	const split = splitWarmTranscript(index, warm);
	if (!split) {
		return { reason: index.persistent().length <= warm.count ? "history-shrank" : "history-diverged" };
	}
	if (split.delta.length === 0) return { reason: "history-shrank" };
	if (!split.delta.some((message) => message.role === "user" || message.role === "toolResult")) return { reason: "no-user-message" };
	// Matching tolerates context managers rewriting what the session already
	// holds, but the session keeps the original: once enough was dropped or
	// summarized, only a fresh session actually releases that context.
	const hidden = hiddenBytes(index, warm, split.end) ?? 0;
	if (warm.bytes !== undefined && policy && shouldReclaim(hidden, warm.bytes, index.cold(policy.coldMs), policy)) return { reason: "context-reclaimed" };
	return { warm, delta: split.delta, hidden };
}

function planFromMatch(index: TranscriptIndex, match: WarmMatch): TurnPlan {
	if ("reason" in match) return { kind: "fresh", input: index.fresh(), reason: match.reason };
	const { warm, delta, hidden } = match;
	const systemPrompt = index.systemPrompt();
	const systemChanged = systemPrompt !== warm.systemPrompt;
	const tools = index.tools();
	const toolsChanged = tools !== warm.tools;
	const visible = delta.filter((message) => message.role !== "system");
	let input: AcpInput;
	if (!systemChanged && !toolsChanged && visible.every((message) => message.role === "user")) {
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
		const headers: string[] = [];
		if (systemChanged && systemPrompt) headers.push(`<pi-system-update>\n${systemPrompt}\n</pi-system-update>`);
		if (toolsChanged) headers.push(toolsUpdate(tools));
		input = transcriptInput("pi://transcript-delta", DELTA_PROMPT, headers.join("\n\n"), visible);
	}
	return {
		kind: "warm",
		sessionId: warm.sessionId,
		maxStepIdx: warm.maxStepIdx,
		input,
		fallback: index.fresh(),
		deltaMessages: delta.length,
		hidden,
	};
}

/** The active pi tool set after it changed since the session's checkpoint. */
function toolsUpdate(tools: string): string {
	const names = tools.split(",").filter(Boolean);
	const text = names.length > 0
		? `The active pi tools are now: ${names.join(", ")}. Call only these pi tools.`
		: "No pi tools are active now.";
	return `<pi-tools-update>\n${text}\n</pi-tools-update>`;
}

/** For a running turn about to continue on `warm` (its tool-boundary
 *  checkpoint): the bytes the session holds beyond pi's current view, and
 *  whether that is enough to restart on a fresh session instead. Undefined
 *  when the checkpoint has no `bytes` or no longer matches. */
export function measureWarm(
	context: TranscriptContext,
	warm: WarmSession,
	policy: Readonly<ReclaimPolicy> | null = DEFAULT_RECLAIM_POLICY,
): { hidden: number; reclaim: boolean } | undefined {
	if (warm.bytes === undefined) return undefined;
	const index = new TranscriptIndex(context);
	const split = splitWarmTranscript(index, warm);
	if (!split) return undefined;
	const hidden = hiddenBytes(index, warm, split.end) ?? 0;
	// Mid-turn the prompt cache is hot: only the share rule applies.
	return { hidden, reclaim: shouldReclaim(hidden, warm.bytes, false, policy) };
}

export function planTurn(
	context: TranscriptContext,
	cwd: string,
	warm: WarmSession | undefined,
	policy: Readonly<ReclaimPolicy> | null = DEFAULT_RECLAIM_POLICY,
): TurnPlan {
	const index = new TranscriptIndex(context);
	return planFromMatch(index, matchWarm(index, cwd, warm, policy));
}

/** Plan against several remembered sessions (most preferred first): the one
 *  with the smallest delta wins; with none usable, the first one's fresh
 *  reason is reported. Inputs are built only for the winner. */
export function planTurnFrom(
	context: TranscriptContext,
	cwd: string,
	candidates: readonly WarmSession[],
	policy: Readonly<ReclaimPolicy> | null = DEFAULT_RECLAIM_POLICY,
): TurnPlan {
	const index = new TranscriptIndex(context);
	let best: Extract<WarmMatch, { warm: WarmSession }> | undefined;
	for (const candidate of candidates) {
		const match = matchWarm(index, cwd, candidate, policy);
		if ("reason" in match) continue;
		if (!best || match.delta.length < best.delta.length) {
			best = match;
			if (best.delta.length === 1) break;
		}
	}
	return planFromMatch(index, best ?? matchWarm(index, cwd, candidates[0], policy));
}

/** State after a completed turn: the session holds pi's persistent messages
 *  plus the final assistant message pi is about to record. */
export function warmAfterTurn(
	context: TranscriptContext,
	final: AssistantMessage,
	sessionId: string,
	cwd: string,
	maxStepIdx?: number,
	/** Bytes the session held beyond pi's view of the turn's prefix
	 *  (`TurnPlan.hidden`; 0 for a fresh session). */
	hidden = 0,
): WarmSession {
	const messages = [...persistentMessages(context.messages), final];
	const warm: WarmSession = {
		sessionId,
		cwd,
		count: messages.length,
		bytes: Math.max(0, transcriptBytes(messages) + hidden),
		hash: fingerprint(messages),
		keys: nonHistoryKeys(messages),
		items: warmItemsForMessages(messages),
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

function toWarmItemEntry(raw: unknown): WarmItem | null {
	if (!raw || typeof raw !== "object") return null;
	const candidate = raw as { role?: unknown; key?: unknown; userText?: unknown };
	if (candidate.role !== "user" && candidate.role !== "assistant" && candidate.role !== "toolResult") return null;
	if (typeof candidate.key !== "string" || !candidate.key) return null;
	const item: WarmItem = { role: candidate.role, key: candidate.key };
	if (typeof candidate.userText === "string") item.userText = candidate.userText;
	return item;
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
	if (Array.isArray(data.items)) {
		const items = data.items.map(toWarmItemEntry).filter((item): item is WarmItem => item !== null);
		if (items.length > 0) warm.items = items;
	}
	if (data.maxStepIdx !== undefined && Number.isFinite(data.maxStepIdx)) {
		warm.maxStepIdx = Number(data.maxStepIdx);
	}
	if (data.bytes !== undefined && Number.isFinite(data.bytes)) {
		warm.bytes = Number(data.bytes);
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
