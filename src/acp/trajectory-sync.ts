// Synchronize pi's effective context into agy's native trajectory, in place.
// No transcript-priming messages are generated: known user/tool protobuf fields
// are edited and a compaction/history summary replaces the native prefix it
// covers. The caller must stop the ACP process before opening the store.

import { createRequire } from "node:module";
import fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { FRESH_PROMPT, IMAGE_ONLY_PROMPT, isEmptyFailedAssistant, isHistorySummary, REALCTX_USER_IMAGE_DROP, persistentMessages, warmItemsForMessages, type WarmItem } from "../transcript.js";
import { decodeProtoFields, optionalProtoBytesAt, protoTextAt, removeProtoFields, repeatedProtoBytesAt, replaceRepeatedProtoTextPart, rewriteRepeatedProtoFields, setProtoText } from "./trajectory-proto.js";

const USER_STEP = 14;
const ASSISTANT_STEP = 15;
const TOOL_RESULT_STEP = 132;
const CHECKPOINT_STEP = 23;
const USER_TEXT = [19, 2];
const USER_ITEMS = [19, 3];
/** Repeated user media: 1 MIME type, 5 uploaded file path, 2 bytes. */
const USER_MEDIA = [19, 9];
const TOOL_NAME = [5, 4, 2];
const TOOL_TEXT = [140, 2, 1];
/** Repeated tool media: 1 MIME type, 5 offloaded file URI, 2 bytes. */
const TOOL_MEDIA = [140, 2, 4];
const TOOL_MEDIA_URI = [5];
const TOOL_RENDER = [140, 2, 3];
/** Repeated rendering parts: one `{1: text}` then one `{2: {1: uri}}` per medium. */
const TOOL_RENDER_PARTS = [140, 2, 3, 10];
/** A pi tool error (status 7): the error text and its byte-identical mirror;
 *  the `error_details` column repeats both as fields 2 and 3. */
const TOOL_ERROR = [31];
const TOOL_ERROR_TEXT = [31, 2];
const TOOL_ERROR_MIRROR = [31, 3];
/** agy's display rendering of a result: at most this many lines and bytes. */
const DISPLAY_MAX_LINES = 40;
const DISPLAY_MAX_BYTES = 4096;
type SqliteModule = typeof import("node:sqlite");
type Database = InstanceType<SqliteModule["DatabaseSync"]>;
let sqlite: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule {
	if (sqlite !== undefined) {
		if (sqlite) return sqlite;
		throw new TrajectorySyncError("node:sqlite is unavailable; cannot synchronize agy history");
	}
	const emitWarning = process.emitWarning;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	try {
		sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
	} catch {
		sqlite = null;
	} finally {
		process.emitWarning = emitWarning;
	}
	if (!sqlite) throw new TrajectorySyncError("node:sqlite is unavailable; cannot synchronize agy history");
	return sqlite;
}

export class TrajectorySyncError extends Error {
	override name = "TrajectorySyncError";
}

interface NativeStep {
	idx: number;
	type: number;
	payload: Uint8Array;
	renderInfo?: Uint8Array | null;
	/** The `error_details` column: `{2: error, 3: error}` for pi tool errors. */
	errorDetails?: Uint8Array | null;
	status?: number;
}

interface Descriptor {
	role: WarmItem["role"];
	/** Text/name expected in the existing native step, before this edit. */
	userText?: string;
	toolName?: string;
	previousText?: string;
	previousMediaHash?: string;
	hasPrevious: boolean;
	/** An empty failed/aborted assistant turn: agy may or may not hold a
	 *  planner step for it, so it maps to the next native assistant step only
	 *  when one comes next. */
	optional?: boolean;
	message?: Message;
}

interface MappedStep {
	step: NativeStep;
	position: number;
	descriptor: Descriptor;
	/** For tool steps: the pi results (and steering users) the step carries. */
	group?: ToolGroup;
}

function textContent(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap((block) =>
		block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	).join("\n");
}

function descriptorForMessage(message: Message, previous?: WarmItem): Descriptor {
	if (message.role === "system") throw new TrajectorySyncError("System messages do not map to native user steps");
	return {
		role: message.role,
		userText: message.role === "user" ? nativeUserPrompt(previous?.syncText ?? previous?.userText ?? textContent(message), previous?.syncMediaHash) : undefined,
		toolName: message.role === "toolResult" ? previous?.syncName ?? message.toolName : undefined,
		previousText: message.role === "toolResult" ? previous?.syncText : undefined,
		previousMediaHash: previous?.syncMediaHash,
		hasPrevious: previous !== undefined,
		optional: isEmptyFailedAssistant(message) || undefined,
		message,
	};
}

function descriptorForWarmItem(item: WarmItem): Descriptor {
	return {
		role: item.role,
		userText: item.role === "user" ? nativeUserPrompt(item.syncText ?? item.userText ?? "", item.syncMediaHash) : undefined,
		toolName: item.syncName,
		previousText: item.syncText,
		previousMediaHash: item.syncMediaHash,
		hasPrevious: true,
		optional: item.failed || undefined,
	};
}

/** The prompt text agy stores for a user message: image-only turns are sent
 *  with a fixed prompt because ACP requires text. */
function nativeUserPrompt(text: string, mediaHash: string | undefined): string {
	return text || (mediaHash !== undefined ? IMAGE_ONLY_PROMPT : "");
}

interface NativeToolResult {
	/** The pi-side result text, without agy's offloaded-media lines. */
	text: string;
	mediaUris: string[];
	/** agy's appended `[Resource offloaded to <uri>]` lines, verbatim. */
	suffix: string;
	/** Recorded as a pi tool error (field 31) rather than a result (140.2.1). */
	error: boolean;
}

