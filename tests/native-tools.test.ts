import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { BackgroundMessages, formatBackgroundNotice, noticeFromMessage, type BackgroundNotice } from "../src/acp/background.js";
import { acpMode, AcpDriver, type AcpDriverOptions } from "../src/acp/driver.js";
import type { DriverActivity, DriverTurnRequest, TurnHandle } from "../src/driver-types.js";
import { formatDuration, nativeToolLabel, nativeToolLine, NativeToolStatus, type NativeToolEvent } from "../src/native-tools.js";
import { toolPolicyPrompt } from "../src/tool-policy.js";

type WireRequest = { id?: number; method: string; params: Record<string, unknown> };

function fixture(env: Record<string, string> = {}, options: (dir: string) => Partial<AcpDriverOptions> = () => ({})) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-native-test-"));
	const capture = path.join(dir, "requests.ndjson");
	fs.writeFileSync(capture, "");
	const logs: string[] = [];
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [path.join(process.cwd(), "tests/helpers/fake-acp-server.mjs"), capture],
		extraEnv: env,
		log: (msg) => logs.push(msg),
		...options(dir),
	});
	const wire = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireRequest);
	return { driver, wire, dir, logs };
}

const base = { cwd: process.cwd(), model: "gemini-3.8-flash", effort: "medium", mode: "default", skipPermissions: true } satisfies Omit<DriverTurnRequest, "prompt">;

async function drain(handle: TurnHandle): Promise<DriverActivity[]> {
	const activities: DriverActivity[] = [];
	for (;;) {
		const next = await handle.next();
		if (!next) return activities;
		activities.push(next);
	}
}

const natives = (activities: DriverActivity[]) => activities.filter((a): a is Extract<DriverActivity, { type: "native_tool" }> => a.type === "native_tool");
const text = (activities: DriverActivity[]) => activities.flatMap((a) => (a.type === "text" ? [a.delta] : [])).join("");

test("tool policy names the active pi tools and is absent without them", () => {
	const policy = toolPolicyPrompt(["read", "bash", "edit", "bash", ""]);
	assert.ok(policy);
	assert.match(policy, /^read, bash, edit$/m);
	assert.match(policy, /Use these pi tools for all file and shell work/);
	assert.match(policy, /including images/);
	assert.match(policy, /Do not use your built-in run_command, read_file, write_file, edit_file, list_dir tools/);
	assert.match(policy, /do not delegate work to subagents/);
	assert.match(policy, /only for a job no pi tool can do/);
	assert.equal(toolPolicyPrompt([]), undefined);
});

test("native call labels, durations, and lines", () => {
	assert.equal(nativeToolLabel("run_command", { CommandLine: "npm   test\n--watch", WaitMsBeforeAsync: 500 }, "npm test"), "run_command npm test --watch");
	assert.equal(nativeToolLabel("read_file", { Path: "/w/src/a.ts" }, "File a.ts"), "read_file /w/src/a.ts");
	assert.equal(nativeToolLabel("invoke_subagent", { Role: "Checker", Prompt: "long" }, "Run invoke_subagent"), "invoke_subagent Checker");
	assert.equal(nativeToolLabel("search_web", {}, "\"acp\" on Web"), "search_web \"acp\" on Web");
	assert.equal(nativeToolLabel("list_dir", {}, "Run list_dir"), "list_dir");
	assert.equal(nativeToolLabel("run_command", { CommandLine: "x".repeat(200) }).length, "run_command ".length + 80);
	assert.equal(formatDuration(420), "0.4s");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(125_000), "2m 5s");
	assert.equal(nativeToolLine({ label: "read_file a", status: "ok", durationMs: 1500, background: false }), "agy → read_file a ✓ 1.5s");
	assert.equal(nativeToolLine({ label: "run_command false", status: "failed", durationMs: 100, background: false }), "agy → run_command false ✗ 0.1s");
	assert.equal(nativeToolLine({ label: "read_file b", status: "ok", durationMs: 3, background: false }), "agy → read_file b ✓", "no duration for a call reported in one burst");
	assert.equal(nativeToolLine({ label: "invoke_subagent C", status: "ok", durationMs: 600, background: true }), "agy → invoke_subagent C ✓ 0.6s (runs in background)");
	assert.equal(nativeToolLine({ label: "run_command sleep 9", status: "running", background: true }), "agy → run_command sleep 9 … (runs in background)");
});

