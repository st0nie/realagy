import assert from "node:assert/strict";
import { test } from "vitest";
import {
	decodeProtoFields,
	encodeVarint,
	protoTextAt,
	removeProtoFields,
	setProtoText,
} from "../src/acp/trajectory-proto.js";

const bytes = (...values: number[]) => Buffer.from(values);
const field = (number: number, value: Buffer) => Buffer.concat([encodeVarint(number * 8 + 2), encodeVarint(value.length), value]);

test("nested text edits preserve unknown fields and allow length changes", () => {
	const unknown = Buffer.from([
		0x08, 0x96, 0x01, // field 1, varint 150
		0x1d, 1, 2, 3, 4, // field 3, fixed32
		0x21, 1, 2, 3, 4, 5, 6, 7, 8, // field 4, fixed64
	]);
	const child = Buffer.concat([unknown, field(5, Buffer.from("short"))]);
	const parent = Buffer.concat([field(7, child), field(2, Buffer.from("tail"))]);

	const edited = setProtoText(parent, [7, 5], "a considerably longer value");
	assert.equal(protoTextAt(edited, [7, 5]), "a considerably longer value");
	assert.equal(protoTextAt(edited, [2]), "tail");
	const nested = decodeProtoFields(edited).find((item) => item.number === 7)!;
	const childAfter = edited.subarray(nested.valueStart, nested.valueEnd);
	assert.deepEqual([...decodeProtoFields(childAfter).map((item) => [item.number, item.wire])], [[1, 0], [3, 5], [4, 1], [5, 2]]);
	assert.ok(childAfter.includes(unknown.subarray(0, unknown.length)));
});

test("a text edit canonicalizes only the addressed length prefixes", () => {
	// Non-minimal but legal length prefix: the editor must preserve all unrelated bytes.
	const child = Buffer.concat([field(1, Buffer.from("before")), bytes(0x20, 0x01)]);
	const parent = Buffer.concat([bytes(0x0a, child.length | 0x80, 0x00), child, bytes(0x18, 0x07)]);
	const edited = setProtoText(parent, [1, 1], "after");
	assert.equal(protoTextAt(edited, [1, 1]), "after");
	assert.deepEqual(edited.subarray(-2), bytes(0x18, 0x07));
	assert.ok(edited.includes(bytes(0x20, 0x01)));
});

test("repeated media removal preserves all other fields and ordering", () => {
	const child = Buffer.concat([
		field(1, Buffer.from("keep-before")),
		field(9, Buffer.from("image-a")),
		field(2, Buffer.from("keep-middle")),
		field(9, Buffer.from("image-b")),
		field(1, Buffer.from("keep-after")),
	]);
	const parent = field(4, child);
	const edited = removeProtoFields(parent, [4, 9]);
	const editedChild = decodeProtoFields(edited)[0]!;
	const childData = edited.subarray(editedChild.valueStart, editedChild.valueEnd);
	const kept = decodeProtoFields(childData)
		.filter((item) => item.number === 1)
		.map((item) => childData.subarray(item.valueStart, item.valueEnd).toString());
	assert.deepEqual(kept, ["keep-before", "keep-after"]);
	assert.equal(protoTextAt(edited, [4, 2]), "keep-middle");
	assert.equal(decodeProtoFields(edited).length, 1);
	assert.ok(!edited.includes(Buffer.from("image-a")));
	assert.ok(!edited.includes(Buffer.from("image-b")));
	assert.equal(removeProtoFields(parent, [4, 8]).toString("base64"), parent.toString("base64"));
});

test("ambiguous, missing, and malformed schema paths fail explicitly", () => {
	const repeated = Buffer.concat([field(3, Buffer.from("a")), field(3, Buffer.from("b"))]);
	assert.throws(() => protoTextAt(repeated, [3]), /Expected one protobuf field 3, found 2/);
	assert.throws(() => setProtoText(repeated, [4], "x"), /Expected one protobuf field 4, found 0/);
	assert.throws(() => decodeProtoFields(bytes(0x0a, 0x05, 0x01)), /Truncated protobuf field/);
	assert.throws(() => decodeProtoFields(bytes(0x00)), /Invalid protobuf field number/);
	assert.throws(() => decodeProtoFields(bytes(0x0b)), /Unsupported protobuf wire type 3/);
});