/** The verified pi tool-error layout: field 31 holds exactly the error text
 *  (2) and its byte-identical mirror (3), and no result was recorded. */
function nativeToolError(step: NativeStep): string | undefined {
	const block = optionalProtoBytesAt(step.payload, TOOL_ERROR);
	if (block === undefined) return undefined;
	const numbers = decodeProtoFields(block).map((field) => `${field.number}:${field.wire}`).join(",");
	const text = optionalProtoBytesAt(step.payload, TOOL_ERROR_TEXT);
	if (numbers !== "2:2,3:2" || text === undefined || !text.equals(optionalProtoBytesAt(step.payload, TOOL_ERROR_MIRROR) ?? Buffer.alloc(0))) {
		throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified error layout`);
	}
	return text.toString("utf8");
}

/** Whether agy recorded pi's outcome for a tool step: a result or an error. */
function hasRecordedOutcome(step: NativeStep): boolean {
	return optionalProtoBytesAt(step.payload, TOOL_TEXT) !== undefined || optionalProtoBytesAt(step.payload, TOOL_ERROR) !== undefined;
}

/** Split a native tool result into pi's text and agy's media references. Each
 *  stored medium must be announced by exactly one trailing offload line with
 *  its URI, in order; any other layout fails closed. */
function nativeToolResult(step: NativeStep): NativeToolResult {
	const mediaUris = repeatedProtoBytesAt(step.payload, TOOL_MEDIA).map((entry) => {
		const uri = optionalProtoBytesAt(entry, TOOL_MEDIA_URI)?.toString("utf8");
		if (!uri) throw new TrajectorySyncError(`Native tool step ${step.idx} has media without a file URI`);
		return uri;
	});
	if (optionalProtoBytesAt(step.payload, TOOL_TEXT) === undefined) {
		const error = nativeToolError(step);
		if (error === undefined) throw new TrajectorySyncError(`Native tool step ${step.idx} has no recorded result (status ${step.status ?? "unknown"}); its pi result never reached agy`);
		if (mediaUris.length > 0) throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified media layout`);
		return { text: error, mediaUris, suffix: "", error: true };
	}
	if (optionalProtoBytesAt(step.payload, TOOL_ERROR) !== undefined) {
		throw new TrajectorySyncError(`Native tool step ${step.idx} records both a result and an error`);
	}
	const raw = protoTextAt(step.payload, TOOL_TEXT);
	if (mediaUris.length === 0) return { text: raw, mediaUris, suffix: "", error: false };
	const lines = mediaUris.map((uri) => `[Resource offloaded to ${uri}]`);
	const suffix = `\n${lines.join("\n")}`;
	if (raw.endsWith(suffix)) return { text: raw.slice(0, -suffix.length), mediaUris, suffix, error: false };
	if (raw === suffix.slice(1)) return { text: "", mediaUris, suffix: raw, error: false };
	throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified media layout`);
}

/** agy's display rendering of a result (agy 1.5.3): the first 40 lines, cut
 *  to 4096 bytes at a character boundary, with a note when anything was cut.
 *  Callers must first reproduce the existing rendering with it. */
function displayedResult(text: string): string {
	const lines = text.split("\n");
	let shown = lines.slice(0, DISPLAY_MAX_LINES).join("\n");
	let cut = lines.length > DISPLAY_MAX_LINES;
	const bytes = Buffer.from(shown, "utf8");
	if (bytes.length > DISPLAY_MAX_BYTES) {
		shown = new TextDecoder().decode(bytes.subarray(0, DISPLAY_MAX_BYTES), { stream: true });
		cut = true;
	}
	const remaining = lines.length - shown.split("\n").length;
	const note = !cut ? "" : remaining > 0 ? `\n\n_… ${remaining} more lines, truncated for display._` : "\n\n_… truncated for display._";
	return `\n\n**Result**\n\`\`\`\n${shown}\n\`\`\`${note}`;
}

function semanticType(role: Descriptor["role"]): number {
	return role === "user" ? USER_STEP : role === "assistant" ? ASSISTANT_STEP : TOOL_RESULT_STEP;
}

function nativeText(step: NativeStep): string | undefined {
	if (step.type === USER_STEP) return protoTextAt(step.payload, USER_TEXT);
	if (step.type === TOOL_RESULT_STEP) return nativeToolResult(step).text;
	return undefined;
}

function sameTool(nativeName: string, piName: string): boolean {
	return nativeName === piName || nativeName === `mcp_pi-bridge_${piName}`;
}

/** The text agy received for a pi result: `bridgeResult` substitutes a
 *  placeholder for an empty result. */
function deliveredText(text: string, images: number): string {
	return text || (images > 0 ? "(image result)" : "(no output)");
}

/** Whether a native per-result text is what pi's `text` was delivered as. */
function sameResultText(native: string, text: string, images: number): boolean {
	return native === text || native === deliveredText(text, images) || native.replace(/^Stored tool value: /, "").replace(/\n$/, "") === text;
}

function imageCount(message: Message | undefined): number {
	return message && Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0;
}

/** Bridge-local rejections realagy answers without pi (inactive tool, invalid
 *  parallel batch, transcript priming); pi never sees these native steps. */
const BRIDGE_REJECTION = /^(?:Pi tool \S+ is not active in pi right now\. Active pi tools: [^\n]*\.|Error: parallel[^\n]*|Pi tools are unavailable while the pi transcript is delivered in parts\. Reply with only OK\.)$/;

