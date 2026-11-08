import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { optionalProtoBytesAt, protoTextAt, removeProtoFields } from "../src/acp/trajectory-proto.js";
import { synchronizeConversation, TrajectorySyncError } from "../src/acp/trajectory-sync.js";
import { FRESH_PROMPT, syncItemsForMessages, warmItemsForMessages } from "../src/transcript.js";

const temporary: string[] = [];
afterEach(() => {
	for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function encodeVarint(value: number): number[] {
	const out: number[] = [];
	let remaining = value;
	do {
		const byte = remaining & 127;
		remaining = Math.floor(remaining / 128);
		out.push(remaining ? byte | 128 : byte);
	} while (remaining);
	return out;
}
function field(number: number, value: string | Uint8Array): Buffer {
	const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
	return Buffer.concat([Buffer.from(encodeVarint(number * 8 + 2)), Buffer.from(encodeVarint(bytes.length)), bytes]);
}
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
/** agy 1.5.3 user step: 19.2 prompt, 19.3.1 prompt mirror, repeated 19.9 media. */
function userPayload(text: string, images: number | boolean = 0): Buffer {
	const media = Array.from({ length: Number(images) }, (_, i) => field(9, Buffer.concat([field(1, "image/png"), field(5, `/brain/s/.user_uploaded/uploaded_media_${i}.png`), field(2, PNG)])));
	return field(19, Buffer.concat([field(2, text), field(3, field(1, text)), ...media]));
}
function toolUri(i: number): string {
	return `file:///brain/s/.system_generated/steps/2/media_${i}.png`;
}
function renderedResult(text: string): string {
	return `**Arguments**\n\`\`\`json\n{}\n\`\`\`\n\n**Result**\n\`\`\`\n${text}\n\`\`\``;
}
/** agy 1.5.3 Pi-bridge tool step: 140.2.1 text plus one offload line per medium,
 *  optional 140.2.3 rendering mirror, repeated 140.2.4 media. */
function toolMirror(text: string, images = 0): Buffer {
	const resources = Array.from({ length: images }, (_, i) => field(10, field(2, Buffer.concat([field(1, toolUri(i)), field(2, "image/png"), field(3, "read")]))));
	return Buffer.concat([field(5, "Executed"), field(10, field(1, renderedResult(text))), ...resources]);
}
function toolPayload(name: string, text: string, images: number | boolean = 0, mirror = false): Buffer {
	const count = Number(images);
	const lines = Array.from({ length: count }, (_, i) => `[Resource offloaded to ${toolUri(i)}]`);
	const nativeText = count === 0 ? text : text ? `${text}\n${lines.join("\n")}` : lines.join("\n");
	const media = Array.from({ length: count }, (_, i) => field(4, Buffer.concat([field(1, "image/png"), field(5, toolUri(i)), field(2, PNG)])));
	const result = Buffer.concat([field(1, nativeText), ...(mirror ? [field(3, toolMirror(text, count))] : []), ...media]);
	return Buffer.concat([field(5, field(4, field(2, name))), field(140, field(2, result))]);
}
function imageMessage(role: "user" | "toolResult", text: string, images: number): Message {
	const content = [...(text ? [{ type: "text", text }] : []), ...Array.from({ length: images }, (_, i) => ({ type: "image", data: `img${i}`, mimeType: "image/png" }))];
	return role === "user"
		? { role, content, timestamp: 1 } as Message
		: { role, toolCallId: "r1", toolName: "read", content, isError: false, timestamp: 2 } as Message;
}
/** A user turn after realctx dropped its images: the text block plus a separate placeholder block. */
function droppedUser(text: string, placeholder: string): Message {
	return { role: "user", content: [...(text ? [{ type: "text", text }] : []), { type: "text", text: placeholder }], timestamp: 1 } as Message;
}
function storeWithRender(steps: Array<{ type: number; payload: Buffer; render?: Buffer }>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-trajectory-sync-"));
	temporary.push(dir);
	const dbPath = path.join(dir, "conversation.db");
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER, step_payload BLOB NOT NULL, render_info BLOB)");
	const insert = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload, render_info) VALUES (?, ?, 3, ?, ?)");
	steps.forEach((step, idx) => insert.run(idx, step.type, step.payload, step.render ?? null));
	db.close();
	return dbPath;
}
function renderInfo(dbPath: string, idx: number): Buffer | null {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const row = db.prepare("SELECT render_info FROM steps WHERE idx = ?").get(idx) as { render_info: Uint8Array | null };
	db.close();
	return row.render_info ? Buffer.from(row.render_info) : null;
}
function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as Message;
}
function tool(toolCallId: string, toolName: string, text: string): Message {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2 } as Message;
}
function assistant(text = "answer"): Message {
	return { role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: 3 } as unknown as Message;
}
function store(steps: Array<{ type: number; payload: Buffer }>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-trajectory-sync-"));
	temporary.push(dir);
	const dbPath = path.join(dir, "conversation.db");
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_payload BLOB NOT NULL)");
	const insert = db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)");
	steps.forEach((step, idx) => insert.run(idx, step.type, step.payload));
	db.close();
	return dbPath;
}
function rows(dbPath: string): Array<{ idx: number; type: number; payload: Buffer }> {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const rows = db.prepare("SELECT idx, step_type AS type, step_payload AS payload FROM steps ORDER BY idx").all() as unknown as Array<{ idx: number; type: number; payload: Buffer }>;
	db.close();
	return rows.map((row) => ({ ...row, payload: Buffer.from(row.payload) }));
}

