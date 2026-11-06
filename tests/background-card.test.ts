import assert from "node:assert/strict";
import { test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BackgroundNotice } from "../src/acp/background.js";
import { backgroundCardLines, renderBackgroundCard } from "../src/background-card.js";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Wraps every styled span as <name>…</name>, so styling is visible in assertions. */
const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => `*${text}*`,
} as unknown as Theme;

const task: BackgroundNotice = {
	sessionId: "s",
	kind: "task",
	workId: "bg1",
	tool: "run_command",
	target: "sleep 15 && echo DONE",
	title: "Sleep and print DONE finished",
	exitCode: 0,
	durationMs: 15_200,
	tail: "DONE",
	output: "DONE",
	logPath: "/tmp/task-4.log",
};

test("a finished task card: tool, target, title, exit code, duration, output, and an expand hint", () => {
	assert.deepEqual(backgroundCardLines(task, false, tagTheme, "HINT"), [
		"<toolTitle>*agy background*</toolTitle> <success>✓</success>  *run_command*  sleep 15 && echo DONE",
		"<muted>Sleep and print DONE finished · exit 0 · 15s</muted>",
		"",
		"<toolOutput>DONE</toolOutput>",
		"",
		"HINT",
	]);
	assert.deepEqual(backgroundCardLines(task, true, tagTheme, "HINT").slice(-3), ["<toolOutput>DONE</toolOutput>", "", "<dim>log: /tmp/task-4.log</dim>"]);
});

test("a failed task is red and expanding shows the whole captured output", () => {
	const failed = { ...task, exitCode: 2, tail: "e5\ne6", output: "e1\ne2\ne3\ne4\ne5\ne6", logPath: undefined };
	const collapsed = backgroundCardLines(failed, false, tagTheme, "HINT");
	assert.match(collapsed[0]!, /<error>✗<\/error>/);
	assert.equal(collapsed.filter((line) => line.startsWith("<toolOutput>")).length, 2);
	assert.equal(collapsed.at(-1), "HINT", "more output than shown");
	const expanded = backgroundCardLines(failed, true, tagTheme, "HINT");
	assert.equal(expanded.filter((line) => line.startsWith("<toolOutput>")).length, 6);
	assert.ok(!expanded.includes("HINT"));
});

test("subagent and plain message cards", () => {
	const subagent: BackgroundNotice = { sessionId: "s", kind: "subagent", tool: "invoke_subagent", target: "Word Responder", title: "Message from Word Responder (research)", durationMs: 4100, tail: "BANANA", output: "BANANA" };
	assert.deepEqual(backgroundCardLines(subagent, false, tagTheme, "HINT"), [
		"<toolTitle>*agy subagent*</toolTitle> <success>✓</success>  Word Responder",
		"<muted>Message from Word Responder (research) · 4.1s</muted>",
		"",
		"<toolOutput>BANANA</toolOutput>",
	]);
	const message: BackgroundNotice = { sessionId: "s", kind: "message", title: "Note", tail: "", output: "" };
	assert.deepEqual(backgroundCardLines(message, false, tagTheme, "HINT"), ["<toolTitle>*agy message*</toolTitle> <success>✓</success>  Note"]);
});

test("the renderer draws one tool-colored card per item", () => {
	const options = { expanded: false, outputPad: 1, keyText: () => "ctrl+o", keyHint: (_key: string, text: string) => `ctrl+o ${text}` };
	const message = { role: "custom", customType: "agy-background", content: "x", display: true, timestamp: 0, details: { items: [task, { ...task, workId: "bg2", exitCode: 1 }] } };
	const component = renderBackgroundCard(message as never, options as never, tagTheme);
	assert.ok(component);
	const lines = component.render(100).map(strip);
	const header = (mark: string) => lines.findIndex((line) => line.includes(`*agy background*</toolTitle> <${mark}>`));
	assert.ok(header("success") >= 0 && header("error") > header("success"), "cards in message order");
	assert.ok(lines.slice(0, header("error")).some((line) => line.startsWith("[toolSuccessBg]")), "success card background");
	assert.ok(lines.slice(header("error") - 1).every((line) => line === "" || line.startsWith("[toolErrorBg]")), "failed card background");
	assert.ok(lines.some((line) => line.includes("ctrl+o to expand: full output, log path")));
	assert.equal(renderBackgroundCard({ ...message, details: { items: [] } } as never, options as never, tagTheme), undefined);
});
