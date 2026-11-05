import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { calculateContextTokens, AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { conversationDbPath, lastStepIdx } from "../src/acp/step-usage.js";
import { createStreamSimple, POLL_TOOL_NAME, ToolRoundTrips, type AcpSessions } from "../src/provider.js";
import type { DriverActivity, DriverSnapshot, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "../src/driver-types.js";
import { FALLBACK_MODELS, toPiModel } from "../src/models.js";
import {
	freshInput,
	MAX_TRANSCRIPT_BYTES,
	planTurn,
	restoreWarmSessions,
	serializeBounded,
	WARM_SESSION_ENTRY,
	warmAfterTurn,
	type SessionEntryLike,
} from "../src/transcript.js";
class FakeHandle implements TurnHandle {
	id = "turn-1";
	outcome: Promise<TurnOutcome>;
	#activities: DriverActivity[] = [];
	#wake: Array<() => void> = [];
	#closed = false;
	#resolve!: (outcome: TurnOutcome) => void;

	constructor() {
		this.outcome = new Promise((resolve) => { this.#resolve = resolve; });
	}

	async next(): Promise<DriverActivity | null> {
		if (this.#activities.length > 0) return this.#activities.shift()!;
		if (this.#closed) return null;
		await new Promise<void>((resolve) => this.#wake.push(resolve));
		return this.next();
	}

	pushExternal(activity: DriverActivity): void {
		this.#activities.push(activity);
		this.#wake.shift()?.();
	}

	complete(outcome: TurnOutcome = { status: "OK", response: "", finished: true, aborted: false }): void {
		this.#closed = true;
		this.#resolve(outcome);
		for (const wake of this.#wake.splice(0)) wake();
	}
}

class FakeDriver implements TurnDriver {
	state = "ready" as const;
	activeHandle: TurnHandle | null = null;
	onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	requests: DriverTurnRequest[] = [];
	script: DriverActivity[] = [];
	autoFinish = true;

	async run(request: DriverTurnRequest): Promise<TurnHandle> {
		this.requests.push(request);
		const handle = new FakeHandle();
		this.activeHandle = handle;
		for (const activity of this.script) handle.pushExternal(activity);
		if (this.autoFinish) handle.complete();
		return handle;
	}

	reentry(): TurnHandle | null { return this.activeHandle; }
	kickIdle(): void {}
	snapshot(): DriverSnapshot {
		return { state: this.state, stats: { spawns: 0, turns: 0, reused: 0, recycles: 0, recycleReasons: {} }, lifecycle: [] };
	}
	async close(): Promise<void> { this.activeHandle = null; }
}

function context(messages: Message[]): TranscriptContext {
	// SAFETY: fixtures have one leading system message and no tool-state deltas.
	return { messages } as unknown as TranscriptContext;
}

const system = (): Message => ({ role: "system", content: "Test system", timestamp: Date.now() });
const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });

async function collect(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("fresh turns preserve transcript prefix, avoid duplicate prompts, and carry historical images", async () => {
	const driver = new FakeDriver();
	const entry = FALLBACK_MODELS[0];
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver) });
	const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
	const first: Message = { role: "user", content: [{ type: "text", text: "look at this" }, image], timestamp: 1 };
	const result: Message = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "image file" }, image], isError: false, timestamp: 2 };
	await collect(stream(toPiModel(entry), context([system(), first])));
	await collect(stream(toPiModel(entry), context([system(), first, result, user("what is in it?")])));
	const [a, b] = driver.requests;
	assert.equal(a.prompt, b.prompt);
	assert.ok(!a.prompt.includes("look at this"));
	assert.ok(b.contextBlock!.text.startsWith(a.contextBlock!.text));
	assert.equal((b.contextBlock!.text.match(/what is in it\?/g) ?? []).length, 1);
	assert.match(b.contextBlock!.text, /\[Attached image 1\]/);
	assert.match(b.contextBlock!.text, /\[Attached image 2\]/);
	assert.deepEqual(b.images, [{ data: image.data, mimeType: image.mimeType }, { data: image.data, mimeType: image.mimeType }]);
});
test("provider streams native thinking/text and maps GPT to its medium ACP slug", async () => {
	const driver = new FakeDriver();
	driver.script = [{ type: "thought", delta: "reasoning" }, { type: "text", delta: "OK" }];
	const entry = FALLBACK_MODELS.find((candidate) => candidate.id === "gpt-oss-120b")!;
	const entries = [...FALLBACK_MODELS];
	const stream = createStreamSimple({ entries, driver, roundTrips: new ToolRoundTrips(driver) })(
		toPiModel(entry), context([system(), user("Reply")]), { reasoning: "high" },
	);
	const events = await collect(stream);
	assert.ok(events.some((event) => event.type === "thinking_delta" && event.delta === "reasoning"));
	assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "OK"));
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(driver.requests[0].model, "gpt-oss-120b");
	assert.equal(driver.requests[0].effort, "medium");
	assert.equal(driver.requests[0].conversationId, null);
});

