// Exact per-model-call token usage from the official server's conversation
// store. `agy acp` sends no per-model-call usage over ACP; it persists each
// generation step in ~/.gemini/antigravity-cli/conversations/<sessionId>.db
// (table `steps`).
// Agent steps (step_type 15) carry a usage message in metadata field 9:
//   2 = input tokens (uncached), 3 = output tokens, 5 = cache-read tokens
//   (verified by simonepri/refined-antigravity-acp, src/fixes/missing-usage-metrics),
//   4 = cache-write tokens (Cascade ModelUsageStats layout; unverified, and
//   zero for Gemini's implicit caching).
// Every failure degrades to `undefined`: this is an internal format.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { agyDataDir } from "./setup.js";
/** steps.step_type of a model (agent) response; 14 is user input. */
const STEP_TYPE_AGENT = 15;
/** node:sqlite is synchronous: a locked store must not stall pi's event loop. */
const BUSY_TIMEOUT_MS = 100;

export interface StepTokens {
	idx: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Sum of the model calls since a cursor, plus the occupancy of the latest. */
export interface StepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** input + cacheRead + cacheWrite + output of the LATEST call: the context
	 *  the model actually held, which is what pi's totalTokens means. */
	contextTokens: number;
	steps: number;
	lastIdx: number;
}

type SqliteModule = typeof import("node:sqlite");
let sqlite: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
	if (sqlite !== undefined) return sqlite;
	// Node 22 prints an ExperimentalWarning on first load; it would corrupt
	// pi's TUI, so it is swallowed for this one require only.
	const emitWarning = process.emitWarning;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	try {
		sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
	} catch {
		sqlite = null;
	} finally {
		process.emitWarning = emitWarning;
	}
	return sqlite;
}

export function defaultConversationsDir(): string {
	return path.join(agyDataDir(), "conversations");
}

export function conversationDbPath(dir: string, sessionId: string): string | undefined {
	if (!/^[\w.-]+$/.test(sessionId)) return undefined;
	return path.join(dir, `${sessionId}.db`);
}

// --- minimal protobuf reader ---------------------------------------------------

function readVarint(buf: Uint8Array, pos: number): [number, number] | undefined {
	let result = 0;
	let shift = 0;
	for (let i = pos; i < buf.length && shift < 64; i++) {
		const byte = buf[i]!;
		result += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return [result, i + 1];
		shift += 7;
	}
	return undefined;
}

type ProtoValue = { wire: 0; value: number } | { wire: 2; bytes: Uint8Array };

/** First occurrence of each field number; unknown wire types abort parsing. */
export function parseProtoFields(buf: Uint8Array): Map<number, ProtoValue> {
	const fields = new Map<number, ProtoValue>();
	let pos = 0;
	while (pos < buf.length) {
		const tag = readVarint(buf, pos);
		if (!tag) break;
		pos = tag[1];
		const field = Math.floor(tag[0] / 8);
		const wire = tag[0] & 7;
		if (wire === 0) {
			const value = readVarint(buf, pos);
			if (!value) break;
			pos = value[1];
			if (!fields.has(field)) fields.set(field, { wire: 0, value: value[0] });
		} else if (wire === 2) {
			const length = readVarint(buf, pos);
			if (!length || length[1] + length[0] > buf.length) break;
			const bytes = buf.subarray(length[1], length[1] + length[0]);
			pos = length[1] + length[0];
			if (!fields.has(field)) fields.set(field, { wire: 2, bytes });
		} else if (wire === 1) {
			pos += 8;
		} else if (wire === 5) {
			pos += 4;
		} else {
			break;
		}
	}
	return fields;
}

export function tokensFromMetadata(metadata: Uint8Array, idx: number): StepTokens | undefined {
	const stats = parseProtoFields(metadata).get(9);
	if (!stats || stats.wire !== 2) return undefined;
	const fields = parseProtoFields(stats.bytes);
	const count = (n: number): number => {
		const value = fields.get(n);
		return value?.wire === 0 && Number.isSafeInteger(value.value) ? value.value : 0;
	};
	const tokens = { idx, input: count(2), output: count(3), cacheWrite: count(4), cacheRead: count(5) };
	return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 ? tokens : undefined;
}

type Database = InstanceType<SqliteModule["DatabaseSync"]>;

