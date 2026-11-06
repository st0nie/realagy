import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { AcpDriver } from "../src/acp/driver.js";
import { forkConversationAtStep, lastStepIdx, readStepState, siblingUsage, summarizeSteps, tokensFromMetadata } from "../src/acp/step-usage.js";
import { fetchCliUsage, parseCliUsage, quotaExhaustion, UsageMeter } from "../src/quota.js";
import type { DriverActivity, TurnHandle } from "../src/driver-types.js";

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
	return fs.mkdtempSync(path.join(os.tmpdir(), "realagy-usage-test-"));
}

test("sibling tool calls keep the model call's cache ratio and context, not its tokens", () => {
	const usage = siblingUsage({ idx: 3, input: 2399, output: 99, cacheRead: 25612, cacheWrite: 0 });
	assert.deepEqual(usage, { input: 9, output: 0, cacheRead: 91, cacheWrite: 0, contextTokens: 28110, steps: 0, lastIdx: 3 });
	const meter = new UsageMeter();
	meter.addSteps({ ...usage, steps: 0 });
	assert.match(meter.report(), /no measured Antigravity calls/, "placeholders never count as measured calls");
});

test("step usage reads agent-step token stats after a cursor", () => {
	const db = path.join(tmp(), "s.db");
	const handle = new DatabaseSync(db);
	handle.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
	const insert = handle.prepare("INSERT INTO steps VALUES (?, ?, ?)");
	insert.run(0, 14, null);
	insert.run(1, 15, metadata(100, 10, 0));
	insert.run(2, 14, metadata(999, 999, 999)); // user step: ignored
	insert.run(3, 15, metadata(300_000, 50, 1_500_000));
	handle.close();

	assert.deepEqual(tokensFromMetadata(metadata(5, 6, 7), 9), { idx: 9, input: 5, output: 6, cacheWrite: 0, cacheRead: 7 });
	assert.equal(tokensFromMetadata(Uint8Array.from([1, 2, 3]), 0), undefined);
	assert.equal(lastStepIdx(db), 3);
	assert.equal(lastStepIdx(path.join(tmp(), "missing.db")), -1);
	const all = summarizeSteps(readStepState(db)!.steps)!;
	assert.equal(all.steps, 2);
	assert.equal(all.input, 300_100);
	assert.equal(all.cacheRead, 1_500_000);
	assert.equal(all.contextTokens, 300_000 + 50 + 1_500_000);
	assert.deepEqual(readStepState(db, 1)!.steps.map((step) => step.idx), [3]);
	assert.deepEqual(readStepState(db, 3), { steps: [], maxIdx: 3 });
	assert.equal(readStepState(path.join(tmp(), "missing.db")), undefined);
});

test("forking a WAL-mode conversation store keeps steps that are still in the -wal file", () => {
	const dir = tmp();
	const writer = new DatabaseSync(path.join(dir, "src.db"));
	try {
		writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
		writer.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
		const insert = writer.prepare("INSERT INTO steps VALUES (?, ?, ?)");
		for (let idx = 0; idx < 6; idx++) insert.run(idx, idx % 2 ? 15 : 14, idx % 2 ? metadata(10, 1, 0) : null);
		// The writer stays open: every step is still only in src.db-wal.
		assert.equal(forkConversationAtStep(dir, "src", 3, "fork"), "fork");
		assert.equal(lastStepIdx(path.join(dir, "fork.db")), 3);
		assert.equal(readStepState(path.join(dir, "fork.db"))!.steps.length, 2);
		assert.equal(lastStepIdx(path.join(dir, "src.db")), 5, "the source branch is untouched");
		assert.equal(forkConversationAtStep(dir, "src", 3, "fork"), undefined, "never overwrites an existing store");
		assert.equal(forkConversationAtStep(dir, "absent", 3, "other"), undefined);
		assert.equal(fs.existsSync(path.join(dir, "other.db")), false);
	} finally {
		writer.close();
	}
});

async function drain(handle: TurnHandle): Promise<DriverActivity[]> {
	const activities: DriverActivity[] = [];
	for (;;) {
		const next = await handle.next();
		if (!next) return activities;
		activities.push(next);
	}
}

