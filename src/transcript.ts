// Pi transcript → ACP prompt input, with warm ACP session reuse.
//
// A completed turn leaves the ACP session holding the same conversation pi
// recorded: the input it was sent, plus the text, tool calls, and tool results
// it produced natively. The next user turn reuses that session and sends only
// the messages pi added since, so the server's native history stays a stable
// prompt prefix (provider prompt caching) instead of being re-serialized.
// Any divergence (compaction, edits, a cwd change, or a failed turn) falls back
// to a fresh session that receives one bounded <pi_history> replay plus the
// newest input, keeping pi the sole source of truth. A changed active tool set
// is announced in the delta instead: the pi-bridge lists every tool an extension
// can activate, so the session can already call it.
import { createHash } from "node:crypto";
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, getSystemMessageText, type AssistantMessage, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
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
	/** Exact model-visible content hash of the persistent prefix, including
	 *  realctx drop placeholders, image bytes, and history summaries. */
	contentHash?: string;
	/** Per-message hashes of non-system, non-summary messages in order. */
	keys?: string[];
	/** Structured non-system message descriptors for extension-invariant matching. */
	items?: WarmItem[];
	systemPrompt: string;
	tools: string;
}

export const EMPTY_INPUT_CONTINUATION = "Continue the task from the latest tool results above.";

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
export const LOCKED_REPLAY_BUDGET_BYTES = 160_000;
export const UNLOCKED_REPLAY_BUDGET_BYTES = 2_200_000;
/** Kept for warm transcript deltas, which still use agy's priming-part path. */
export const MAX_TRANSCRIPT_BYTES = LOCKED_REPLAY_BUDGET_BYTES;


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
	const serialized = serializeRange(messages.filter((message) => message.role !== "system"));
	const body = { text: [header, serialized.text].filter(Boolean).join("\n\n"), images: serialized.images };
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

export function isHistorySummary(message: Message): boolean {
	if (message.role !== "user") return false;
	return isHistorySummaryText(contentText(message.content));
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
	const systemUpdate = renderSystemDelta(trailing);
	if (systemUpdate) notes.push(`<pi-system-update>\n${systemUpdate}\n</pi-system-update>`);
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

/** Render Pi's system prompt without its `tools` section: every bridged tool's
 *  description is already in its MCP schema and named by `toolPolicyPrompt`. */
export function renderPiSystemPrompt(messages: readonly Message[]): string {
	const message = getCurrentSystemMessage(messages as Message[]);
	if (!message) return "";
	if (!message.sections || !("tools" in message.sections)) return getSystemMessageText(message);
	const { tools: _tools, ...sections } = message.sections;
	return getSystemMessageText({ ...message, sections });
}

/** Render only the system-prompt changes carried by `messages`, omitting `sections.tools`. */
function renderSystemDelta(messages: readonly Message[]): string {
	const content: string[] = [];
	const sections = new Map<string, string | null>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const text = contentText(message.content).trim();
		if (text) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (name === "tools") continue;
			sections.set(name, value);
		}
	}
	const parts = [...content];
	for (const [name, value] of sections) {
		parts.push(value === null ? `Removed system prompt section "${name}".` : value);
	}
	return parts.join("\n\n");
}

/** Render a historical image as a placeholder; only live-input images are
 *  attached to the rebuilt ACP prompt. */
function serializeReplayMessage(message: Message): string {
	return serializeMessage(message, 0).text.replace(/\[Attached image \d+\]/g, "[Image in original transcript]");
}

/** Keep a valid UTF-8 suffix of at most `maxBytes`, with an explicit marker. */
function headWithinBytes(text: string, maxBytes: number): string {
	const marker = "...[Earlier content omitted]...\n";
	const available = maxBytes - Buffer.byteLength(marker, "utf8");
	if (available <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	let start = Math.max(0, buffer.length - available);
	while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++;
	return marker + buffer.subarray(start).toString("utf8");
}

/** DSH-style bounded replay: whole messages newest-first, one omission note,
 *  and only an oversized newest historical tool result may be truncated. */
export function serializeHistoryReplay(messages: readonly Message[], maxBytes: number): string {
	const rendered = messages.map(serializeReplayMessage).filter(Boolean);
	if (Buffer.byteLength(rendered.join("\n\n"), "utf8") <= maxBytes) {
		return rendered.length > 0 ? `<pi_history>\n${rendered.join("\n\n")}\n</pi_history>` : "";
	}
	const kept: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let index = rendered.length - 1; index >= 0; index--) {
		const text = rendered[index]!;
		const separator = kept.length > 0 ? 2 : 0;
		const size = Buffer.byteLength(text, "utf8") + separator;
		if (used + size <= maxBytes) {
			kept.unshift(text);
			used += size;
			continue;
		}
		if (kept.length === 0 && maxBytes > 1024 && messages[index]?.role === "toolResult") {
			const truncated = headWithinBytes(text, maxBytes);
			if (truncated) kept.unshift(truncated);
		}
		omitted = index + 1;
		break;
	}
	if (omitted > 0) kept.unshift(`[Earlier ${omitted} history messages omitted to fit the context replay budget]`);
	return kept.length > 0 ? `<pi_history>\n${kept.join("\n\n")}\n</pi_history>` : "";
}