function isBridgeRejection(step: NativeStep): boolean {
	if (step.type !== TOOL_RESULT_STEP || optionalProtoBytesAt(step.payload, TOOL_TEXT) !== undefined) return false;
	try {
		const error = nativeToolError(step);
		return error !== undefined && BRIDGE_REJECTION.test(error);
	} catch {
		return false;
	}
}

/** Native steps pi never saw: bridge-local rejections, plus their planner when
 *  every tool step it issued was rejected. */
function bridgeOrphans(steps: NativeStep[]): Set<number> {
	const orphans = new Set<number>();
	const semantic = steps.filter((step) => [USER_STEP, ASSISTANT_STEP, TOOL_RESULT_STEP].includes(step.type));
	for (let index = 0; index < semantic.length; index++) {
		if (semantic[index]!.type !== ASSISTANT_STEP) continue;
		let end = index + 1;
		while (end < semantic.length && semantic[end]!.type === TOOL_RESULT_STEP) end++;
		const tools = semantic.slice(index + 1, end);
		const rejected = tools.filter(isBridgeRejection);
		for (const step of rejected) orphans.add(step.idx);
		if (tools.length > 0 && rejected.length === tools.length) orphans.add(semantic[index]!.idx);
	}
	return orphans;
}

const PARALLEL_NATIVE_TOOL = "mcp_pi-bridge_parallel";
type ParallelBlock = { type: "text"; text: string } | { type: "image"; index: number; mimeType: string };
interface ParallelEntry { callId: string; name: string; isError: boolean; content: ParallelBlock[] }

/** Parse a native parallel batch: exactly `formatParallelResults` JSON, each
 *  entry one text block then its numbered images. */
function parallelEntries(step: NativeStep, text: string, mediaCount: number): ParallelEntry[] {
	const unverified = () => new TrajectorySyncError(`Native parallel step ${step.idx} has an unverified result layout`);
	const shaped = (value: unknown, keys: string[]): value is Record<string, unknown> =>
		value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join("\0") === keys.join("\0");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw unverified();
	}
	if (JSON.stringify(parsed, null, 2) !== text || !shaped(parsed, ["results"]) || !Array.isArray(parsed.results) || parsed.results.length === 0) throw unverified();
	let images = 0;
	for (const entry of parsed.results as unknown[]) {
		if (!shaped(entry, ["callId", "name", "isError", "content"]) || typeof entry.callId !== "string" || typeof entry.name !== "string" ||
			typeof entry.isError !== "boolean" || !Array.isArray(entry.content) || entry.content.length === 0) throw unverified();
		(entry.content as unknown[]).forEach((block, index) => {
			const valid = index === 0
				? shaped(block, ["type", "text"]) && block.type === "text" && typeof block.text === "string"
				: shaped(block, ["type", "index", "mimeType"]) && block.type === "image" && block.index === ++images && typeof block.mimeType === "string";
			if (!valid) throw unverified();
		});
	}
	if (images !== mediaCount) throw unverified();
	return parsed.results as ParallelEntry[];
}

const STEERING_HEADER = "\n\n<pi-steering>\nThe user sent a steering message while this tool was running. Address it immediately:\n";
const STEERING_FOOTER = "\n</pi-steering>";

/** The pi user messages a verified steering block (as `formatToolResult`
 *  appends it) carries; pi keeps them as user messages with no native step. */
function steeringUsers(idx: number, steering: string, descriptors: Descriptor[], start: number): Descriptor[] {
	const mismatch = () => new TrajectorySyncError(`Native tool step ${idx} carries a steering message that pi's context does not match`);
	if (!steering.startsWith(STEERING_HEADER) || !steering.endsWith(STEERING_FOOTER)) throw mismatch();
	const notes = steering.slice(STEERING_HEADER.length, -STEERING_FOOTER.length);
	const users: Descriptor[] = [];
	for (let index = start; index < descriptors.length && descriptors[index]!.role === "user"; index++) {
		const descriptor = descriptors[index]!;
		if (descriptor.previousMediaHash !== undefined || imageCount(descriptor.message) > 0 || !descriptor.userText) break;
		users.push(descriptor);
		const joined = users.map((user) => `<user>\n${user.userText}\n</user>`).join("\n\n");
		if (notes === joined) return users;
		if (notes.endsWith(`\n\n${joined}`)) {
			const update = notes.slice(0, -joined.length - 2);
			if (update.startsWith("<pi-system-update>\n") && update.endsWith("\n</pi-system-update>")) return users;
		}
	}
	throw mismatch();
}

/** One native tool step and the pi tool results it carries: one result, or
 *  every result of a parallel batch. */
interface ToolGroup {
	step: NativeStep;
	native: NativeToolResult;
	entries?: ParallelEntry[];
	results: Descriptor[];
	/** Exact native per-result text, without the steering block. */
	texts: string[];
	/** Steering block agy received after the last result, verbatim. */
	steering: string;
	/** Pi user messages carried by `steering`. */
	absorbed: Descriptor[];
}

