import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { AcpDriver } from "../src/acp/driver.js";
import type { DriverTurnRequest, TurnOutcome } from "../src/driver-types.js";
import { syncItemsForMessages } from "../src/transcript.js";

const drivers: AcpDriver[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const driver of drivers.splice(0)) await driver.close();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function field(id: number, content: Buffer | string): Buffer {
	const bytes = Buffer.from(content);
	const varint = (n: number): number[] => n < 128 ? [n] : [(n & 127) | 128, ...varint(Math.floor(n / 128))];
	return Buffer.concat([Buffer.from(varint(id * 8 + 2)), Buffer.from(varint(bytes.length)), bytes]);
}
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const tool = (text: string): Message => ({ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 2 });
const original = [user("question"), tool("ORIGINAL_RESULT")];
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-sync-lifecycle-"));
	directories.push(dir);
	const dbPath = path.join(dir, "native-session.db");
	const capture = path.join(dir, "requests.ndjson");
	fs.writeFileSync(capture, "");
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB)");
	const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, NULL)");
	insert.run(0, 14, field(19, field(2, "question")));
	insert.run(1, 132, Buffer.concat([field(5, field(4, field(2, "mcp_pi-bridge_read"))), field(140, field(2, field(1, "ORIGINAL_RESULT")))]));
	db.close();
	const driver = new AcpDriver({ bin: process.execPath, binArgs: [path.resolve("tests/helpers/native-sync-server.mjs"), capture, dbPath], conversationsDir: () => dir });
	drivers.push(driver);
	const requests = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; pid: number; params: Record<string, unknown> });
	const request = (overrides: Partial<DriverTurnRequest> = {}): DriverTurnRequest => ({ cwd: dir, model: "test", mode: "default", skipPermissions: true, conversationId: "native-session", prompt: "next question", ...overrides });
	const sync = (hasNewUser: boolean): DriverTurnRequest["contextSync"] => ({ messages: [user("question"), tool("SYNCED_RESULT"), ...(hasNewUser ? [user("new input")] : [])], previousItems: syncItemsForMessages(original), hasNewUser });
	return { driver, requests, request, sync, dbPath };
}
async function run(driver: AcpDriver, request: DriverTurnRequest): Promise<TurnOutcome> {
	const handle = await driver.run(request);
	while (await handle.next()) { /* drain the streamed activities */ }
	return handle.outcome;
}

test("native sync waits for old-process flush, reopens the same ID, and sends only new input", async () => {
	const f = fixture();
	assert.equal((await run(f.driver, f.request())).response, "ORIGINAL_RESULT");
	const pid = f.driver.pid;
	const outcome = await run(f.driver, f.request({ prompt: "new input", contextSync: f.sync(true) }));
	assert.equal(outcome.status, "OK");
	assert.equal(outcome.conversationId, "native-session");
	assert.equal(outcome.response, "SYNCED_RESULT");
	assert.notEqual(f.driver.pid, pid);
	const wire = f.requests();
	assert.equal(wire.filter((r) => r.method === "spawn").length, 2);
	assert.equal(wire.filter((r) => r.method === "session/new").length, 0);
	assert.ok(wire.findIndex((r) => r.method === "stopped") < wire.indexOf(wire.filter((r) => r.method === "spawn").at(-1)!));
	assert.deepEqual(wire.filter((r) => r.method === "session/prompt").at(-1)!.params.prompt, [{ type: "text", text: "new input" }]);
});

test("unchanged context keeps the same process and does not rewrite native history", async () => {
	const f = fixture();
	const bytes = fs.readFileSync(f.dbPath);
	await run(f.driver, f.request());
	const pid = f.driver.pid;
	await run(f.driver, f.request({ prompt: "another question" }));
	assert.equal(f.driver.pid, pid);
	assert.equal(f.requests().filter((r) => r.method === "spawn").length, 1);
	assert.equal(f.requests().filter((r) => r.method === "session/resume").length, 1);
	assert.deepEqual(fs.readFileSync(f.dbPath), bytes);
});

test("a completed mid-turn tool result continues with empty input, no user step, and no tool execution", async () => {
	const f = fixture();
	// Start and cancel the old native prompt at a parked tool boundary.
	const parked = await f.driver.run(f.request({ prompt: "[park]" }));
	const ready = new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("fake ACP did not receive parked prompt")), 5_000);
		const timer = setInterval(() => {
			if (!f.requests().some((r) => r.method === "session/prompt")) return;
			clearInterval(timer); clearTimeout(deadline); resolve();
		}, 5);
	});
	await ready;
	await f.driver.cancelActive("effective context changed");
	assert.equal((await parked.outcome).aborted, true);
	const outcome = await run(f.driver, f.request({ prompt: "", contextSync: f.sync(false) }));
	assert.equal(outcome.status, "OK");
	assert.equal(outcome.response, "SYNCED_RESULT");
	assert.equal(outcome.conversationId, "native-session");
	assert.deepEqual(f.requests().filter((r) => r.method === "session/prompt").at(-1)!.params.prompt, [{ type: "text", text: "" }]);
	assert.equal(f.requests().filter((r) => r.method.startsWith("tools/")).length, 0);
	const db = new DatabaseSync(f.dbPath);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM steps WHERE step_type = 14").get() as { n: number }).n, 1);
	db.close();
});

test("mapping failure does not start a new process or send a prompt to stale history", async () => {
	const f = fixture();
	await run(f.driver, f.request());
	const sync = f.sync(true)!;
	sync.previousItems = syncItemsForMessages([user("incorrect prior question"), tool("ORIGINAL_RESULT")]);
	const count = f.requests().filter((r) => r.method === "session/prompt").length;
	const outcome = await run(f.driver, f.request({ contextSync: sync }));
	assert.equal(outcome.status, "ERROR");
	assert.match(outcome.error ?? "", /changed identity/);
	assert.equal(f.driver.pid, undefined);
	assert.equal(f.requests().filter((r) => r.method === "session/prompt").length, count);
	const retry = await run(f.driver, f.request());
	assert.equal(retry.status, "ERROR");
	assert.match(retry.error ?? "", /synchronization is incomplete/);
	assert.equal(f.requests().filter((r) => r.method === "spawn").length, 1);
	assert.equal(f.requests().filter((r) => r.method === "session/prompt").length, count);
});

test("same-ID reload failure must not fall back to a fresh session or transcript replay", async () => {
	const f = fixture();
	await run(f.driver, f.request());
	fs.writeFileSync(`${f.dbPath}.reject-load`, "reject");
	const outcome = await run(f.driver, f.request({ contextSync: f.sync(true), fallback: { prompt: "MUST NOT SEND" } }));
	assert.equal(outcome.status, "ERROR");
	assert.match(outcome.error ?? "", /reload failure/);
	assert.equal(f.requests().filter((r) => r.method === "session/new").length, 0);
	assert.equal(f.requests().filter((r) => r.method === "session/prompt").length, 1);
	const retry = await run(f.driver, f.request());
	assert.equal(retry.status, "ERROR");
	assert.match(retry.error ?? "", /synchronization is incomplete/);
	assert.equal(f.requests().filter((r) => r.method === "session/prompt").length, 1);
});