test("live status shows the oldest running call with its elapsed time and clears", () => {
	vi.useFakeTimers();
	try {
		let now = 1000;
		const shown: Array<string | undefined> = [];
		const status = new NativeToolStatus((text) => shown.push(text), () => now, 1000);
		status.update({ type: "start", id: "a", label: "run_command make", startedAt: 1000 });
		now = 3200;
		vi.advanceTimersByTime(1000);
		status.update({ type: "start", id: "b", label: "read_file x", startedAt: 3200 });
		status.update({ type: "end", id: "a" });
		status.update({ type: "end", id: "missing" });
		status.update({ type: "end", id: "b" });
		vi.advanceTimersByTime(5000);
		assert.deepEqual(shown, [
			"agy: run_command make … 0.0s",
			"agy: run_command make … 2.2s",
			"agy: run_command make … 2.2s (+1 more)",
			"agy: read_file x … 0.0s",
			undefined,
		]);
		status.update({ type: "start", id: "c", label: "x", startedAt: now });
		status.close();
		vi.advanceTimersByTime(5000);
		status.update({ type: "start", id: "d", label: "y", startedAt: now });
		assert.equal(shown.length, 6, "nothing renders after close");
	} finally {
		vi.useRealTimers();
	}
});

test("ACP modes are ones agy 1.5 offers", () => {
	assert.equal(acpMode("default", true), "accept-edits");
	assert.equal(acpMode("default", false), "default");
	assert.equal(acpMode("plan", true), "plan");
});

test("the tool policy rides on session/new and session/resume, and turns use valid modes", async () => {
	const { driver, wire, dir } = fixture({ FAKE_ACP_RESUME: "1", FAKE_ACP_DB_DIR: "" }, (tmp) => ({
		systemPrompt: () => "POLICY",
		conversationsDir: () => tmp,
	}));
	try {
		const first = await driver.run({ ...base, prompt: "one" });
		await drain(first);
		const sessionId = (await first.outcome).conversationId!;
		fs.writeFileSync(path.join(dir, `${sessionId}.db`), "");
		await driver.close();
		const second = await driver.run({ ...base, conversationId: sessionId, prompt: "two" });
		await drain(second);
		assert.equal((await second.outcome).status, "OK");
		const meta = (method: string) => wire().find((request) => request.method === method)?.params._meta;
		assert.deepEqual(meta("session/new"), { antigravity: { eagerMcpServers: ["pi-bridge"], systemPrompt: { append: "POLICY" } } });
		assert.deepEqual(meta("session/resume"), { antigravity: { eagerMcpServers: ["pi-bridge"], systemPrompt: { append: "POLICY" } } });
		const modes = wire().filter((request) => request.method === "session/set_config_option" && request.params.configId === "mode").map((request) => request.params.value);
		assert.deepEqual(modes, ["accept-edits", "accept-edits"]);
	} finally {
		await driver.close();
	}
});

test("no policy appends nothing to agy's system prompt", async () => {
	const { driver, wire } = fixture({}, () => ({ systemPrompt: () => undefined }));
	try {
		await drain(await driver.run({ ...base, prompt: "one" }));
		assert.deepEqual(wire().find((request) => request.method === "session/new")?.params._meta, { antigravity: { eagerMcpServers: ["pi-bridge"] } });
	} finally {
		await driver.close();
	}
});

test("native calls are reported with status and live events; pi bridge calls are not", async () => {
	const events: NativeToolEvent[] = [];
	const { driver } = fixture({}, () => ({ onNativeTool: (event) => events.push(event) }));
	try {
		const handle = await driver.run({ ...base, prompt: "[native]" });
		const activities = await drain(handle);
		assert.deepEqual(natives(activities).map(({ label, status, background }) => ({ label, status, background })), [
			{ label: "read_file /w/a.txt", status: "ok", background: false },
			{ label: "run_command false", status: "failed", background: false },
		]);
		assert.ok(natives(activities).every((native) => typeof native.durationMs === "number" && native.durationMs >= 0));
		const bridge = activities.find((a) => a.type === "tool_start" && a.toolCallId === "b1");
		assert.deepEqual(bridge && bridge.type === "tool_start" ? { name: bridge.name, mcpServer: bridge.mcpServer } : undefined, { name: "bash", mcpServer: "pi-bridge" });
		assert.deepEqual(events.map((event) => `${event.type}:${event.id}`), ["start:n1", "end:n1", "start:n2", "end:n2"]);
		assert.equal(text(activities), "OK");
	} finally {
		await driver.close();
	}
});