test("provider preserves context occupancy separately from cumulative usage", async () => {
	const driver = new FakeDriver();
	driver.script = [
		{ type: "context_usage", contextUsage: { used: 54357, size: 1000000 } },
		{ type: "usage", usage: { input_tokens: 693513, output_tokens: 3731, total_tokens: 697244, cache_read_tokens: 633966 } },
		{ type: "text", delta: "OK" },
	];
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver) });
	const done = (await collect(stream(toPiModel(FALLBACK_MODELS[0]), context([system(), user("Reply")])))).find((event) => event.type === "done");
	assert.equal(done?.type, "done");
	if (done?.type !== "done") throw new Error("No done event");
	assert.equal(done.message.usage.totalTokens, 54357);
	assert.equal(calculateContextTokens(done.message.usage), 54357);
	assert.equal(done.message.usage.input, 59547);
	assert.equal(done.message.usage.input + done.message.usage.output + done.message.usage.cacheRead, 697244);
	assert.equal((done.message.usage as typeof done.message.usage & { agyCumulativeTotalTokens?: number }).agyCumulativeTotalTokens, 697244);
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(user("Reply"));
	sessionManager.appendMessage(done.message);
	// Exercise stock pi's plugin-facing getter with only its two state dependencies.
	const receiver = { sessionManager, _limitsModel: () => ({ contextWindow: 1000000 }) };
	// SAFETY: getContextUsage only accesses sessionManager and _limitsModel.
	const usage = AgentSession.prototype.getContextUsage.call(receiver as unknown as AgentSession);
	assert.equal(usage?.tokens, 54357);
	assert.equal(usage?.percent, 54357 / 1000000 * 100);
});

test("MCP call becomes a genuine pi toolUse and its toolResult resumes ACP", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const entries = [...FALLBACK_MODELS];
	const model = toPiModel(FALLBACK_MODELS.find((candidate) => candidate.id === "claude-sonnet-5-5")!);
	const roundTrips = new ToolRoundTrips(driver);
	const streamSimple = createStreamSimple({ entries, driver, roundTrips });

	const first = collect(streamSimple(model, context([system(), user("Run bash")])));
	await vi.waitFor(() => assert.equal(driver.requests.length, 1));
	const parked = roundTrips.onToolCall("call-1", "bash", { command: "printf ok" }, new AbortController().signal);
	const firstEvents = await first;
	const done = firstEvents.find((event) => event.type === "done");
	assert.equal(done?.type === "done" && done.reason, "toolUse");
	const toolCall = firstEvents.find((event) => event.type === "toolcall_end");
	assert.equal(toolCall?.type === "toolcall_end" && toolCall.toolCall.name, "bash");
	assert.deepEqual(toolCall?.type === "toolcall_end" && toolCall.toolCall.arguments, { command: "printf ok" });

	const handle = driver.activeHandle as FakeHandle;
	handle.pushExternal({ type: "context_usage", contextUsage: { used: 54357, size: 1000000 } });
	handle.pushExternal({ type: "usage", usage: { input_tokens: 693513, output_tokens: 3731, total_tokens: 697244 } });
	handle.pushExternal({ type: "text", delta: "finished" });
	handle.complete();
	const toolResult: Message = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() };
	const second = collect(streamSimple(model, context([system(), user("Run bash"), toolResult])));
	assert.deepEqual(await parked, { content: [{ type: "text", text: "ok" }], isError: false });
	const secondEvents = await second;
	assert.ok(secondEvents.some((event) => event.type === "text_delta" && event.delta === "finished"));
	assert.equal(secondEvents.at(-1)?.type, "done");
	const finalDone = secondEvents.find((event) => event.type === "done");
	assert.equal(finalDone?.type === "done" && finalDone.message.usage.totalTokens, 54357);
	assert.equal(finalDone?.type === "done" && (finalDone.message.usage as typeof finalDone.message.usage & { agyCumulativeTotalTokens?: number }).agyCumulativeTotalTokens, 697244);
});

