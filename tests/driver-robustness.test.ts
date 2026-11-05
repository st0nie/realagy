import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AcpDriver, type AcpDriverOptions } from "../src/acp/driver.js";
import type { DriverActivity, DriverTurnRequest, TurnHandle } from "../src/driver-types.js";

type WireRequest = { id?: number; method: string; params: Record<string, unknown> };

function fixture(env: Record<string, string> = {}, options: (dir: string) => Partial<AcpDriverOptions> = () => ({})): { driver: AcpDriver; wire: () => WireRequest[]; dir: string; logs: string[] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-driver-test-"));
	const capture = path.join(dir, "requests.ndjson");
	fs.writeFileSync(capture, "");
	const logs: string[] = [];
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [path.join(process.cwd(), "tests/helpers/fake-acp-server.mjs"), capture],
		extraEnv: env,
		log: (msg) => logs.push(msg),
		...options(dir),
	});
	const wire = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireRequest);
	return { driver, wire, dir, logs };
}

const base = { cwd: process.cwd(), model: "gemini-3.8-flash", effort: "medium", mode: "accept-edits", skipPermissions: true } satisfies Omit<DriverTurnRequest, "prompt">;

async function drain(handle: TurnHandle): Promise<DriverActivity[]> {
	const activities: DriverActivity[] = [];
	for (;;) {
		const next = await handle.next();
		if (!next) return activities;
		activities.push(next);
	}
}

/** Resolve once the fake server has received a request matching `method`. */
async function waitFor(wire: () => WireRequest[], method: string, count = 1): Promise<void> {
	const deadline = Date.now() + 5000;
	while (wire().filter((request) => request.method === method).length < count) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("Esc sends session/cancel as a notification and keeps the process and session", async () => {
	const { driver, wire, logs } = fixture();
	try {
		const controller = new AbortController();
		const first = await driver.run({ ...base, prompt: "[hang]", signal: controller.signal });
		await waitFor(wire, "session/prompt");
		controller.abort();
		const outcome = await first.outcome;
		assert.equal(outcome.aborted, true);
		assert.equal(outcome.status, "OK");
		assert.equal(outcome.conversationId, "session-1");
		const cancel = wire().find((request) => request.method === "session/cancel")!;
		assert.equal(cancel.id, undefined, "ACP cancel is a notification");
		assert.deepEqual(cancel.params, { sessionId: "session-1" });
		assert.ok(!logs.includes("teardown"), "a settled cancel never kills agy");

		const second = await driver.run({ ...base, conversationId: "session-1", prompt: "next" });
		await drain(second);
		assert.equal((await second.outcome).status, "OK");
		assert.equal(wire().filter((request) => request.method === "initialize").length, 1, "no respawn");
		assert.equal(wire().filter((request) => request.method === "session/new").length, 1, "the live session is reused");
	} finally {
		await driver.close();
	}
});

test("a cancel agy ignores tears the process down after the grace period, and the next turn respawns", async () => {
	const { driver, wire, logs } = fixture({}, () => ({ cancelGraceMs: 100 }));
	try {
		const controller = new AbortController();
		const first = await driver.run({ ...base, prompt: "[silent-cancel]", signal: controller.signal });
		await waitFor(wire, "session/prompt");
		controller.abort();
		const outcome = await first.outcome;
		assert.equal(outcome.aborted, true);
		assert.ok(logs.includes("cancel-timeout"));
		assert.ok(logs.includes("teardown"));

		const second = await driver.run({ ...base, conversationId: "session-1", prompt: "next" });
		await drain(second);
		assert.equal((await second.outcome).status, "OK");
		assert.equal(wire().filter((request) => request.method === "initialize").length, 2, "respawned");
	} finally {
		await driver.close();
	}
});

test("an abort before the prompt is sent settles at once without cancelling or killing", async () => {
	const { driver, wire, logs } = fixture();
	try {
		const controller = new AbortController();
		const first = await driver.run({ ...base, prompt: "first", signal: controller.signal });
		controller.abort();
		const outcome = await first.outcome;
		assert.equal(outcome.aborted, true);
		const second = await driver.run({ ...base, prompt: "second" });
		await drain(second);
		assert.equal((await second.outcome).status, "OK");
		assert.equal(wire().filter((request) => request.method === "session/cancel").length, 0);
		assert.ok(!logs.includes("teardown"));
		assert.equal(wire().filter((request) => request.method === "initialize").length, 1);
	} finally {
		await driver.close();
	}
});

test("agy exiting mid-turn fails the turn with its exit code and last stderr line; the next turn respawns", async () => {
	const { driver, wire } = fixture();
	try {
		const first = await driver.run({ ...base, prompt: "[exit]" });
		await drain(first);
		const outcome = await first.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /exit code 3/);
		assert.match(outcome.error ?? "", /fatal: fake server crashed/);

		const second = await driver.run({ ...base, prompt: "again" });
		await drain(second);
		assert.equal((await second.outcome).status, "OK");
		assert.equal(wire().filter((request) => request.method === "initialize").length, 2);
	} finally {
		await driver.close();
	}
});

