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

function shortMessageHash(message: Message): string {
	return createHash("sha256").update(messageKey(message)).digest("hex").slice(0, 16);
}

function toWarmItem(message: Exclude<Message, { role: "system" }>): WarmItem {
	const item: WarmItem = {
		role: message.role,
		key: shortMessageHash(message),
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
		out.push(shortMessageHash(message));
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

/** Split `messages` into the warm session's prefix and the new delta,
 *  tolerating extension prompt decorations, transient injected messages, and
 *  context-compression summaries that replace older turns. */
export function splitWarmTranscript(
	messages: Message[],
	warm: { count: number; hash: string; keys?: readonly string[]; items?: readonly WarmItem[] },
): { prefix: Message[]; delta: Message[] } | null {
	const direct = splitAtPersistentCount(messages, warm.count);
	if (direct && fingerprint(direct.prefix) === warm.hash) {
		return direct;
	}

	const body: BodyEntry[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || isEphemeralMessage(message) || message.role === "system") continue;
		body.push({
			index: i,
			item: toWarmItem(message),
			isSummary: isHistorySummary(message),
			isCompaction: isCompactionSummary(message),
		});
	}
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