test("AcpDriver reports exact step usage, reuses live sessions, and falls back with complete input", async () => {
	const dir = tmp();
	const capture = path.join(dir, "requests.ndjson");
	fs.writeFileSync(capture, "");
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [path.join(process.cwd(), "tests/helpers/fake-acp-server.mjs"), capture],
		extraEnv: { FAKE_ACP_DB_DIR: dir },
		conversationsDir: () => dir,
	});
	const base = { cwd: process.cwd(), model: "gemini-3.8-flash", effort: "medium", mode: "default" as const, skipPermissions: true };
	const wire = () => fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
	try {
		const first = await driver.run({ ...base, prompt: "first" });
		const firstActivities = await drain(first);
		const outcome = await first.outcome;
		assert.equal(outcome.conversationId, "session-1");
		assert.deepEqual(firstActivities.filter((activity) => activity.type === "step_usage"), [
			{ type: "step_usage", usage: { input: 1200, output: 80, cacheRead: 8800, cacheWrite: 0, contextTokens: 10_080, steps: 1 } },
		]);
		assert.ok(!firstActivities.some((activity) => activity.type === "usage"), "no synthetic estimates by default");

		const second = await driver.run({ ...base, conversationId: "session-1", prompt: "delta", fallback: { prompt: "full" } });
		const secondSteps = (await drain(second)).filter((activity) => activity.type === "step_usage");
		assert.equal(secondSteps.length, 1, "only the new turn's step is reported");
		const afterSecond = wire();
		assert.equal(afterSecond.filter((request) => request.method === "session/new").length, 1);
		assert.equal(afterSecond.filter((request) => request.method === "session/load").length, 0);
		const prompts = afterSecond.filter((request) => request.method === "session/prompt");
		assert.equal(prompts.at(-1)!.params.sessionId, "session-1");
		assert.deepEqual(prompts.at(-1)!.params.prompt, [{ type: "text", text: "delta" }]);

		const third = await driver.run({ ...base, conversationId: "missing", prompt: "delta", fallback: { prompt: "full" } });
		await drain(third);
		assert.equal((await third.outcome).conversationId, "session-2");
		assert.deepEqual(wire().filter((request) => request.method === "session/prompt").at(-1)!.params.prompt, [{ type: "text", text: "full" }]);
	} finally {
		await driver.close();
	}
});

const CLI_USAGE = JSON.stringify({
	conversation_id: "", status: "SUCCESS",
	command: { name: "usage", data: { groups: [
		{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.71, reset_time: "2026-11-11T12:51:28Z" }, { id: "gemini-5h", window: "5h", remaining_fraction: 1 }] },
		{ name: "Claude and GPT models", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.44 }] },
		{ name: "Gemini 4 Argon", buckets: [{ id: "argon", window: "weekly", remaining_fraction: 0.9885914921760559 }] },
	] } },
});

test("quota helpers parse agy /usage output and exhaustion notices", () => {
	const groups = parseCliUsage(CLI_USAGE);
	assert.deepEqual(groups.map((group) => group.name), ["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"]);
	assert.throws(() => parseCliUsage("nope"));
	assert.throws(() => parseCliUsage(JSON.stringify({ status: "ERROR", error: "not signed in" })), /not signed in/);
	const now = Date.UTC(2026, 10, 5, 0, 0);
	assert.deepEqual(
		quotaExhaustion("Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 2 hours, 30 minutes.", now),
		{ resetAt: new Date(now + 2.5 * 3_600_000).toISOString() },
	);
	assert.equal(quotaExhaustion("All good"), undefined);
});

test("usage meter reports cache hits and every quota group", () => {
	const meter = new UsageMeter();
	assert.match(meter.report(), /no measured Antigravity calls/);
	meter.addSteps({ input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, contextTokens: 1010, steps: 1 });
	meter.addSteps({ input: 100, output: 10, cacheRead: 900, cacheWrite: 0, contextTokens: 1010, steps: 1 });
	meter.setQuota(parseCliUsage(CLI_USAGE));
	const report = meter.report(new Date(Date.UTC(2026, 10, 5)));
	assert.match(report, /Cache hits: 90% latest · 45% this session/);
	assert.match(report, /Claude and GPT models\n  weekly: 44% left/);
	assert.match(report, /Gemini 4 Argon\n  weekly: 98\.8% left/, "never rounds a used bucket up to 100%");
	meter.setExhausted({});
	assert.match(meter.report(), /Quota exhausted/);
});

test("fetchCliUsage resolves as soon as stdout flushes the JSON line", async () => {
	const dir = tmp();
	const script = path.join(dir, "fake-agy.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(CLI_USAGE)} + "\\n");\nsetTimeout(() => process.exit(0), 5000);\n`,
		{ mode: 0o755 },
	);
	const started = Date.now();
	const groups = await fetchCliUsage(script, 10_000);
	assert.ok(Date.now() - started < 2000, "resolves without waiting for post-output teardown");
	assert.equal(groups.length, 3);
});
