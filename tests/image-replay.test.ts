import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { freshInput, IMAGE_ONLY_PROMPT, MAX_REPLAY_IMAGE_BYTES, MAX_REPLAY_IMAGES, planTurn, warmAfterTurn } from "../src/transcript.js";

const image = (value: string) => ({ type: "image" as const, data: Buffer.from(value).toString("base64"), mimeType: "image/png" });
const user = (text: string, ...images: ReturnType<typeof image>[]): Message => ({ role: "user", content: [{ type: "text", text }, ...images], timestamp: 1 });
const assistant = (text: string): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }], api: "agy-bridge", provider: "antigravity", model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: 2,
});
const tool = (text: string, ...images: ReturnType<typeof image>[]): Message => ({
	role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text }, ...images], isError: false, timestamp: 3,
});
const ctx = (messages: Message[]) => ({ messages }) as unknown as TranscriptContext;
const injected = (label: string): Message => user(`[pi-lens automated check — not a user request] ${label}`);

test("fresh input retains current images when separate ephemeral messages follow", () => {
	const img = image("live");
	const input = freshInput(ctx([user("describe", img), injected("one"), injected("two")]));
	assert.deepEqual(input.images, [{ data: img.data, mimeType: img.mimeType }]);
	assert.ok(!input.prompt.includes("<pi_history>"));
	assert.equal(input.prompt.match(/not a user request/g)?.length, 2);
	assert.match(input.prompt, /^describe/);
});

test("replay associates ordered user, tool and current images, without rewriting literal text", () => {
	const [a, b, c, d] = [image("a"), image("b"), image("c"), image("d")];
	const input = freshInput(ctx([user("first [Attached image 1]", a, b), assistant("reading"), tool("tool result", c), user("new", d)]));
	assert.deepEqual(input.images.map((block) => block.data), [a.data, b.data, c.data, d.data]);
	assert.match(input.prompt, /first \[Attached image 1\]\n\[Attached image 1\]\n\[Attached image 2\]/);
	assert.match(input.prompt, /tool result\n\[Attached image 3\]/);
	assert.match(input.prompt, /Current input images: \[Attached image 4\]/);
});

test("a no-text current image keeps its image-only instruction", () => {
	const img = image("live");
	const input = freshInput(ctx([{ role: "user", content: [img], timestamp: 1 }]));
	assert.equal(input.prompt, IMAGE_ONLY_PROMPT);
	assert.equal(input.images.length, 1);
});

test("history text trimming also removes images from omitted messages", () => {
	const old = image("old");
	const recent = image("recent");
	const input = freshInput(ctx([user("X".repeat(3000), old), assistant("done"), tool("recent", recent), user("question")]), 700);
	assert.deepEqual(input.images.map((block) => block.data), [recent.data]);
	assert.match(input.prompt, /history messages omitted/);
	assert.ok(!input.prompt.includes("X".repeat(100)));
	assert.match(input.prompt, /recent\n\[Attached image 1\]/);
});

test("truncated newest tool result explicitly omits its images", () => {
	const input = freshInput(ctx([tool("X".repeat(4000), image("tool")), user("question")]), 1600);
	assert.equal(input.images.length, 0);
	assert.match(input.prompt, /Images omitted: truncated tool result/);
	assert.match(input.prompt, /Earlier content omitted/);
});

test("history image count limit favors newest images and leaves live images unaffected", () => {
	const historical = Array.from({ length: MAX_REPLAY_IMAGES + 2 }, (_, i) => image(`history-${i}`));
	const live = image("live");
	const input = freshInput(ctx([user("old", ...historical), assistant("ok"), user("new", live)]));
	assert.deepEqual(input.images.map((block) => block.data), [...historical.slice(2).map((block) => block.data), live.data]);
	assert.equal(input.prompt.match(/Image omitted: historical image replay limit/g)?.length, 2);
	assert.match(input.prompt, /Current input images: \[Attached image 21\]/);
});

test("history byte limit skips an oversized image and retains smaller ones", () => {
	const small = image("small");
	const large = { type: "image" as const, data: Buffer.alloc(MAX_REPLAY_IMAGE_BYTES + 1).toString("base64"), mimeType: "image/png" };
	const input = freshInput(ctx([user("old", small, large), assistant("ok"), user("new")]));
	assert.deepEqual(input.images.map((block) => block.data), [small.data]);
	assert.match(input.prompt, /Image omitted: historical image replay limit/);
});

test("warm session sends only new images while its fresh fallback includes history", () => {
	const old = image("old"), current = image("current");
	const first = [user("first", old)];
	const answer = assistant("ok");
	const warm = warmAfterTurn(ctx(first), answer, "session", "/work");
	const plan = planTurn(ctx([...first, answer, user("new", current)]), "/work", warm);
	assert.equal(plan.kind, "warm");
	if (plan.kind !== "warm") return;
	assert.deepEqual(plan.input.images.map((block) => block.data), [current.data]);
	assert.deepEqual(plan.fallback.images.map((block) => block.data), [old.data, current.data]);
});

test("ephemeral input after assistant does not absorb a preceding history message", () => {
	const input = freshInput(ctx([user("old", image("old")), assistant("done"), injected("notice")]));
	assert.match(input.prompt, /<pi_history>[\s\S]*old[\s\S]*done[\s\S]*<\/pi_history>/);
	assert.match(input.prompt, /not a user request/);
	assert.equal(input.images.length, 1);
});
