import fs from "node:fs";
import readline from "node:readline";

const capture = process.argv[2];
const record = (message) => fs.appendFileSync(capture, JSON.stringify(message) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });

// FAKE_ACP_DB_DIR: persist one agent step per prompt like agy_acp_server's
// conversation store (steps.metadata field 9 = token usage).
const dbDir = process.env.FAKE_ACP_DB_DIR;
let sessionCount = 0;
const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (n, value) => [...varint(n * 8), ...varint(value)];
const bytesField = (n, bytes) => [...varint(n * 8 + 2), ...varint(bytes.length), ...bytes];
async function writeStep(sessionId, tokens) {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(`${dbDir}/${sessionId}.db`);
	db.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
	const next = (db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM steps").get()).idx;
	db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, 14, NULL)").run(next);
	const usage = [...field(1, 7), ...field(2, tokens.input), ...field(3, tokens.output), ...field(5, tokens.cacheRead)];
	db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)").run(next + 1, Uint8Array.from([...field(1, 3), ...bytesField(9, usage)]));
	db.close();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
	if (!line.trim()) return;
	const request = JSON.parse(line);
	record(request);
	const { id, method, params } = request;
	if (method === "initialize") {
		result(id, { protocolVersion: 1, agentInfo: { name: "fake", version: "1" }, authMethods: [] });
		return;
	}
	if (method === "session/new") {
		result(id, {
			sessionId: `session-${++sessionCount}`,
			models: {
				currentModelId: "gemini-3.8-flash-medium",
				availableModels: [
					{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
					{ modelId: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
					{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
				],
			},
			configOptions: [],
		});
		return;
	}
	if (method === "session/load" && params.sessionId === "missing") {
		send({ jsonrpc: "2.0", id, error: { code: -32002, message: "session not found" } });
		return;
	}
	if (method === "session/set_config_option") {
		result(id, { configOptions: [] });
		return;
	}
	if (method === "session/prompt") {
		if (dbDir) await writeStep(params.sessionId, { input: 1200, output: 80, cacheRead: 8800 });
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used: 321, size: 1000 } } });
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", used: -1, size: 0 } } });
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session", update: { sessionUpdate: "usage_update", used: 999, size: 1000 } } });
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } } } });
		send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } } });
		result(id, { stopReason: "end_turn" });
		return;
	}
	if (method === "session/cancel") {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not implemented" } });
		return;
	}
	result(id, {});
});
