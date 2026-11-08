// Synchronize pi's effective context into agy's native trajectory, in place.
// No transcript-priming messages are generated: known user/tool protobuf fields
// are edited and a compaction/history summary replaces the native prefix it
// covers. The caller must stop the ACP process before opening the store.

import { createRequire } from "node:module";
import fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { FRESH_PROMPT, IMAGE_ONLY_PROMPT, isHistorySummary, REALCTX_USER_IMAGE_DROP, persistentMessages, warmItemsForMessages, type WarmItem } from "../transcript.js";
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
	message?: Message;
}

interface MappedStep {
	step: NativeStep;
	position: number;
	descriptor: Descriptor;
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
}

/** Split a native tool result into pi's text and agy's media references. Each
 *  stored medium must be announced by exactly one trailing offload line with
 *  its URI, in order; any other layout fails closed. */
function nativeToolResult(step: NativeStep): NativeToolResult {
	const raw = protoTextAt(step.payload, TOOL_TEXT);
	const mediaUris = repeatedProtoBytesAt(step.payload, TOOL_MEDIA).map((entry) => {
		const uri = optionalProtoBytesAt(entry, TOOL_MEDIA_URI)?.toString("utf8");
		if (!uri) throw new TrajectorySyncError(`Native tool step ${step.idx} has media without a file URI`);
		return uri;
	});
	if (mediaUris.length === 0) return { text: raw, mediaUris, suffix: "" };
	const lines = mediaUris.map((uri) => `[Resource offloaded to ${uri}]`);
	const suffix = `\n${lines.join("\n")}`;
	if (raw.endsWith(suffix)) return { text: raw.slice(0, -suffix.length), mediaUris, suffix };
	if (raw === suffix.slice(1)) return { text: "", mediaUris, suffix: raw };
	throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified media layout`);
}

function semanticType(role: Descriptor["role"]): number {
	return role === "user" ? USER_STEP : role === "assistant" ? ASSISTANT_STEP : TOOL_RESULT_STEP;
}

function nativeText(step: NativeStep): string | undefined {
	if (step.type === USER_STEP) return protoTextAt(step.payload, USER_TEXT);
	if (step.type === TOOL_RESULT_STEP) return protoTextAt(step.payload, TOOL_TEXT);
	return undefined;
}

function sameTool(nativeName: string, piName: string): boolean {
	return nativeName === piName || nativeName === `mcp_pi-bridge_${piName}`;
}

function comparableNativeText(step: NativeStep): string {
	if (step.type !== TOOL_RESULT_STEP) return nativeText(step) ?? "";
	return nativeToolResult(step).text.replace(/^Stored tool value: /, "").replace(/\n$/, "");
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
/** Strict ordered mapping: skipping another semantic step would leave stale
 *  native history, so only non-message bookkeeping steps may intervene. */
function mapSteps(steps: NativeStep[], descriptors: Descriptor[], startPosition = 0): MappedStep[] {
	const mapped: MappedStep[] = [];
	let position = startPosition;
	for (const descriptor of descriptors) {
		while (position < steps.length && ![USER_STEP, ASSISTANT_STEP, TOOL_RESULT_STEP].includes(steps[position]!.type)) {
			if (steps[position]!.type === CHECKPOINT_STEP) {
				throw new TrajectorySyncError("Native agy compaction checkpoints require explicit migration before context sync");
			}
			position++;
		}
		const step = steps[position];
		if (!step) throw new TrajectorySyncError(`Native trajectory ended before ${descriptor.role} message ${mapped.length + 1}`);
		const expected = semanticType(descriptor.role);
		if (step.type !== expected) {
			throw new TrajectorySyncError(`Native step ${step.idx} has type ${step.type}; expected ${expected} for ${descriptor.role}`);
		}
		if (descriptor.role === "user" && descriptor.userText !== undefined && nativeText(step) !== descriptor.userText && !isInitialWrappedUser(step, descriptor.userText)) {
			throw new TrajectorySyncError(`Native user step ${step.idx} does not match pi's prior user message`);
		}
		if (descriptor.role === "toolResult") {
			const name = protoTextAt(step.payload, TOOL_NAME);
			if (!name) throw new TrajectorySyncError(`Native tool step ${step.idx} has no recognizable MCP tool name`);
			if (optionalProtoBytesAt(step.payload, TOOL_TEXT) === undefined) {
				throw new TrajectorySyncError(`Native tool step ${step.idx} has no recorded result (status ${step.status ?? "unknown"}); its pi result never reached agy`);
			}
			if (descriptor.toolName !== undefined && !sameTool(name, descriptor.toolName)) {
				throw new TrajectorySyncError(`Native tool step ${step.idx} is ${name}; expected ${descriptor.toolName}`);
			}
			if (descriptor.previousText !== undefined && comparableNativeText(step) !== descriptor.previousText) {
				throw new TrajectorySyncError(`Native tool step ${step.idx} does not match pi's prior tool result`);
			}
		}
		mapped.push({ step, position, descriptor });
		position++;
	}
	return mapped;
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

/** Locate the unchanged old suffix after a new history summary. Tool-result
 *  keys use toolCallId/toolName, so realctx drops do not change identity. */
