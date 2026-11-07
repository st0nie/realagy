import assert from "node:assert/strict";
import { test } from "vitest";
import { AcpAuthError, parseAcpTurnUsage, translateError } from "../src/acp/connection.js";
import { JsonRpcResponseError, JsonRpcSession } from "../src/acp/jsonrpc.js";

function session(opts: Partial<ConstructorParameters<typeof JsonRpcSession>[0]> = {}) {
	const sent: Array<Record<string, unknown>> = [];
	const rpc = new JsonRpcSession({ send: (frame) => sent.push(JSON.parse(frame)), ...opts });
	return { rpc, sent };
}

test("requests correlate responses across split chunks; notifications carry no id", async () => {
	const { rpc, sent } = session();
	const pending = rpc.request("session/new", { cwd: "/w" });
	rpc.notify("session/cancel", { sessionId: "s1" });
	assert.deepEqual(sent, [
		{ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/w" } },
		{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } },
	]);
	const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "é" } });
	rpc.feed(frame.slice(0, 10));
	rpc.feed(`${frame.slice(10)}\n`);
	assert.deepEqual(await pending, { sessionId: "é" });
});

test("error responses keep their code; malformed lines are reported, never fatal", async () => {
	const parseErrors: string[] = [];
	const { rpc } = session({ onParseError: (line) => parseErrors.push(line) });
	const pending = rpc.request("session/set_config_option");
	rpc.feed("not json\n[1,2]\n");
	rpc.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown model ID: x" } })}\n`);
	await assert.rejects(pending, (err: unknown) => err instanceof JsonRpcResponseError && err.code === -32602 && err.message === "Unknown model ID: x");
	assert.deepEqual(parseErrors, ["not json", "[1,2]"]);
});

test("abortAll rejects pending requests and silences later sends", async () => {
	const { rpc, sent } = session();
	const pending = rpc.request("session/prompt");
	rpc.abortAll("connection closed");
	await assert.rejects(pending, /connection closed \(request: session\/prompt\)/);
	rpc.notify("session/cancel", {});
	await assert.rejects(rpc.request("session/new"), /connection aborted/);
	assert.equal(sent.length, 1);
});

test("a peer flooding stdout without newlines aborts the session", async () => {
	let overflow = "";
	const { rpc } = session({ onOverflow: (detail) => (overflow = detail) });
	const pending = rpc.request("initialize");
	const chunk = "x".repeat(1024 * 1024);
	for (let i = 0; i < 40 && !overflow; i++) rpc.feed(chunk);
	assert.match(overflow, /no newline/);
	await assert.rejects(pending, /stdout frame overflow/);
});

test("server requests are answered, and handler failures become JSON-RPC errors", async () => {
	const { rpc, sent } = session({
		onRequest: async (method) => {
			if (method === "fs/read_text_file") throw new Error("client capability not enabled: fs/read_text_file");
			return { outcome: { outcome: "cancelled" } };
		},
	});
	rpc.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} })}\n`);
	rpc.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: {} })}\n`);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(sent, [
		{ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
		{ jsonrpc: "2.0", id: 8, error: { code: -32000, message: "client capability not enabled: fs/read_text_file" } },
	]);
});

test("ACP turn usage parses every agy field and rejects malformed counts", () => {
	assert.deepEqual(
		parseAcpTurnUsage({ inputTokens: 7039, outputTokens: 1, cachedReadTokens: 5, cachedWriteTokens: 2, thoughtTokens: 3, totalTokens: 7040 }),
		{ input_tokens: 7039, output_tokens: 1, total_tokens: 7040, thinking_tokens: 3, cache_read_tokens: 5, cache_write_tokens: 2 },
	);
	assert.equal(parseAcpTurnUsage({ inputTokens: -1, outputTokens: 1, totalTokens: 1 }), undefined);
	assert.equal(parseAcpTurnUsage([1]), undefined);
});

test("auth errors point at agy sign-in and /realagy setup", () => {
	const err = translateError("session/new", new JsonRpcResponseError({ code: -32000, message: "auth", data: { message: "not signed in" } }));
	assert.ok(err instanceof AcpAuthError);
	assert.match(err.message, /not signed in.*Sign in with `agy`.*\/realagy setup/);
	const typed = translateError("x", new JsonRpcResponseError({ code: -32601, message: "Method not found" }));
	assert.equal((typed as JsonRpcResponseError).code, -32601);
});