test("slow tools early-ack and return the real result through the poll tool", async () => {
	vi.useFakeTimers();
	try {
		const driver = new FakeDriver();
		driver.autoFinish = false;
		await driver.run({ cwd: process.cwd(), model: "gpt-oss-120b", mode: "accept-edits", skipPermissions: true, prompt: "test" });
		const roundTrips = new ToolRoundTrips(driver);
		const parked = roundTrips.onToolCall("slow-1", "bash", {}, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(20_000);
		const early = await parked;
		assert.match(early.content[0].type === "text" ? early.content[0].text : "", /STILL RUNNING/);
		roundTrips.resolve("slow-1", "slow output", false);
		const polled = await roundTrips.onToolCall("poll", POLL_TOOL_NAME, { callId: "slow-1" }, new AbortController().signal);
		assert.deepEqual(polled, { content: [{ type: "text", text: "slow output" }], isError: false });
	} finally {
		vi.useRealTimers();
	}
});


test("image tool results go back as MCP image blocks on the existing ACP handle", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const close = vi.spyOn(driver, "close");
	const roundTrips = new ToolRoundTrips(driver);
	const model = toPiModel(FALLBACK_MODELS[0]);
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	try {
		const first = collect(stream(model, context([system(), user("Read the image")])));
		await vi.waitFor(() => assert.equal(driver.requests.length, 1));
		const parked = roundTrips.onToolCall("image-call", "read", { path: "/tmp/arbitrary.png" }, new AbortController().signal);
		await first;
		const handle = driver.activeHandle as FakeHandle;
		handle.pushExternal({ type: "text", delta: "seen" });
		handle.complete();
		const result: Message = { role: "toolResult", toolCallId: "image-call", toolName: "read", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], isError: false, timestamp: 2 };
		await collect(stream(model, context([system(), user("Read the image"), result])));
		const reply = await parked;
		assert.deepEqual(reply.content, [{ type: "text", text: "(image result)" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		assert.equal(driver.requests.length, 1);
		assert.equal(close.mock.calls.length, 0);
	} finally { roundTrips.failAll("test done"); }
});

test("steering messages queued during a tool call ride the MCP tool result and preserve warm sessions", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const roundTrips = new ToolRoundTrips(driver);
	const model = toPiModel(FALLBACK_MODELS[0]);
	const sessions = {};
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips, sessions });
	const image = { type: "image" as const, data: "c3RlZXI=", mimeType: "image/png" };
	try {
		const turnStart = [system(), user("Update docs")];
		const step1 = collect(stream(model, context(turnStart)));
		await vi.waitFor(() => assert.equal(driver.requests.length, 1));
		const parked1 = roundTrips.onToolCall("call-1", "read", { path: "README.md" }, new AbortController().signal);
		const step1Done = (await step1).find((event) => event.type === "done");
		assert.equal(step1Done?.type, "done");
		if (step1Done?.type !== "done") return;

		// User sends two steering messages (second with an image) while call-1 runs.
		const result1: Message = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "# Old README" }], isError: false, timestamp: 2 };
		const steer1 = user("put docs in docs/xxx");
		const steer2: Message = { role: "user", content: [{ type: "text", text: "not a huge README.md" }, image], timestamp: 3 };
		const afterSteer = [...turnStart, step1Done.message, result1, steer1, steer2];

		const step2 = collect(stream(model, context(afterSteer)));
		const reply1 = await parked1;
		assert.equal(reply1.isError, false);
		assert.deepEqual(reply1.content, [
			{
				type: "text",
				text: [
					"# Old README",
					"",
					"<pi-steering>",
					"The user sent a steering message while this tool was running. Address it immediately:",
					"<user>\nput docs in docs/xxx\n</user>",
					"",
					"<user>\nnot a huge README.md\n[Attached image 1]\n</user>",
					"</pi-steering>",
				].join("\n"),
			},
			{ type: "image", data: "c3RlZXI=", mimeType: "image/png" },
		]);

		// A subsequent tool call in the same turn must not re-send earlier steering.
		const parked2 = roundTrips.onToolCall("call-2", "bash", { command: "cargo test" }, new AbortController().signal);
		const step2Done = (await step2).find((event) => event.type === "done");
		assert.equal(step2Done?.type, "done");
		if (step2Done?.type !== "done") return;

		const handle = driver.activeHandle as FakeHandle;
		handle.pushExternal({ type: "text", delta: "all done" });
		handle.complete({ status: "OK", response: "all done", finished: true, aborted: false, conversationId: "acp-warm" });
		const result2: Message = { role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "9 passed" }], isError: false, timestamp: 4 };
		const afterCall2 = [...afterSteer, step2Done.message, result2];
		const step3Done = (await collect(stream(model, context(afterCall2)))).find((event) => event.type === "done");
		assert.deepEqual(await parked2, { content: [{ type: "text", text: "9 passed" }], isError: false });
		assert.equal(step3Done?.type, "done");
		if (step3Done?.type !== "done") return;

		// Next user turn reuses the warm session cleanly with only the new user prompt.
		driver.autoFinish = true;
		driver.script = [{ type: "text", delta: "no change needed" }];
		await collect(stream(model, context([...afterCall2, step3Done.message, user("do I need to change compose?")])));
		assert.equal(driver.requests.length, 2);
		assert.equal(driver.requests[1].conversationId, "acp-warm");
		assert.equal(driver.requests[1].prompt, "do I need to change compose?");
		assert.equal(driver.requests[1].contextBlock, undefined);
	} finally {
		roundTrips.failAll("test done");
	}
});