/** One fresh ACP prompt: Pi system instructions, bounded `<pi_history>`, then
 *  the newest input verbatim. No native snapshot or SQLite rewrite is involved. */
export function freshInput(context: TranscriptContext, maxBytes = UNLOCKED_REPLAY_BUDGET_BYTES): AcpInput {
	// Fresh requests must include transient current-turn injections exactly once;
	// only warm-prefix bookkeeping excludes them.
	const visible = context.messages.filter((message) => message.role !== "system");
	const last = visible.at(-1);
	const inputStart = last?.role === "user" && !isHistorySummary(last) ? visible.length - 1 : visible.length;
	const history = visible.slice(0, inputStart);
	const trailing = visible.slice(inputStart);
	const texts: string[] = [];
	const images: AcpImage[] = [];
	for (const message of trailing) {
		const text = contentText(message.content);
		if (text) texts.push(text);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
		}
	}
	const live = texts.join("\n\n") || (trailing.length > 0 && images.length > 0 ? IMAGE_ONLY_PROMPT : EMPTY_INPUT_CONTINUATION);
	const systemText = renderPiSystemPrompt(context.messages);
	const system = systemText ? `<pi-system>\n${systemText}\n</pi-system>` : "";
	const fixedBytes = Buffer.byteLength([system, live].filter(Boolean).join("\n\n"), "utf8");
	const historyBytes = Math.max(0, maxBytes - fixedBytes - Buffer.byteLength("<pi_history>\n\n</pi_history>\n\n", "utf8") - 128);
	const replay = serializeHistoryReplay(history, historyBytes);
	return { prompt: [system, replay, live].filter(Boolean).join("\n\n"), images };
}

/** Content fingerprint: role, visible text, tool identities, and image bytes.
 *  Thinking is excluded; it is model-private and may be redacted by pi. */
/** Native prompt text agy stores for a user turn that has images but no text. */
export const IMAGE_ONLY_PROMPT = "See the attached images.";

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



