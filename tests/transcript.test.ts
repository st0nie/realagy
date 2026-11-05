import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createStreamSimple, ToolRoundTrips, type AcpSessions } from "../src/provider.js";
import { DELTA_PROMPT, FRESH_PROMPT, planTurn, warmAfterTurn } from "../src/transcript.js";
import { UsageMeter } from "../src/quota.js";
import { FALLBACK_MODELS, toPiModel } from "../src/models.js";
import type { DriverActivity, DriverSnapshot, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "../src/driver-types.js";

const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const system = (prompt = "Test system", tools = ["read"]): Message =>
	({ role: "system", content: prompt, toolsAdded: tools.map(tool), timestamp: 0 }) as unknown as Message;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }], api: "agy-bridge", provider: "antigravity", model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: 2,
});
// SAFETY: fixtures are well-formed transcripts with one leading system message.
const ctx = (messages: Message[]) => ({ messages }) as unknown as TranscriptContext;

test("planTurn reuses a warm session for plain user turns and falls back on divergence", () => {
	const turn1 = [system(), user("hello")];
	const fresh = planTurn(ctx(turn1), "/w", undefined);
	assert.equal(fresh.kind, "fresh");
	assert.equal(fresh.input.prompt, FRESH_PROMPT);
	assert.match(fresh.input.contextBlock!.text, /<pi-system>\nTest system/);

	const warm = warmAfterTurn(ctx(turn1), assistant("hi"), "s1", "/w");
	const turn2 = [...turn1, assistant("hi"), user("next")];
	const plan = planTurn(ctx(turn2), "/w", warm);
	assert.equal(plan.kind, "warm");
	if (plan.kind !== "warm") return;
	assert.equal(plan.sessionId, "s1");
	assert.deepEqual(plan.input, { prompt: "next", images: [] });
	assert.equal(plan.fallback.prompt, FRESH_PROMPT);
	assert.match(plan.fallback.contextBlock!.text, /next/);

	assert.equal(planTurn(ctx(turn2), "/other", warm).kind, "fresh");
	assert.deepEqual(planTurn(ctx([system(), user("edited"), assistant("hi"), user("next")]), "/w", warm), { ...planTurn(ctx([system(), user("edited"), assistant("hi"), user("next")]), "/w", undefined), reason: "history-diverged" });
	assert.equal(planTurn(ctx([system("Test system", ["read", "bash"]), user("hello"), assistant("hi"), user("next")]), "/w", warm).kind, "fresh");
	assert.equal(planTurn(ctx(turn1), "/w", warm).kind, "fresh");
});

test("planTurn sends foreign replies and system updates as a transcript delta", () => {
	const turn1 = [system(), user("hello")];
	const warm = warmAfterTurn(ctx(turn1), assistant("hi"), "s1", "/w");
	const update = { role: "system", content: "Extra rule", timestamp: 3 } as unknown as Message;
	const plan = planTurn(ctx([...turn1, assistant("hi"), user("q1"), assistant("other model answer"), update, user("q2")]), "/w", warm);
	assert.equal(plan.kind, "warm");
	if (plan.kind !== "warm") return;
	assert.equal(plan.input.prompt, DELTA_PROMPT);
	assert.equal(plan.input.contextBlock!.uri, "pi://transcript-delta");
	assert.match(plan.input.contextBlock!.text, /<pi-system-update>[\s\S]*Extra rule/);
	assert.match(plan.input.contextBlock!.text, /<assistant>\nother model answer/);
	assert.ok(!plan.input.contextBlock!.text.includes("hello"));
});

class Handle implements TurnHandle {
	id = "t";
	outcome: Promise<TurnOutcome>;
	#items: DriverActivity[];
	constructor(items: DriverActivity[], outcome: TurnOutcome) {
		this.#items = [...items];
		this.outcome = Promise.resolve(outcome);
	}
	async next(): Promise<DriverActivity | null> { return this.#items.shift() ?? null; }
	pushExternal(): void {}
}

class ScriptDriver implements TurnDriver {
	state = "ready" as const;
	activeHandle: TurnHandle | null = null;
	onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	requests: DriverTurnRequest[] = [];
	constructor(public script: DriverActivity[], public outcome: Partial<TurnOutcome> = {}) {}
	async run(request: DriverTurnRequest): Promise<TurnHandle> {
		this.requests.push(request);
		return new Handle(this.script, { status: "OK", response: "", finished: true, aborted: false, conversationId: "acp-1", ...this.outcome });
	}
	reentry(): TurnHandle | null { return null; }
	kickIdle(): void {}
	snapshot(): DriverSnapshot { return { state: "ready", stats: { spawns: 0, turns: 0, reused: 0, recycles: 0, recycleReasons: {} }, lifecycle: [] }; }
	async close(): Promise<void> {}
}

async function run(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessageEvent> {
	let last: AssistantMessageEvent | undefined;
	for await (const event of stream) last = event;
	return last!;
}

test("provider reports exact step usage, reuses the ACP session, and feeds the meter", async () => {
	const driver = new ScriptDriver([
		{ type: "context_usage", contextUsage: { used: 999_999, size: 1_000_000 } },
		{ type: "step_usage", usage: { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, contextTokens: 10_050, steps: 1 } },
		{ type: "text", delta: "hi" },
	]);
	const sessions: AcpSessions = {};
	const meter = new UsageMeter();
	const model = toPiModel(FALLBACK_MODELS[0]);
	const streamSimple = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver), sessions, meter });
	const first = [system(), user("hello")];
	const done = await run(streamSimple(model, ctx(first), { cwd: "/w" } as never));
	assert.equal(done.type, "done");
	if (done.type !== "done") return;
	assert.equal(done.message.usage.cacheRead, 9000);
	assert.equal(done.message.usage.input, 1000);
	assert.equal(calculateContextTokens(done.message.usage), 10_050, "measured call wins over usage_update");
	assert.equal(sessions.warm?.sessionId, "acp-1");
	assert.match(meter.report(), /Cache hits: 90% latest · 90% this session/);

	await run(streamSimple(model, ctx([...first, done.message, user("again")]), { cwd: "/w" } as never));
	assert.equal(driver.requests[1].conversationId, "acp-1");
	assert.equal(driver.requests[1].prompt, "again");
	assert.equal(driver.requests[1].contextBlock, undefined);
	assert.equal(driver.requests[1].fallback?.prompt, FRESH_PROMPT);
});

test("provider leaves unmeasured messages to pi and turns quota notices into errors", async () => {
	const driver = new ScriptDriver([{ type: "text", delta: "x" }]);
	const model = toPiModel(FALLBACK_MODELS[0]);
	const done = await run(createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver) })(model, ctx([system(), user("hello")])));
	assert.equal(done.type, "done");
	if (done.type === "done") assert.equal(calculateContextTokens(done.message.usage), 0);

	const notice = "Usage Limit Reached\n\nYou have reached your current quota for this period.";
	const exhaustedDriver = new ScriptDriver([{ type: "text", delta: notice }], { response: notice });
	const meter = new UsageMeter();
	const sessions: AcpSessions = {};
	const failed = await run(createStreamSimple({ entries: [...FALLBACK_MODELS], driver: exhaustedDriver, roundTrips: new ToolRoundTrips(exhaustedDriver), meter, sessions })(model, ctx([system(), user("hello")])));
	assert.equal(failed.type, "error");
	assert.match(meter.report(), /Quota exhausted/);
	assert.equal(sessions.warm, undefined);
});