test("bounded transcript keeps system prompt, realctx-history summaries, and newest messages under the byte cap", () => {
	const sys = "<pi-system>\nSystem rules\n</pi-system>";
	const hist = user('<realctx-history part="h1" turns="1-5" replaced="12.0k tok">\nEarlier summary\n</realctx-history>');
	const imgOld = { type: "image" as const, data: "b2xk", mimeType: "image/png" };
	const imgNew = { type: "image" as const, data: "bmV3", mimeType: "image/png" };
	const oldMsg: Message = { role: "user", content: [{ type: "text", text: "old ".repeat(400) }, imgOld], timestamp: 2 };
	const midMsg = user("mid ".repeat(400));
	const recentMsg: Message = { role: "user", content: [{ type: "text", text: "latest user question" }, imgNew], timestamp: 4 };

	const bounded = serializeBounded(sys, [system(), hist, oldMsg, midMsg, recentMsg], 1_200);
	assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 1_200);
	assert.match(bounded.text, /^<pi-system>\nSystem rules\n<\/pi-system>/);
	assert.match(bounded.text, /<realctx-history part="h1"/);
	assert.match(bounded.text, /<pi-transcript-omitted messages="2">/);
	assert.match(bounded.text, /latest user question\n\[Attached image 1\]/);
	assert.ok(!bounded.text.includes("old old old"));
	assert.deepEqual(bounded.images, [{ data: "bmV3", mimeType: "image/png" }]);

	const huge = freshInput(context([system(), hist, user("x".repeat(MAX_TRANSCRIPT_BYTES + 20_000)), user("tail prompt")]));
	assert.ok(Buffer.byteLength(huge.contextBlock!.text, "utf8") <= MAX_TRANSCRIPT_BYTES);
	assert.match(huge.contextBlock!.text, /<realctx-history part="h1"/);
	assert.match(huge.contextBlock!.text, /tail prompt/);
});