/** Run `fn` on a short-lived connection; any failure (missing store, lock,
 *  schema drift, no node:sqlite) yields undefined. */
function withDb<T>(dbPath: string, readOnly: boolean, fn: (db: Database) => T): T | undefined {
	const mod = loadSqlite();
	if (!mod || !fs.existsSync(dbPath)) return undefined;
	let db: Database | undefined;
	try {
		db = new mod.DatabaseSync(dbPath, { readOnly, timeout: BUSY_TIMEOUT_MS } as ConstructorParameters<SqliteModule["DatabaseSync"]>[1]);
		return fn(db);
	} catch {
		return undefined;
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
}

function maxIdx(db: Database): number {
	const row = db.prepare("SELECT MAX(idx) AS idx FROM steps").get() as { idx: number | bigint | null } | undefined;
	return row?.idx === null || row?.idx === undefined ? -1 : Number(row.idx);
}

/** Model-call steps with token stats after `afterIdx` (oldest first) and the
 *  store's highest step index, read on one connection. */
export function readStepState(dbPath: string, afterIdx = -1): { steps: StepTokens[]; maxIdx: number } | undefined {
	return withDb(dbPath, true, (db) => {
		const rows = db.prepare(
			"SELECT idx, metadata FROM steps WHERE step_type = ? AND idx > ? AND metadata IS NOT NULL ORDER BY idx ASC",
		).all(STEP_TYPE_AGENT, afterIdx) as Array<{ idx: number | bigint; metadata: Uint8Array | null }>;
		const steps: StepTokens[] = [];
		for (const row of rows) {
			if (!(row.metadata instanceof Uint8Array)) continue;
			const tokens = tokensFromMetadata(row.metadata, Number(row.idx));
			if (tokens) steps.push(tokens);
		}
		return { steps, maxIdx: maxIdx(db) };
	});
}

/** Highest step index currently stored (−1 for an empty or missing store). */
export function lastStepIdx(dbPath: string): number {
	return withDb(dbPath, true, maxIdx) ?? -1;
}

function replaceBufferToken(source: Uint8Array, fromText: string, toText: string): Buffer {
	const buf = Buffer.from(source);
	if (!fromText || fromText === toText) return buf;
	return Buffer.from(buf.toString("latin1").split(fromText).join(toText), "latin1");
}

function pruneForkedTables(
	db: Database,
	sessionId: string,
	newSessionId: string,
	maxStepIdx: number,
): void {
	db.prepare("DELETE FROM steps WHERE idx > ?").run(maxStepIdx);

	try {
		const genRows = db.prepare("SELECT idx, data FROM gen_metadata").all() as Array<{ idx: number | bigint; data: Uint8Array | null }>;
		const delGen = db.prepare("DELETE FROM gen_metadata WHERE idx = ?");
		for (const row of genRows) {
			if (!(row.data instanceof Uint8Array)) continue;
			const packed = parseProtoFields(row.data).get(2);
			const firstStep = packed?.wire === 2 ? readVarint(packed.bytes, 0) : undefined;
			if (firstStep && firstStep[0] > maxStepIdx) delGen.run(row.idx);
		}
	} catch { /* optional auxiliary table */ }

	try {
		const execRows = db.prepare("SELECT idx, data FROM executor_metadata").all() as Array<{ idx: number | bigint; data: Uint8Array | null }>;
		const delExec = db.prepare("DELETE FROM executor_metadata WHERE idx = ?");
		for (const row of execRows) {
			if (!(row.data instanceof Uint8Array)) continue;
			const endStep = parseProtoFields(row.data).get(3);
			if (endStep?.wire === 0 && endStep.value > maxStepIdx) delExec.run(row.idx);
		}
	} catch { /* optional auxiliary table */ }

	const newTrajectoryId = randomUUID();
	let oldTrajectoryId = "";
	try {
		const metaRow = db.prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1").get() as { trajectory_id?: string | null } | undefined;
		if (metaRow?.trajectory_id) oldTrajectoryId = metaRow.trajectory_id;
		db.prepare("UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?").run(newTrajectoryId, newSessionId);
	} catch { /* optional metadata table */ }

	try {
		const blobRow = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data?: Uint8Array | null } | undefined;
		if (blobRow?.data instanceof Uint8Array) {
			const withSession = replaceBufferToken(blobRow.data, sessionId, newSessionId);
			const patched = oldTrajectoryId ? replaceBufferToken(withSession, oldTrajectoryId, newTrajectoryId) : withSession;
			db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(patched);
		}
	} catch { /* optional metadata blob */ }
}