test("a missing agy binary fails turns and discovery with a /agy setup pointer", async () => {
	const driver = new AcpDriver({ bin: path.join(os.tmpdir(), "realagy-no-such-agy") });
	try {
		await assert.rejects(driver.listModels(process.cwd()), /Cannot start the Antigravity CLI .*realagy-no-such-agy.*Run \/agy setup/);
		const handle = await driver.run({ ...base, prompt: "hi" });
		await drain(handle);
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "ERROR");
		assert.match(outcome.error ?? "", /ENOENT/);
		assert.match(outcome.error ?? "", /Run \/agy setup/);
	} finally {
		await driver.close();
	}
});

test("concurrent discovery and the first turn share one spawn and handshake", async () => {
	const { driver, wire } = fixture();
	try {
		const [models, handle] = await Promise.all([driver.listModels(process.cwd()), driver.run({ ...base, prompt: "hi" })]);
		await drain(handle);
		assert.equal(models.length, 3);
		assert.equal((await handle.outcome).status, "OK");
		const methods = wire().map((request) => request.method);
		assert.equal(methods.filter((method) => method === "initialize").length, 1);
		assert.equal(methods[0], "initialize", "nothing precedes the handshake");
	} finally {
		await driver.close();
	}
});

test("a persisted session is resumed with session/resume when agy advertises it", async () => {
	const first = fixture({ FAKE_ACP_RESUME: "1" });
	const dir = first.dir;
	try {
		const handle = await first.driver.run({ ...base, prompt: "one" });
		await drain(handle);
	} finally {
		await first.driver.close();
	}
	fs.writeFileSync(path.join(dir, "session-1.db"), "");
	const second = fixture({ FAKE_ACP_RESUME: "1" }, () => ({ conversationsDir: () => dir }));
	try {
		const handle = await second.driver.run({ ...base, conversationId: "session-1", prompt: "delta", fallback: { prompt: "full" } });
		await drain(handle);
		const outcome = await handle.outcome;
		assert.equal(outcome.conversationId, "session-1");
		const methods = second.wire().map((request) => request.method);
		assert.ok(methods.includes("session/resume"));
		assert.ok(!methods.includes("session/load"));
		assert.ok(!methods.includes("session/new"));
		assert.deepEqual(second.wire().find((request) => request.method === "session/prompt")!.params.prompt, [{ type: "text", text: "delta" }]);
	} finally {
		await second.driver.close();
	}
});

test("without resume support session/load is used and its replayed history never reaches pi", async () => {
	const { driver, wire, dir } = fixture({}, (dir) => ({ conversationsDir: () => dir }));
	fs.writeFileSync(path.join(dir, "session-7.db"), "");
	try {
		const handle = await driver.run({ ...base, conversationId: "session-7", prompt: "delta", fallback: { prompt: "full" } });
		const activities = await drain(handle);
		assert.equal((await handle.outcome).conversationId, "session-7");
		const text = activities.flatMap((activity) => (activity.type === "text" ? [activity.delta] : [])).join("");
		assert.equal(text, "OK");
		assert.ok(wire().some((request) => request.method === "session/load"));
	} finally {
		await driver.close();
	}
});

test("a remembered session whose store is gone gets a fresh session and the full fallback input", async () => {
	const { driver, wire } = fixture({ FAKE_ACP_RESUME: "1" }, (dir) => ({ conversationsDir: () => dir }));
	try {
		const handle = await driver.run({ ...base, conversationId: "deleted-session", prompt: "delta", fallback: { prompt: "full" } });
		await drain(handle);
		assert.equal((await handle.outcome).conversationId, "session-1");
		const methods = wire().map((request) => request.method);
		assert.ok(!methods.includes("session/resume"), "agy is never asked to reopen a lost session");
		assert.ok(!methods.includes("session/load"));
		assert.deepEqual(wire().find((request) => request.method === "session/prompt")!.params.prompt, [{ type: "text", text: "full" }]);
	} finally {
		await driver.close();
	}
});

test("cancelActive ends a turn parked on pi tool calls", async () => {
	const { driver, wire } = fixture();
	try {
		const handle = await driver.run({ ...base, prompt: "[hang]" });
		await waitFor(wire, "session/prompt");
		handle.pushExternal({ type: "bridge_call", callId: "c1", name: "read", args: {} });
		await driver.cancelActive("superseded");
		const outcome = await handle.outcome;
		assert.equal(outcome.aborted, true);
		assert.equal(driver.activeHandle, null);
		assert.ok(wire().some((request) => request.method === "session/cancel"));
		await driver.cancelActive("no-op without an active turn");
	} finally {
		await driver.close();
	}
});

test("close() settles the active turn and stops the process", async () => {
	const { driver, wire } = fixture();
	const handle = await driver.run({ ...base, prompt: "[hang]" });
	await waitFor(wire, "session/prompt");
	await driver.close();
	const outcome = await handle.outcome;
	assert.equal(outcome.status, "ERROR");
	assert.match(outcome.error ?? "", /shut down/);
});