function toolGroup(step: NativeStep, descriptors: Descriptor[], start: number): ToolGroup {
	const name = protoTextAt(step.payload, TOOL_NAME);
	if (!name) throw new TrajectorySyncError(`Native tool step ${step.idx} has no recognizable MCP tool name`);
	if (!hasRecordedOutcome(step)) {
		throw new TrajectorySyncError(`Native tool step ${step.idx} has no recorded result (status ${step.status ?? "unknown"}); its pi result never reached agy`);
	}
	const native = nativeToolResult(step);
	const first = descriptors[start]!;
	let entries: ParallelEntry[] | undefined;
	let results: Descriptor[];
	let texts: string[];
	if (name === PARALLEL_NATIVE_TOOL && first.toolName !== "parallel") {
		entries = parallelEntries(step, native.text, native.mediaUris.length);
		results = descriptors.slice(start, start + entries.length);
		if (results.length !== entries.length || results.some((descriptor) => descriptor.role !== "toolResult")) {
			throw new TrajectorySyncError(`Native parallel step ${step.idx} carries ${entries.length} results that pi's context does not hold`);
		}
		entries.forEach((entry, index) => {
			const descriptor = results[index]!;
			const message = descriptor.message;
			if ((descriptor.toolName !== undefined && entry.name !== descriptor.toolName) ||
				(message?.role === "toolResult" && (entry.callId !== message.toolCallId || entry.isError !== Boolean(message.isError)))) {
				throw new TrajectorySyncError(`Native parallel step ${step.idx} entry ${index + 1} is ${entry.name}; expected ${descriptor.toolName}`);
			}
		});
		if (native.error !== entries.some((entry) => entry.isError)) {
			throw new TrajectorySyncError(`Native parallel step ${step.idx} has an unverified error layout`);
		}
		texts = entries.map((entry) => (entry.content[0] as { text: string }).text);
	} else {
		if (first.toolName !== undefined && !sameTool(name, first.toolName)) {
			throw new TrajectorySyncError(`Native tool step ${step.idx} is ${name}; expected ${first.toolName}`);
		}
		results = [first];
		texts = [native.text];
	}
	const mismatch = () => new TrajectorySyncError(`Native tool step ${step.idx} does not match pi's prior tool result`);
	// Pi's text as agy last received it (saved warm text). A result completed
	// since the last warm save has none: pi may already have rewritten it.
	const expected = (descriptor: Descriptor): string | undefined => descriptor.previousText;
	const images = (descriptor: Descriptor) => descriptor.message ? imageCount(descriptor.message) : descriptor.previousMediaHash ? 1 : 0;
	const following = start + results.length;
	let steering = "";
	let absorbed: Descriptor[] = [];
	const lastIndex = texts.length - 1;
	const last = texts[lastIndex]!;
	const lastExpected = expected(results[lastIndex]!);
	if (lastExpected === undefined) {
		// Absorb a trailing steering block only when it carries exactly the pi
		// user messages that follow; otherwise those users fail to map.
		const at = last.lastIndexOf(STEERING_HEADER);
		if (at >= 0) {
			try {
				absorbed = steeringUsers(step.idx, last.slice(at), descriptors, following);
				steering = last.slice(at);
			} catch {
				absorbed = [];
			}
		}
	} else if (!sameResultText(last, lastExpected, images(results[lastIndex]!))) {
		const base = [lastExpected, deliveredText(lastExpected, images(results[lastIndex]!))].find((text) => last.startsWith(`${text}${STEERING_HEADER}`));
		if (base === undefined) throw mismatch();
		steering = last.slice(base.length);
		absorbed = steeringUsers(step.idx, steering, descriptors, following);
	}
	if (steering) texts[lastIndex] = last.slice(0, -steering.length);
	results.forEach((descriptor, index) => {
		const text = expected(descriptor);
		if (text !== undefined && !sameResultText(texts[index]!, text, images(descriptor))) throw mismatch();
	});
	return { step, native, entries, results, texts, steering, absorbed };
}

// Fresh sessions currently place the initial user message inside a transcript
// resource in one native step. Accept only the single-text-message shape; a
// multi-message resource cannot safely be mapped one step per Pi message.
function isInitialWrappedUser(step: NativeStep, text: string): boolean {
	if (step.idx !== 0 || !text) return false;
	const actual = nativeText(step) ?? "";
	const prefix = "Content of pi://transcript:\n";
	const suffix = `<user>\n${text}\n</user>${FRESH_PROMPT}`;
	if (!actual.startsWith(prefix) || !actual.endsWith(suffix)) return false;
	const header = actual.slice(prefix.length, actual.length - suffix.length);
	return header === "" || (header.startsWith("<pi-system>\n") && header.endsWith("\n</pi-system>\n\n") && header.indexOf("</pi-system>") === header.length - "</pi-system>\n\n".length);
}
interface Mapping {
	mapped: MappedStep[];
	/** Native position carrying each descriptor, in descriptor order. */
	positions: number[];
	/** Optional descriptors that own no native step (their position is the next step's). */
	skipped: Set<number>;
}

/** Strict ordered mapping: skipping another semantic step would leave stale
 *  native history, so only non-message bookkeeping steps and bridge-local
 *  rejections pi never saw may intervene. One native tool step carries one pi
 *  result, every result of a parallel batch, and any steering users appended
 *  to its last result. */