test("a running native call pauses the inactivity guard", async () => {
	const { driver } = fixture();
	try {
		// 60 ms guard, 400 ms native command.
		const single = await driver.run({ ...base, prompt: "[native-slow:400]", inactivityMin: 0.001 });
		const alone = await drain(single);
		assert.equal((await single.outcome).status, "OK", (await single.outcome).error);
		assert.deepEqual(natives(alone).map((native) => native.label), ["run_command make"]);
		const handle = await driver.run({ ...base, prompt: "[native-slow:400] [overlap]", inactivityMin: 0.001 });
		const activities = await drain(handle);
		const outcome = await handle.outcome;
		assert.equal(outcome.status, "OK", outcome.error);
		// The quick call ends first; the slow one still holds the guard off.
		assert.deepEqual(natives(activities).map((native) => native.label), ["read_file /w/q", "run_command make"]);
	} finally {
		await driver.close();
	}
});

test("background work: marked at prompt end, reported from agy's messages, leftovers never reach the next reply", async () => {
	const notices: BackgroundNotice[] = [];
	const events: NativeToolEvent[] = [];
	const brain = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-brain-"));
	const { driver: bgDriver, logs } = fixture({ FAKE_ACP_BRAIN_DIR: brain }, () => ({
		brainDir: () => brain,
		backgroundPollMs: 20,
		onBackgroundMessage: (notice) => notices.push(notice),
		onNativeTool: (event) => events.push(event),
	}));
	try {
		const first = await bgDriver.run({ ...base, prompt: "[background]" });
		const activities = await drain(first);
		const sessionId = (await first.outcome).conversationId!;
		assert.deepEqual(natives(activities).map(({ label, status, background }) => ({ label, status, background })), [
			{ label: "run_command sleep 1; echo FINISHED", status: "running", background: true },
		]);
		assert.deepEqual(events.map((event) => event.type), ["start", "end"], "the live status clears when the turn settles");
		await vi.waitFor(() => assert.equal(notices.length, 1), { timeout: 3000 });
		assert.deepEqual(notices[0], { sessionId, title: "Sleep task finished", exitCode: 0, tail: "tick\nFINISHED" });

		const second = await bgDriver.run({ ...base, conversationId: sessionId, prompt: "next" });
		const next = await drain(second);
		assert.equal(text(next), "OK");
		assert.equal((await second.outcome).response, "OK");
		assert.deepEqual(natives(next), []);
		assert.deepEqual(next.find((a) => a.type === "context_usage"), { type: "context_usage", contextUsage: { used: 1234, size: 100000 } }, "status before the echo still applies");
		assert.ok(!next.some((a) => a.type === "tool_done" && a.toolCallId === "bg1"));
		assert.ok(logs.includes("leftovers-dropped"));
	} finally {
		await bgDriver.close();
	}
});

test("subagents are marked as background work and their reply is reported", async () => {
	const notices: BackgroundNotice[] = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-brain-"));
	const { driver } = fixture({ FAKE_ACP_BRAIN_DIR: dir }, () => ({
		brainDir: () => dir,
		backgroundPollMs: 20,
		onBackgroundMessage: (notice) => notices.push(notice),
	}));
	try {
		const activities = await drain(await driver.run({ ...base, prompt: "[subagent]" }));
		assert.deepEqual(natives(activities).map(({ label, status, background }) => ({ label, status, background })), [
			{ label: "invoke_subagent Checker", status: "ok", background: true },
		]);
		await vi.waitFor(() => assert.equal(notices.length, 1), { timeout: 3000 });
		assert.equal(notices[0]?.title, "Message from Checker (research)");
		assert.equal(notices[0]?.tail, "all good");
		assert.equal(notices[0]?.exitCode, undefined);
	} finally {
		await driver.close();
	}
});

