import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { calculateContextTokens, AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { runAgentLoop, type AgentTool } from "@earendil-works/pi-agent-core";
import { conversationDbPath, lastStepIdx } from "../src/acp/step-usage.js";
import { createStreamSimple, ESCALATE_AFTER_MS, failParkedCalls, POLL_TOOL_NAME, ToolRoundTrips, type AcpSessions } from "../src/provider.js";
import type { DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "../src/driver-types.js";
import { FALLBACK_MODELS, toPiModel } from "../src/models.js";
import { PARALLEL_TOOL_NAME } from "../src/parallel.js";
import {
	freshInput,
	MAX_TRANSCRIPT_BYTES,
	planTurn,
	planTurnFrom,
	restoreWarmSessions,
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

	get closed(): boolean {
		return this.#closed;
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

	complete(outcome: TurnOutcome = { status: "OK", response: "", aborted: false }): void {
		this.#closed = true;
		this.#resolve(outcome);
		for (const wake of this.#wake.splice(0)) wake();
	}
}

class FakeDriver implements TurnDriver {
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
	cancels: string[] = [];
	bridgeWaits = 0;
	async awaitBridgeResults(): Promise<void> { this.bridgeWaits++; }
	async cancelActive(reason: string): Promise<void> {
		const active = this.activeHandle;
		if (!(active instanceof FakeHandle) || active.closed) return;
		this.cancels.push(reason);
		const outcome = { status: "OK", response: "", aborted: true } as const;
		active.complete(outcome);
		this.onTurnEnd?.(outcome);
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
		{ type: "usage", usage: { input_tokens: 693513, output_tokens: 3731, total_tokens: 697244, cache_read_tokens: 633000, cache_write_tokens: 966 } },
		{ type: "text", delta: "OK" },
	];
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver) });
	const done = (await collect(stream(toPiModel(FALLBACK_MODELS[0]), context([system(), user("Reply")])))).find((event) => event.type === "done");
	assert.equal(done?.type, "done");
	if (done?.type !== "done") throw new Error("No done event");
	assert.equal(done.message.usage.totalTokens, 54357);
	assert.equal(calculateContextTokens(done.message.usage), 54357);
	assert.equal(done.message.usage.input, 59547);
	assert.equal(done.message.usage.cacheWrite, 966);
	assert.equal(done.message.usage.input + done.message.usage.output + done.message.usage.cacheRead + done.message.usage.cacheWrite, 697244);
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

test("a new pi turn cancels a turn left parked on unanswered tool calls instead of queueing behind it", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const model = toPiModel(FALLBACK_MODELS[0]);
	const roundTrips = new ToolRoundTrips(driver);
	const streamSimple = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	const first = collect(streamSimple(model, context([system(), user("Run bash")])));
	await vi.waitFor(() => assert.equal(driver.requests.length, 1));
	void roundTrips.onToolCall("call-1", "bash", { command: "sleep 1" }, new AbortController().signal);
	const firstDone = (await first).find((event) => event.type === "done");
	assert.equal(firstDone?.type === "done" && firstDone.reason, "toolUse");
	const parked = driver.activeHandle as FakeHandle;

	// pi's loop ended after the toolUse message; the user sends a new prompt.
	driver.autoFinish = true;
	const second = await collect(streamSimple(model, context([system(), user("Run bash"), user("never mind")])));
	assert.deepEqual(driver.cancels, ["superseded by a new pi turn"]);
	assert.equal(parked.closed, true);
	assert.equal(driver.requests.length, 2);
	assert.ok(second.some((event) => event.type === "done"));
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

test("parallel emits genuine Pi calls that the native agent loop executes concurrently", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const roundTrips = new ToolRoundTrips(driver);
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	const model = toPiModel(FALLBACK_MODELS[0]);
	let releaseFirst!: () => void;
	let releaseSecond!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
	const started: string[] = [];
	const completed: string[] = [];
	const hooks: string[] = [];
	const tools: AgentTool[] = ["first", "second"].map((name) => ({
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => {
			started.push(name);
			await (name === "first" ? firstGate : secondGate);
			completed.push(name);
			if (name === "second") throw new Error("second failed");
			return { content: [{ type: "text" as const, text: "first ok" }], details: undefined };
		},
	}));
	// The fake ACP server finishes when Pi re-enters after all tool results.
	driver.reentry = () => {
		const handle = driver.activeHandle as FakeHandle;
		handle.complete();
		return handle;
	};
	const running = runAgentLoop(
		[user("run both")],
		{ messages: [], tools },
		{
			model,
			toolExecution: "parallel",
			convertToLlm: (messages) => messages as Message[],
			beforeToolCall: async ({ toolCall }) => { hooks.push(toolCall.name); return undefined; },
		},
		() => {},
		undefined,
		stream,
	);
	await vi.waitFor(() => assert.equal(driver.requests.length, 1));
	const parked = roundTrips.onToolCall("batch", PARALLEL_TOOL_NAME, {
		calls: [{ name: "first", arguments: {} }, { name: "second", arguments: {} }],
	}, new AbortController().signal);

	// Both tools must enter execute before either is released: this fails if
	// realagy emits the calls in separate, serial Pi turns.
	await vi.waitFor(() => assert.deepEqual([...started].sort(), ["first", "second"]));
	releaseSecond();
	await vi.waitFor(() => assert.deepEqual(completed, ["second"]));
	releaseFirst();
	const [aggregate, messages] = await Promise.all([parked, running]);
	assert.deepEqual(hooks, ["first", "second"], "Pi's normal permission/hook path ran for each call");
	assert.equal(aggregate.isError, true);
	const text = aggregate.content[0];
	assert.equal(text.type, "text");
	const payload = JSON.parse(text.type === "text" ? text.text : "");
	assert.deepEqual(payload.results.map((result: { name: string }) => result.name), ["first", "second"]);
	assert.deepEqual(payload.results.map((result: { isError: boolean }) => result.isError), [false, true]);
	assert.equal(payload.results[0].content[0].text, "first ok");
	assert.match(payload.results[1].content[0].text, /second failed/);
	const toolMessage = messages.find((message) => message.role === "assistant" && message.content.filter((block) => block.type === "toolCall").length === 2);
	assert.equal(toolMessage?.role, "assistant");
	if (toolMessage?.role === "assistant") {
		assert.deepEqual(toolMessage.content.filter((block) => block.type === "toolCall").map((block) => block.type === "toolCall" && block.id), ["batch:1", "batch:2"]);
	}
	const final = messages.at(-1);
	assert.equal(final?.role, "assistant", "the native follow-up turn completed after the batch");
	if (final?.role === "assistant") assert.equal(final.stopReason, "stop");
});

test("parallel keeps one outer poll handle and survives the initial HTTP disconnect", async () => {
	vi.useFakeTimers();
	try {
		const driver = new FakeDriver();
		driver.autoFinish = false;
		await driver.run({ cwd: process.cwd(), model: "gpt-oss-120b", mode: "default", skipPermissions: true, prompt: "test" });
		const roundTrips = new ToolRoundTrips(driver, { escalateAfterMs: 60 });
		const signal = new AbortController();
		const parked = roundTrips.onToolCall("batch", PARALLEL_TOOL_NAME, {
			calls: [{ name: "read", arguments: { path: "a" } }, { name: "read", arguments: { path: "b" } }],
		}, signal.signal);
		await vi.advanceTimersByTimeAsync(60);
		const early = await parked;
		assert.match(early.content[0].type === "text" ? early.content[0].text : "", /STILL RUNNING[\s\S]*callId "batch"/);
		signal.abort();
		assert.equal(roundTrips.isPending("batch:1"), true);
		assert.equal(roundTrips.isPending("batch:2"), true);

		roundTrips.resolve("batch:2", "second", true);
		roundTrips.resolve("batch:1", "first", false);
		const result = await roundTrips.onToolCall("poll", POLL_TOOL_NAME, { callId: "batch" }, new AbortController().signal);
		assert.equal(result.isError, true);
		const text = result.content[0];
		assert.equal(text.type, "text");
		const payload = JSON.parse(text.type === "text" ? text.text : "");
		assert.deepEqual(payload.results.map((entry: { callId: string }) => entry.callId), ["batch:1", "batch:2"]);
		assert.equal(roundTrips.hasPendingBatchCalls(), false);
		const innerPoll = await roundTrips.onToolCall("poll-inner", POLL_TOOL_NAME, { callId: "batch:1" }, new AbortController().signal);
		assert.match(innerPoll.content[0].type === "text" ? innerPoll.content[0].text ?? "" : "", /Unknown or non-escalated callId: batch:1/);
	} finally {
		vi.useRealTimers();
	}
});

test("aborting a parallel Pi turn settles the outer request and every inner call", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const roundTrips = new ToolRoundTrips(driver);
	driver.onTurnEnd = (outcome) => failParkedCalls(roundTrips, outcome);
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	const model = toPiModel(FALLBACK_MODELS[0]);
	const abort = new AbortController();
	const first = collect(stream(model, context([system(), user("parallel")]), { signal: abort.signal }));
	await vi.waitFor(() => assert.equal(driver.requests.length, 1));
	const parked = roundTrips.onToolCall("batch", PARALLEL_TOOL_NAME, {
		calls: [{ name: "read", arguments: {} }, { name: "bash", arguments: {} }],
	}, new AbortController().signal);
	const firstEvents = await first;
	const done = firstEvents.find((event) => event.type === "done");
	assert.equal(done?.type === "done" && done.reason, "toolUse");
	if (done?.type !== "done") throw new Error("missing parallel toolUse");
	assert.equal(done.message.content.filter((block) => block.type === "toolCall").length, 2);
	abort.abort();
	const aborted = await collect(stream(model, context([system(), user("parallel"), done.message]), { signal: abort.signal }));
	await assert.rejects(parked, /aborted|ended/);
	assert.equal(aborted.at(-1)?.type, "error");
	assert.equal(roundTrips.isPending("batch"), false);
	assert.equal(roundTrips.isPending("batch:1"), false);
	assert.equal(roundTrips.isPending("batch:2"), false);
	assert.equal(roundTrips.hasPendingBatchCalls(), false);
	assert.equal((driver.activeHandle as FakeHandle).closed, true);
});

test("incomplete parallel results fail the batch without re-entering or starting ACP", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const roundTrips = new ToolRoundTrips(driver);
	driver.onTurnEnd = (outcome) => failParkedCalls(roundTrips, outcome);
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	const model = toPiModel(FALLBACK_MODELS[0]);
	let reentries = 0;
	driver.reentry = () => {
		reentries++;
		const handle = driver.activeHandle as FakeHandle;
		handle.complete();
		return handle;
	};
	const first = collect(stream(model, context([system(), user("parallel")])));
	await vi.waitFor(() => assert.equal(driver.requests.length, 1));
	const parked = roundTrips.onToolCall("batch", PARALLEL_TOOL_NAME, {
		calls: [{ name: "read", arguments: {} }, { name: "read", arguments: {} }],
	}, new AbortController().signal);
	const rejection = assert.rejects(parked, /parallel tool results are incomplete/);
	const firstEvents = await first;
	const done = firstEvents.find((event) => event.type === "done");
	if (done?.type !== "done") throw new Error("missing parallel toolUse");
	const partial: Message = {
		role: "toolResult",
		toolCallId: "batch:1",
		toolName: "read",
		content: [{ type: "text", text: "partial" }],
		isError: false,
		timestamp: Date.now(),
	};
	const second = await collect(stream(model, context([system(), user("parallel"), done.message, partial])));
	await rejection;
	const last = second.at(-1);
	assert.equal(last?.type, "error");
	if (last?.type === "error") assert.match(last.error.errorMessage ?? "", /parallel tool results are incomplete/);
	assert.equal(reentries, 0);
	assert.equal(driver.requests.length, 1, "no new ACP turn receives a partial batch");
	assert.deepEqual(driver.cancels, ["parallel tool results are incomplete; the batch was aborted"]);
	assert.equal(roundTrips.hasPendingBatchCalls(), false);
	assert.equal(roundTrips.isPending("batch"), false);
});