function mapSteps(steps: NativeStep[], descriptors: Descriptor[], startPosition = 0): Mapping {
	const mapped: MappedStep[] = [];
	const positions: number[] = [];
	const skipped = new Set<number>();
	const orphans = bridgeOrphans(steps);
	let position = startPosition;
	let index = 0;
	while (index < descriptors.length) {
		const descriptor = descriptors[index]!;
		while (position < steps.length && (![USER_STEP, ASSISTANT_STEP, TOOL_RESULT_STEP].includes(steps[position]!.type) || orphans.has(steps[position]!.idx))) {
			if (steps[position]!.type === CHECKPOINT_STEP) {
				throw new TrajectorySyncError("Native agy compaction checkpoints require explicit migration before context sync");
			}
			position++;
		}
		const step = steps[position];
		if (descriptor.optional) {
			// An empty failed/aborted turn: it owns the next native planner step
			// only when agy recorded one (the prompt reached the model).
			const next = descriptors[index + 1];
			positions.push(position);
			if (step?.type === ASSISTANT_STEP && next?.role !== "assistant") {
				mapped.push({ step, position, descriptor });
				position++;
			} else {
				skipped.add(index);
			}
			index++;
			continue;
		}
		if (!step) throw new TrajectorySyncError(`Native trajectory ended before ${descriptor.role} message ${index + 1}`);
		const expected = semanticType(descriptor.role);
		if (step.type !== expected) {
			throw new TrajectorySyncError(`Native step ${step.idx} has type ${step.type}; expected ${expected} for ${descriptor.role}`);
		}
		if (descriptor.role === "user" && descriptor.userText !== undefined && nativeText(step) !== descriptor.userText && !isInitialWrappedUser(step, descriptor.userText)) {
			throw new TrajectorySyncError(`Native user step ${step.idx} does not match pi's prior user message`);
		}
		if (descriptor.role === "toolResult") {
			const group = toolGroup(step, descriptors, index);
			const carried = group.results.length + group.absorbed.length;
			for (let offset = 0; offset < carried; offset++) positions.push(position);
			mapped.push({ step, position, descriptor, group });
			index += carried;
		} else {
			positions.push(position);
			mapped.push({ step, position, descriptor });
			index++;
		}
		position++;
	}
	return { mapped, positions, skipped };
}

function sameIdentity(message: Message, item: WarmItem): boolean {
	const current = warmItemsForMessages([message])[0];
	if (current?.role !== item.role) return false;
	if (current.key === item.key && current.userText === item.userText) return true;
	// realctx replaces a dropped user image with a placeholder, intentionally
	// changing the user text/key while retaining the same native user step.
	return message.role === "user" && item.syncMediaHash !== undefined && current.syncMediaHash === undefined &&
		current.userText === item.userText && REALCTX_USER_IMAGE_DROP.test(textContent(message));
}

/** Separator between consecutive history summaries in their shared native
 *  user step. */
const SUMMARY_JOIN = "\n\n";

/** Number of consecutive history summaries opening pi's effective context.
 *  realctx can apply several history parts in one request, and pi compaction
 *  can follow a realctx summary; agy holds them all in its first user step. */
function leadingSummaryCount(messages: Message[]): number {
	let count = 0;
	while (count < messages.length && messages[count]!.role === "user" && isHistorySummary(messages[count]!)) count++;
	return count;
}

function leadingSummaryItemCount(items: WarmItem[]): number {
	let count = 0;
	while (count < items.length && items[count]!.role === "user" && items[count]!.summary === true) count++;
	return count;
}

/** The single warm item standing for the summaries that share agy's first
 *  native user step. */
function mergedSummaryItem(items: WarmItem[], count: number): WarmItem {
	if (count <= 1) return items[0]!;
	const texts = items.slice(0, count).map((item) => item.syncText ?? item.userText ?? "");
	return { role: "user", key: items[0]!.key, userText: texts.join(SUMMARY_JOIN), syncText: texts.join(SUMMARY_JOIN), summary: true };
}

/** Native descriptors for warm items, with leading summaries merged into one
 *  user step; `positionOf` maps a warm item index to its native position. */
function mapWarmItems(steps: NativeStep[], items: WarmItem[]): { positionOf: (index: number) => number; ownsStep: (index: number) => boolean } {
	const merged = leadingSummaryItemCount(items);
	const collapsed = merged > 1 ? [mergedSummaryItem(items, merged), ...items.slice(merged)] : items;
	const { positions, skipped } = mapSteps(steps, collapsed.map(descriptorForWarmItem));
	const at = (index: number) => merged > 1 ? Math.max(0, index - merged + 1) : index;
	return { positionOf: (index) => positions[at(index)]!, ownsStep: (index) => !skipped.has(at(index)) };
}

/** Locate the unchanged old suffix after new history summaries. Tool-result
 *  keys use toolCallId/toolName, so realctx drops do not change identity. */
function summarySuffixStart(messages: Message[], summaries: number, previousItems: WarmItem[]): number {
	const tail = messages.slice(summaries);
	const candidates: number[] = [];
	for (let start = Math.max(1, leadingSummaryItemCount(previousItems)); start < previousItems.length; start++) {
		const oldSuffix = previousItems.slice(start);
		if (tail.length < oldSuffix.length) continue;
		if (oldSuffix.every((item, offset) => sameIdentity(tail[offset]!, item))) candidates.push(start);
	}
	if (candidates.length !== 1) {
		throw new TrajectorySyncError(`History summary boundary is not unique (${candidates.length} candidates)`);
	}
	return candidates[0]!;
}

function onlyField(part: Uint8Array, number: number): boolean {
	const fields = decodeProtoFields(part);
	return fields.length === 1 && fields[0]!.number === number && fields[0]!.wire === 2;
}

/** Rewrite the verified rendering parts of a tool step: the Markdown text part
 *  must end with exactly pi's previous result, and resource parts must name
 *  the stored media URIs in order. Dropped media lose their resource parts. */
