import assert from "node:assert/strict";
import { test } from "vitest";
import http from "node:http";
import { bridgedPiTools, bridgeInputSchema, declaresToolArgument, dispatchablePiTool } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";

test("bridge lists every model-facing pi tool, active or not, and dispatches only active ones", () => {
	const tools = [
		{ name: "read", exposure: "direct" },
		{ name: "bash" },
		// pi-lens situational tool: registered, inactive until activated.
		{ name: "lens_symbols", exposure: "direct" },
		{ name: "ask", exposure: "model-only" },
		{ name: "mcp__docs__search", exposure: "deferred" },
		{ name: "memory_recall", exposure: "codemode" },
		{ name: "secret", exposure: "hidden" },
		{ name: "AskAntigravity" },
		{ name: "bridge_poll_result" },
	];
	const active = ["read", "bash", "memory_recall"];
	assert.deepEqual(bridgedPiTools(tools, active).map((tool) => tool.name), ["read", "bash", "lens_symbols", "ask", "memory_recall"]);
	// Activating a situational tool mid-session does not change the list.
	assert.deepEqual(bridgedPiTools(tools, [...active, "lens_symbols"]).map((tool) => tool.name), bridgedPiTools(tools, active).map((tool) => tool.name));
	assert.equal(dispatchablePiTool(tools, active, "bash"), true);
	assert.equal(dispatchablePiTool(tools, active, "lens_symbols"), false);
	assert.equal(dispatchablePiTool(tools, [...active, "lens_symbols"], "lens_symbols"), true);
	assert.equal(dispatchablePiTool(tools, [...active, "AskAntigravity"], "AskAntigravity"), false);
	assert.equal(dispatchablePiTool(tools, active, "secret"), false);
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

test("detects explicitly declared metadata-named arguments", () => {
	assert.equal(declaresToolArgument({ properties: { toolSummary: { type: "string" } } }, "toolSummary"), true);
	assert.equal(declaresToolArgument({ anyOf: [{ properties: { toolSummary: {} } }] }, "toolSummary"), true);
	assert.equal(declaresToolArgument({ properties: { nested: { properties: { toolSummary: {} } } } }, "toolSummary"), false);
	assert.equal(declaresToolArgument(undefined, "toolSummary"), false);
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
