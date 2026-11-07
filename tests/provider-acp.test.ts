// End to end through the real AcpDriver and the fake ACP server: Esc + continue
// (on the first turn, during a pi tool, and mid tool loop), extension tool
// changes, /tree rewinds, and transcripts too large for one prompt.
//
// The failure scenarios from the user's sessions are rebuilt from their
// description (the session logs were not available):
//   01a1afbb            /tree rewind; pi's tool restore activated pi-lens's
//                       situational tools and its next request declared them
//                       in a `<tools>` system message: fresh 160 KB fallback.
//   01a1af56 / 01a1ab97 Esc while a command ran (on the first turn, and in a
//                       multi-step tool loop), then `continue`: fresh fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { test, vi } from "vitest";
import { AcpDriver } from "../src/acp/driver.js";
import { createStreamSimple, failParkedCalls, ToolRoundTrips, type AcpSessions } from "../src/provider.js";
import { FALLBACK_MODELS, toPiModel } from "../src/models.js";
import { MAX_TRANSCRIPT_BYTES, restoreWarmSessions, WARM_SESSION_ENTRY, type WarmSession } from "../src/transcript.js";

type WireRequest = { id?: number; method: string; params: Record<string, any> };

const LENS_TOOLS = ["lens_symbols", "lens_references", "lens_diagnostics", "lens_rename", "lens_outline"];
const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const system = (tools = ["bash", "read", "pi_lens_activate_tools"]): Message =>
	({ role: "system", content: "Rules", toolsAdded: tools.map(tool), timestamp: 0 }) as unknown as Message;
/** pi's `<tools>` declaration message (agent-loop declareToolChanges). */
const toolsDeclared = (names: string[]): Message =>
	({ role: "system", content: "", toolsAdded: names.map(tool), timestamp: 5 }) as unknown as Message;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const toolResult = (id: string, name: string, text: string, isError = false): Message =>
	({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 3 });
const ctx = (messages: Message[]) => ({ messages }) as unknown as TranscriptContext;

function harness() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-provider-acp-"));
	const capture = path.join(dir, "requests.ndjson");
	const dbDir = path.join(dir, "conversations");
	fs.mkdirSync(dbDir);
	fs.writeFileSync(capture, "");
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [path.join(process.cwd(), "tests/helpers/fake-acp-server.mjs"), capture],
		extraEnv: { FAKE_ACP_DB_DIR: dbDir, FAKE_ACP_RESUME: "1" },
		conversationsDir: () => dbDir,
	});
	const roundTrips = new ToolRoundTrips(driver);
	driver.onTurnEnd = (outcome) => failParkedCalls(roundTrips, outcome);
	const persisted: WarmSession[] = [];
	const sessions: AcpSessions = { conversationsDir: () => dbDir, onWarm: (warm) => persisted.push(warm) };
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips, sessions });
	const model = toPiModel(FALLBACK_MODELS.find((entry) => entry.id === "gemini-3-8-flash")!);
	const wire = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireRequest);
	const prompts = () => wire().filter((request) => request.method === "session/prompt").map((request) => ({
		sessionId: request.params.sessionId as string,
		text: (request.params.prompt as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text).join("\n"),
		resource: (request.params.prompt as Array<{ type: string; resource?: { uri: string; text: string } }>).find((block) => block.type === "resource")?.resource,
	}));
	const sessionNews = () => wire().filter((request) => request.method === "session/new").length;
	/** One pi request; `onEvent` sees events as they stream (to press Esc). */
	const turn = async (messages: Message[], options: { signal?: AbortSignal; onEvent?: (event: AssistantMessageEvent) => void } = {}) => {
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream(model, ctx(messages), { cwd: process.cwd(), signal: options.signal } as never)) {
			events.push(event);
			options.onEvent?.(event);
		}
		const last = events.at(-1)!;
		const message: AssistantMessage = last.type === "done" ? last.message : last.type === "error" ? last.error : (() => { throw new Error(`no final event: ${last.type}`); })();
		return { events, message, reason: last.type === "done" || last.type === "error" ? last.reason : undefined };
	};
	const waitForPrompts = (count: number) => vi.waitFor(() => assert.equal(prompts().length, count), { timeout: 5000 });
	return { driver, roundTrips, sessions, persisted, turn, prompts, sessionNews, waitForPrompts, dbDir };
}