test("warm session survives realctx drops, path-notes, history chunks, tag stripping, and ephemeral pi-lens messages", () => {
	const model = toPiModel(FALLBACK_MODELS[0]);
	const img = { type: "image" as const, data: "dXNlckltZw==", mimeType: "image/png" };
	const turn1User: Message = { role: "user", content: [{ type: "text", text: "inspect this screenshot" }, img], timestamp: 1 };
	const turn1Asst: Message = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "src/a.ts" } },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 2,
	};
	const turn1Tool: Message = {
		role: "toolResult",
		toolCallId: "call-read-1",
		toolName: "read",
		content: [{ type: "text", text: "full file contents\n<realctx-path-notes>\nnote\n</realctx-path-notes>" }],
		isError: false,
		timestamp: 3,
	};
	const turn2User = user("can we work with realctx historian?");
	const transient1 = user("[pi-lens automated check — not a user request] Address 🔴 blockers before continuing");
	const rawFinal = {
		role: "assistant" as const,
		content: [{
			type: "text" as const,
			text: 'Yes, it uses\n<realctx-history part="h1">\nsummary\n</realctx-history>\nand\n[#42 dropped · read a.ts · 3.1k tok]\nplaceholders.',
		}],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 10,
	};
	const warm = warmAfterTurn(
		context([system(), turn1User, turn1Asst, turn1Tool, turn2User, transient1]),
		rawFinal,
		"acp-session-1",
		"/repo",
	);

	// 1. Next turn after realctx drops the user image and toolResult body, strips forged assistant tags,
	//    and pi-lens removes its ephemeral check message:
	const turn1UserDropped: Message = {
		role: "user",
		content: [
			{ type: "text", text: "inspect this screenshot" },
			{ type: "text", text: "[#1 dropped · user image (1 image) · 1.2k tok]" },
		],
		timestamp: 1,
	};
	const turn1ToolDropped: Message = {
		...turn1Tool,
		content: [{ type: "text", text: "[#2 dropped · read src/a.ts · 3.1k tok]" }],
	};
	const cleanedAssistant = {
		...rawFinal,
		content: [{
			type: "text" as const,
			text: "Yes, it uses\n\nand\n\nplaceholders.",
		}],
	};
	const planAfterDrops = planTurn(
		context([system(), turn1UserDropped, turn1Asst, turn1ToolDropped, turn2User, cleanedAssistant, user("great, let's adapt it")]),
		"/repo",
		warm,
	);
	assert.equal(planAfterDrops.kind, "warm");
	if (planAfterDrops.kind !== "warm") return;
	assert.equal(planAfterDrops.sessionId, "acp-session-1");
	assert.equal(planAfterDrops.input.prompt, "great, let's adapt it");

	// 2. Next turn after realctx historian also folds turn 1 into a <realctx-history> summary chunk:
	const historyChunk = user('<realctx-history part="h1" turns="1-1" replaced="4.3k tok">\nTurn 1 summary\n</realctx-history>');
	const planAfterHistorian = planTurn(
		context([system(), historyChunk, turn2User, cleanedAssistant, user("still warm after historian?")]),
		"/repo",
		warm,
	);
	assert.equal(planAfterHistorian.kind, "warm");
	if (planAfterHistorian.kind !== "warm") return;
	assert.equal(planAfterHistorian.sessionId, "acp-session-1");
	assert.equal(planAfterHistorian.input.prompt, "still warm after historian?");
});