describe("native trajectory synchronization", () => {
	it("rewrites a dropped tool result with arbitrary length and no replay", () => {
		const dbPath = store([{ type: 14, payload: userPayload("question") }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "Stored tool value: OLD") }, { type: 15, payload: assistantPayload() }]);
		const result = synchronizeConversation(dbPath, [user("question"), tool("r1", "read", "NEW_WITH_A_MUCH_LONGER_VALUE"), assistant()], warmItemsForMessages([user("question"), tool("r1", "read", "OLD"), assistant()]), false);
		assert.deepEqual(result, { editedSteps: 1, deletedSteps: 0, summary: false });
		assert.equal(protoTextAt(rows(dbPath)[1]!.payload, [140, 2, 1]), "NEW_WITH_A_MUCH_LONGER_VALUE");
	});

	it("preserves a single initial transcript resource when editing a later tool result", () => {
		const wrapped = `Content of pi://transcript:\n<pi-system>\nPolicy\n</pi-system>\n\n<user>\nquestion\n</user>${FRESH_PROMPT}`;
		const previous = [user("question"), tool("r1", "read", "OLD"), assistant()];
		const dbPath = store([{ type: 14, payload: userPayload(wrapped) }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 15, payload: assistantPayload() }]);
		const before = rows(dbPath)[0]!.payload;
		const result = synchronizeConversation(dbPath, [user("question"), tool("r1", "read", "NEW"), assistant()], syncItemsForMessages(previous), false);
		assert.equal(result.editedSteps, 1);
		assert.deepEqual(rows(dbPath)[0]!.payload, before);
		assert.equal(protoTextAt(rows(dbPath)[1]!.payload, [140, 2, 1]), "NEW");
	});

	it("refuses ambiguous multi-message initial resources without writing", () => {
		const wrapped = `Content of pi://transcript:\n<user>\nother\n</user>\n\n<user>\nquestion\n</user>${FRESH_PROMPT}`;
		const dbPath = store([{ type: 14, payload: userPayload(wrapped) }]);
		const before = rows(dbPath);
		assert.throws(() => synchronizeConversation(dbPath, [user("question")], syncItemsForMessages([user("question")]), false), /does not match/);
		assert.deepEqual(rows(dbPath), before);
	});
	it("summarizes a real two-block initial transcript without modifying its continuation block", () => {
		const prefix = "Content of pi://transcript:\n<pi-system>\nPolicy\n</pi-system>\n\n";
		const original = `${prefix}<user>\nquestion\n</user>`;
		const wrapped = original + FRESH_PROMPT;
		const payload = field(19, Buffer.concat([field(2, wrapped), field(3, field(1, original)), field(3, field(1, FRESH_PROMPT))]));
		const previous = [user("question"), tool("r1", "read", "OLD"), assistant()];
		const dbPath = store([{ type: 14, payload }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 15, payload: assistantPayload() }]);
		const summary = user('<realctx-history part="h1">SUMMARY</realctx-history>');
		assert.deepEqual(synchronizeConversation(dbPath, [summary, assistant()], syncItemsForMessages(previous), false), { editedSteps: 1, deletedSteps: 1, summary: true });
		const expected = `${prefix}<user>\n<realctx-history part="h1">SUMMARY</realctx-history>\n</user>`;
		const actual = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(actual, [19, 2]), expected + FRESH_PROMPT);
		assert.ok(Buffer.from(actual).includes(field(3, field(1, expected))));
		assert.ok(Buffer.from(actual).includes(field(3, field(1, FRESH_PROMPT))));
	});
	it("rejects a mismatched repeated initial transcript mirror without writing", () => {
		const original = "Content of pi://transcript:\n<user>\nquestion\n</user>";
		const payload = field(19, Buffer.concat([field(2, original + FRESH_PROMPT), field(3, field(1, original)), field(3, field(1, "unexpected"))]));
		const previous = [user("question"), tool("r1", "read", "OLD"), assistant()];
		const dbPath = store([{ type: 14, payload }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 15, payload: assistantPayload() }]);
		const before = rows(dbPath);
		const summary = user('<realctx-history part="h1">SUMMARY</realctx-history>');
		assert.throws(() => synchronizeConversation(dbPath, [summary, assistant()], syncItemsForMessages(previous), false), /do not uniquely match/);
		assert.deepEqual(rows(dbPath), before);
	});
	it("replaces a verified wrapped initial user with a summary while retaining the system header", () => {
		const prefix = "Content of pi://transcript:\n<pi-system>\nPolicy\n</pi-system>\n\n";
		const wrapped = `${prefix}<user>\nquestion\n</user>${FRESH_PROMPT}`;
		const previous = [user("question"), tool("r1", "read", "OLD"), assistant()];
		const dbPath = store([{ type: 14, payload: userPayload(wrapped) }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 15, payload: assistantPayload() }]);
		const summary = user('<realctx-history part="h1">SUMMARY</realctx-history>');
		const result = synchronizeConversation(dbPath, [summary, assistant()], syncItemsForMessages(previous), false);
		assert.deepEqual(result, { editedSteps: 1, deletedSteps: 1, summary: true });
		const expected = `${prefix}<user>\n<realctx-history part="h1">SUMMARY</realctx-history>\n</user>${FRESH_PROMPT}`;
		assert.equal(protoTextAt(rows(dbPath)[0]!.payload, [19, 2]), expected);
		assert.equal(protoTextAt(rows(dbPath)[0]!.payload, [19, 3, 1]), expected);
	});
	it("refuses to rewrite a tool result with an unverified native mirror", () => {
		const mirroredResult = field(140, field(2, Buffer.concat([field(1, "OLD"), field(3, field(10, field(1, "Result: OLD")))])));
		const dbPath = store([{ type: 132, payload: Buffer.concat([field(5, field(4, field(2, "mcp_pi-bridge_read"))), mirroredResult]) }]);
		const before = rows(dbPath);
		assert.throws(() => synchronizeConversation(dbPath, [tool("r1", "read", "NEW")], syncItemsForMessages([tool("r1", "read", "OLD")]), false), /unverified result mirror/);
		assert.deepEqual(rows(dbPath), before);
	});
	it("retains an unchanged tool-result mirror", () => {
		const result = field(140, field(2, Buffer.concat([field(1, "OLD"), field(3, field(10, field(1, "Result: OLD")))])));
		const dbPath = store([{ type: 132, payload: Buffer.concat([field(5, field(4, field(2, "mcp_pi-bridge_read"))), result]) }]);
		const before = rows(dbPath);
		assert.deepEqual(synchronizeConversation(dbPath, [tool("r1", "read", "OLD")], syncItemsForMessages([tool("r1", "read", "OLD")]), false), { editedSteps: 0, deletedSteps: 0, summary: false });
		assert.deepEqual(rows(dbPath), before);
	});
	it("preserves an unchanged native tool-result prefix byte-for-byte", () => {
		const dbPath = store([{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "Stored tool value: OLD") }]);
		const before = rows(dbPath);
		assert.deepEqual(synchronizeConversation(dbPath, [tool("r1", "read", "OLD")], syncItemsForMessages([tool("r1", "read", "OLD")]), false), { editedSteps: 0, deletedSteps: 0, summary: false });
		assert.deepEqual(rows(dbPath), before);
	});
	it("maps a newly completed mid-turn tool result without treating it as user input", () => {
		const dbPath = store([{ type: 14, payload: userPayload("question") }, { type: 15, payload: assistantPayload() }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "Stored tool value: RESULT") }]);
		const result = synchronizeConversation(dbPath, [user("question"), assistant(), tool("r1", "read", "RESULT")], warmItemsForMessages([user("question"), assistant()]), false);
		assert.equal(result.editedSteps, 1);
		assert.equal(rows(dbPath).length, 3);
	});
	it("discards the cancelled generation after a mid-turn sync, keeping the completed tool result", () => {
		const executing = Buffer.concat([field(5, field(4, field(2, "mcp_pi-bridge_read")))]);
		const steps = [
			{ type: 14, payload: userPayload("question") },
			{ type: 15, payload: assistantPayload() },
			{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") },
			{ type: 101, payload: Buffer.from(field(1, "bookkeeping")) },
			{ type: 15, payload: assistantPayload() },
			{ type: 132, payload: executing },
		];
		const messages = [user("question"), assistant(), tool("r1", "read", "SYNCED")];
		const previous = warmItemsForMessages([user("question"), assistant()]);
		const dbPath = store(steps);
		const before = rows(dbPath);
		assert.throws(() => synchronizeConversation(dbPath, messages, previous, false), /Native step 4 is not represented/);
		assert.deepEqual(rows(dbPath), before);
		const result = synchronizeConversation(dbPath, messages, previous, false, { discardCancelledTail: true });
		assert.deepEqual(result, { editedSteps: 1, deletedSteps: 2, summary: false });
		const after = rows(dbPath);
		assert.deepEqual(after.map((row) => row.idx), [0, 1, 2, 3]);
		assert.equal(protoTextAt(after[2]!.payload, [140, 2, 1]), "SYNCED");
	});

	it("never discards a trailing user step, even for a cancelled generation", () => {
		const dbPath = store([
			{ type: 14, payload: userPayload("question") },
			{ type: 15, payload: assistantPayload() },
			{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") },
			{ type: 15, payload: assistantPayload() },
			{ type: 14, payload: userPayload("unseen") },
		]);
		const before = rows(dbPath);
		assert.throws(() => synchronizeConversation(dbPath, [user("question"), assistant(), tool("r1", "read", "NEW")], warmItemsForMessages([user("question"), assistant()]), false, { discardCancelledTail: true }), /Native step 4 is not represented/);
		assert.deepEqual(rows(dbPath), before);
	});

	it("explains a pending native tool step whose pi result was never recorded", () => {
		const dbPath = store([
			{ type: 14, payload: userPayload("question") },
			{ type: 15, payload: assistantPayload() },
			{ type: 132, payload: Buffer.concat([field(5, field(4, field(2, "mcp_pi-bridge_read")))]) },
		]);
		const before = rows(dbPath);
		assert.throws(() => synchronizeConversation(dbPath, [user("question"), assistant(), tool("r1", "read", "NEW")], warmItemsForMessages([user("question"), assistant()]), false, { discardCancelledTail: true }), /Native tool step 2 has no recorded result.*never reached agy/);
		assert.deepEqual(rows(dbPath), before);
	});

	it("removes native tool-image media when realctx drops it", () => {
		const dbPath = store([{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "Stored tool value: OLD", true) }]);
		synchronizeConversation(dbPath, [tool("r1", "read", "[#2 dropped · read image · binary]")], [{ ...warmItemsForMessages([tool("r1", "read", "OLD")])[0]!, syncMediaHash: "image-hash" }], false);
		const payload = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(payload, [140, 2, 1]), "[#2 dropped · read image · binary]");
		assert.notEqual(optionalProtoBytesAt(toolPayload("read", "OLD", true), [140, 2, 4]), undefined, "fixture initially has media");
		assert.equal(optionalProtoBytesAt(payload, [140, 2, 4]), undefined);
		assert.ok(removeProtoFields(payload, [140, 2, 4]).equals(payload), "sync removed the media field");
	});

	it("removes native user-image media for a realctx image-drop placeholder", () => {
		const dbPath = store([{ type: 14, payload: userPayload("look", true) }]);
		synchronizeConversation(dbPath, [droppedUser("look", "[#0 dropped · user image · 1.0k tok]")], syncItemsForMessages([imageMessage("user", "look", 1)]), false);
		const payload = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(payload, [19, 2]), "look\n[#0 dropped · user image · 1.0k tok]");
		assert.notEqual(optionalProtoBytesAt(userPayload("look", true), [19, 9]), undefined, "fixture initially has media");
		assert.equal(optionalProtoBytesAt(payload, [19, 9]), undefined);
		assert.equal(protoTextAt(payload, [19, 3, 1]), "look\n[#0 dropped · user image · 1.0k tok]");
		assert.ok(removeProtoFields(payload, [19, 9]).equals(payload), "sync removed the media field");
	});

	it("drops every user image and edits the image-only native prompt", () => {
		const previous = [imageMessage("user", "Two pictures.", 2), imageMessage("user", "", 1), assistant()];
		const dbPath = storeWithRender([{ type: 14, payload: userPayload("Two pictures.", 2) }, { type: 14, payload: userPayload("See the attached images.", 1) }, { type: 15, payload: assistantPayload() }]);
		const effective = [droppedUser("Two pictures.", "[#3 dropped · 2 user images · 3.2k tok]"), droppedUser("", "[#4 dropped · user image · 1.6k tok]"), assistant()];
		const result = synchronizeConversation(dbPath, effective, syncItemsForMessages(previous), false);
		assert.equal(result.editedSteps, 2);
		const [first, second] = rows(dbPath);
		assert.equal(optionalProtoBytesAt(first!.payload, [19, 2])?.toString(), "Two pictures.\n[#3 dropped · 2 user images · 3.2k tok]");
		assert.equal(protoTextAt(first!.payload, [19, 3, 1]), "Two pictures.\n[#3 dropped · 2 user images · 3.2k tok]");
		assert.ok(removeProtoFields(first!.payload, [19, 9]).equals(first!.payload));
		assert.equal(protoTextAt(second!.payload, [19, 2]), "[#4 dropped · user image · 1.6k tok]");
		assert.ok(removeProtoFields(second!.payload, [19, 9]).equals(second!.payload));
	});

	it("maps an unchanged image-only user prompt", () => {
		const previous = [imageMessage("user", "", 1), assistant(), user("next"), tool("r1", "read", "OLD")];
		const dbPath = store([{ type: 14, payload: userPayload("See the attached images.", 1) }, { type: 15, payload: assistantPayload() }, { type: 14, payload: userPayload("next") }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }]);
		const before = rows(dbPath)[0]!.payload;
		synchronizeConversation(dbPath, [...previous.slice(0, 3), tool("r1", "read", "NEW")], syncItemsForMessages(previous), false);
		assert.ok(rows(dbPath)[0]!.payload.equals(before), "image-only user step is untouched");
		assert.equal(protoTextAt(rows(dbPath)[3]!.payload, [140, 2, 1]), "NEW");
	});

	it("rewrites a verified text-only tool mirror and its render_info copy", () => {
		const payload = toolPayload("mcp_pi-bridge_read", "OLD", 0, true);
		const dbPath = storeWithRender([{ type: 132, payload, render: optionalProtoBytesAt(payload, [140, 2, 3]) }]);
		synchronizeConversation(dbPath, [tool("r1", "read", "NEW")], syncItemsForMessages([tool("r1", "read", "OLD")]), false);
		const edited = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(edited, [140, 2, 1]), "NEW");
		assert.equal(protoTextAt(edited, [140, 2, 3, 10, 1]), renderedResult("NEW"));
		assert.equal(protoTextAt(edited, [140, 2, 3, 5]), "Executed", "other mirror fields are preserved");
		assert.ok(renderInfo(dbPath, 0)!.equals(optionalProtoBytesAt(edited, [140, 2, 3])!));
	});

	it("drops tool images from the result, offload lines, mirror resources and render_info", () => {
		const payload = toolPayload("mcp_pi-bridge_read", "shot\nTAIL", 2, true);
		const dbPath = storeWithRender([{ type: 132, payload, render: optionalProtoBytesAt(payload, [140, 2, 3]) }]);
		const placeholder = "[#2 dropped · read shot.png · 3.2k tok · 2 images]";
		const result = synchronizeConversation(dbPath, [tool("r1", "read", placeholder)], syncItemsForMessages([imageMessage("toolResult", "shot\nTAIL", 2)]), false);
		assert.equal(result.editedSteps, 1);
		const edited = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(edited, [140, 2, 1]), placeholder);
		assert.ok(removeProtoFields(edited, [140, 2, 4]).equals(edited), "media removed");
		const mirror = optionalProtoBytesAt(edited, [140, 2, 3])!;
		assert.equal(protoTextAt(mirror, [10, 1]), renderedResult(placeholder), "only the text part remains");
		assert.ok(!edited.toString("latin1").includes("offloaded") && !edited.toString("latin1").includes("media_"), "no media reference survives");
		assert.ok(renderInfo(dbPath, 0)!.equals(mirror));
	});

	it("drops an image-only tool result", () => {
		const payload = toolPayload("mcp_pi-bridge_read", "", 1, true);
		const dbPath = storeWithRender([{ type: 132, payload, render: optionalProtoBytesAt(payload, [140, 2, 3]) }]);
		synchronizeConversation(dbPath, [tool("r1", "read", "[#2 dropped · read a.png · 1.6k tok · image]")], syncItemsForMessages([imageMessage("toolResult", "", 1)]), false);
		const edited = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(edited, [140, 2, 1]), "[#2 dropped · read a.png · 1.6k tok · image]");
		assert.ok(removeProtoFields(edited, [140, 2, 4]).equals(edited));
	});

	it("keeps retained tool media when only the text changes", () => {
		const payload = toolPayload("mcp_pi-bridge_read", "OLD", 1, true);
		const dbPath = storeWithRender([{ type: 132, payload, render: optionalProtoBytesAt(payload, [140, 2, 3]) }]);
		synchronizeConversation(dbPath, [imageMessage("toolResult", "NEW", 1)], syncItemsForMessages([imageMessage("toolResult", "OLD", 1)]), false);
		const edited = rows(dbPath)[0]!.payload;
		assert.equal(protoTextAt(edited, [140, 2, 1]), `NEW\n[Resource offloaded to ${toolUri(0)}]`);
		assert.notEqual(optionalProtoBytesAt(edited, [140, 2, 4]), undefined);
		assert.equal(protoTextAt(optionalProtoBytesAt(edited, [140, 2, 3])!, [5]), "Executed");
		assert.ok(edited.toString("latin1").includes(renderedResult("NEW")));
	});

	it("fails closed when tool offload lines do not name the stored media", () => {
		const good = toolPayload("mcp_pi-bridge_read", "OLD", 1);
		const bad = Buffer.from(good.toString("latin1").replace("media_0.png]", "media_9.png]"), "latin1");
		const dbPath = store([{ type: 132, payload: bad }]);
		assert.throws(() => synchronizeConversation(dbPath, [tool("r1", "read", "[#2 dropped]")], syncItemsForMessages([imageMessage("toolResult", "OLD", 1)]), false), /unverified media layout/);
		assert.ok(rows(dbPath)[0]!.payload.equals(bad), "database is unchanged");
	});

	it("fails closed when a dropped user image has no verified native media", () => {
		const dbPath = store([{ type: 14, payload: userPayload("look") }]);
		assert.throws(() => synchronizeConversation(dbPath, [droppedUser("look", "[#0 dropped · user image · 1.0k tok]")], syncItemsForMessages([imageMessage("user", "look", 1)]), false), /unverified media layout/);
	});

	it("replaces the native prefix covered by a history summary", () => {
		const dbPath = store([{ type: 14, payload: userPayload("old question") }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "Stored tool value: OLD") }, { type: 15, payload: assistantPayload() }]);
		const summary = user('<realctx-history part="h1">SUMMARY_NATIVE_PREFIX</realctx-history>');
		const result = synchronizeConversation(dbPath, [summary, assistant()], warmItemsForMessages([user("old question"), tool("r1", "read", "OLD"), assistant()]), false);
		assert.deepEqual(result, { editedSteps: 1, deletedSteps: 1, summary: true });
		const remaining = rows(dbPath);
		assert.deepEqual(remaining.map((row) => row.idx), [0, 2]);
		assert.equal(protoTextAt(remaining[0]!.payload, [19, 2]), '<realctx-history part="h1">SUMMARY_NATIVE_PREFIX</realctx-history>');
	});

	it("keeps a user turn whose multiple images were dropped in the suffix after a summary", () => {
		const previous = [user("old question"), assistant(), imageMessage("user", "look", 2), assistant()];
		const dbPath = store([{ type: 14, payload: userPayload("old question") }, { type: 15, payload: assistantPayload() }, { type: 14, payload: userPayload("look", 2) }, { type: 15, payload: assistantPayload() }]);
		const summary = user('<realctx-history part="h1">SUMMARY</realctx-history>');
		const effective = [summary, droppedUser("look", "[#5 dropped · 2 user images · 3.2k tok]"), assistant()];
		const result = synchronizeConversation(dbPath, effective, syncItemsForMessages(previous), false);
		assert.deepEqual(result, { editedSteps: 2, deletedSteps: 1, summary: true });
		const remaining = rows(dbPath);
		assert.deepEqual(remaining.map((row) => row.idx), [0, 2, 3]);
		assert.ok(removeProtoFields(remaining[1]!.payload, [19, 9]).equals(remaining[1]!.payload), "user media removed");
		assert.match(protoTextAt(remaining[1]!.payload, [19, 2]), /^look\n\[#5 dropped · 2 user images/);
	});

	it("fails closed without writes when native tool identity is ambiguous", () => {
		const dbPath = store([{ type: 132, payload: toolPayload("mcp_pi-bridge_other", "Stored tool value: OLD") }]);
		const before = rows(dbPath)[0]!.payload;
		assert.throws(() => synchronizeConversation(dbPath, [tool("r1", "read", "NEW")], warmItemsForMessages([tool("r1", "read", "OLD")]), false), TrajectorySyncError);
		assert.deepEqual(rows(dbPath)[0]!.payload, before);
	});

	it("supports consecutive summary replacements and preserves every retained suffix step", () => {
		const original = [user("old"), tool("r1", "read", "OLD"), assistant("first"), user("retained question"), assistant("retained answer")];
		const dbPath = store([
			{ type: 14, payload: userPayload("old") },
			{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "Stored tool value: OLD") },
			{ type: 15, payload: assistantPayload() },
			{ type: 14, payload: userPayload("retained question") },
			{ type: 15, payload: assistantPayload() },
		]);
		const retained = rows(dbPath).slice(3);
		const first = [user('<realctx-history part="h1">FIRST SUMMARY</realctx-history>'), ...original.slice(2)];
		synchronizeConversation(dbPath, first, syncItemsForMessages(original), false);
		const second = [user('<realctx-history part="h2">SECOND SUMMARY</realctx-history>'), ...original.slice(3)];
		const result = synchronizeConversation(dbPath, second, syncItemsForMessages(first), false);
		assert.deepEqual(result, { editedSteps: 1, deletedSteps: 1, summary: true });
		assert.deepEqual(rows(dbPath).map((row) => row.idx), [0, 3, 4]);
		assert.deepEqual(rows(dbPath).slice(1), retained);
		assert.equal(protoTextAt(rows(dbPath)[0]!.payload, [19, 3, 1]), '<realctx-history part="h2">SECOND SUMMARY</realctx-history>');
	});

	it("filters system and ephemeral messages from the native history mapping", () => {
		const before = [user("question"), tool("r1", "read", "OLD"), assistant()];
		const dbPath = store([{ type: 14, payload: userPayload("question") }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 15, payload: assistantPayload() }]);
		const system = { role: "system", content: "system instructions" } as Message;
		const result = synchronizeConversation(dbPath, [system, user("[pi-lens automated context — not a user request]\ntransient"), user("question"), tool("r1", "read", "NEW"), assistant()], syncItemsForMessages(before), false);
		assert.equal(result.editedSteps, 1);
		assert.equal(protoTextAt(rows(dbPath)[1]!.payload, [140, 2, 1]), "NEW");
	});

	it("applies a Pi compaction summary and a drop in its retained suffix in one sync", () => {
		const compaction = (text: string) => user(`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${text}\n</summary>`);
		const original = [user("old question"), tool("r0", "read", "OLD0"), assistant(), user("kept question"), tool("r1", "read", "KEPT_OLD"), assistant()];
		const dbPath = store([
			{ type: 14, payload: userPayload("old question") },
			{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD0") },
			{ type: 15, payload: assistantPayload() },
			{ type: 14, payload: userPayload("kept question") },
			{ type: 132, payload: toolPayload("mcp_pi-bridge_read", "KEPT_OLD") },
			{ type: 15, payload: assistantPayload() },
		]);
		const first = [compaction("PI COMPACTION"), user("kept question"), tool("r1", "read", "[#5 dropped · read · 1k tok]"), assistant()];
		assert.deepEqual(synchronizeConversation(dbPath, first, syncItemsForMessages(original), false), { editedSteps: 2, deletedSteps: 2, summary: true });
		assert.deepEqual(rows(dbPath).map((row) => row.idx), [0, 3, 4, 5]);
		assert.match(protoTextAt(rows(dbPath)[0]!.payload, [19, 2]), /PI COMPACTION/);
		assert.equal(protoTextAt(rows(dbPath)[2]!.payload, [140, 2, 1]), "[#5 dropped · read · 1k tok]");
		// A later Pi compaction replaces the first summary and its covered steps again.
		const second = [compaction("SECOND PI COMPACTION"), assistant()];
		assert.deepEqual(synchronizeConversation(dbPath, second, syncItemsForMessages(first), false), { editedSteps: 1, deletedSteps: 2, summary: true });
		assert.deepEqual(rows(dbPath).map((row) => row.idx), [0, 5]);
		assert.match(protoTextAt(rows(dbPath)[0]!.payload, [19, 3, 1]), /SECOND PI COMPACTION/);
		assert.doesNotMatch(Buffer.concat(rows(dbPath).map((row) => row.payload)).toString("latin1"), /OLD0|KEPT_OLD|kept question/);
	});

	it("rolls back all edits when SQLite fails partway through a summary update", () => {
		const before = [user("old"), tool("r1", "read", "OLD"), assistant()];
		const dbPath = store([{ type: 14, payload: userPayload("old") }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 15, payload: assistantPayload() }]);
		const original = rows(dbPath);
		const db = new DatabaseSync(dbPath);
		db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON steps BEGIN SELECT RAISE(ABORT, 'test disk failure'); END");
		db.close();
		assert.throws(() => synchronizeConversation(dbPath, [user('<realctx-history part="h1">SUMMARY</realctx-history>'), assistant()], syncItemsForMessages(before), false), /test disk failure/);
		assert.deepEqual(rows(dbPath), original);
	});

	it("refuses stale or unmapped native history without applying partial edits", () => {
		const dbPath = store([{ type: 14, payload: userPayload("question") }, { type: 132, payload: toolPayload("mcp_pi-bridge_read", "OLD") }, { type: 14, payload: userPayload("not in Pi") }]);
		const original = rows(dbPath);
		assert.throws(() => synchronizeConversation(dbPath, [user("question"), tool("r1", "read", "NEW")], syncItemsForMessages([user("question"), tool("r1", "read", "OLD")]), false), /not represented/);
		assert.deepEqual(rows(dbPath), original);
	});
});

function assistantPayload(): Buffer {
	return Buffer.from([8, 1]);
}