test("01a1af56: Esc during a streaming reply on the first turn, then `continue`, reuses the session", async () => {
	const h = harness();
	try {
		const u1 = user("Write the release notes [hang]");
		const esc = new AbortController();
		const first = await h.turn([system(), u1], {
			signal: esc.signal,
			onEvent: (event) => { if (event.type === "text_delta") esc.abort(); },
		});
		assert.equal(first.reason, "aborted");
		assert.equal(first.message.content.find((block) => block.type === "text")?.type === "text" && (first.message.content[0] as { text: string }).text, "partial");
		// The aborted turn left a persisted checkpoint instead of nothing.
		assert.equal(h.persisted.length, 1);
		assert.equal(h.sessions.warm?.sessionId, "session-1");
		assert.equal(h.sessions.warm?.count, 3, "system, prompt, aborted reply");

		const next = await h.turn([system(), u1, first.message, user("continue")]);
		assert.equal(next.reason, "stop");
		const sent = h.prompts().at(-1)!;
		assert.deepEqual(sent, { sessionId: "session-1", text: "continue", resource: undefined }, "only the new message, on the same session");
		assert.equal(h.sessionNews(), 1, "no fresh session");
	} finally {
		await h.driver.close();
	}
});

test("01a1ab97: Esc while pi runs bash, then `continue`, delivers the aborted result to the same session", async () => {
	const h = harness();
	try {
		const u1 = user("Run the build [hang]");
		const esc = new AbortController();
		const first = h.turn([system(), u1], { signal: esc.signal });
		await h.waitForPrompts(1);
		// agy calls pi's bash over the bridge; pi gets a genuine toolUse.
		const parked = h.roundTrips.onToolCall("call-1", "bash", { command: "npm run build" }, new AbortController().signal);
		const toolUse = await first;
		assert.equal(toolUse.reason, "toolUse");
		// The tool boundary is a checkpoint already (memory only).
		assert.equal(h.sessions.step?.sessionId, "session-1");
		assert.equal(h.sessions.warm, h.sessions.step);
		assert.equal(h.persisted.length, 0);

		// Esc while bash runs: the ACP turn is cancelled and its parked call failed.
		esc.abort();
		await assert.rejects(parked, /aborted|ended/);
		assert.equal(h.roundTrips.isPending("call-1"), false);
		await vi.waitFor(() => assert.equal(h.driver.activeHandle, null));

		// pi hands back the aborted tool result with the run's signal aborted.
		const r1 = toolResult("call-1", "bash", "Command aborted", true);
		const aborted = await h.turn([system(), u1, toolUse.message, r1], { signal: esc.signal });
		assert.equal(aborted.reason, "aborted");
		assert.equal(h.prompts().length, 1, "nothing new was sent");
		// The settled turn persisted its checkpoint at the toolUse message.
		assert.equal(h.persisted.length, 1);
		assert.equal(h.persisted[0].count, 3);
		assert.equal(h.persisted[0].maxStepIdx, 0);

		const next = await h.turn([system(), u1, toolUse.message, r1, aborted.message, user("continue")]);
		assert.equal(next.reason, "stop");
		const sent = h.prompts().at(-1)!;
		assert.equal(sent.sessionId, "session-1", "the same session, not a fork or a fresh one");
		assert.equal(sent.resource?.uri, "pi://transcript-delta");
		assert.match(sent.resource!.text, /<pi-tool-result name="bash" id="call-1" error=true>\nCommand aborted/);
		assert.match(sent.resource!.text, /<user>\ncontinue\n<\/user>/);
		assert.ok(!sent.resource!.text.includes("Run the build"), "the session already holds the prompt");
		assert.equal(h.sessionNews(), 1);
	} finally {
		await h.driver.close();
	}
});

