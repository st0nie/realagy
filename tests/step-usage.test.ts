// Conversation-store evidence behind warm checkpoints of aborted turns and
// tool boundaries: user-input steps, the store step a turn reached, and
// forking at an aborted turn's checkpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { AcpDriver } from "../src/acp/driver.js";
import { conversationDbPath, lastStepIdx, resolveSessionAtStep, userInputSince } from "../src/acp/step-usage.js";
import type { DriverActivity, DriverTurnRequest, TurnHandle } from "../src/driver-types.js";

type WireRequest = { id?: number; method: string; params: Record<string, unknown> };

const varint = (n: number): number[] => {
	const out: number[] = [];
	while (n > 127) {
		out.push((n & 127) | 128);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return out;
};
const field = (n: number, value: number) => [...varint(n * 8), ...varint(value)];
const bytesField = (n: number, bytes: number[]) => [...varint(n * 8 + 2), ...varint(bytes.length), ...bytes];
const metadata = (input: number, output: number, cacheRead: number) =>
	Uint8Array.from([...field(1, 3), ...bytesField(9, [...field(1, 7), ...field(2, input), ...field(3, output), ...field(5, cacheRead)])]);

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "realagy-step-test-"));
}

function store(file: string, steps: Array<[number, number, Uint8Array | null]>): void {
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
	const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
	for (const [idx, type, meta] of steps) insert.run(idx, type, meta);
	db.close();
}

function fixture() {
	const dir = tmp();
	const capture = path.join(dir, "requests.ndjson");
	const dbDir = path.join(dir, "conversations");
	fs.mkdirSync(dbDir);
	fs.writeFileSync(capture, "");
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [path.join(process.cwd(), "tests/helpers/fake-acp-server.mjs"), capture],
		extraEnv: { FAKE_ACP_DB_DIR: dbDir },
		conversationsDir: () => dbDir,
	});
	const wire = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireRequest);
	return { driver, wire, dbDir };
}

const base = { cwd: process.cwd(), model: "gemini-3.8-flash", effort: "medium", mode: "default", skipPermissions: true } satisfies Omit<DriverTurnRequest, "prompt">;

