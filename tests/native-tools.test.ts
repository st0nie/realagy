import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundMessages, backgroundMessageText, noticeFromMessage, type BackgroundNotice } from "../src/acp/background.js";
import { acpMode, AcpDriver, type AcpDriverOptions } from "../src/acp/driver.js";
import type { DriverActivity, DriverTurnRequest, TurnHandle } from "../src/driver-types.js";
import { AgyWorkPanel, formatDuration, nativeToolLabel, nativeToolLine, nativeToolTarget, type PanelHost, type PanelStyle, type PanelWidget, type NativeToolEvent } from "../src/native-tools.js";
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
	assert.match(policy, /Do not use your built-in run_command, read_file, write_file, edit_file tools/);
	assert.match(policy, /do not start subagents, the browser agent, background tasks, or scheduled tasks \(invoke_subagent, define_subagent, manage_subagents, schedule, manage_task\)/);
	assert.match(policy, /only for a job no pi tool can do/);
	assert.equal(toolPolicyPrompt([]), undefined);
});

test("native call labels, durations, and lines", () => {
	const label = (name: string, args: Record<string, unknown>, title?: string) => nativeToolLabel(name, nativeToolTarget(name, args, title));
	assert.equal(label("run_command", { CommandLine: "npm   test\n--watch", WaitMsBeforeAsync: 500 }, "npm test"), "run_command npm test --watch");
	assert.equal(label("read_file", { Path: "/w/src/a.ts" }, "File a.ts"), "read_file /w/src/a.ts");
	assert.equal(label("invoke_subagent", { Role: "Checker", Prompt: "long" }, "Run invoke_subagent"), "invoke_subagent Checker");
	assert.equal(label("search_web", {}, "\"acp\" on Web"), "search_web \"acp\" on Web");
	assert.equal(label("list_dir", {}, "Run list_dir"), "list_dir");
	assert.equal(label("run_command", { CommandLine: "x".repeat(200) }).length, "run_command ".length + 80);
	assert.equal(formatDuration(420), "0.4s");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(125_000), "2m 5s");
	assert.equal(nativeToolLine({ label: "read_file a", status: "ok", durationMs: 1500, background: false }), "agy → read_file a ✓ 1.5s");
	assert.equal(nativeToolLine({ label: "run_command false", status: "failed", durationMs: 100, background: false }), "agy → run_command false ✗ 0.1s");
	assert.equal(nativeToolLine({ label: "read_file b", status: "ok", durationMs: 3, background: false }), "agy → read_file b ✓", "no duration for a call reported in one burst");
	assert.equal(nativeToolLine({ label: "invoke_subagent C", status: "ok", durationMs: 600, background: true }), "agy → invoke_subagent C ✓ 0.6s (runs in background)");
	assert.equal(nativeToolLine({ label: "run_command sleep 9", status: "running", background: true }), "agy → run_command sleep 9 … (runs in background)");
});

/** A fake widget slot: records mounts and redraw requests, renders like pi's TUI. */
function panelHost(style: PanelStyle = { fg: (_color, text) => text }) {
	const state = { mounts: 0, hides: 0, redraws: 0, disposed: 0, widget: undefined as undefined | ReturnType<PanelWidget> };
	const host: PanelHost = {
		show: (factory) => {
			state.mounts += 1;
			state.widget = factory({ requestRender: () => { state.redraws += 1; } }, style);
		},
		hide: () => {
			state.hides += 1;
			state.widget?.dispose();
			state.disposed += 1;
			state.widget = undefined;
		},
	};
	return { host, state, render: (width = 120) => state.widget?.render(width) };
}