test("slow tools early-ack after ESCALATE_AFTER_MS, long-poll on bridge_poll_result, and never hard-kill running tools at 30m", async () => {
	vi.useFakeTimers();
	try {
		const driver = new FakeDriver();
		driver.autoFinish = false;
		await driver.run({ cwd: process.cwd(), model: "gpt-oss-120b", mode: "default", skipPermissions: true, prompt: "test" });
		const roundTrips = new ToolRoundTrips(driver);
		const initialAbort = new AbortController();
		const parked = roundTrips.onToolCall("slow-1", "bash", {}, initialAbort.signal);

		// Does not escalate at 20s anymore; escalates at ESCALATE_AFTER_MS (150s).
		await vi.advanceTimersByTimeAsync(20_000);
		let settled = false;
		void parked.then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false);

		await vi.advanceTimersByTimeAsync(ESCALATE_AFTER_MS - 20_000);
		const early = await parked;
		assert.match(early.content[0].type === "text" ? early.content[0].text : "", /STILL RUNNING/);

		// Initial HTTP request aborting after escalation must not fail the running tool.
		initialAbort.abort();

		// First bridge_poll_result holds for ESCALATE_AFTER_MS and returns STILL RUNNING if still running.
		const poll1Promise = roundTrips.onToolCall("poll-1", POLL_TOOL_NAME, { callId: "slow-1" }, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(ESCALATE_AFTER_MS);
		const poll1 = await poll1Promise;
		assert.match(poll1.content[0].type === "text" ? poll1.content[0].text : "", /STILL RUNNING/);

		// Even after 40 minutes of running, the escalated tool is NOT killed.
		await vi.advanceTimersByTimeAsync(40 * 60_000);

		// Second bridge_poll_result holds until resolve() is called, then wakes immediately.
		const poll2Promise = roundTrips.onToolCall("poll-2", POLL_TOOL_NAME, { callId: "slow-1" }, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(5_000);
		roundTrips.resolve("slow-1", "20-min build succeeded", false);
		const polled = await poll2Promise;
		assert.deepEqual(polled, { content: [{ type: "text", text: "20-min build succeeded" }], isError: false });
	} finally {
		vi.useRealTimers();
	}
});

test("late toolResult after ACP turn ended while escalated tool was running reuses warm ACP session", async () => {
	const driver = new FakeDriver();
	driver.autoFinish = false;
	const entries = [...FALLBACK_MODELS];
	const model = toPiModel(FALLBACK_MODELS[0]);
	const roundTrips = new ToolRoundTrips(driver, { escalateAfterMs: 10, pollWaitMs: 10 });
	const sessions: AcpSessions = {};
	const streamSimple = createStreamSimple({ entries, driver, roundTrips, sessions });

	const userMsg = user("Run 20m task");
	const first = collect(streamSimple(model, context([system(), userMsg])));
	await vi.waitFor(() => assert.equal(driver.requests.length, 1));

	const parked = roundTrips.onToolCall("long-call-1", "bash", { command: "sleep 1200" }, new AbortController().signal);
	const firstEvents = await first;
	const firstDone = firstEvents.find((event) => event.type === "done");
	assert.equal(firstDone?.type === "done" && firstDone.reason, "toolUse");
	if (firstDone?.type !== "done") return;

	// Escalates while pi is still running the tool.
	const early = await parked;
	assert.match(early.content[0].type === "text" ? early.content[0].text : "", /STILL RUNNING/);

	// Suppose agy gives up polling and ends its ACP turn before the tool finishes in pi.
	const handle = driver.activeHandle as FakeHandle;
	handle.pushExternal({ type: "text", delta: "Task is still running, let me know when done." });
	handle.complete({ conversationId: "conv-long-1", status: "OK", response: "Task is still running", aborted: false });
	driver.activeHandle = null;
	await handle.outcome;

	// Warm session should have been recorded at the toolUse checkpoint when the handle settled.
	await vi.waitFor(() => assert.equal(sessions.warm?.sessionId, "conv-long-1"));
	assert.equal(sessions.parked, undefined);

	// 20 minutes later, pi finishes the bash tool and invokes streamSimple with the toolResult.
	driver.autoFinish = true;
	driver.script = [{ type: "text", delta: "Received the 20m build output!" }];
	const toolResult: Message = {
		role: "toolResult",
		toolCallId: "long-call-1",
		toolName: "bash",
		content: [{ type: "text", text: "build completed after 20m" }],
		isError: false,
		timestamp: Date.now(),
	};
	const secondEvents = await collect(streamSimple(model, context([system(), userMsg, firstDone.message, toolResult])));
	assert.ok(secondEvents.some((event) => event.type === "text_delta" && event.delta === "Received the 20m build output!"));
	assert.equal(driver.requests.length, 2);
	assert.equal(driver.requests[1].conversationId, "conv-long-1");
	assert.match(driver.requests[1].contextBlock?.text ?? "", /<pi-tool-result name="bash" id="long-call-1" error=false>/);
	assert.match(driver.requests[1].contextBlock?.text ?? "", /build completed after 20m/);
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
		handle.complete({ status: "OK", response: "all done", aborted: false, conversationId: "acp-warm" });
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

test("large transcript transport retains every message and image without an omission budget", () => {
	const hist = user('<realctx-history part="h1">Earlier summary</realctx-history>');
	const big = user("中🙂".repeat(300_000));
	const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
	const latest: Message = { role: "user", content: [{ type: "text", text: "latest user question" }, image], timestamp: 4 };
	const input = freshInput(context([system(), hist, big, latest]));
	const blocks = [...(input.parts ?? []).map((part) => part.contextBlock), input.contextBlock!];
	assert.ok(blocks.length > 8);
	for (const block of blocks) assert.ok(Buffer.byteLength(block.text) <= MAX_TRANSCRIPT_BYTES);
	const all = blocks.map((block) => block.text).join("");
	assert.ok(all.includes("中🙂".repeat(300_000)));
	assert.match(all, /<realctx-history part="h1">/);
	assert.match(all, /latest user question/);
	assert.doesNotMatch(all, /pi-transcript-omitted|older content clipped/);
	assert.deepEqual(input.images, [{ data: image.data, mimeType: image.mimeType }]);
});

test("applied realctx drops and summaries synchronize while retaining the native session", () => {
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
	assert.equal(planAfterDrops.kind, "context-sync");
	if (planAfterDrops.kind !== "context-sync") return;
	assert.equal(planAfterDrops.sessionId, "acp-session-1");
	assert.equal(planAfterDrops.input.prompt, "great, let's adapt it");

	// 2. Next turn after realctx historian also folds turn 1 into a <realctx-history> summary chunk:
	const historyChunk = user('<realctx-history part="h1" turns="1-1" replaced="4.3k tok">\nTurn 1 summary\n</realctx-history>');
	const planAfterHistorian = planTurn(
		context([system(), historyChunk, turn2User, cleanedAssistant, user("still warm after historian?")]),
		"/repo",
		warm,
	);
	assert.equal(planAfterHistorian.kind, "context-sync");
	if (planAfterHistorian.kind !== "context-sync") return;
	assert.equal(planAfterHistorian.sessionId, "acp-session-1");
	assert.equal(planAfterHistorian.input.prompt, "still warm after historian?");
});

test("small mid-turn realctx history compression during tool reentry preserves warm reuse for the next turn", async () => {
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
		// Simulate pi-lens `append-to-last-user` injecting session-start guidance into currentUser on the first request:
		const currentUserInjected: Message = {
			role: "user",
			content: [
				{ type: "text", text: "run checks" },
				{ type: "text", text: "[pi-lens automated context — not a user request]\n\n📌 pi-lens active" },
			],
			timestamp: 2,
		};
		const currentUserPlain = user("run checks");
		const initial = [system(), oldTurnUser, oldTurnAsst, currentUserInjected];

		const step1 = collect(stream(model, context(initial)));
		await vi.waitFor(() => assert.equal(driver.requests.length, 1));
		const parked = roundTrips.onToolCall("call-compact", "bash", { command: "npm test" }, new AbortController().signal);
		const step1Done = (await step1).find((event) => event.type === "done");
		assert.equal(step1Done?.type, "done");
		if (step1Done?.type !== "done") return;

		// While the tool runs, realctx historian replaces oldTurnUser + oldTurnAsst with a summary chunk,
		// and pi-lens no longer appends the transient guidance block to currentUser on reentry.
		const historyChunk = user('<realctx-history part="h1" turns="1-1" replaced="2.0k tok">\nSummarized old turn\n</realctx-history>');
		const result: Message = { role: "toolResult", toolCallId: "call-compact", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };
		const compactedMidTurn = [system(), historyChunk, currentUserPlain, step1Done.message, result];

		const handle = driver.activeHandle as FakeHandle;
		handle.pushExternal({ type: "text", delta: "checks passed" });
		handle.complete({ status: "OK", response: "checks passed", aborted: false, conversationId: "acp-warm-midturn" });

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

test("effective history changes synchronize while genuine user identity edits diverge", async () => {
	const model = toPiModel(FALLBACK_MODELS[0]);
	const makeAsst = (text: string): Message => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});

	// Turn 1: Arbitrary third-party RAG/linter extension prepends a header, appends a trailer,
	// and injects a standalone transient reminder message (with no pi-lens/realctx markers).
	const t1UserDecorated = user("[RAG Context: auth.ts]\nhow does login work?\n\n<linter-hint>0 errors</linter-hint>");
	const t1Transient = user("CUSTOM EXTENSION REMINDER: be concise");
	const t1Asst = makeAsst("Login verifies the token.");
	const warm1 = warmAfterTurn(
		context([system(), t1UserDecorated, t1Transient]),
		t1Asst as Extract<Message, { role: "assistant" }>,
		"acp-universal-1",
		"/repo",
	);

	// On Turn 2, SessionManager restores the undecorated user prompt and drops the transient reminder,
	// while the extension decorates Turn 2's prompt with an extra `{ type: "text" }` block.
	const t1UserClean = user("how does login work?");
	const t2UserDecorated: Message = {
		role: "user",
		content: [
			{ type: "text", text: "what about logout?" },
			{ type: "text", text: "<custom-skill-context>\nlogout clears cookies\n</custom-skill-context>" },
		],
		timestamp: Date.now(),
	};
	const plan2 = planTurn(context([system(), t1UserClean, t1Asst, t2UserDecorated]), "/repo", warm1);
	assert.equal(plan2.kind, "context-sync");
	if (plan2.kind !== "context-sync") return;
	assert.equal(plan2.sessionId, "acp-universal-1");
	assert.match(plan2.input.prompt, /^what about logout\?\n<custom-skill-context>/);

	const t2Asst = makeAsst("Logout clears the session cookie.");
	const warm2 = warmAfterTurn(
		context([system(), t1UserClean, t1Asst, t2UserDecorated]),
		t2Asst as Extract<Message, { role: "assistant" }>,
		"acp-universal-1",
		"/repo",
	);
	const t2UserClean = user("what about logout?");

	// Turn 3A: Arbitrary summarizer extension folds Turn 1 into a custom summary message (not <realctx-history>).
	const customSummary = user("<custom-extension-summary>\nUser asked about login.\n</custom-extension-summary>");
	const plan3Summary = planTurn(
		context([system(), customSummary, t2UserClean, t2Asst, user("and refresh tokens?")]),
		"/repo",
		warm2,
	);
	assert.equal(plan3Summary.kind, "context-sync");
	if (plan3Summary.kind === "context-sync") {
		assert.equal(plan3Summary.input.prompt, "and refresh tokens?");
	}

	// Turn 3B: Sliding-window extension drops Turn 1 completely without inserting a summary message.
	const plan3Sliding = planTurn(
		context([system(), t2UserClean, t2Asst, user("and refresh tokens?")]),
		"/repo",
		warm2,
	);
	assert.equal(plan3Sliding.kind, "context-sync");
	if (plan3Sliding.kind === "context-sync") {
		assert.equal(plan3Sliding.input.prompt, "and refresh tokens?");
	}

	// Turn 3C: In-place edit of Turn 1's user message still triggers history-diverged!
	const plan3Edited = planTurn(
		context([system(), user("how does OAuth work?"), t1Asst, t2UserClean, t2Asst, user("and refresh tokens?")]),
		"/repo",
		warm2,
	);
	assert.equal(plan3Edited.kind, "fresh");
	if (plan3Edited.kind === "fresh") {
		assert.equal(plan3Edited.reason, "history-diverged");
	}

	// Turn 3D: Manual Pi `/compact` summary forces a fresh session.
	const piCompaction = user(
		"The conversation history before this point was compacted into the following summary:\n\n<summary>\nCompacted summary\n</summary>",
	);
	const plan3Compacted = planTurn(
		context([system(), piCompaction, t2UserClean, t2Asst, user("after manual compact")]),
		"/repo",
		warm2,
	);
	assert.equal(plan3Compacted.kind, "context-sync");
});

test("agy's native tool calls become thinking lines without duplicating the reply text", async () => {
	const driver = new FakeDriver();
	const roundTrips = new ToolRoundTrips(driver);
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	const entry = FALLBACK_MODELS.find((candidate) => candidate.id === "gemini-3-8-flash")!;
	driver.autoFinish = false;
	driver.script = [
		{ type: "thought", delta: "Let me look" },
		{ type: "native_tool", toolCallId: "n1", label: "read_file /w/a.txt", status: "ok", durationMs: 400, background: false },
		{ type: "text", delta: "Hello " },
		{ type: "native_tool", toolCallId: "n2", label: "run_command false", status: "failed", durationMs: 120, background: false },
		{ type: "native_tool", toolCallId: "n3", label: "invoke_subagent Checker", status: "ok", durationMs: 600, background: true },
		{ type: "text", delta: "world" },
		{ type: "native_tool", toolCallId: "n4", label: "run_command sleep 60", status: "running", background: true },
	];
	const pending = collect(stream(toPiModel(entry), context([system(), user("go")])));
	await vi.waitFor(() => assert.ok(driver.activeHandle));
	(driver.activeHandle as FakeHandle).complete({ status: "OK", response: "Hello world", aborted: false, conversationId: "s" });
	const done = (await pending).find((event) => event.type === "done");
	assert.equal(done?.type, "done");
	if (done?.type !== "done") return;
	assert.equal(driver.requests[0]?.mode, "default");
	assert.deepEqual(done.message.content, [
		{ type: "thinking", thinking: "Let me look\nagy → read_file /w/a.txt ✓ 0.4s\n" },
		{ type: "text", text: "Hello " },
		{
			type: "thinking",
			thinking: [
				"agy → run_command false ✗ 0.1s",
				"agy → invoke_subagent Checker ✓ 0.6s (runs in background)",
				"",
			].join("\n"),
		},
		{ type: "text", text: "world" },
		// The message ends on a thinking line: the reply is not appended again.
		{ type: "thinking", thinking: "agy → run_command sleep 60 … (runs in background)\n" },
	]);
});

test("a reply split by native-tool thinking lines is one assistant reply in the transcript, without the lines", () => {
	const reply = {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello " },
			{ type: "thinking", thinking: "agy → read_file a ✓ 0.1s\n" },
			{ type: "text", text: "world" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
			{ type: "text", text: "after" },
		],
	} as unknown as Message;
	const text = freshInput(context([reply])).contextBlock!.text;
	assert.ok(text.includes("<assistant>\nHello world\n</assistant>"), text);
	assert.ok(text.indexOf("Hello world") < text.indexOf("assistant-tool-call") && text.indexOf("assistant-tool-call") < text.indexOf("<assistant>\nafter"));
	assert.ok(!text.includes("agy →"));
});

test("agy's high-traffic notice fails the turn as a retryable overload instead of becoming the answer", async () => {
	const driver = new FakeDriver();
	const roundTrips = new ToolRoundTrips(driver);
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips });
	const entry = FALLBACK_MODELS.find((candidate) => candidate.id === "gpt-oss-120b")!;
	const notice = "\n⚠ Our servers are experiencing high traffic right now, please try again in a minute.\n";
	driver.autoFinish = false;
	driver.script = [{ type: "text", delta: notice }];
	const pending = collect(stream(toPiModel(entry), context([system(), user("go")])));
	await vi.waitFor(() => assert.ok(driver.activeHandle));
	(driver.activeHandle as FakeHandle).complete({ status: "OK", response: notice, aborted: false, conversationId: "s" });
	const events = await pending;
	const error = events.find((event) => event.type === "error");
	assert.equal(error?.type, "error");
	if (error?.type !== "error") return;
	assert.equal(error.error.stopReason, "error");
	assert.equal(error.error.errorMessage, "Antigravity servers are overloaded: Our servers are experiencing high traffic right now, please try again in a minute.");
	// pi's auto-retry keys on "overloaded" in the error message.
	assert.match(error.error.errorMessage ?? "", /overloaded/);
});

function reclaimAssistant(content: Extract<Message, { role: "assistant" }>["content"], timestamp = Date.now()): Extract<Message, { role: "assistant" }> {
	const model = toPiModel(FALLBACK_MODELS[0]);
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function toolResult(id: string, text: string): Message {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

const readCall = (id: string) => reclaimAssistant([{ type: "toolCall", id, name: "read", arguments: { path: id } }]);

test("every applied drop synchronizes the same session regardless of size, share, or cache age", () => {
	for (const bytes of [1, 5_000, 50_000, 200_000]) {
		for (const age of [0, 10 * 60_000]) {
			const u1 = user("inspect the logs");
			const a1 = readCall("c1");
			const result = toolResult("c1", "x".repeat(bytes));
			const final = reclaimAssistant([{ type: "text", text: "done" }], Date.now() - age);
			const history = [system(), u1, a1, result];
			const warm = warmAfterTurn(context(history), final, "acp-drop", "/repo");
			assert.equal(planTurn(context([...history, final, user("next")]), "/repo", warm).kind, "warm");
			const dropped = toolResult("c1", "[#1 dropped · read c1]");
			const plan = planTurn(context([system(), u1, a1, dropped, final, user("next")]), "/repo", warm);
			assert.equal(plan.kind, "context-sync");
			if (plan.kind !== "context-sync") throw new Error("expected sync");
			assert.equal(plan.sessionId, "acp-drop");
			assert.equal(plan.input.prompt, "next");
			assert.equal(plan.input.contextBlock, undefined);
			assert.equal(plan.input.parts, undefined);
			assert.equal(plan.hasNewUser, true);
			assert.deepEqual(plan.messages[3], dropped);
		}
	}
});

test("consecutive rewrites synchronize immediately and unchanged checkpoints stay incremental", () => {
	const u1 = user("read both files");
	const a1 = readCall("c1");
	const r1 = toolResult("c1", "a".repeat(5_000));
	const a2 = readCall("c2");
	const r2 = toolResult("c2", "b".repeat(5_000));
	const final1 = reclaimAssistant([{ type: "text", text: "Both read." }]);
	const before = [system(), u1, a1, r1, a2, r2];
	const warm1 = warmAfterTurn(context(before), final1, "acp-repeat", "/repo");
	const after = [system(), u1, a1, toolResult("c1", "[#1 dropped]"), a2, r2, final1, user("summarize")];
	assert.equal(planTurn(context(after), "/repo", warm1).kind, "context-sync");
	const final2 = reclaimAssistant([{ type: "text", text: "Summary." }]);
	const warm2 = warmAfterTurn(context(after), final2, "acp-repeat", "/repo");
	assert.equal(planTurn(context([...after, final2, user("next")]), "/repo", warm2).kind, "warm");
	const repeated = [...after];
	repeated[5] = toolResult("c2", "[#2 dropped]");
	const plan = planTurn(context([...repeated, final2, user("next")]), "/repo", warm2);
	assert.equal(plan.kind, "context-sync");
	if (plan.kind === "context-sync") assert.equal(plan.sessionId, "acp-repeat");
});

test("restored checkpoints retain exact sync metadata; legacy checkpoints request verification", () => {
	const final = reclaimAssistant([{ type: "text", text: "hello" }]);
	const warm = warmAfterTurn(context([system(), user("hi")]), final, "acp-restored", "/repo");
	const { checkpoints } = restoreWarmSessions([
		{ type: "custom", customType: WARM_SESSION_ENTRY, data: { ...warm, contentHash: undefined } },
		{ type: "custom", customType: WARM_SESSION_ENTRY, data: warm },
	]);
	assert.deepEqual(checkpoints.at(-1)?.syncItems, warm.syncItems);
	assert.equal(checkpoints.at(-1)?.contentHash, warm.contentHash);
	const next = context([system(), user("hi"), final, user("again")]);
	assert.equal(planTurn(next, "/repo", checkpoints[0]).kind, "context-sync");
	assert.equal(planTurn(next, "/repo", checkpoints[1]).kind, "warm");
});

test("mid-turn drops settle completed tools before cancel and keep the session without replay", async () => {
	for (const bytes of [10, 10_000, 200_000]) {
		const driver = new FakeDriver();
		driver.autoFinish = false;
		const roundTrips = new ToolRoundTrips(driver);
		driver.onTurnEnd = (outcome) => failParkedCalls(roundTrips, outcome);
		const model = toPiModel(FALLBACK_MODELS[0]);
		const sessions: AcpSessions = {};
		const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips, sessions });
		try {
			const u1 = user("scan the repo");
			const first = collect(stream(model, context([system(), u1])));
			await vi.waitFor(() => assert.equal(driver.requests.length, 1));
			const handle = driver.activeHandle as FakeHandle;
			const push = handle.pushExternal.bind(handle);
			handle.pushExternal = (activity) => push(activity.type === "bridge_call" ? { ...activity, sessionId: "acp-running" } : activity);
			const call1 = roundTrips.onToolCall("c1", "read", {}, new AbortController().signal);
			const d1 = (await first).find((event) => event.type === "done");
			if (d1?.type !== "done") throw new Error("no toolUse 1");
			const r1 = toolResult("c1", "x".repeat(bytes));
			const second = collect(stream(model, context([system(), u1, d1.message, r1])));
			await call1;
			const call2 = roundTrips.onToolCall("c2", "read", {}, new AbortController().signal);
			const d2 = (await second).find((event) => event.type === "done");
			if (d2?.type !== "done") throw new Error("no toolUse 2");
			driver.autoFinish = true;
			driver.script = [{ type: "text", delta: "continued" }];
			const rewritten = [system(), u1, d1.message, toolResult("c1", "[#1 dropped]"), d2.message, toolResult("c2", "small")];
			const third = await collect(stream(model, context(rewritten)));
			assert.equal(third.at(-1)?.type, "done");
			assert.match(JSON.stringify(await call2), /small/);
			assert.equal(roundTrips.isPending("c2"), false);
			assert.equal(driver.cancels.length, 1);
			assert.equal(driver.requests.length, 2);
			const request = driver.requests[1];
			assert.equal(request.conversationId, "acp-running");
			assert.equal(request.prompt, "");
			assert.equal(request.contextBlock, undefined);
			assert.equal(request.parts, undefined);
			assert.equal(request.fallback, undefined);
			assert.equal(request.contextSync?.hasNewUser, false);
			assert.deepEqual(request.contextSync?.messages, rewritten);
			assert.equal(request.contextSync?.discardCancelledTail, true);
		} finally {
			roundTrips.failAll("test cleanup");
		}
	}
});

test("rewritten history never falls back to an older checkpoint or forks its DB", async () => {
	const u1 = user("check status");
	const a1 = reclaimAssistant([{ type: "text", text: "Clean." }]);
	const cp1 = warmAfterTurn(context([system(), u1]), a1, "acp-branch", "/repo", 2);
	const u2 = user("inspect huge log");
	const a2 = readCall("c-big");
	const r2 = toolResult("c-big", "x".repeat(200_000));
	const a3 = reclaimAssistant([{ type: "text", text: "Found error." }]);
	const cp2 = warmAfterTurn(context([system(), u1, a1, u2, a2, r2]), a3, "acp-branch", "/repo", 6);
	const afterDrop = [system(), u1, a1, u2, a2, toolResult("c-big", "[#1 dropped]"), a3, user("fix it")];
	for (const candidates of [[cp2, cp1], [cp1, cp2]]) {
		const plan = planTurnFrom(context(afterDrop), "/repo", candidates);
		assert.equal(plan.kind, "context-sync");
		if (plan.kind === "context-sync") assert.equal(plan.maxStepIdx, 6);
	}
	const driver = new FakeDriver();
	const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver), sessions: { warm: cp2, checkpoints: [cp1, cp2] } });
	await collect(stream(toPiModel(FALLBACK_MODELS[0]), context(afterDrop), { cwd: "/repo" } as never));
	assert.equal(driver.requests[0].conversationId, "acp-branch");
	assert.equal(driver.requests[0].contextBlock, undefined);
	assert.ok(driver.requests[0].contextSync);
	assert.equal(driver.requests[0].contextSync?.discardCancelledTail, undefined, "between-turn sync never discards native steps");
});
