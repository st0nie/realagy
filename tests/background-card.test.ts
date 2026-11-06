import assert from "node:assert/strict";
import { test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { BackgroundNotice } from "../src/acp/background.js";
import { backgroundItemText, renderBackgroundCard, type BackgroundCardMessage } from "../src/background-card.js";

/** Wraps every styled span as <name>…</name>, so styling is visible in assertions. */
const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => `*${text}*`,
} as unknown as Theme;

/** Background only, so rendered lines read as plain text. */
const bgTheme = {
	fg: (_color: string, text: string) => text,
	bg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => text,
} as unknown as Theme;

const keyHint = (_key: string, text: string) => `ctrl+o ${text}`;
const opts = (expanded: boolean) => ({ expanded, outputPad: 1, keyText: () => "ctrl+o", keyHint }) as never;

const eight = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
const task: BackgroundNotice = {
	sessionId: "s",
	kind: "task",
	workId: "bg1",
	tool: "run_command",
	target: "sleep 15 && echo DONE",
	title: "Sleep and print DONE finished",
	exitCode: 0,
	durationMs: 15_200,
	output: eight,
	logPath: "/tmp/task-4.log",
};

const message = (items: BackgroundNotice[]): BackgroundCardMessage =>
	({ role: "custom", customType: "agy-background", content: "x", display: true, timestamp: 0, details: { items } }) as BackgroundCardMessage;
const text = (card: Component | undefined) => card!.render(120).map((line) => line.trimEnd()).join("\n");
const click = (card: Component, y: number, button: "left" | "right" = "left") =>
	card.handleMouse?.({ type: "click", button, x: 0, y, screenX: 0, screenY: y, width: 120, height: 20, shift: false, alt: false, ctrl: false });

test("collapsed item: realtasks-style header and a 5-line preview under an expand hint", () => {
	assert.deepEqual(backgroundItemText(task, { expanded: false, keyHint }, tagTheme).split("\n"), [
		"<success>✓</success> <toolTitle>*agy task*</toolTitle> <accent>Sleep and print DONE finished</accent><muted> · exit 0 · 15s</muted>",
		"",
		"<muted>... (3 earlier lines,</muted> ctrl+o to expand<muted>)</muted>",
		...[4, 5, 6, 7, 8].map((n) => `<toolOutput>line ${n}</toolOutput>`),
	]);
});

test("expanded item: command line, whole output and log path", () => {
	const lines = backgroundItemText(task, { expanded: true, keyHint }, tagTheme).split("\n");
	assert.equal(lines[1], "<muted>$ sleep 15 && echo DONE</muted>");
	assert.equal(lines.filter((line) => line.startsWith("<toolOutput>")).length, 8);
	assert.deepEqual(lines.slice(-2), ["", "<muted>log: /tmp/task-4.log</muted>"]);
	assert.ok(!lines.some((line) => line.includes("to expand")));
});

test("failed, subagent, other-tool and plain message items", () => {
	const failed = backgroundItemText({ ...task, exitCode: 2, output: "boom" }, { expanded: false, keyHint }, tagTheme);
	assert.match(failed, /^<error>✗<\/error> .*exit 2/);
	const subagent: BackgroundNotice = { sessionId: "s", kind: "subagent", tool: "invoke_subagent", target: "Word Responder", title: "Message from Word Responder (research)", durationMs: 4100, output: "BANANA" };
	assert.deepEqual(backgroundItemText(subagent, { expanded: true, keyHint }, tagTheme).split("\n"), [
		"<success>✓</success> <toolTitle>*agy subagent*</toolTitle> <accent>Word Responder</accent><muted> · 4.1s</muted>",
		"<muted>Message from Word Responder (research)</muted>",
		"",
		"<toolOutput>BANANA</toolOutput>",
	]);
	const write: BackgroundNotice = { sessionId: "s", kind: "task", tool: "write_file", target: "/tmp/a", title: "Write", output: "" };
	assert.match(backgroundItemText(write, { expanded: true, keyHint }, tagTheme), /<muted>write_file \/tmp\/a<\/muted>/);
	const note: BackgroundNotice = { sessionId: "s", kind: "message", title: "Note", output: "" };
	assert.equal(backgroundItemText(note, { expanded: true, keyHint }, tagTheme), "<success>✓</success> <toolTitle>*agy message*</toolTitle> <accent>Note</accent>");
});

test("one card per message: padded custom-message background", () => {
	const ok = text(renderBackgroundCard(message([task]), opts(false), bgTheme)).split("\n");
	assert.ok(ok.every((line) => line.startsWith("[customMessageBg]")), "custom-message background on every row, padding included");
	assert.ok(ok[0]!.replace("[customMessageBg]", "").trim() === "", "vertical padding");
	const both = text(renderBackgroundCard(message([task, { ...task, workId: "bg2", exitCode: 1, output: "boom" }]), opts(false), bgTheme));
	assert.ok(both.split("\n").every((line) => line.startsWith("[customMessageBg]")));
	assert.ok(both.indexOf("exit 0") < both.indexOf("exit 1"), "items in message order");
	assert.equal(renderBackgroundCard(message([]), opts(false), bgTheme), undefined);
});

test("left click toggles one card, also on its padding row; other buttons do nothing", () => {
	const msg = message([task]);
	const card = renderBackgroundCard(msg, opts(false), bgTheme)!;
	assert.ok(!text(card).includes("line 1"));
	assert.equal(click(card, 0, "right"), undefined);
	assert.deepEqual(click(card, 0), { handled: true });
	assert.ok(text(card).includes("line 1"));
	assert.ok(text(card).includes("log: /tmp/task-4.log"));
	click(card, 3);
	assert.ok(!text(card).includes("line 1"));
	assert.ok(!text(renderBackgroundCard(message([task]), opts(false), bgTheme)).includes("line 1"), "another message is untouched");
});

test("a click survives re-renders until the global expand state changes", () => {
	const msg = message([task]);
	click(renderBackgroundCard(msg, opts(false), bgTheme)!, 0);
	assert.ok(text(renderBackgroundCard(msg, opts(false), bgTheme)).includes("line 1"), "pi rebuilt the card: the click holds");
	assert.ok(text(renderBackgroundCard(msg, opts(true), bgTheme)).includes("line 1"));
	assert.ok(!text(renderBackgroundCard(msg, opts(false), bgTheme)).includes("line 1"), "ctrl+o reset the click");
});
