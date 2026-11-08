// Deterministic ACP process for native-store lifecycle tests. It holds a read
// cache like agy, flushes before exiting, and never accepts transcript replay.
import fs from "node:fs";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const [capture, dbPath] = process.argv.slice(2);
const record = (method, params = {}) => fs.appendFileSync(capture, JSON.stringify({ method, params, pid: process.pid }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, value = {}) => send({ jsonrpc: "2.0", id, result: value });
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-session", update: value } });
const db = new DatabaseSync(dbPath);
const cached = db.prepare("SELECT idx, step_payload FROM steps ORDER BY idx").all();
let hanging;
record("spawn");
process.on("SIGTERM", () => {
	// A final flush would overwrite a premature edit. Tests verify stop() waits.
	const update = db.prepare("UPDATE steps SET step_payload = ? WHERE idx = ?");
	for (const row of cached) update.run(row.step_payload, row.idx);
	record("stopped");
	db.close();
	process.exit(0);
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const { id, method, params = {} } = JSON.parse(line);
	record(method, params);
	if (method === "initialize") return result(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
	if (method === "session/new") return result(id, { sessionId: "native-session", models: { availableModels: [] }, configOptions: [] });
	if (method === "session/resume" || method === "session/load") {
		if (fs.existsSync(`${dbPath}.reject-load`)) return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "test reload failure" } });
		return result(id, { sessionId: params.sessionId });
	}
	if (method === "session/set_config_option") return result(id);
	if (method === "session/cancel") {
		if (hanging !== undefined) result(hanging, { stopReason: "cancelled" });
		hanging = undefined;
		return;
	}
	if (method === "session/prompt") {
		const text = params.prompt.map((block) => block.text ?? "").join("");
		if (text === "[park]") { hanging = id; return; }
		if (params.prompt.some((block) => block.type === "resource")) throw new Error("Native sync must not replay a transcript");
		if (text) update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
		// Content is from this process's startup snapshot, not a post-prompt DB read.
		const value = Buffer.from(cached[1].step_payload).toString("utf8").includes("SYNCED_RESULT") ? "SYNCED_RESULT" : "ORIGINAL_RESULT";
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
		return result(id, { stopReason: "end_turn" });
	}
	result(id);
});