function rewriteToolRender(idx: number, parts: Buffer[], native: NativeToolResult, newText: string, keepMedia: boolean): (Buffer | null)[] {
	const unverified = () => new TrajectorySyncError(`Native tool step ${idx} has an unverified result mirror; refusing partial synchronization`);
	const [textPart, ...resources] = parts;
	if (!textPart || !onlyField(textPart, 1) || resources.length !== native.mediaUris.length) throw unverified();
	resources.forEach((part, index) => {
		if (!onlyField(part, 2) || optionalProtoBytesAt(part, [2, 1])?.toString("utf8") !== native.mediaUris[index]) throw unverified();
	});
	const rendered = protoTextAt(textPart, [1]);
	// agy renders only a display excerpt of the result; the model reads 140.2.1.
	// Rewrite it only when the excerpt rule reproduces the existing rendering.
	const suffix = displayedResult(native.text);
	if (!rendered.startsWith("**Arguments**\n```json\n") || !rendered.endsWith(suffix)) throw unverified();
	const rewritten = `${rendered.slice(0, -suffix.length)}${displayedResult(newText)}`;
	return [setProtoText(textPart, [1], rewritten), ...resources.map((part) => keepMedia ? part : null)];
}

function editedPayload(step: NativeStep, descriptor: Descriptor): Uint8Array {
	const message = descriptor.message;
	if (!message) return step.payload;
	let payload = step.payload;
	const currentMediaHash = warmItemsForMessages([message])[0]?.syncMediaHash;
	const mediaChanged = descriptor.hasPrevious && currentMediaHash !== descriptor.previousMediaHash;
	if (mediaChanged && currentMediaHash !== undefined) {
		throw new TrajectorySyncError(`Native step ${step.idx} requires an image replacement; only verified image drops are supported`);
	}
	if (message.role === "user") {
		if (descriptor.userText !== undefined && isInitialWrappedUser(step, descriptor.userText)) {
			if (mediaChanged) throw new TrajectorySyncError("Editing media in an initial transcript resource is not yet supported safely");
			if (textContent(message) === descriptor.userText) return payload;
			if (!isHistorySummary(message)) throw new TrajectorySyncError("Editing an initial transcript resource is not yet supported safely");
			// Preserve the original system header and fresh-session wrapper, replacing
			// only the uniquely verified single-user payload with the summary.
			const actual = nativeText(step)!;
			const suffix = `<user>\n${descriptor.userText}\n</user>${FRESH_PROMPT}`;
			const rewritten = `${actual.slice(0, -suffix.length)}<user>\n${textContent(message)}\n</user>${FRESH_PROMPT}`;
			payload = replaceRepeatedProtoTextPart(payload, [19], 3, 1, actual, [
				{ oldPart: actual, newPart: rewritten },
				{ oldPart: actual.slice(0, -FRESH_PROMPT.length), newPart: rewritten.slice(0, -FRESH_PROMPT.length) },
			]);
			payload = setProtoText(payload, USER_TEXT, rewritten);
			return payload;
		}
		const prompt = nativeUserPrompt(textContent(message), currentMediaHash);
		if (mediaChanged) {
			// The verified layout keeps media only in repeated 19.9 and the prompt
			// mirror 19.3 as text alone; anything else may hide another copy.
			const items = optionalProtoBytesAt(payload, USER_ITEMS);
			if (repeatedProtoBytesAt(payload, USER_MEDIA).length === 0 || (items !== undefined && decodeProtoFields(items).some((field) => field.number !== 1))) {
				throw new TrajectorySyncError(`Native user step ${step.idx} has an unverified media layout`);
			}
			payload = removeProtoFields(payload, USER_MEDIA);
		}
		payload = setProtoText(payload, USER_TEXT, prompt);
		if (optionalProtoBytesAt(payload, [19, 3, 1]) !== undefined) {
			payload = setProtoText(payload, [19, 3, 1], prompt);
		}
		return payload;
	}
	return payload;
}

/** Rewrite a native tool step to the current text of the pi results it
 *  carries, keeping agy's delivery framing (parallel JSON, steering block). */
