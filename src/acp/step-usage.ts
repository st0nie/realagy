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

/** Model-call steps with token stats after `afterIdx`, oldest first. */
export function readStepTokens(dbPath: string, afterIdx = -1): StepTokens[] | undefined {
	const mod = loadSqlite();
	if (!mod || !fs.existsSync(dbPath)) return undefined;
	let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
	try {
		db = new mod.DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS } as ConstructorParameters<SqliteModule["DatabaseSync"]>[1]);
		const rows = db.prepare(
			"SELECT idx, metadata FROM steps WHERE step_type = ? AND idx > ? AND metadata IS NOT NULL ORDER BY idx ASC",
		).all(STEP_TYPE_AGENT, afterIdx) as Array<{ idx: number | bigint; metadata: Uint8Array | null }>;
		const steps: StepTokens[] = [];
		for (const row of rows) {
			if (!(row.metadata instanceof Uint8Array)) continue;
			const tokens = tokensFromMetadata(row.metadata, Number(row.idx));
			if (tokens) steps.push(tokens);
		}
		return steps;
	} catch {
		return undefined;
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
}

/** Highest step index currently stored (−1 for an empty or missing store). */
export function lastStepIdx(dbPath: string): number {
	const mod = loadSqlite();
	if (!mod || !fs.existsSync(dbPath)) return -1;
	let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
	try {
		db = new mod.DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS } as ConstructorParameters<SqliteModule["DatabaseSync"]>[1]);
		const row = db.prepare("SELECT MAX(idx) AS idx FROM steps").get() as { idx: number | bigint | null } | undefined;
		return row?.idx === null || row?.idx === undefined ? -1 : Number(row.idx);
	} catch {
		return -1;
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
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
