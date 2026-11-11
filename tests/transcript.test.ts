import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createStreamSimple, ToolRoundTrips, type AcpSessions } from "../src/provider.js";
import { DELTA_PROMPT, EMPTY_INPUT_CONTINUATION, LOCKED_REPLAY_BUDGET_BYTES, MAX_TRANSCRIPT_BYTES, planTurn, splitUtf8, UNLOCKED_REPLAY_BUDGET_BYTES, warmAfterTurn } from "../src/transcript.js";
import { treeRestoreExtras } from "../src/tool-loadout.js";
import { UsageMeter } from "../src/quota.js";
import { toPiModel } from "../src/models.js";
import { TEST_MODELS } from "./helpers/model-fixtures.js";
import type { DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "../src/driver-types.js";

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
	assert.match(fresh.input.prompt, /hello$/);
	assert.match(fresh.input.prompt, /<pi-system>\nTest system/);

	const warm = warmAfterTurn(ctx(turn1), assistant("hi"), "s1", "/w");
	const turn2 = [...turn1, assistant("hi"), user("next")];
	const plan = planTurn(ctx(turn2), "/w", warm);
	assert.equal(plan.kind, "warm");
	if (plan.kind !== "warm") return;
	assert.equal(plan.sessionId, "s1");
	assert.deepEqual(plan.input, { prompt: "next", images: [] });
	assert.match(plan.fallback.prompt, /<pi_history>[\s\S]*hello[\s\S]*hi[\s\S]*next/);

	assert.equal(planTurn(ctx(turn2), "/other", warm).kind, "fresh");
	assert.deepEqual(planTurn(ctx([system(), user("edited"), assistant("hi"), user("next")]), "/w", warm), { ...planTurn(ctx([system(), user("edited"), assistant("hi"), user("next")]), "/w", undefined), reason: "history-diverged" });
	// A changed tool set keeps the session; the delta announces the tools.
	const retooled = planTurn(ctx([system("Test system", ["read", "bash"]), user("hello"), assistant("hi"), user("next")]), "/w", warm);
	assert.equal(retooled.kind, "warm");
	assert.equal(retooled.input.contextBlock?.uri, "pi://transcript-delta");
	assert.match(retooled.input.contextBlock?.text ?? "", /<pi-tools-update>\nThe active pi tools are now: bash, read\./);
	assert.match(retooled.input.contextBlock?.text ?? "", /<user>\nnext\n<\/user>/);
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
	activeHandle: TurnHandle | null = null;
	onTurnEnd: ((outcome: TurnOutcome) => void) | undefined;
	requests: DriverTurnRequest[] = [];
	constructor(public script: DriverActivity[], public outcome: Partial<TurnOutcome> = {}) {}
	async run(request: DriverTurnRequest): Promise<TurnHandle> {
		this.requests.push(request);
		return new Handle(this.script, { status: "OK", response: "", aborted: false, conversationId: "acp-1", ...this.outcome });
	}
	reentry(): TurnHandle | null { return null; }
	kickIdle(): void {}
	async cancelActive(): Promise<void> {}
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
	const model = toPiModel(TEST_MODELS[0]);
	const streamSimple = createStreamSimple({ entries: [...TEST_MODELS], driver, roundTrips: new ToolRoundTrips(driver), sessions, meter });
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
	assert.match(driver.requests[1].fallback?.prompt ?? "", /<pi_history>[\s\S]*hello[\s\S]*hi[\s\S]*again$/);
});

test("provider leaves unmeasured messages to pi and turns quota notices into errors", async () => {
	const driver = new ScriptDriver([{ type: "text", delta: "x" }]);
	const model = toPiModel(TEST_MODELS[0]);
	const done = await run(createStreamSimple({ entries: [...TEST_MODELS], driver, roundTrips: new ToolRoundTrips(driver) })(model, ctx([system(), user("hello")])));
	assert.equal(done.type, "done");
	if (done.type === "done") assert.equal(calculateContextTokens(done.message.usage), 0);

	const notice = "Usage Limit Reached\n\nYou have reached your current quota for this period.";
	const exhaustedDriver = new ScriptDriver([{ type: "text", delta: notice }], { response: notice });
	const meter = new UsageMeter();
	const sessions: AcpSessions = {};
	const failed = await run(createStreamSimple({ entries: [...TEST_MODELS], driver: exhaustedDriver, roundTrips: new ToolRoundTrips(exhaustedDriver), meter, sessions })(model, ctx([system(), user("hello")])));
	assert.equal(failed.type, "error");
	assert.match(meter.report(), /Quota exhausted/);
	assert.equal(sessions.warm, undefined);
});