test("parallel tool results aggregate and continue on the same ACP session", async () => {
	const h = harness();
	try {
		const u1 = user("Read both files [native-slow:50]");
		const first = h.turn([system(), u1]);
		await h.waitForPrompts(1);
		const parked = h.roundTrips.onToolCall("batch", "parallel", {
			calls: [
				{ name: "read", arguments: { path: "src/a.ts" } },
				{ name: "read", arguments: { path: "src/b.ts" } },
			],
		}, new AbortController().signal);
		const toolUse = await first;
		assert.equal(toolUse.reason, "toolUse");
		assert.deepEqual(
			toolUse.message.content.filter((block) => block.type === "toolCall").map((block) => block.type === "toolCall" && block.id),
			["batch:1", "batch:2"],
		);
		assert.equal(h.sessions.step?.sessionId, "session-1");

		const r1 = toolResult("batch:1", "read", "alpha");
		const r2 = toolResult("batch:2", "read", "beta");
		const second = await h.turn([system(), u1, toolUse.message, r1, r2]);
		assert.equal(second.reason, "stop");
		const aggregate = await parked;
		assert.equal(aggregate.isError, false);
		const text = aggregate.content[0];
		assert.equal(text.type, "text");
		const payload = JSON.parse(text.type === "text" ? text.text : "");
		assert.deepEqual(payload.results.map((result: { content: Array<{ text: string }> }) => result.content[0].text), ["alpha", "beta"]);
		assert.equal(h.prompts().length, 1, "both results resume the existing prompt without a new session/prompt");
		assert.equal(h.sessionNews(), 1);
		assert.equal(h.persisted.at(-1)?.count, 6);

		const next = await h.turn([system(), u1, toolUse.message, r1, r2, second.message, user("next")]);
		assert.equal(next.reason, "stop");
		assert.deepEqual(h.prompts().at(-1), { sessionId: "session-1", text: "next", resource: undefined });
		assert.equal(h.sessionNews(), 1);
	} finally {
		await h.driver.close();
	}
});

test("Esc during the reply after a tool result (multi-step loop) checkpoints the whole loop", async () => {
	const h = harness();
	try {
		const u1 = user("Fix the bug [hang]");
		const esc = new AbortController();
		const first = h.turn([system(), u1], { signal: esc.signal });
		await h.waitForPrompts(1);
		const parked = h.roundTrips.onToolCall("call-1", "read", { path: "src/a.ts" }, new AbortController().signal);
		const toolUse = await first;
		const r1 = toolResult("call-1", "read", "export const a = 1;");
		// pi returns the result: the same ACP turn continues streaming.
		const second = h.turn([system(), u1, toolUse.message, r1], { signal: esc.signal });
		assert.deepEqual(await parked, { content: [{ type: "text", text: "export const a = 1;" }], isError: false });
		esc.abort();
		const aborted = await second;
		assert.equal(aborted.reason, "aborted");
		assert.equal(h.persisted.length, 1);
		assert.equal(h.persisted[0].count, 5, "system, prompt, toolUse, result, aborted reply");

		await h.turn([system(), u1, toolUse.message, r1, aborted.message, user("continue")]);
		assert.deepEqual(h.prompts().at(-1), { sessionId: "session-1", text: "continue", resource: undefined });
		assert.equal(h.sessionNews(), 1);
	} finally {
		await h.driver.close();
	}
});

test("a mid-turn pi_lens_activate_tools keeps the session and the next turn's plain prompt", async () => {
	const h = harness();
	try {
		const u1 = user("Rename the symbol [native-slow:1500]");
		const first = h.turn([system(), u1]);
		await h.waitForPrompts(1);
		const parked = h.roundTrips.onToolCall("call-1", "pi_lens_activate_tools", { tools: LENS_TOOLS }, new AbortController().signal);
		const toolUse = await first;
		const r1 = toolResult("call-1", "pi_lens_activate_tools", `Activated ${LENS_TOOLS.join(", ")}`);
		// pi declares the newly active tools before its next request.
		const loop = [system(), u1, toolUse.message, r1, toolsDeclared(LENS_TOOLS)];
		const done = await h.turn(loop);
		await parked;
		assert.equal(done.reason, "stop");
		assert.match(h.sessions.warm!.tools, /lens_symbols/);

		await h.turn([...loop, done.message, user("now rename it everywhere")]);
		assert.deepEqual(h.prompts().at(-1), { sessionId: "session-1", text: "now rename it everywhere", resource: undefined });
		assert.equal(h.sessionNews(), 1);
	} finally {
		await h.driver.close();
	}
});