/** realctx placeholder for dropped user images: `· user image` or `· 2 user images`. */
export const REALCTX_USER_IMAGE_DROP = /\[#\d+ (?:dropped|summarized|superseded) · (?:\d+ )?user images?\b/;
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
	const item: WarmItem = { role: message.role, key: shortHash(key) };
	if (message.role === "user") item.userText = fullUserText(message.content);
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

/** Unlike `fingerprint`, this includes content mutations that preserve message
 *  identity: realctx drops, image removal, and native/history summaries. */
export function contentFingerprint(messages: Message[]): string {
	const hash = createHash("sha256");
	for (const message of persistentMessages(messages)) {
		const serialized = serializeMessage(message, 0);
		hash.update(JSON.stringify([
			message.role,
			serialized.text,
			serialized.images,
			message.role === "toolResult" ? [message.toolCallId, message.toolName, Boolean(message.isError)] : null,
			message.role === "user" && isHistorySummary(message),
		])).update("\0");
	}
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

	const maxSummaryLead = countLeadingSummaries(body);
	for (let lead = 0; lead <= maxSummaryLead; lead++) {
		const splitIdx = matchSequence(body, lead, warmItems, false);
		if (splitIdx !== null) return splitIdx;
	}

	if (maxSummaryLead > 0) {
		for (let drop = 2; drop < warmItems.length; drop++) {
			const startRole = warmItems[drop]?.role;
			if (startRole === "toolResult") continue;
			const target = warmItems.slice(drop);
			if (target.length < 2 && startRole !== "assistant") continue;
			if (body.length - maxSummaryLead < target.length) continue;
			const splitIdx = matchSequence(body, maxSummaryLead, target, false);
			if (splitIdx !== null) return splitIdx;
		}
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
	const maxSummaryLead = countLeadingSummaries(body);
	const maxUserLead = countLeadingUsers(body);
	for (let drop = 0; drop < targetKeys.length; drop++) {
		const kept = targetKeys.length - drop;
		if (drop > 0 && (drop < 2 || kept < 2)) continue;
		const maxLead = drop === 0 ? maxSummaryLead : Math.min(Math.max(maxSummaryLead, Math.min(drop - 1, maxUserLead)), body.length - kept);
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
/** Per-turn memo of everything planning derives from the transcript: message
 *  keys, prefix fingerprints, the match body, tool/system keys, and fresh input. */
class TranscriptIndex {
	readonly context: TranscriptContext;
	readonly messages: Message[];
	readonly replayBudgetBytes: number;
	#persistent: PersistentEntry[] | undefined;
	/** prefixHashes[k] = fingerprint of the first k persistent messages. */
	#prefixHashes: string[] | undefined;
	#body: BodyEntry[] | undefined;
	#fresh: AcpInput | undefined;
	#tools: string | undefined;
	#systemPrompt: string | undefined;

	constructor(context: TranscriptContext, replayBudgetBytes = UNLOCKED_REPLAY_BUDGET_BYTES) {
		this.context = context;
		this.messages = context.messages;
		this.replayBudgetBytes = replayBudgetBytes;
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


	fresh(): AcpInput {
		this.#fresh ??= freshInput(this.context, this.replayBudgetBytes);
		return this.#fresh;
	}

	tools(): string {
		this.#tools ??= toolsKey(this.context);
		return this.#tools;
	}

	systemPrompt(): string {
		this.#systemPrompt ??= renderPiSystemPrompt(this.messages);
		return this.#systemPrompt;
	}
}

export type TurnPlan =
	| { kind: "fresh"; input: AcpInput; reason: string }
	| {
		kind: "warm";
		sessionId: string;
		input: AcpInput;
		fallback: AcpInput;
		deltaMessages: number;
	};
type WarmMatch = { warm: WarmSession; end: number; delta: Message[] } | { reason: string };

/** Whether `warm` exactly matches a prefix of this transcript. */
function matchWarmPrefix(index: TranscriptIndex, cwd: string, warm: WarmSession | undefined): WarmMatch {
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
	const prefix = persistentMessages(index.messages.slice(0, split.end));
	if (warm.contentHash !== contentFingerprint(prefix)) return { reason: "history-changed" };
	return { warm, end: split.end, delta: split.delta };
}


function planFromMatch(index: TranscriptIndex, match: WarmMatch): TurnPlan {
	if ("reason" in match) return { kind: "fresh", input: index.fresh(), reason: match.reason };
	const { warm, end, delta } = match;
	const systemPrompt = index.systemPrompt();
	const systemChanged = systemPrompt !== warm.systemPrompt && getCurrentSystemPrompt(index.messages) !== warm.systemPrompt;
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
		input = { prompt: texts.join("\n\n") || IMAGE_ONLY_PROMPT, images };
	} else {
		const headers: string[] = [];
		if (systemChanged) {
			const prefix = index.messages.slice(0, end);
			const prefixMatches =
				renderPiSystemPrompt(prefix) === warm.systemPrompt ||
				getCurrentSystemPrompt(prefix) === warm.systemPrompt;
			const systemUpdate = prefixMatches ? (renderSystemDelta(delta) || systemPrompt) : systemPrompt;
			if (systemUpdate) headers.push(`<pi-system-update>\n${systemUpdate}\n</pi-system-update>`);
		}
		if (toolsChanged) headers.push(toolsUpdate(tools));
		input = transcriptInput("pi://transcript-delta", DELTA_PROMPT, headers.join("\n\n"), visible);
	}
	return {
		kind: "warm",
		sessionId: warm.sessionId,
		input,
		fallback: index.fresh(),
		deltaMessages: delta.length,
	};
}

/** The active pi tool set after it changed since the session's warm snapshot. */
function toolsUpdate(tools: string): string {
	const names = tools.split(",").filter(Boolean);
	const text = names.length > 0
		? `The active pi tools are now: ${names.join(", ")}. Call only these pi tools.`
		: "No pi tools are active now.";
	return `<pi-tools-update>\n${text}\n</pi-tools-update>`;
}


export function planTurn(context: TranscriptContext, cwd: string, warm: WarmSession | undefined, replayBudgetBytes?: number): TurnPlan {
	const index = new TranscriptIndex(context, replayBudgetBytes);
	return planFromMatch(index, matchWarmPrefix(index, cwd, warm));
}


/** State after a completed turn: the session holds pi's persistent messages
 *  plus the final assistant message pi is about to record. */
export function warmAfterTurn(
	context: TranscriptContext,
	final: AssistantMessage,
	sessionId: string,
	cwd: string,
): WarmSession {
	const messages = [...persistentMessages(context.messages), final];
	const warm: WarmSession = {
		sessionId,
		cwd,
		count: messages.length,
		hash: fingerprint(messages),
		contentHash: contentFingerprint(messages),
		keys: nonHistoryKeys(messages),
		items: warmItemsForMessages(messages),
		systemPrompt: renderPiSystemPrompt(context.messages),
		tools: toolsKey(context),
	};
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
	if (typeof data.contentHash === "string") warm.contentHash = data.contentHash;
	if (Array.isArray(data.keys)) warm.keys = data.keys.map((key) => String(key));
	if (Array.isArray(data.items)) {
		const items = data.items.map(toWarmItemEntry).filter((item): item is WarmItem => item !== null);
		if (items.length > 0) warm.items = items;
	}
	return warm;
}

/** Restore only the latest warm entry on Pi's current branch. Off-branch entries
 *  are deliberately ignored: rewinds and edits rebuild instead of guessing agy state. */
export function restoreWarmSessions(branchEntries: readonly SessionEntryLike[]): { warm: WarmSession | undefined } {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index]!;
		if (entry.type !== "custom" || entry.customType !== WARM_SESSION_ENTRY) continue;
		const warm = toWarmSession(entry.data);
		if (warm) return { warm };
	}
	return { warm: undefined };
}
