import assert from "node:assert/strict";
import { test } from "vitest";
import http from "node:http";
import { bridgedPiTools, bridgeInputSchema } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

test("bridge includes active pi builtins and rejects internal/inactive tools", () => {
	const tools = [{ name: "read" }, { name: "bash" }, { name: "write" }, { name: "AskAntigravity" }, { name: "bridge_poll_result" }];
	assert.deepEqual(bridgedPiTools(tools, ["read", "bash"]).map((tool) => tool.name), ["read", "bash"]);
});

test("loopback MCP requires its token and lists/calls pi tools", async () => {
	const started = await startMcpServer({
		listTools: () => [{ name: "bash", description: "pi bash", inputSchema: { type: "object" } }],
		onToolCall: async (_id, name, args) => ({ content: [{ type: "text", text: `${name}:${String(args.command)}` }] }),
	});
	assert.equal(started.ok, true);
	if (!started.ok) return;
	const { port, token, close } = started.handle;
	const url = `http://127.0.0.1:${port}/mcp`;
	try {
		const denied = await fetch(url, { method: "POST", body: "{}" });
		assert.equal(denied.status, 403);
		const call = (id: number, method: string, params: object) => fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				[TOKEN_HEADER]: token,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		const listed = await call(1, "tools/list", {});
		assert.equal(listed.status, 200);
		assert.match(await listed.text(), /bash/);
		const called = await call(2, "tools/call", { name: "bash", arguments: { command: "printf ok" } });
		assert.equal(called.status, 200);
		assert.match(await called.text(), /bash:printf ok/);
	} finally {
		await close();
	}
});

test("bridge input schemas are normalized once per tool definition", () => {
	const parameters = { type: "object", properties: { mode: { const: "fast" } } };
	const schema = bridgeInputSchema(parameters);
	assert.deepEqual(schema, { type: "object", properties: { mode: { enum: ["fast"] } } });
	assert.equal(bridgeInputSchema(parameters), schema, "cached per parameters object");
	assert.deepEqual(parameters.properties.mode, { const: "fast" }, "pi's definition is never mutated");
	assert.deepEqual(bridgeInputSchema(undefined), { type: "object", properties: {}, additionalProperties: true });
	assert.deepEqual(bridgeInputSchema({ size: 1n }), { type: "object", properties: {}, additionalProperties: true });
});

test("loopback MCP decodes request bodies whose multi-byte characters span network chunks", async () => {
	let received: unknown;
	const started = await startMcpServer({
		listTools: () => [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
		onToolCall: async (_id, _name, args) => {
			received = args.text;
			return { content: [{ type: "text", text: "ok" }] };
		},
	});
	assert.equal(started.ok, true);
	if (!started.ok) return;
	const { port, token, close } = started.handle;
	try {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "héllo 中文" } } }));
		const split = body.indexOf(Buffer.from("中")) + 1; // inside the 3-byte character
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request({
				host: "127.0.0.1", port, path: "/mcp", method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [TOKEN_HEADER]: token },
			}, (res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			});
			req.on("error", reject);
			req.write(body.subarray(0, split));
			setTimeout(() => req.end(body.subarray(split)), 50);
		});
		assert.equal(status, 200);
		assert.equal(received, "héllo 中文");
	} finally {
		await close();
	}
});