test("01a1afbb: /tree rewind with pi's restored pi-lens tools declared in a <tools> message stays warm", async () => {
	const h = harness();
	try {
		const u1 = user("Explain the module");
		const t1 = await h.turn([system(), u1]);
		const u2 = user("Add tests");
		const t2 = await h.turn([system(), u1, t1.message, u2]);
		assert.equal(h.persisted.length, 2);

		// Reload, then rewind to turn 1 with a new prompt. pi's restore
		// activated pi-lens's situational tools, so its request declares them.
		const restored = restoreWarmSessions(
			h.persisted.map((data) => ({ type: "custom", customType: WARM_SESSION_ENTRY, data })).slice(0, 1),
			h.persisted.map((data) => ({ type: "custom", customType: WARM_SESSION_ENTRY, data })),
		);
		h.sessions.warm = restored.warm;
		h.sessions.checkpoints = restored.checkpoints;
		const rewound = await h.turn([system(), u1, t1.message, toolsDeclared(LENS_TOOLS), user("Document it instead")]);
		assert.equal(rewound.reason, "stop");
		const sent = h.prompts().at(-1)!;
		// session-1 advanced past turn 1, so the rewind forks it at that step.
		assert.notEqual(sent.sessionId, "session-1");
		assert.ok(fs.existsSync(path.join(h.dbDir, `${sent.sessionId}.db`)), "a forked store, not a fresh session");
		assert.equal(h.sessionNews(), 1);
		assert.equal(sent.resource?.uri, "pi://transcript-delta");
		assert.match(sent.resource!.text, /<pi-tools-update>\nThe active pi tools are now: [^\n]*lens_symbols/);
		assert.match(sent.resource!.text, /<user>\nDocument it instead\n<\/user>/);
		assert.ok(!sent.resource!.text.includes("Add tests"));
		void t2;
	} finally {
		await h.driver.close();
	}
});

test("switching to agy mid-session delivers a transcript too large for one prompt in parts, then stays warm", async () => {
	const h = harness();
	try {
		// Another provider's long run before switching to an agy model.
		const other: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text: `${"FIRST-MARK ".repeat(4)}\n${"long output line\n".repeat(20_000)}` }],
			api: "anthropic-messages", provider: "anthropic", model: "claude", stopReason: "stop", timestamp: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const history = [system(), user("Audit the repo"), other as Message, user("Now continue with agy")];
		const events: AssistantMessageEvent[] = [];
		const done = await h.turn(history, { onEvent: (event) => events.push(event) });
		assert.equal(done.reason, "stop");
		const sent = h.prompts();
		assert.equal(sent.length, 3, "two earlier parts, then the prompt");
		assert.ok(sent.every((prompt) => prompt.sessionId === "session-1"));
		assert.match(sent[0].text, /^Part 1 of 3 of the pi transcript/);
		assert.match(sent[0].resource!.text, /^<pi-system>[\s\S]*FIRST-MARK/);
		assert.match(sent[2].text, /part 3 of 3 of the pi transcript/);
		assert.match(sent[2].resource!.text, /<user>\nNow continue with agy\n<\/user>$/);
		for (const prompt of sent) assert.ok(Buffer.byteLength(prompt.resource!.text, "utf8") <= MAX_TRANSCRIPT_BYTES);
		assert.ok(!sent.some((prompt) => prompt.resource!.text.includes("<pi-transcript-omitted")), "nothing was dropped");
		assert.equal(sent.map((prompt) => prompt.resource!.text).join("").split("long output line").length - 1, 20_000);
		// The parts' acknowledgements are not pi's reply.
		assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" && event.delta), ["OK"]);

		await h.turn([...history, done.message, user("next")]);
		assert.deepEqual(h.prompts().at(-1), { sessionId: "session-1", text: "next", resource: undefined });
	} finally {
		await h.driver.close();
	}
});

test("Esc while transcript parts are delivered refuses pi tools and records no checkpoint", async () => {
	const h = harness();
	try {
		const esc = new AbortController();
		const history = [system(), user(`Old task [hang] ${"x".repeat(MAX_TRANSCRIPT_BYTES)}`), user("new task")];
		const pending = h.turn(history, { signal: esc.signal });
		await h.waitForPrompts(1);
		assert.equal(h.driver.priming, true);
		const refused = await h.roundTrips.onToolCall("c1", "bash", {}, new AbortController().signal);
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].type === "text" ? refused.content[0].text : "", /delivered in parts/);
		esc.abort();
		const aborted = await pending;
		assert.equal(aborted.reason, "aborted");
		assert.equal(h.prompts().length, 1, "the real prompt was never sent");
		assert.equal(h.sessions.warm, undefined, "the session holds only part of the transcript");
		assert.equal(h.persisted.length, 0);
	} finally {
		await h.driver.close();
	}
});