test("planTurn reuses only the current exact prefix and rebuilds stale or changed history", () => {
	const turn1 = [system(), user("hello")];
	const warm1 = warmAfterTurn(ctx(turn1), assistant("hi"), "s1", "/w");
	const turn2 = [...turn1, assistant("hi"), user("q2")];
	const warm2 = warmAfterTurn(ctx(turn2), assistant("a2"), "s2", "/w");
	const nowMessages = [...turn2, assistant("a2"), user("q3")];
	const now = ctx(nowMessages);

	const best = planTurn(now, "/w", warm2);
	assert.equal(best.kind === "warm" && best.sessionId, "s2");
	assert.equal(best.kind === "warm" && best.deltaMessages, 1);
	assert.equal(planTurn(now, "/w", warm1).kind, "warm", "an exact prefix can be reused; no alternate checkpoint list is consulted");
	assert.equal(planTurn(now, "/other", warm2).kind, "fresh");
	assert.equal(planTurn(now, "/w", undefined).kind, "fresh");

	const rewritten = [...nowMessages];
	rewritten[1] = user("hello edited");
	const replay = planTurn(ctx(rewritten), "/w", warm2);
	assert.equal(replay.kind, "fresh");
	assert.match(replay.input.prompt, /<pi_history>[\s\S]*hello edited[\s\S]*<\/pi_history>/);
	assert.ok(replay.input.prompt.endsWith("q3"), "the newest input stays outside the replay and verbatim");
});
const LENS_TOOLS = ["lens_symbols", "lens_references", "lens_diagnostics", "lens_rename", "lens_outline"];
const toolsDeclared = (names: string[]): Message =>
	({ role: "system", content: "", toolsAdded: names.map(tool), timestamp: 5 }) as unknown as Message;
const toolUse = (id: string, name: string, stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage => ({
	...assistant(""), content: [{ type: "toolCall", id, name, arguments: { command: "npm run build" } }], stopReason,
});
const abortedReply = (text = ""): AssistantMessage => ({ ...assistant(text), content: text ? [{ type: "text", text }] : [], stopReason: "aborted", errorMessage: "Operation aborted" });
const result = (id: string, name: string, text: string, isError = false): Message =>
	({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 3 });

test("a /tree rewind rebuilds instead of reusing the later native session", () => {
	const turn1 = [system("Test system", ["read", "bash"]), user("explain")];
	const reply1 = assistant("it parses");
	const turn2 = [...turn1, reply1, user("add tests")];
	const warm = warmAfterTurn(ctx(turn2), assistant("added"), "s1", "/w");
	const rewound = [...turn1, reply1, toolsDeclared(LENS_TOOLS), user("document it")];
	const plan = planTurn(ctx(rewound), "/w", warm);
	assert.equal(plan.kind, "fresh");
	assert.match(plan.input.prompt, /<pi_history>[\s\S]*explain[\s\S]*it parses[\s\S]*<\/pi_history>/);
	assert.ok(!plan.input.prompt.includes("add tests"), "the abandoned branch is not replayed");
	assert.ok(plan.input.prompt.endsWith("document it"));
});
test("treeRestoreExtras undoes only what the restore activated beyond the branch's declarations", () => {
	const branch = [
		{ type: "message", message: { role: "system", toolsAdded: [{ name: "bash" }, { name: "read" }, { name: "lens_old" }] } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "system", toolsRemoved: [{ name: "lens_old" }] } },
		{ type: "custom" },
	];
	const before = new Set(["bash", "read", "new_ext"]);
	assert.deepEqual(treeRestoreExtras(branch, before, ["bash", "read", "new_ext", ...LENS_TOOLS]), LENS_TOOLS);
	assert.deepEqual(treeRestoreExtras(branch, new Set(), ["bash", "lens_old"]), [], "declared by the branch, even if removed");
	assert.deepEqual(treeRestoreExtras([], before, ["bash", "read", "new_ext"]), []);
});