test("agy's invalid-output retry notice is thinking, not reply text", async () => {
	const { driver } = fixture();
	try {
		const handle = await driver.run({ ...base, prompt: "[invalid]" });
		const activities = await drain(handle);
		assert.equal(text(activities), "OK");
		assert.equal((await handle.outcome).response, "OK");
		const thoughts = activities.flatMap((a) => (a.type === "thought" ? [a.delta] : [])).join("");
		assert.match(thoughts, /⚠ Model produced invalid output\. agy retries\./);
	} finally {
		await driver.close();
	}
});

test("frames are not lost when agy does not echo the prompt", async () => {
	const { driver, logs } = fixture();
	try {
		const handle = await driver.run({ ...base, prompt: "[no-echo] [native]" });
		const activities = await drain(handle);
		assert.equal(text(activities), "OK");
		assert.equal(natives(activities).length, 2);
		assert.ok(logs.includes("no-prompt-echo"));
	} finally {
		await driver.close();
	}
});

test("agy messages become notices with exit code and output tail", () => {
	const notice = noticeFromMessage("s", {
		title: "Build finished",
		content: `Command exited with code 2.\r\n\r\nCommand output:\r\n${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n")}\r\n\nLog: file:///tmp/task-3.log`,
	});
	assert.deepEqual(notice, { sessionId: "s", title: "Build finished", exitCode: 2, tail: "line 4\nline 5\nline 6\nline 7\nline 8\nline 9" });
	assert.equal(formatBackgroundNotice(notice), "Antigravity background: Build finished (exit code 2)\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9");
	const untitled = noticeFromMessage("s", { sender: "sub-9", content: "x".repeat(2000) });
	assert.equal(untitled.title, "Message from sub-9");
	assert.equal(untitled.tail.length, 600);
	assert.equal(formatBackgroundNotice({ sessionId: "s", title: "Done", tail: "" }), "Antigravity background: Done");
});

test("the watcher ignores old, foreign, and unreadable messages and stops when the work is done or expired", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-watch-"));
	const dir = path.join(root, "s1", ".system_generated", "messages");
	fs.mkdirSync(dir, { recursive: true });
	const write = (name: string, body: unknown) => fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
	const notices: BackgroundNotice[] = [];
	let now = 10_000;
	const watcher = new BackgroundMessages({ brainDir: () => root, onMessage: (notice) => notices.push(notice), intervalMs: 60_000, maxAgeMs: 5000, now: () => now });
	try {
		const at = (ms: number) => new Date(ms).toISOString();
		write("old.json", { recipient: "s1", sender: "s1/task-0", timestamp: at(1000), content: "old" });
		write("read.json", { recipient: "s1", sender: "x" });
		write("foreign.json", { recipient: "other", sender: "s1/task-1", timestamp: at(20_000), content: "no" });
		write("self.json", { recipient: "s1", sender: "s1", timestamp: at(20_000), content: "no" });
		write("partial.json", "{\"recipient\":");
		watcher.track("s1", { since: 9000, taskIds: ["t1"], subagents: 1 });
		watcher.track("s1", { since: 9500, taskIds: [], subagents: 0 });
		watcher.poll();
		assert.equal(notices.length, 0);
		write("task.json", { recipient: "s1", sender: "s1/task-1", timestamp: at(20_000), renderDetails: { messageTitle: "T" }, content: "Command exited with code 0.", sourceMetadata: { tool: { toolCall: { id: "t1" } } } });
		watcher.poll();
		assert.deepEqual(notices.map((notice) => notice.title), ["T"]);
		assert.deepEqual(watcher.watching, ["s1"], "the subagent is still outstanding");
		write("partial.json", { recipient: "s1", sender: "sub", timestamp: at(20_000), content: "done" });
		watcher.poll();
		assert.deepEqual(notices.map((notice) => notice.tail), ["", "done"]);
		assert.deepEqual(watcher.watching, []);

		watcher.track("s1", { since: 30_000, taskIds: ["t9"], subagents: 0 });
		now += 6000;
		watcher.poll();
		assert.deepEqual(watcher.watching, [], "expired");
		watcher.track("missing", { since: 0, taskIds: ["t"], subagents: 0 });
		watcher.poll();
		assert.deepEqual(watcher.watching, ["missing"], "a directory agy has not created yet is retried");
	} finally {
		watcher.close();
	}
	assert.deepEqual(watcher.watching, []);
});
