import fs from "node:fs";
import readline from "node:readline";

const capture = process.argv[2];
const record = (message) => fs.appendFileSync(capture, JSON.stringify(message) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const update = (sessionId, value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });

// FAKE_ACP_DB_DIR: persist each prompt like agy's conversation store: its
// user-input step (14) on arrival, kept when the prompt is cancelled, and one
// agent step (15, metadata field 9 = token usage) when it completes.
const dbDir = process.env.FAKE_ACP_DB_DIR;
// FAKE_ACP_RESUME: advertise and answer session/resume, as agy 1.5 does.
const canResume = Boolean(process.env.FAKE_ACP_RESUME);
// FAKE_ACP_BRAIN_DIR: where background work reports completion, like agy's
// brain/<sessionId>/.system_generated/messages/<id>.json.
const brainDir = process.env.FAKE_ACP_BRAIN_DIR;
/** sessionId → frames agy buffered while no prompt ran (sent at the next
 *  prompt's start, before the prompt echo). */
const leftovers = new Map();
/** agy 1.5's session modes (session/new modes.availableModes). */
const MODES = ["default", "accept-edits", "plan"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function writeMessage(sessionId, message) {
	const dir = `${brainDir}/${sessionId}/.system_generated/messages`;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(`${dir}/msg-${Date.now()}-${Math.random().toString(16).slice(2)}.json`, JSON.stringify({ recipient: sessionId, priority: "MESSAGE_PRIORITY_HIGH", timestamp: new Date().toISOString(), ...message }));
}
let sessionCount = 0;
/** sessionId → request id of a prompt waiting for session/cancel. */
const hanging = new Map();
const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (n, value) => [...varint(n * 8), ...varint(value)];
const bytesField = (n, bytes) => [...varint(n * 8 + 2), ...varint(bytes.length), ...bytes];
async function appendStep(sessionId, stepType, metadata) {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(`${dbDir}/${sessionId}.db`);
	db.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
	const next = (db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM steps").get()).idx;
	db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)").run(next, stepType, metadata);
	db.close();
}
const writeUserInput = (sessionId) => appendStep(sessionId, 14, null);
function writeStep(sessionId, tokens) {
	const usage = [...field(1, 7), ...field(2, tokens.input), ...field(3, tokens.output), ...field(5, tokens.cacheRead)];
	return appendStep(sessionId, 15, Uint8Array.from([...field(1, 3), ...bytesField(9, usage)]));
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
			modes: { currentModeId: "default", availableModes: MODES.map((modeId) => ({ id: modeId, name: modeId })) },
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
		// Like agy 1.5: only the advertised modes exist.
		if (params.configId === "mode" && !MODES.includes(params.value)) {
			fail(id, -32602, `Unknown mode: ${params.value}`);
			return;
		}
		result(id, { configOptions: [] });
		return;
	}
	if (method === "session/prompt") {
		const text = params.prompt.map((block) => block.text ?? block.resource?.text ?? "").join("\n");
		const sid = params.sessionId;
		if (dbDir) await writeUserInput(sid);
		// Like agy: leftovers of finished background work first, then the
		// prompt echo, then the live turn.
		const pending = leftovers.get(sid);
		for (const frame of pending ?? []) update(sid, frame);
		// agy sends session status before the echo too; it is current, not a leftover.
		if (pending) update(sid, { sessionUpdate: "usage_update", used: 1234, size: 100000 });
		leftovers.delete(sid);
		if (!text.includes("[no-echo]")) update(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
		// [invalid]: agy's retry notice after a malformed model tool call.
		if (text.includes("[invalid]")) update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n⚠ Model produced invalid output.\n" } });
		if (text.includes("[native]")) {
			update(sid, { sessionUpdate: "tool_call", toolCallId: "n1", name: "read_file", args: { Path: "/w/a.txt" }, status: "in_progress", kind: "read", title: "File a.txt", rawInput: { Path: "/w/a.txt" } });
			update(sid, { sessionUpdate: "tool_call_update", toolCallId: "n1", name: "read_file", status: "completed", kind: "read", title: "File a.txt" });
			update(sid, { sessionUpdate: "tool_call", toolCallId: "n2", name: "run_command", args: { CommandLine: "false" }, status: "in_progress", kind: "execute", title: "false", rawInput: { CommandLine: "false" } });
			update(sid, { sessionUpdate: "tool_call_update", toolCallId: "n2", name: "run_command", status: "failed", kind: "execute", title: "false", rawOutput: { output: "" } });
			update(sid, { sessionUpdate: "tool_call", toolCallId: "b1", name: "mcp_pi-bridge_bash", args: { command: "ls" }, status: "in_progress", kind: "other", title: "Run mcp_pi-bridge_bash", rawInput: { command: "ls" } });
			update(sid, { sessionUpdate: "tool_call_update", toolCallId: "b1", name: "mcp_pi-bridge_bash", status: "completed", kind: "other", title: "Run mcp_pi-bridge_bash" });
		}
		const slow = /\[native-slow:(\d+)\]/.exec(text);
		if (slow) {
			update(sid, { sessionUpdate: "tool_call", toolCallId: "s1", name: "run_command", args: { CommandLine: "make" }, status: "in_progress", kind: "execute", title: "make", rawInput: { CommandLine: "make" } });
			// [overlap]: a quick call ends while the slow one still runs.
			if (text.includes("[overlap]")) update(sid, { sessionUpdate: "tool_call", toolCallId: "q1", name: "read_file", args: { Path: "/w/q" }, status: "in_progress", kind: "read", title: "File q", rawInput: { Path: "/w/q" } });
			if (text.includes("[overlap]")) update(sid, { sessionUpdate: "tool_call_update", toolCallId: "q1", name: "read_file", status: "completed", kind: "read", title: "File q" });
			await sleep(Number(slow[1]));
			update(sid, { sessionUpdate: "tool_call_update", toolCallId: "s1", name: "run_command", status: "completed", kind: "execute", title: "make", rawOutput: { output: "Command exited with code 0." } });
		}
		if (text.includes("[background]")) {
			update(sid, { sessionUpdate: "tool_call", toolCallId: "bg1", name: "run_command", args: { CommandLine: "sleep 1; echo FINISHED" }, status: "in_progress", kind: "execute", title: "sleep 1; echo FINISHED", rawInput: { CommandLine: "sleep 1; echo FINISHED" } });
			setTimeout(() => {
				writeMessage(sid, { sender: `${sid}/task-1`, renderDetails: { messageTitle: "Sleep task finished" }, content: "Command exited with code 0.\n\nCommand output:\ntick\r\nFINISHED\r\n\nLog: file:///tmp/task-1.log", sourceMetadata: { tool: { toolCall: { id: "bg1", name: "run_command" } } } });
				leftovers.set(sid, [
					{ sessionUpdate: "tool_call_update", toolCallId: "bg1", name: "run_command", status: "completed", kind: "execute", title: "sleep 1; echo FINISHED", rawOutput: { output: "FINISHED" } },
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LEFTOVER" } },
				]);
			}, 50);
		}
		if (text.includes("[subagent]")) {
			update(sid, { sessionUpdate: "tool_call", toolCallId: "sa1", name: "invoke_subagent", args: { Role: "Checker", Prompt: "check" }, status: "in_progress", kind: "other", title: "Run invoke_subagent", rawInput: { Role: "Checker", Prompt: "check" } });
			update(sid, { sessionUpdate: "tool_call_update", toolCallId: "sa1", name: "invoke_subagent", status: "completed", kind: "other", title: "Run invoke_subagent" });
			setTimeout(() => writeMessage(sid, { sender: "sub-1", renderDetails: { messageTitle: "Message from Checker (research)" }, content: "all good" }), 50);
		}
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