test("01a1ab97: after Esc during a pi tool, `continue` matches the tool-boundary or abort checkpoint", () => {
	const u1 = user("run the build");
	const head = [system("Test system", ["bash"]), u1];
	const a1 = toolUse("call-1", "bash");
	const r1 = result("call-1", "bash", "Command aborted", true);
	const a2 = abortedReply();
	const now = ctx([...head, a1, r1, a2, user("continue")]);

	// Checkpoint at the toolUse message (the turn settled while bash ran).
	const atTool = warmAfterTurn(ctx(head), a1, "s1", "/w");
	const fromTool = planTurn(now, "/w", atTool);
	assert.equal(fromTool.kind, "warm");
	if (fromTool.kind !== "warm") return;
	assert.equal(fromTool.input.contextBlock!.uri, "pi://transcript-delta");
	assert.equal(fromTool.input.contextBlock!.text, '<pi-tool-result name="bash" id="call-1" error=true>\nCommand aborted\n</pi-tool-result>\n\n<user>\ncontinue\n</user>');

	// Checkpoint at the aborted reply (the result reached the running turn).
	const atAbort = warmAfterTurn(ctx([...head, a1, r1]), a2, "s1", "/w");
	const fromAbort = planTurn(now, "/w", atAbort);
	assert.deepEqual(fromAbort.kind === "warm" && fromAbort.input, { prompt: "continue", images: [] });

	// First turn, Esc mid-reply: the partial reply is part of the checkpoint.
	const partial = abortedReply("Here is the pl");
	const first = warmAfterTurn(ctx(head), partial, "s2", "/w");
	const resumed = planTurn(ctx([...head, partial, user("continue")]), "/w", first);
	assert.deepEqual(resumed.kind === "warm" && [resumed.sessionId, resumed.input], ["s2", { prompt: "continue", images: [] }]);
});

test("splitUtf8 keeps pieces under the cap, prefers line ends, and never splits a character", () => {
	assert.deepEqual(splitUtf8("short", 100), ["short"]);
	const lines = splitUtf8(`${"a".repeat(95)}\n${"b".repeat(50)}`, 100);
	assert.deepEqual(lines, [`${"a".repeat(95)}\n`, "b".repeat(50)]);
	const wide = splitUtf8("é".repeat(120), 101);
	assert.equal(wide.join(""), "é".repeat(120));
	for (const piece of wide) assert.ok(Buffer.byteLength(piece, "utf8") <= 101 && !piece.includes("\uFFFD"));
	assert.ok(Buffer.byteLength(wide[0], "utf8") >= 90);
});

test("fresh and delta transcripts retain every message across bounded UTF-8 parts", () => {
	const turn1 = [system(), user("hello")];
	const warm = warmAfterTurn(ctx(turn1), assistant("hi"), "s1", "/w");
	const big = (n: number) => assistant(`other model\n${"line of output\n".repeat(n)}`);
	const plan = planTurn(ctx([...turn1, assistant("hi"), user("audit"), big(25_000), user("continue with agy")]), "/w", warm);
	assert.equal(plan.kind, "warm");
	if (plan.kind !== "warm") return;
	const parts = plan.input.parts ?? [];
	assert.equal(parts.length, 2);
	assert.ok(parts.every((part) => Buffer.byteLength(part.contextBlock.text, "utf8") <= MAX_TRANSCRIPT_BYTES));
	assert.ok(parts.every((part, index) => part.contextBlock.uri === "pi://transcript-delta" && part.prompt.startsWith(`Part ${index + 1} of 3`)));
	assert.match(plan.input.prompt, /^Continue the task\.[\s\S]*part 3 of 3 of the pi transcript/);
	const whole = [...parts.map((part) => part.contextBlock.text), plan.input.contextBlock!.text].join("");
	assert.equal(whole.split("line of output").length - 1, 25_000);
	assert.match(whole, /^<user>\naudit\n<\/user>/);
	assert.match(whole, /<user>\ncontinue with agy\n<\/user>$/);
	assert.match(plan.fallback.prompt, /<pi_history>[\s\S]*line of output[\s\S]*continue with agy$/);

	// A fresh replay is one bounded prompt, not priming parts. It keeps the
	// newest history and newest input, omitting oldest history when necessary.
	const runs = Array.from({ length: 30 }, (_, index) => [user(`step ${index}`), big(6_700)]).flat();
	const huge = planTurn(ctx([system(), ...runs, user("tail")]), "/w", undefined);
	assert.equal(huge.kind, "fresh");
	assert.equal(huge.input.parts, undefined);
	assert.equal(huge.input.contextBlock, undefined);
	assert.ok(Buffer.byteLength(huge.input.prompt, "utf8") <= UNLOCKED_REPLAY_BUDGET_BYTES);
	assert.match(huge.input.prompt, /^<pi-system>/);
	assert.match(huge.input.prompt, /\[Earlier \d+ history messages omitted to fit the context replay budget\]/);
	assert.ok(!huge.input.prompt.includes("<user>\nstep 0\n</user>"));
	assert.ok(huge.input.prompt.endsWith("tail"));
});

