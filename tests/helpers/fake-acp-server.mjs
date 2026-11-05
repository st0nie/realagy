import fs from "node:fs";
import readline from "node:readline";

const capture = process.argv[2];
const record = (message) => fs.appendFileSync(capture, JSON.stringify(message) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const update = (sessionId, value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });

// FAKE_ACP_DB_DIR: persist one agent step per prompt like agy's conversation
// store (steps.metadata field 9 = token usage).
const dbDir = process.env.FAKE_ACP_DB_DIR;
// FAKE_ACP_RESUME: advertise and answer session/resume, as agy 1.5 does.
const canResume = Boolean(process.env.FAKE_ACP_RESUME);
let sessionCount = 0;
/** sessionId → request id of a prompt waiting for session/cancel. */
const hanging = new Map();
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
		result(id, {
			protocolVersion: 1,
			agentInfo: { name: "fake", version: "1" },
			agentCapabilities: { loadSession: true, sessionCapabilities: canResume ? { resume: {}, load: {} } : { load: {} } },
			authMethods: [],
		});
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
	if ((method === "session/load" || method === "session/resume") && params.sessionId === "missing") {
		fail(id, -32603, `Failed to read session ${params.sessionId}`);
		return;
	}
	if (method === "session/resume" && !canResume) {
		fail(id, -32601, "Method not found: session/resume");
		return;
	}
	if (method === "session/load") {
		// Like agy: the history replays as notifications before the response.
		update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old prompt" } });
		update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED" } });
		result(id, {});
		return;
	}
	if (method === "session/set_config_option") {
		result(id, { configOptions: [] });
		return;
	}
	if (method === "session/prompt") {
		const text = params.prompt.map((block) => block.text ?? block.resource?.text ?? "").join("\n");
		if (text.includes("[exit]")) {
			process.stderr.write("fatal: fake server crashed\n");
			process.exit(3);
		}
		if (text.includes("[hang]") || text.includes("[silent-cancel]")) {
			update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
			if (text.includes("[hang]")) hanging.set(params.sessionId, id);
			return;
		}
		if (dbDir) await writeStep(params.sessionId, { input: 1200, output: 80, cacheRead: 8800 });
		update(params.sessionId, { sessionUpdate: "usage_update", used: 321, size: 1000 });
		update(params.sessionId, { sessionUpdate: "usage_update", used: -1, size: 0 });
		update("other-session", { sessionUpdate: "usage_update", used: 999, size: 1000 });
		update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } });
		update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
		result(id, { stopReason: "end_turn" });
		return;
	}
	if (method === "session/cancel") {
		// A notification, as in ACP. agy never answers the request form either.
		const pending = hanging.get(params.sessionId);
		if (id === undefined && pending !== undefined) {
			hanging.delete(params.sessionId);
			result(pending, { stopReason: "cancelled" });
		}
		return;
	}
	if (id !== undefined) result(id, {});
});