function editedToolPayload(group: ToolGroup): Uint8Array {
	const { step, native } = group;
	let payload = step.payload;
	for (const user of group.absorbed) {
		if (user.message && textContent(user.message) !== user.userText) {
			throw new TrajectorySyncError(`Native tool step ${step.idx} carries a steering message pi has since changed`);
		}
	}
	const states = group.results.map((descriptor) => {
		const message = descriptor.message;
		if (!message) throw new TrajectorySyncError(`Native tool step ${step.idx} has no current pi result`);
		const currentMediaHash = warmItemsForMessages([message])[0]?.syncMediaHash;
		const mediaChanged = descriptor.hasPrevious && currentMediaHash !== descriptor.previousMediaHash;
		if (mediaChanged && currentMediaHash !== undefined) {
			throw new TrajectorySyncError(`Native step ${step.idx} requires an image replacement; only verified image drops are supported`);
		}
		return { descriptor, text: textContent(message), images: imageCount(message), mediaChanged };
	});
	const mediaChanged = states.some((state) => state.mediaChanged);
	// Preserve the native representation byte-for-byte for unchanged results,
	// including a newly completed tool result already present on the trajectory.
	if (!mediaChanged && states.every((state, index) => sameResultText(group.texts[index]!, state.text, state.images))) return payload;
	const hasPrevious = group.results.every((descriptor) => descriptor.hasPrevious);
	let newText: string;
	if (group.entries) {
		if (mediaChanged) throw new TrajectorySyncError(`Native parallel step ${step.idx} has an unverified media layout`);
		const results = group.entries.map((entry, index) => ({
			...entry,
			content: entry.content.map((block, blockIndex) => blockIndex === 0 ? { type: "text", text: deliveredText(states[index]!.text, states[index]!.images) } : block),
		}));
		newText = `${JSON.stringify({ results }, null, 2)}${group.steering}`;
	} else {
		newText = `${states[0]!.text}${group.steering}`;
	}
	if (native.error) {
		// A pi tool error: the rendering shows only the arguments, and the
		// error text plus its mirror are the whole model-visible outcome.
		if (mediaChanged || !hasPrevious) {
			throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified error layout`);
		}
		if (repeatedProtoBytesAt(payload, TOOL_RENDER_PARTS).some((part) => optionalProtoBytesAt(part, [1])?.toString("utf8").includes("\n\n**Result**\n"))) {
			throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified result mirror; refusing partial synchronization`);
		}
		payload = setProtoText(payload, TOOL_ERROR_TEXT, newText);
		return setProtoText(payload, TOOL_ERROR_MIRROR, newText);
	}
	if (mediaChanged && native.mediaUris.length === 0) {
		throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified media layout`);
	}
	const keepMedia = !mediaChanged;
	if (optionalProtoBytesAt(payload, TOOL_RENDER) !== undefined) {
		// Only the verified Pi-bridge rendering is supported: one Markdown text
		// part ending with the result, then one resource part per medium. Never
		// guess how to rewrite other native renderings.
		if (!hasPrevious) {
			throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified result mirror; refusing partial synchronization`);
		}
		payload = rewriteRepeatedProtoFields(payload, TOOL_RENDER_PARTS, (parts) =>
			rewriteToolRender(step.idx, parts, native, newText, keepMedia));
	}
	payload = setProtoText(payload, TOOL_TEXT, keepMedia ? newText + native.suffix : newText);
	if (!keepMedia) payload = removeProtoFields(payload, TOOL_MEDIA);
	return payload;
}

export interface TrajectorySyncOptions {
	/** pi cancelled the parked native turn to synchronize; unmapped trailing
	 *  planner/tool steps belong to that discarded generation. */
	discardCancelledTail?: boolean;
}
export interface TrajectorySyncResult {
	editedSteps: number;
	deletedSteps: number;
	summary: boolean;
}

/** Edit the persisted trajectory to exactly the mappable effective pi context.
 *  `hasNewUser` excludes the final user message: the subsequent native prompt
 *  will append it. With no new user, that prompt is the verified empty native
 *  continuation and all current tool results must already have native steps.
 *  With `discardCancelledTail`, planner/tool steps after the mapped prefix are
 *  the cancelled generation pi never received and are removed; any later user
 *  or checkpoint step still fails closed. */