test("locked replay keeps the newest input complete while omitting old history", () => {
	const history = Array.from({ length: 100 }, (_, index) => user(`old-${index}-${"x".repeat(4_000)}`));
	const newest = `newest-${"你好".repeat(100)}`;
	const plan = planTurn(ctx([system(), ...history, user(newest)]), "/w", undefined, LOCKED_REPLAY_BUDGET_BYTES);
	assert.equal(plan.kind, "fresh");
	assert.ok(Buffer.byteLength(plan.input.prompt, "utf8") <= LOCKED_REPLAY_BUDGET_BYTES);
	assert.match(plan.input.prompt, /\[Earlier \d+ history messages omitted to fit the context replay budget\]/);
	assert.ok(plan.input.prompt.endsWith(newest));
	assert.ok(!plan.input.prompt.includes("old-0-"));
});

test("fresh replay preserves every newest-input block once and keeps earlier users in history", () => {
	const latest = user("implement the fix");
	latest.content = [
		{ type: "text", text: "implement the fix" },
		{ type: "text", text: "[pi-lens automated context — not a user request]\nRun the focused tests." },
		{ type: "text", text: "<project-skill>Use the repository convention.</project-skill>" },
	];
	const plan = planTurn(ctx([system(), user("earlier request"), latest]), "/w", undefined);
	assert.equal(plan.kind, "fresh");
	const historyEnd = plan.input.prompt.indexOf("</pi_history>");
	const history = plan.input.prompt.slice(0, historyEnd);
	const live = plan.input.prompt.slice(historyEnd);
	assert.match(history, /earlier request/);
	assert.ok(!history.includes("implement the fix"));
	assert.match(live, /implement the fix/);
	assert.match(live, /Run the focused tests\./);
	assert.match(live, /<project-skill>Use the repository convention\.<\/project-skill>/);
	assert.equal(plan.input.prompt.split("implement the fix").length - 1, 1);
});

test("fresh replay uses a fixed continuation when history ends in tool results", () => {
	const messages = [system(), user("run"), toolUse("c1", "bash"), result("c1", "bash", "ok")];
	const plan = planTurn(ctx(messages), "/w", undefined);
	assert.equal(plan.kind, "fresh");
	assert.ok(plan.input.prompt.endsWith(EMPTY_INPUT_CONTINUATION));
	assert.match(plan.input.prompt, /<pi_history>[\s\S]*<pi-tool-result name="bash" id="c1" error=false>/);
});

test("prefix fingerprints skip transient messages exactly like the stored fingerprint", () => {
	const lens = (text: string): Message => user(`[pi-lens automated check — not a user request] ${text}`);
	const turn2 = [system(), user("hello"), assistant("hi"), user("q2")];
	const { keys: _keys, items: _items, ...hashOnly } = warmAfterTurn(ctx(turn2), assistant("a2"), "s2", "/w");
	// Only the count + fingerprint path can match a checkpoint without keys/items.
	const now = ctx([system(), user("hello"), lens("old"), assistant("hi"), user("q2"), assistant("a2"), lens("new"), user("q3")]);
	const plan = planTurn(now, "/w", hashOnly);
	assert.equal(plan.kind, "warm");
	assert.equal(plan.kind === "warm" && plan.deltaMessages, 2);
	assert.equal(plan.kind === "warm" && plan.input.prompt.includes("q3"), true);
});