test("the live panel mounts once, redraws through pi's TUI while work runs, and unmounts when idle", () => {
	vi.useFakeTimers();
	try {
		let now = 1000;
		const { host, state, render } = panelHost();
		const panel = new AgyWorkPanel(host, { now: () => now, intervalMs: 1000 });
		panel.update({ type: "start", id: "a", tool: "run_command", target: "make", startedAt: 1000 });
		assert.equal(state.mounts, 1);
		assert.deepEqual(render(), [" ⠋ agy  run_command  make  0.0s"]);
		now = 3200;
		vi.advanceTimersByTime(1000);
		assert.equal(state.redraws, 1, "a tick only requests a redraw");
		assert.deepEqual(render(), [" ⠙ agy  run_command  make  2.2s"], "the spinner turns and the time runs");
		panel.update({ type: "start", id: "b", tool: "invoke_subagent", target: "Checker", startedAt: 3200 });
		panel.update({ type: "background", id: "a", kind: "task" });
		panel.update({ type: "background", id: "b", kind: "subagent" });
		panel.update({ type: "background", id: "missing", kind: "task" });
		assert.equal(state.mounts, 1, "changes redraw the mounted widget");
		assert.deepEqual(render(), [" ⠙ agy  background  make  2.2s", " ⠙ agy  subagent    Checker  0.0s"]);
		for (const line of render(20)!) assert.ok(visibleWidth(line) <= 20, line);
		for (const id of ["c", "d", "e", "f"]) panel.update({ type: "start", id, tool: "read_file", startedAt: now });
		assert.equal(render()?.length, 6, "five rows and a summary");
		assert.equal(render()?.at(-1), "   … 1 more");
		const redraws = state.redraws;
		panel.update({ type: "end", id: "missing" });
		assert.equal(state.redraws, redraws, "unknown ids change nothing");
		for (const id of ["a", "b", "c", "d", "e", "f"]) panel.update({ type: "end", id });
		assert.deepEqual([state.hides, state.disposed], [1, 1], "an empty panel is removed");
		const settled = state.redraws;
		vi.advanceTimersByTime(5000);
		assert.equal(state.redraws, settled, "no redraws while idle");
		panel.update({ type: "start", id: "g", tool: "x", startedAt: now });
		assert.equal(state.mounts, 2, "new work mounts it again");
		panel.close();
		vi.advanceTimersByTime(5000);
		panel.update({ type: "start", id: "h", tool: "y", startedAt: now });
		assert.equal(state.mounts, 2, "nothing mounts after close");
		assert.equal(state.redraws, settled, "nothing redraws after close");
		assert.equal(panel.size, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("the live panel uses pi's theme", () => {
	const { host, render } = panelHost({ fg: (color, text) => `<${color}>${text}` });
	const panel = new AgyWorkPanel(host, { now: () => 0 });
	panel.update({ type: "start", id: "a", tool: "read_file", startedAt: 0 });
	assert.deepEqual(render(), [" <accent>⠋ <muted>agy  <toolTitle>read_file  <dim>0.0s"]);
	panel.close();
});

test("ACP modes are ones agy 1.5 offers", () => {
	assert.equal(acpMode("default"), "default");
	assert.equal(acpMode("plan"), "plan");
});

test("the tool policy rides on session/new and session/resume, and turns use valid modes", async () => {
	const { driver, wire, dir, logs } = fixture({ FAKE_ACP_RESUME: "1", FAKE_ACP_DB_DIR: "" }, (tmp) => ({
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
		assert.deepEqual(modes, ["default", "default"]);
		assert.ok(!logs.includes("mode-apply-failed"), "agy accepts the mode");
	} finally {
		await driver.close();
	}
});

test("the tool policy rides on session/load when agy cannot resume", async () => {
	const { driver, wire, dir } = fixture({ FAKE_ACP_DB_DIR: "" }, (tmp) => ({ systemPrompt: () => "POLICY", conversationsDir: () => tmp }));
	try {
		const first = await driver.run({ ...base, prompt: "one" });
		await drain(first);
		const sessionId = (await first.outcome).conversationId!;
		fs.writeFileSync(path.join(dir, `${sessionId}.db`), "");
		await driver.close();
		await drain(await driver.run({ ...base, conversationId: sessionId, prompt: "two" }));
		assert.deepEqual(wire().find((request) => request.method === "session/load")?.params._meta, { antigravity: { eagerMcpServers: ["pi-bridge"], systemPrompt: { append: "POLICY" } } });
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
		assert.deepEqual(events[0], { type: "start", id: "n1", tool: "read_file", target: "/w/a.txt", startedAt: (events[0] as { startedAt: number }).startedAt });
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
		onBackgroundMessages: (items) => {
			// the panel entry ends before pi hears of the result
			assert.equal(events.at(-1)?.type, "end");
			notices.push(...items);
		},
		onNativeTool: (event) => events.push(event),
	}));
	try {
		const first = await bgDriver.run({ ...base, prompt: "[background]" });
		const activities = await drain(first);
		const sessionId = (await first.outcome).conversationId!;
		assert.deepEqual(natives(activities).map(({ label, status, background }) => ({ label, status, background })), [
			{ label: "run_command sleep 1; echo FINISHED", status: "running", background: true },
		]);
		assert.deepEqual(events.map((event) => event.type), ["start", "background"], "the call stays in the panel as background work");
		await vi.waitFor(() => assert.equal(notices.length, 1), { timeout: 3000 });
		assert.deepEqual(events.map((event) => `${event.type}:${event.id}`), ["start:bg1", "background:bg1", "end:bg1"]);
		const { durationMs, ...notice } = notices[0]!;
		assert.ok(typeof durationMs === "number" && durationMs >= 0);
		assert.deepEqual(notice, {
			sessionId,
			kind: "task",
			workId: "bg1",
			tool: "run_command",
			target: "sleep 1; echo FINISHED",
			title: "Sleep task finished",
			exitCode: 0,
			output: "tick\nFINISHED",
			logPath: "/tmp/task-1.log",
		});

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

test("without a brain directory, background work leaves the panel when the turn settles", async () => {
	const events: NativeToolEvent[] = [];
	const brain = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-brain-"));
	const { driver } = fixture({ FAKE_ACP_BRAIN_DIR: brain }, () => ({
		brainDir: () => undefined,
		onBackgroundMessages: () => assert.fail("nothing is watched"),
		onNativeTool: (event) => events.push(event),
	}));
	try {
		await drain(await driver.run({ ...base, prompt: "[background] [subagent]" }));
		assert.deepEqual(events.map((event) => `${event.type}:${event.id}`).sort(), ["end:bg1", "end:sa1", "start:bg1", "start:sa1"]);
	} finally {
		await driver.close();
	}
});

test("background work leaves the panel when the agy process that ran it exits", async () => {
	const events: NativeToolEvent[] = [];
	const notices: BackgroundNotice[] = [];
	// agy writes its messages elsewhere, so only the exit can end the work.
	const writes = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-brain-"));
	const watched = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-brain-"));
	const { driver } = fixture({ FAKE_ACP_BRAIN_DIR: writes }, () => ({
		brainDir: () => watched,
		backgroundPollMs: 20,
		onBackgroundMessages: (items) => notices.push(...items),
		onNativeTool: (event) => events.push(event),
	}));
	try {
		await drain(await driver.run({ ...base, prompt: "[background]" }));
		assert.deepEqual(events.map((event) => `${event.type}:${event.id}`), ["start:bg1", "background:bg1"]);
		const crashed = await driver.run({ ...base, prompt: "[exit]" });
		await drain(crashed);
		assert.equal((await crashed.outcome).status, "ERROR");
		assert.deepEqual(events.map((event) => `${event.type}:${event.id}`), ["start:bg1", "background:bg1", "end:bg1"]);
		assert.deepEqual(notices, []);
	} finally {
		await driver.close();
	}
});

test("subagents are marked as background work and their reply is reported", async () => {
	const notices: BackgroundNotice[] = [];
	const events: NativeToolEvent[] = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-brain-"));
	const { driver } = fixture({ FAKE_ACP_BRAIN_DIR: dir }, () => ({
		brainDir: () => dir,
		backgroundPollMs: 20,
		onBackgroundMessages: (items) => notices.push(...items),
		onNativeTool: (event) => events.push(event),
	}));
	try {
		const activities = await drain(await driver.run({ ...base, prompt: "[subagent]" }));
		assert.deepEqual(natives(activities).map(({ label, status, background }) => ({ label, status, background })), [
			{ label: "invoke_subagent Checker", status: "ok", background: true },
		]);
		await vi.waitFor(() => assert.equal(notices.length, 1), { timeout: 3000 });
		assert.equal(notices[0]?.title, "Message from Checker (research)");
		assert.equal(notices[0]?.kind, "subagent");
		assert.equal(notices[0]?.workId, "sa1");
		assert.equal(notices[0]?.target, "Checker");
		assert.equal(notices[0]?.output, "all good");
		assert.equal(notices[0]?.exitCode, undefined);
		assert.deepEqual(events.map((event) => `${event.type}:${event.id}`), ["start:sa1", "background:sa1", "end:sa1"]);
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

test("agy messages become notices with exit code, output, and log path; the model reads them as text", () => {
	const content = `Command exited with code 2.\r\n\r\nCommand output:\r\n${Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n")}\r\n\nLog: file:///tmp/my%20task-3.log`;
	const item = { id: "t3", tool: "run_command", target: "make", startedAt: 1000 };
	const notice = noticeFromMessage("s", { title: "Build finished", content, timestamp: 4500 }, { kind: "task", item });
	assert.equal(notice.exitCode, 2);
	assert.equal(notice.durationMs, 3500);
	assert.equal(notice.logPath, "/tmp/my task-3.log");
	assert.equal(notice.output.split("\n").length, 80);
	assert.equal(notice.output.split("\n")[0], "line 20");
	const untitled = noticeFromMessage("s", { sender: "sub-9", content: "x".repeat(9000) });
	assert.equal(untitled.title, "Message from sub-9");
	assert.equal(untitled.kind, "message");
	assert.equal(untitled.output.length, 8000);
	const quiet = noticeFromMessage("s", { title: "Quiet", content: "Command exited with code 0." }, { kind: "task", item });
	assert.equal(quiet.output, "", "the exit line is not output");
	assert.equal(backgroundMessageText([notice, quiet]), [
		"Antigravity background work started earlier in this conversation finished:",
		`- Background command run_command \`make\` (agy: "Build finished") finished: exit code 2, ran 3.5s.\nOutput (last lines):\n\`\`\`\n${notice.output}\n\`\`\`\nFull log: /tmp/my task-3.log`,
		"- Background command run_command `make` (agy: \"Quiet\") finished: exit code 0.\n(no output)",
	].join("\n\n"));
	assert.match(backgroundMessageText([{ sessionId: "s", kind: "subagent", tool: "invoke_subagent", target: "Checker", title: "Message from Checker (research)", output: "ok" }]), /Subagent invoke_subagent `Checker`.*\nReply:\n```\nok\n```$/s);
	assert.match(backgroundMessageText([{ sessionId: "s", kind: "message", title: "Hi", output: "" }]), /- agy message "Hi" finished\.\n\(no output\)$/);
});

test("the watcher ignores old, foreign, and unreadable messages and stops when the work is done or expired", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-watch-"));
	const dir = path.join(root, "s1", ".system_generated", "messages");
	fs.mkdirSync(dir, { recursive: true });
	const write = (name: string, body: unknown) => fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
	const notices: BackgroundNotice[] = [];
	const forgotten: string[] = [];
	let polls = 0;
	let now = 10_000;
	const watcher = new BackgroundMessages({
		brainDir: () => root,
		onMessages: (items) => {
			polls += 1;
			notices.push(...items);
		},
		onForget: (ids) => forgotten.push(...ids),
		intervalMs: 60_000,
		maxAgeMs: 5000,
		now: () => now,
	});
	const work = (id: string) => ({ id, tool: "run_command", startedAt: 9000 });
	try {
		const at = (ms: number) => new Date(ms).toISOString();
		write("old.json", { recipient: "s1", sender: "s1/task-0", timestamp: at(1000), content: "old" });
		write("read.json", { recipient: "s1", sender: "x" });
		write("foreign.json", { recipient: "other", sender: "s1/task-1", timestamp: at(20_000), content: "no" });
		write("self.json", { recipient: "s1", sender: "s1", timestamp: at(20_000), content: "no" });
		write("partial.json", "{\"recipient\":");
		watcher.track("s1", { since: 9000, tasks: [work("t1")], subagents: [{ id: "sa", tool: "invoke_subagent", target: "Checker", startedAt: 9000 }] });
		watcher.track("s1", { since: 9500, tasks: [], subagents: [] });
		watcher.poll();
		assert.equal(notices.length, 0);
		write("task.json", { recipient: "s1", sender: "s1/task-1", timestamp: at(20_000), renderDetails: { messageTitle: "T" }, content: "Command exited with code 0.", sourceMetadata: { tool: { toolCall: { id: "t1" } } } });
		watcher.poll();
		assert.deepEqual(notices.map((notice) => [notice.title, notice.kind, notice.workId]), [["T", "task", "t1"]]);
		assert.deepEqual(watcher.watching, ["s1"], "the subagent is still outstanding");
		write("partial.json", { recipient: "s1", sender: "sub", timestamp: at(20_000), content: "done" });
		watcher.poll();
		assert.deepEqual(notices.map((notice) => notice.output), ["", "done"]);
		assert.deepEqual(notices.map((notice) => notice.workId), ["t1", "sa"], "a message from another conversation reports the subagent");
		assert.deepEqual(watcher.watching, []);
		assert.equal(polls, 2, "one callback per poll with news");
		assert.deepEqual(forgotten, []);

		watcher.track("s1", { since: 30_000, tasks: [work("t9")], subagents: [] });
		now += 6000;
		watcher.poll();
		assert.deepEqual(watcher.watching, [], "expired");
		assert.deepEqual(forgotten, ["t9"], "expired work leaves the panel");
		watcher.track("missing", { since: 0, tasks: [work("t")], subagents: [] });
		watcher.poll();
		assert.deepEqual(watcher.watching, ["missing"], "a directory agy has not created yet is retried");
		watcher.forgetAll();
		assert.deepEqual(forgotten, ["t9", "t"], "work of an exited agy is forgotten");
		assert.deepEqual(watcher.watching, []);
	} finally {
		watcher.close();
	}
	assert.deepEqual(watcher.watching, []);
});