test("mid-turn realctx history compression during tool reentry preserves warm reuse for the next turn", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const roundTrips = new ToolRoundTrips(driver);
	const model = toPiModel(FALLBACK_MODELS[0]);
	const sessions: AcpSessions = {};
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips, sessions });
	try {
		const oldTurnUser = user("old question");
		const oldTurnAsst: Message = {
			role: "assistant",
			content: [{ type: "text", text: "old answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		};
		const currentUser = user("run checks");
		const initial = [system(), oldTurnUser, oldTurnAsst, currentUser];

		const step1 = collect(stream(model, context(initial)));
		await vi.waitFor(() => assert.equal(driver.requests.length, 1));
		const parked = roundTrips.onToolCall("call-compact", "bash", { command: "npm test" }, new AbortController().signal);
		const step1Done = (await step1).find((event) => event.type === "done");
		assert.equal(step1Done?.type, "done");
		if (step1Done?.type !== "done") return;

		// While the tool runs, realctx historian replaces oldTurnUser + oldTurnAsst with a summary chunk,
		// while keeping currentUser intact.
		const historyChunk = user('<realctx-history part="h1" turns="1-1" replaced="2.0k tok">\nSummarized old turn\n</realctx-history>');
		const result: Message = { role: "toolResult", toolCallId: "call-compact", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };
		const compactedMidTurn = [system(), historyChunk, currentUser, step1Done.message, result];

		const handle = driver.activeHandle as FakeHandle;
		handle.pushExternal({ type: "text", delta: "checks passed" });
		handle.complete({ status: "OK", response: "checks passed", finished: true, aborted: false, conversationId: "acp-warm-midturn" });

		const step2Done = (await collect(stream(model, context(compactedMidTurn)))).find((event) => event.type === "done");
		await parked;
		assert.equal(step2Done?.type, "done");
		if (step2Done?.type !== "done") return;

		// Because currentUser remained intact after the <realctx-history> summary, the next turn stays warm!
		driver.autoFinish = true;
		driver.script = [{ type: "text", delta: "warm reply" }];
		await collect(stream(model, context([...compactedMidTurn, step2Done.message, user("next request")])));
		assert.equal(driver.requests.length, 2);
		assert.equal(driver.requests[1].conversationId, "acp-warm-midturn");
		assert.equal(driver.requests[1].prompt, "next request");
		assert.equal(driver.requests[1].contextBlock, undefined);
	} finally {
		roundTrips.failAll("test done");
	}
});

test("persisted warm checkpoints survive reload and fork the SQLite store on /tree branch rewind", async () => {
	const require = createRequire(import.meta.url);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-rewind-"));
	const baseSessionId = "11111111-2222-3333-4444-555555555555";
	const baseTid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const dbPath = conversationDbPath(tmpDir, baseSessionId)!;

	const seedSteps = (maxIdx: number) => {
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
			CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob);
			CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, data blob);
			CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id text DEFAULT 'main' PRIMARY KEY, data blob);
		`);
		db.prepare("INSERT OR REPLACE INTO trajectory_meta VALUES (?, ?, 4, 17)").run(baseTid, baseSessionId);
		db.prepare("INSERT OR REPLACE INTO trajectory_metadata_blob VALUES ('main', ?)").run(
			Buffer.from(`meta:${baseSessionId}:tid:${baseTid}`, "utf8"),
		);
		for (let i = 0; i <= maxIdx; i++) {
			db.prepare("INSERT OR REPLACE INTO steps (idx, step_type, status) VALUES (?, ?, 3)").run(i, i === 0 || i === 4 ? 14 : 15);
		}
		// gen_metadata[0] -> steps [1, 2], gen_metadata[1] -> steps [5, 6]
		db.prepare("INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (0, ?, 4)").run(Uint8Array.from([0x12, 0x02, 0x01, 0x02]));
		if (maxIdx >= 5) {
			db.prepare("INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (1, ?, 4)").run(Uint8Array.from([0x12, 0x02, 0x05, 0x06]));
		}
		// executor_metadata[0] -> end step 3, executor_metadata[1] -> end step 8
		db.prepare("INSERT OR REPLACE INTO executor_metadata (idx, data) VALUES (0, ?)").run(Uint8Array.from([0x08, 0x04, 0x10, 0x02, 0x18, 0x03]));
		if (maxIdx >= 8) {
			db.prepare("INSERT OR REPLACE INTO executor_metadata (idx, data) VALUES (1, ?)").run(Uint8Array.from([0x08, 0x04, 0x10, 0x0c, 0x18, 0x08]));
		}
		db.close();
	};

	const driver = new FakeDriver();
	driver.autoFinish = false;
	const roundTrips = new ToolRoundTrips(driver);
	const model = toPiModel(FALLBACK_MODELS[0]);
	const sessionEntries: SessionEntryLike[] = [];
	const sessions: AcpSessions = {
		conversationsDir: () => tmpDir,
		onWarm: (warm) => {
			sessionEntries.push({ type: "custom", customType: WARM_SESSION_ENTRY, data: warm });
		},
	};
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips, sessions });

	try {
		// Turn 1 completes at maxStepIdx = 3.
		seedSteps(3);
		const t1Messages = [system(), user("Turn 1 question")];
		const t1Promise = collect(stream(model, context(t1Messages)));
		await vi.waitFor(() => assert.equal(driver.requests.length, 1));
		(driver.activeHandle as FakeHandle).pushExternal({ type: "text", delta: "Turn 1 answer" });
		(driver.activeHandle as FakeHandle).complete({
			status: "OK",
			response: "Turn 1 answer",
			finished: true,
			aborted: false,
			conversationId: baseSessionId,
			maxStepIdx: 3,
		});
		const t1Done = (await t1Promise).find((e) => e.type === "done");
		assert.equal(t1Done?.type, "done");
		if (t1Done?.type !== "done") return;

		// Turn 2 (Branch A) reuses baseSessionId (DB is still at step 3 when Turn 2A starts)
		// and advances DB to maxStepIdx = 8 while Turn 2A executes.
		const t2AMessages = [...t1Messages, t1Done.message, user("Turn 2A question")];
		const t2APromise = collect(stream(model, context(t2AMessages)));
		await vi.waitFor(() => assert.equal(driver.requests.length, 2));
		assert.equal(driver.requests[1].conversationId, baseSessionId);
		assert.equal(driver.requests[1].prompt, "Turn 2A question");
		seedSteps(8);
		(driver.activeHandle as FakeHandle).pushExternal({ type: "text", delta: "Turn 2A answer" });
		(driver.activeHandle as FakeHandle).complete({
			status: "OK",
			response: "Turn 2A answer",
			finished: true,
			aborted: false,
			conversationId: baseSessionId,
			maxStepIdx: 8,
		});
		const t2ADone = (await t2APromise).find((e) => e.type === "done");
		assert.equal(t2ADone?.type, "done");
		if (t2ADone?.type !== "done") return;

		// Simulate /reload + /tree rewind back to Turn 1 (where branch only has Turn 1, or even stops at Turn 1 assistant before its custom entry).
		const reloaded = restoreWarmSessions([sessionEntries[0]!], sessionEntries);
		sessions.warm = reloaded.warm;
		sessions.checkpoints = reloaded.checkpoints;

		driver.autoFinish = true;
		driver.script = [{ type: "text", delta: "Turn 2B answer" }];
		const t2BMessages = [...t1Messages, t1Done.message, user("Turn 2B alternate question")];
		await collect(stream(model, context(t2BMessages)));

		assert.equal(driver.requests.length, 3);
		const forkedSessionId = driver.requests[2].conversationId;
		assert.ok(forkedSessionId && forkedSessionId !== baseSessionId, "expected a forked sessionId on rewind");
		assert.equal(driver.requests[2].prompt, "Turn 2B alternate question");
		assert.equal(driver.requests[2].contextBlock, undefined);

		// Verify the forked SQLite DB was truncated to step <= 3 while the original DB stayed at step 8.
		assert.equal(lastStepIdx(dbPath), 8);
		const forkedDbPath = conversationDbPath(tmpDir, forkedSessionId!)!;
		assert.equal(lastStepIdx(forkedDbPath), 3);
		const checkDb = new DatabaseSync(forkedDbPath, { readOnly: true });
		const genCount = (checkDb.prepare("SELECT count(*) AS cnt FROM gen_metadata").get() as { cnt: number }).cnt;
		const execCount = (checkDb.prepare("SELECT count(*) AS cnt FROM executor_metadata").get() as { cnt: number }).cnt;
		const metaCascade = (checkDb.prepare("SELECT cascade_id FROM trajectory_meta LIMIT 1").get() as { cascade_id: string }).cascade_id;
		const blobText = Buffer.from((checkDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data: Uint8Array }).data).toString("utf8");
		checkDb.close();
		assert.equal(genCount, 1);
		assert.equal(execCount, 1);
		assert.equal(metaCascade, forkedSessionId);
		assert.ok(blobText.includes(forkedSessionId!));
		assert.ok(!blobText.includes(baseSessionId));

		// Switching back to Branch A (Turn 2A) in /tree still reuses the intact baseSessionId at step 8!
		await collect(stream(model, context([...t2AMessages, t2ADone.message, user("Turn 3A question on original branch")])));
		assert.equal(driver.requests.length, 4);
		assert.equal(driver.requests[3].conversationId, baseSessionId);
		assert.equal(driver.requests[3].prompt, "Turn 3A question on original branch");
	} finally {
		roundTrips.failAll("test done");
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