/** Fork `<sessionId>.db` into a new `<forkedSessionId>.db` truncated to `idx <= maxStepIdx`
 *  so a `/tree` rewind to an earlier turn loads the exact ACP state at that turn
 *  without mutating the later branch's store. The stores run in WAL mode, so the
 *  copy is a `VACUUM INTO` snapshot (a file copy would miss steps still in the
 *  `-wal` file). Returns `undefined` if unavailable. */
export function forkConversationAtStep(
	dir: string,
	sessionId: string,
	maxStepIdx: number,
	newSessionId: string = randomUUID(),
): string | undefined {
	const srcPath = conversationDbPath(dir, sessionId);
	const dstPath = conversationDbPath(dir, newSessionId);
	if (!srcPath || !dstPath || maxStepIdx < 0 || fs.existsSync(dstPath)) return undefined;
	const forked =
		withDb(srcPath, true, (db) => db.prepare("VACUUM INTO ?").run(dstPath)) !== undefined &&
		withDb(dstPath, false, (db) => {
			pruneForkedTables(db, sessionId, newSessionId, maxStepIdx);
			return true;
		}) === true;
	if (forked) return newSessionId;
	for (const file of [dstPath, `${dstPath}-wal`, `${dstPath}-shm`, `${dstPath}-journal`]) {
		try { fs.rmSync(file, { force: true }); } catch { /* ignore cleanup failure */ }
	}
	return undefined;
}

/** Return `sessionId` when its SQLite store is still at `maxStepIdx`, or fork a
 *  truncated copy when later turns have advanced `<sessionId>.db` past `maxStepIdx`. */
export function resolveSessionAtStep(
	dir: string | undefined,
	sessionId: string,
	maxStepIdx: number | undefined,
): string {
	if (!dir || maxStepIdx === undefined || maxStepIdx < 0) return sessionId;
	const dbPath = conversationDbPath(dir, sessionId);
	if (!dbPath || !fs.existsSync(dbPath)) return sessionId;
	const currentMax = lastStepIdx(dbPath);
	if (currentMax <= maxStepIdx) return sessionId;
	return forkConversationAtStep(dir, sessionId, maxStepIdx) ?? sessionId;
}

export function summarizeSteps(steps: StepTokens[]): StepUsage | undefined {
	const last = steps.at(-1);
	if (!last) return undefined;
	const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") => steps.reduce((total, step) => total + step[key], 0);
	return {
		input: sum("input"),
		output: sum("output"),
		cacheRead: sum("cacheRead"),
		cacheWrite: sum("cacheWrite"),
		contextTokens: last.input + last.cacheRead + last.cacheWrite + last.output,
		steps: steps.length,
		lastIdx: last.idx,
	};
}

/** Prompt tokens a sibling placeholder reports. Small enough to leave the
 *  session's token totals effectively exact. */
export const SIBLING_PROMPT_TOKENS = 100;

/** Usage for a pi message that shares its model call with an earlier one
 *  (parallel tool calls: one call, several pi toolUse messages). The call's
 *  tokens were already reported, so this carries only the call's cache-hit
 *  ratio, scaled to SIBLING_PROMPT_TOKENS, and its measured context size, so
 *  pi's per-message cache-hit rate and context bar stay steady. */
export function siblingUsage(last: StepTokens): StepUsage {
	const prompt = last.input + last.cacheRead + last.cacheWrite;
	const scale = prompt > 0 ? SIBLING_PROMPT_TOKENS / prompt : 0;
	const cacheRead = Math.round(last.cacheRead * scale);
	const cacheWrite = Math.round(last.cacheWrite * scale);
	return {
		input: prompt > 0 ? Math.max(0, SIBLING_PROMPT_TOKENS - cacheRead - cacheWrite) : 0,
		output: 0,
		cacheRead,
		cacheWrite,
		contextTokens: prompt + last.output,
		steps: 0,
		lastIdx: last.idx,
	};
}