export function synchronizeConversation(
	dbPath: string,
	messages: Message[],
	previousItems: WarmItem[],
	hasNewUser: boolean,
	options: TrajectorySyncOptions = {},
): TrajectorySyncResult {
	if (!fs.existsSync(dbPath)) throw new TrajectorySyncError(`Conversation store does not exist: ${dbPath}`);
	const DatabaseSync = loadSqlite().DatabaseSync;
	const db: Database = new DatabaseSync(dbPath, { timeout: 2_000 });
	let transaction = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		transaction = true;
		const columns = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
		const hasRenderInfo = columns.some((column) => column.name === "render_info");
		// Optional columns (status, render_info) are absent in older schemas.
		const rows = db.prepare("SELECT * FROM steps ORDER BY idx ASC").all() as Array<{
			idx: number | bigint;
			step_type: number;
			status?: number | bigint;
			step_payload: Uint8Array | null;
			render_info?: Uint8Array | null;
			error_details?: Uint8Array | null;
		}>;
		const steps: NativeStep[] = rows.map((row) => {
			if (!(row.step_payload instanceof Uint8Array)) {
				throw new TrajectorySyncError(`Native step ${row.idx} has no protobuf payload`);
			}
			return {
				idx: Number(row.idx),
				type: row.step_type,
				payload: row.step_payload,
				renderInfo: row.render_info,
				errorDetails: row.error_details,
				status: row.status === undefined ? undefined : Number(row.status),
			};
		});
		if (steps.some((step) => step.type === CHECKPOINT_STEP)) {
			throw new TrajectorySyncError("Native agy compaction checkpoints require explicit migration before context sync");
		}
		const effective = persistentMessages(messages).filter((message) => message.role !== "system");
		if (hasNewUser) {
			if (effective.at(-1)?.role !== "user") throw new TrajectorySyncError("New native input is not the final pi user message");
			effective.pop();
		}
		if (effective.length === 0) throw new TrajectorySyncError("Effective pi context has no native messages to synchronize");

		const summaries = leadingSummaryCount(effective);
		const summary = summaries > 0;
		const summaryMessage: Message | undefined = summaries > 1
			? { role: "user", content: effective.slice(0, summaries).map(textContent).join(SUMMARY_JOIN), timestamp: (effective[0] as { timestamp: number }).timestamp }
			: effective[0];
		const updates = new Map<number, Uint8Array>();
		const deletes = new Set<number>();
		let mapped: MappedStep[];
		if (summary) {
			if (previousItems.length < 2) throw new TrajectorySyncError("Cannot locate summary replacement without the previous native prefix");
			const oldMapping = mapWarmItems(steps, previousItems);
			const suffixStart = summarySuffixStart(effective, summaries, previousItems);
			const summaryStep = steps[oldMapping.positionOf(0)]!;
			if (summaryStep.type !== USER_STEP) throw new TrajectorySyncError("History summary must replace a native user step");
			const tailPosition = oldMapping.positionOf(suffixStart);
			if (oldMapping.ownsStep(suffixStart - 1) && tailPosition === oldMapping.positionOf(suffixStart - 1)) {
				throw new TrajectorySyncError("History summary boundary splits one native tool step");
			}
			// No native step left after the summary only when the whole retained
			// suffix is empty failed turns agy never recorded.
			const tailIdx = steps[tailPosition]?.idx ?? Number.POSITIVE_INFINITY;
			for (const step of steps) {
				if (step.idx > summaryStep.idx && step.idx < tailIdx) deletes.add(step.idx);
			}
			const summaryDescriptor = descriptorForMessage(summaryMessage!, mergedSummaryItem(previousItems, leadingSummaryItemCount(previousItems)));
			const summaryPayload = editedPayload(summaryStep, summaryDescriptor);
			if (!Buffer.from(summaryPayload).equals(Buffer.from(summaryStep.payload))) updates.set(summaryStep.idx, summaryPayload);
			const tail = effective.slice(summaries).map((message, offset) => descriptorForMessage(message, previousItems[suffixStart + offset]));
			const tailMapped = mapSteps(steps, tail, tailPosition).mapped;
			mapped = [{ step: summaryStep, position: 0, descriptor: summaryDescriptor }, ...tailMapped];
		} else {
			if (effective.length < previousItems.length) {
				throw new TrajectorySyncError("Messages were removed without a history summary; native prefix deletion is ambiguous");
			}
			const added = effective.slice(previousItems.length);
			if (added.some((message) => message.role !== "toolResult" && !isEmptyFailedAssistant(message))) {
				throw new TrajectorySyncError("Only newly completed tool results may be appended during native continuation");
			}
			for (let index = 0; index < previousItems.length; index++) {
				if (!sameIdentity(effective[index]!, previousItems[index]!)) {
					throw new TrajectorySyncError(`Pi message ${index + 1} changed identity; only tool-result/image drops are safely mappable`);
				}
			}
			mapped = mapSteps(steps, effective.map((message, index) => descriptorForMessage(message, previousItems[index]))).mapped;
		}

		const lastPosition = mapped.at(-1)?.position ?? -1;
		const orphans = bridgeOrphans(steps);
		for (const step of steps.slice(lastPosition + 1)) {
			if (deletes.has(step.idx) || ![USER_STEP, ASSISTANT_STEP, TOOL_RESULT_STEP, CHECKPOINT_STEP].includes(step.type)) continue;
			if (options.discardCancelledTail && (step.type === ASSISTANT_STEP || step.type === TOOL_RESULT_STEP)) {
				deletes.add(step.idx);
				continue;
			}
			if (orphans.has(step.idx)) continue;
			throw new TrajectorySyncError(`Native step ${step.idx} is not represented in pi's effective context`);
		}
		for (const item of mapped) {
			if (summary && item.descriptor.message === summaryMessage) continue;
			if (!item.descriptor.message) continue;
			const payload = item.group ? editedToolPayload(item.group) : editedPayload(item.step, item.descriptor);
			if (!Buffer.from(payload).equals(Buffer.from(item.step.payload))) updates.set(item.step.idx, payload);
		}

		if (hasRenderInfo) {
			const updateRender = db.prepare("UPDATE steps SET render_info = ? WHERE idx = ?");
			for (const step of steps) {
				const updated = updates.get(step.idx);
				if (!updated || step.type !== TOOL_RESULT_STEP) continue;
				const oldMirror = optionalProtoBytesAt(step.payload, TOOL_RENDER);
				if (oldMirror === undefined) continue;
				const newMirror = optionalProtoBytesAt(updated, TOOL_RENDER);
				if (!step.renderInfo || !Buffer.from(step.renderInfo).equals(oldMirror) || newMirror === undefined) {
					throw new TrajectorySyncError(`Native tool step ${step.idx} has an inconsistent independent rendering mirror`);
				}
				updateRender.run(newMirror, step.idx);
			}
		}
		if (columns.some((column) => column.name === "error_details")) {
			// agy repeats a pi tool error in error_details as fields 2 and 3.
			const updateDetails = db.prepare("UPDATE steps SET error_details = ? WHERE idx = ?");
			for (const step of steps) {
				const updated = updates.get(step.idx);
				if (!updated || step.type !== TOOL_RESULT_STEP) continue;
				const oldError = nativeToolError(step);
				if (oldError === undefined) continue;
				const details = step.errorDetails;
				const layout = details ? decodeProtoFields(details).map((field) => `${field.number}:${field.wire}`).join(",") : "";
				if (!details || layout !== "2:2,3:2" || protoTextAt(details, [2]) !== oldError || protoTextAt(details, [3]) !== oldError) {
					throw new TrajectorySyncError(`Native tool step ${step.idx} has inconsistent error details`);
				}
				const newError = protoTextAt(updated, TOOL_ERROR_TEXT);
				updateDetails.run(setProtoText(setProtoText(details, [2], newError), [3], newError), step.idx);
			}
		}
		const update = db.prepare("UPDATE steps SET step_payload = ? WHERE idx = ?");
		for (const [idx, payload] of updates) update.run(payload, idx);
		const remove = db.prepare("DELETE FROM steps WHERE idx = ?");
		for (const idx of deletes) remove.run(idx);
		db.exec("COMMIT");
		transaction = false;
		return { editedSteps: updates.size, deletedSteps: deletes.size, summary };
	} catch (error) {
		if (transaction) {
			try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
		}
		if (error instanceof TrajectorySyncError) throw error;
		throw new TrajectorySyncError(`Failed to synchronize native trajectory: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		db.close();
	}
}
