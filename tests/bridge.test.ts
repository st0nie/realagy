import assert from "node:assert/strict";
import { test } from "vitest";
import { bridgedPiTools } from "../src/bridge-catalog.js";
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
