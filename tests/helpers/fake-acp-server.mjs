import fs from "node:fs";
import readline from "node:readline";

const capture = process.argv[2];
const record = (message) => fs.appendFileSync(capture, JSON.stringify(message) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });

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
			sessionId: "session-1",
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
	if (method === "session/set_config_option") {
		result(id, { configOptions: [] });
		return;
	}
	if (method === "session/prompt") {
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