async function waitFor(wire: () => WireRequest[], method: string, count = 1): Promise<void> {
	const deadline = Date.now() + 5000;
	while (wire().filter((request) => request.method === method).length < count) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function drain(handle: TurnHandle): Promise<DriverActivity[]> {
	const activities: DriverActivity[] = [];
	for (;;) {
		const next = await handle.next();
		if (!next) return activities;
		activities.push(next);
	}
}

test("userInputSince finds a prompt's user-input step after a cursor", () => {
	const db = path.join(tmp(), "s.db");
	store(db, [[0, 14, null], [1, 15, metadata(10, 1, 0)], [2, 132, null]]);
	assert.equal(userInputSince(db, -1), true);
	assert.equal(userInputSince(db, 0), false, "agent and system steps are not user input");
	store(db, [[3, 14, null]]);
	assert.equal(userInputSince(db, 2), true);
	assert.equal(userInputSince(path.join(tmp(), "missing.db"), -1), undefined, "unreadable means unknown");
});

test("an Esc during a streaming prompt reports the delivered prompt and the store step it reached", async () => {
	const { driver, wire, dbDir } = fixture();
	try {
		const controller = new AbortController();
		const handle = await driver.run({ ...base, prompt: "Write the report [hang]", signal: controller.signal });
		await waitFor(wire, "session/prompt");
		controller.abort();
		const outcome = await handle.outcome;
		assert.equal(outcome.aborted, true);
		assert.equal(outcome.conversationId, "session-1");
		assert.equal(outcome.promptDelivered, true, "agy stored the prompt's user-input step");
		assert.equal(outcome.maxStepIdx, 0);
		assert.equal(lastStepIdx(conversationDbPath(dbDir, "session-1")!), 0);

		// An abort before the prompt was sent leaves the session untouched.
		const early = new AbortController();
		const second = await driver.run({ ...base, conversationId: "session-1", prompt: "next", signal: early.signal });
		early.abort();
		const skipped = await second.outcome;
		assert.equal(skipped.aborted, true);
		assert.equal(skipped.promptDelivered, false);
		assert.equal(wire().filter((request) => request.method === "session/prompt").length, 1);

		const third = await driver.run({ ...base, conversationId: "session-1", prompt: "continue" });
		await drain(third);
		const done = await third.outcome;
		assert.equal(done.promptDelivered, true);
		assert.equal(done.maxStepIdx, 2, "user input 1 (cancelled), user input 2 + agent step");
	} finally {
		await driver.close();
	}
});

test("bridge calls carry their session and store step, and siblings of one model call get placeholder usage", async () => {
	const { driver, wire, dbDir } = fixture();
	try {
		const controller = new AbortController();
		const handle = await driver.run({ ...base, prompt: "Run two tools [hang]", signal: controller.signal });
		await waitFor(wire, "session/prompt");
		await vi.waitFor(() => assert.equal(lastStepIdx(conversationDbPath(dbDir, "session-1")!), 0));
		// The model call that requested both tools finished: agy stored it.
		store(conversationDbPath(dbDir, "session-1")!, [[1, 15, metadata(2000, 40, 8000)]]);
		handle.pushExternal({ type: "bridge_call", callId: "c1", name: "bash", args: {} });
		handle.pushExternal({ type: "bridge_call", callId: "c2", name: "read", args: {} });
		controller.abort();
		const activities = await drain(handle);
		const calls = activities.filter((activity): activity is Extract<DriverActivity, { type: "bridge_call" }> => activity.type === "bridge_call");
		assert.deepEqual(calls.map(({ callId, sessionId, maxStepIdx }) => ({ callId, sessionId, maxStepIdx })), [
			{ callId: "c1", sessionId: "session-1", maxStepIdx: 1 },
			{ callId: "c2", sessionId: "session-1", maxStepIdx: 1 },
		]);
		const usage = activities.filter((activity) => activity.type === "step_usage").map((activity) => activity.type === "step_usage" && activity.usage);
		assert.equal(usage.length, 2);
		assert.deepEqual(usage[0], { input: 2000, output: 40, cacheRead: 8000, cacheWrite: 0, contextTokens: 10_040, steps: 1 });
		assert.deepEqual(usage[1], { input: 20, output: 0, cacheRead: 80, cacheWrite: 0, contextTokens: 10_040, steps: 0 }, "sibling placeholder, same cache ratio");
		assert.equal((await handle.outcome).maxStepIdx, 1);
	} finally {
		await driver.close();
	}
});

test("an aborted turn's checkpoint resumes its store as is and forks it once later turns advanced it", () => {
	const dir = tmp();
	// Turn 1 completed (steps 0-1); turn 2 was cancelled after its prompt (step 2).
	store(path.join(dir, "s1.db"), [[0, 14, null], [1, 15, metadata(10, 1, 0)], [2, 14, null]]);
	assert.equal(resolveSessionAtStep(dir, "s1", 2), "s1", "continue after Esc: no fork");
	// `continue` advanced the store; a /tree rewind to the aborted turn forks it.
	store(path.join(dir, "s1.db"), [[3, 14, null], [4, 15, metadata(10, 1, 0)]]);
	const forked = resolveSessionAtStep(dir, "s1", 2);
	assert.notEqual(forked, "s1");
	assert.equal(lastStepIdx(path.join(dir, `${forked}.db`)), 2);
	assert.equal(userInputSince(path.join(dir, `${forked}.db`), 1), true, "the fork keeps the aborted turn's prompt");
	assert.equal(lastStepIdx(path.join(dir, "s1.db")), 4, "the other branch's store is untouched");
});