test("structured system prompts omit duplicate sections.tools and send incremental section updates on warm turns", () => {
	const structuredSystem = (extraSections: Record<string, string | null> = {}, tools = ["read", "bash"]): Message => ({
		role: "system",
		content: "",
		sections: {
			preamble: "You are a coding assistant running inside pi.",
			tools: "<tools>\n- read: Read a file\n- bash: Run commands\n</tools>",
			rules: "<rules>\n- Be concise\n</rules>",
			docs: "<docs>\nPi docs\n</docs>",
			cwd: "<cwd>\n/w\n</cwd>",
			...extraSections,
		},
		toolsAdded: tools.map(tool),
		timestamp: 0,
	}) as unknown as Message;

	const head = [structuredSystem(), user("hello")];
	const fresh = planTurn(ctx(head), "/w", undefined);
	assert.equal(fresh.kind, "fresh");
	const freshText = fresh.input.prompt;
	assert.match(freshText, /You are a coding assistant running inside pi\./);
	assert.match(freshText, /<rules>\n- Be concise\n<\/rules>/);
	assert.match(freshText, /<docs>\nPi docs\n<\/docs>/);
	assert.ok(!freshText.includes("<tools>"), "duplicate sections.tools prose must be omitted");

	const warm = warmAfterTurn(ctx(head), assistant("hi"), "s-struct", "/w");
	assert.ok(!warm.systemPrompt.includes("<tools>"));

	// Mid-session tool activation that only updates sections.tools + toolsAdded emits <pi-tools-update> without <pi-system-update>.
	const toolsOnlyPatch = {
		role: "system",
		content: "",
		sections: { tools: "<tools>\n- read: Read a file\n- bash: Run commands\n- lens_symbols: Find symbols\n</tools>" },
		toolsAdded: ["lens_symbols"].map(tool),
		timestamp: 3,
	} as unknown as Message;
	const activated = planTurn(ctx([...head, assistant("hi"), toolsOnlyPatch, user("find foo")]), "/w", warm);
	assert.equal(activated.kind, "warm");
	if (activated.kind !== "warm") return;
	const activatedDelta = activated.input.contextBlock!.text;
	assert.match(activatedDelta, /<pi-tools-update>\nThe active pi tools are now: bash, lens_symbols, read\./);
	assert.ok(!activatedDelta.includes("<pi-system-update>"), "tools-only section change should not send <pi-system-update>");

	// When another section (e.g. rules) changes, <pi-system-update> carries only the changed section, not preamble/docs/tools.
	const rulesPatch = {
		role: "system",
		content: "",
		sections: {
			tools: "<tools>\n- read: Read a file\n</tools>",
			rules: "<rules>\n- Be concise\n- Prefer lens_symbols\n</rules>",
		},
		timestamp: 4,
	} as unknown as Message;
	const ruleUpdated = planTurn(ctx([...head, assistant("hi"), rulesPatch, user("next")]), "/w", warm);
	assert.equal(ruleUpdated.kind, "warm");
	if (ruleUpdated.kind !== "warm") return;
	const ruleDelta = ruleUpdated.input.contextBlock!.text;
	assert.match(ruleDelta, /<pi-system-update>\n<rules>\n- Be concise\n- Prefer lens_symbols\n<\/rules>\n<\/pi-system-update>/);
	assert.ok(!ruleDelta.includes("Pi docs"), "unchanged sections should not be re-sent in <pi-system-update>");
	assert.ok(!ruleDelta.includes("<tools>"));

	// Legacy checkpoints saved before sections.tools stripping remain plain user prompts on /resume.
	const legacyWarm = {
		...warm,
		systemPrompt: [
			"You are a coding assistant running inside pi.",
			"<tools>\n- read: Read a file\n- bash: Run commands\n</tools>",
			"<rules>\n- Be concise\n</rules>",
			"<docs>\nPi docs\n</docs>",
			"<cwd>\n/w\n</cwd>",
		].join("\n\n"),
	};
	const legacyPlan = planTurn(ctx([...head, assistant("hi"), user("continue")]), "/w", legacyWarm);
	assert.equal(legacyPlan.kind, "warm");
	if (legacyPlan.kind === "warm") {
		assert.deepEqual(legacyPlan.input, { prompt: "continue", images: [] });
	}
});