function summarySuffixStart(messages: Message[], previousItems: WarmItem[]): number {
	const tail = messages.slice(1);
	const candidates: number[] = [];
	for (let start = 1; start < previousItems.length; start++) {
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
	const suffix = `\n\n**Result**\n\`\`\`\n${native.text}\n\`\`\``;
	if (!rendered.startsWith("**Arguments**\n```json\n") || !rendered.endsWith(suffix)) throw unverified();
	const rewritten = `${rendered.slice(0, -suffix.length)}\n\n**Result**\n\`\`\`\n${newText}\n\`\`\``;
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
	if (message.role === "toolResult") {
		const native = nativeToolResult(step);
		const newText = textContent(message);
		// Preserve the native representation byte-for-byte for unchanged results,
		// including a newly completed tool result already present on the trajectory.
		if ((descriptor.hasPrevious ? comparableNativeText(step) : native.text) === newText && !mediaChanged) return payload;
		if (mediaChanged && native.mediaUris.length === 0) {
			throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified media layout`);
		}
		const keepMedia = !mediaChanged;
		if (optionalProtoBytesAt(payload, TOOL_RENDER) !== undefined) {
			// Only the verified Pi-bridge rendering is supported: one Markdown text
			// part ending with the result, then one resource part per medium. Never
			// guess how to rewrite other native renderings.
			if (!descriptor.hasPrevious) {
				throw new TrajectorySyncError(`Native tool step ${step.idx} has an unverified result mirror; refusing partial synchronization`);
			}
			payload = rewriteRepeatedProtoFields(payload, TOOL_RENDER_PARTS, (parts) =>
				rewriteToolRender(step.idx, parts, native, newText, keepMedia));
		}
		payload = setProtoText(payload, TOOL_TEXT, keepMedia ? newText + native.suffix : newText);
		if (!keepMedia) payload = removeProtoFields(payload, TOOL_MEDIA);
		return payload;
	}
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
		}>;
		const steps: NativeStep[] = rows.map((row) => {
			if (!(row.step_payload instanceof Uint8Array)) {
				throw new TrajectorySyncError(`Native step ${row.idx} has no protobuf payload`);
			}
			return { idx: Number(row.idx), type: row.step_type, payload: row.step_payload, renderInfo: row.render_info, status: row.status === undefined ? undefined : Number(row.status) };
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

		const summary = isHistorySummary(effective[0]!);
		const updates = new Map<number, Uint8Array>();
		const deletes = new Set<number>();
		let mapped: MappedStep[];
		if (summary) {
			if (previousItems.length < 2) throw new TrajectorySyncError("Cannot locate summary replacement without the previous native prefix");
			const oldMapped = mapSteps(steps, previousItems.map(descriptorForWarmItem));
			const suffixStart = summarySuffixStart(effective, previousItems);
			const summaryStep = oldMapped[0]!.step;
			if (summaryStep.type !== USER_STEP) throw new TrajectorySyncError("History summary must replace a native user step");
			const tailFirst = oldMapped[suffixStart]!.step;
			for (const step of steps) {
				if (step.idx > summaryStep.idx && step.idx < tailFirst.idx) deletes.add(step.idx);
			}
			const summaryDescriptor = descriptorForMessage(effective[0]!, previousItems[0]);
			updates.set(summaryStep.idx, editedPayload(summaryStep, summaryDescriptor));
			const tail = effective.slice(1).map((message, offset) => descriptorForMessage(message, previousItems[suffixStart + offset]));
			const tailMapped = mapSteps(steps, tail, oldMapped[suffixStart]!.position);
			mapped = [{ step: summaryStep, position: 0, descriptor: summaryDescriptor }, ...tailMapped];
		} else {
			if (effective.length < previousItems.length) {
				throw new TrajectorySyncError("Messages were removed without a history summary; native prefix deletion is ambiguous");
			}
			const added = effective.slice(previousItems.length);
			if (added.some((message) => message.role !== "toolResult")) {
				throw new TrajectorySyncError("Only newly completed tool results may be appended during native continuation");
			}
			for (let index = 0; index < previousItems.length; index++) {
				if (!sameIdentity(effective[index]!, previousItems[index]!)) {
					throw new TrajectorySyncError(`Pi message ${index + 1} changed identity; only tool-result/image drops are safely mappable`);
				}
			}
			mapped = mapSteps(steps, effective.map((message, index) => descriptorForMessage(message, previousItems[index])));
		}

		const lastPosition = mapped.at(-1)?.position ?? -1;
		for (const step of steps.slice(lastPosition + 1)) {
			if (![USER_STEP, ASSISTANT_STEP, TOOL_RESULT_STEP, CHECKPOINT_STEP].includes(step.type)) continue;
			if (options.discardCancelledTail && (step.type === ASSISTANT_STEP || step.type === TOOL_RESULT_STEP)) {
				deletes.add(step.idx);
				continue;
			}
			throw new TrajectorySyncError(`Native step ${step.idx} is not represented in pi's effective context`);
		}
		for (const item of mapped) {
			if (summary && item.descriptor.message === effective[0]) continue;
			if (!item.descriptor.message) continue;
			const payload = editedPayload(item.step, item.descriptor);
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
