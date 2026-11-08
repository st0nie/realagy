import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { deriveAgyNativeContinuation, patchAgyNativeContinuation } from "../src/acp/continuation-patch.js";

const SIGNATURE = 0x1100;
const SEGMENT_OFFSET = 0x1000;
const SEGMENT_VADDR = 0x400000;
const SEGMENT_SIZE = 0x1000;
const SECOND = SIGNATURE + 3 + 0xcf;
const THIRD = SECOND + 0x11;

function fixture(): Buffer {
	const data = Buffer.alloc(0x2000);
	data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	data.writeUInt16LE(3, 16);
	data.writeUInt16LE(62, 18);
	data.writeBigUInt64LE(64n, 32);
	data.writeUInt16LE(56, 54);
	data.writeUInt16LE(1, 56);
	data.writeUInt32LE(1, 64);
	data.writeUInt32LE(5, 68);
	data.writeBigUInt64LE(BigInt(SEGMENT_OFFSET), 72);
	data.writeBigUInt64LE(BigInt(SEGMENT_VADDR), 80);
	data.writeBigUInt64LE(BigInt(SEGMENT_SIZE), 96);
	data.writeBigUInt64LE(BigInt(SEGMENT_SIZE), 104);
	data.set(Buffer.from([0x48, 0x85, 0xf6, 0x0f, 0x85, 0x20, 0, 0, 0]), SIGNATURE);
	data.set(Buffer.from([0x48, 0x8b, 0x94, 0x24, 0x78, 0x02, 0, 0]), SIGNATURE + 9);
	data.set(Buffer.from([0x48, 0x85, 0xf6, 0x0f, 0x84, 0x20, 0, 0, 0]), SECOND);
	data.set(Buffer.from([0x48, 0x85, 0xd2, 0x0f, 0x84, 0x20, 0, 0, 0]), THIRD);
	return data;
}

const address = (offset: number): number => SEGMENT_VADDR + offset - SEGMENT_OFFSET;
const branchTarget = (data: Buffer, opcode: number): number => address(opcode) + 6 + data.readInt32LE(opcode + 2);
const jumpTarget = (data: Buffer, opcode: number): number => address(opcode) + 5 + data.readInt32LE(opcode + 1);

test("native continuation preserves ordinary prompt branches and changes only empty admission", () => {
	const source = fixture();
	const original = Buffer.from(source);
	const originalQuestionTarget = branchTarget(source, THIRD + 3);
	const patched = patchAgyNativeContinuation(source);
	assert.deepEqual(source, original, "the source buffer is not mutated");
	assert.equal(patched.format, "elf");
	assert.equal(patched.arch, "x64");
	assert.equal(patched.data[SIGNATURE + 3], 0xe9);
	assert.equal(jumpTarget(patched.data, SIGNATURE + 3), address(SECOND));
	assert.equal(patched.data[SIGNATURE + 8], 0x90);
	assert.equal(patched.data.readInt32LE(SECOND + 5), 0, "empty input enters the existing native body");
	assert.equal(patched.data[THIRD + 2], 0xf6, "the question guard tests the prompt, not a nil question pointer");
	assert.equal(branchTarget(patched.data, THIRD + 3), originalQuestionTarget);
});

test("continuation signature matching is unique and confined to executable x64 code", () => {
	assert.throws(() => patchAgyNativeContinuation(Buffer.alloc(128)), /expected ELF, PE32\+/);
	const missing = fixture();
	missing.fill(0, SIGNATURE, THIRD + 9);
	assert.throws(() => patchAgyNativeContinuation(missing), /found 0/);
	const ambiguous = fixture();
	ambiguous.set(ambiguous.subarray(SIGNATURE, THIRD + 9), SIGNATURE + 0x200);
	assert.throws(() => patchAgyNativeContinuation(ambiguous), /ambiguous/);
	const nonExecutable = fixture();
	nonExecutable.writeUInt32LE(4, 68);
	assert.throws(() => patchAgyNativeContinuation(nonExecutable), /no executable instruction region/);
});

test("continuation derivation is source-hash cached and leaves the source untouched", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-continuation-test-"));
	const sourcePath = path.join(root, "agy");
	const cacheDir = path.join(root, "derived");
	const source = fixture();
	fs.writeFileSync(sourcePath, source);
	const first = await deriveAgyNativeContinuation(sourcePath, { cacheDir });
	const second = await deriveAgyNativeContinuation(sourcePath, { cacheDir });
	assert.equal(first, second);
	assert.equal(path.basename(first), `agy-${crypto.createHash("sha256").update(source).digest("hex")}-native-continuation`);
	assert.deepEqual(fs.readFileSync(sourcePath), source);
	assert.ok(fs.statSync(first).mode & 0o111);
	fs.writeFileSync(sourcePath, Buffer.alloc(0x2000));
	await assert.rejects(deriveAgyNativeContinuation(sourcePath, { cacheDir }), /expected ELF|found 0/);
	assert.deepEqual(fs.readFileSync(first), patchAgyNativeContinuation(source).data, "an invalid update cannot replace the prior cached binary");
});

// agy 1.5.3 darwin-arm64 prompt admission, relocated into a minimal Mach-O.
const ARM_TEXT_OFFSET = 0x200;
const ARM_TEXT_VADDR = 0x100001000;
const ARM_SIGNATURE = ARM_TEXT_OFFSET + 0x10;
const ARM_L1 = ARM_SIGNATURE + 0xa0;
const ARM_L3 = ARM_L1 + 0xd8;
const ARM_NOP = 0xd503201f;

function machoFixture(): Buffer {
	const data = Buffer.alloc(0x600);
	data.writeUInt32LE(0xfeedfacf, 0);
	data.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
	data.writeUInt32LE(1, 16);
	data.writeUInt32LE(152, 20);
	data.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
	data.writeUInt32LE(152, 36);
	data.write("__TEXT", 40);
	data.writeUInt32LE(1, 96);
	data.write("__text", 104);
	data.write("__TEXT", 120);
	data.writeBigUInt64LE(BigInt(ARM_TEXT_VADDR), 136);
	data.writeBigUInt64LE(0x300n, 144);
	data.writeUInt32LE(ARM_TEXT_OFFSET, 152);
	for (let at = ARM_TEXT_OFFSET; at < ARM_TEXT_OFFSET + 0x300; at += 4) data.writeUInt32LE(ARM_NOP, at);
	data.writeUInt32LE(0xb5000501, ARM_SIGNATURE); // cbnz x1, L1
	data.writeUInt32LE(0xb5000504, ARM_SIGNATURE + 4); // cbnz x4, L1 + 4
	data.writeUInt32LE(0x928feb23, ARM_SIGNATURE + 0x34); // mov x3, #-32602
	data.writeUInt32LE(0xb40006c4, ARM_L1); // cbz x4, L3
	data.writeUInt32LE(0xf94077e6, ARM_L1 + 4); // ldr x6, [sp, #0xe8]
	data.writeUInt32LE(0xb40006a6, ARM_L1 + 8); // cbz x6, L3 + 4
	data.writeUInt32LE(0xf94077e6, ARM_L3); // ldr x6, [sp, #0xe8]
	return data;
}

const arm64Target = (data: Buffer, offset: number): number => {
	const word = data.readUInt32LE(offset);
	const imm = word >>> 26 === 0x05 ? word & 0x03ffffff : (word >>> 5) & 0x7ffff;
	const bits = word >>> 26 === 0x05 ? 26 : 19;
	return offset + (imm & (1 << (bits - 1)) ? imm - (1 << bits) : imm) * 4;
};

test("macOS arm64 continuation applies the x64 control-flow change to the same three instructions", () => {
	const source = machoFixture();
	const original = Buffer.from(source);
	const patched = patchAgyNativeContinuation(source);
	assert.deepEqual(source, original, "the source buffer is not mutated");
	assert.equal(patched.format, "macho");
	assert.equal(patched.arch, "arm64");
	assert.deepEqual(patched.offsets, [ARM_SIGNATURE + 4, ARM_L1, ARM_L1 + 8]);
	const changedWords = [];
	for (let at = 0; at < source.length; at += 4) if (source.readUInt32LE(at) !== patched.data.readUInt32LE(at)) changedWords.push(at);
	assert.deepEqual(changedWords, patched.offsets);
	assert.equal(patched.data.readUInt32LE(ARM_SIGNATURE), 0xb5000501, "nonempty text keeps its branch");
	assert.equal(patched.data.readUInt32LE(ARM_SIGNATURE + 4), 0x14000027, "empty text reaches the image test");
	assert.equal(arm64Target(patched.data, ARM_SIGNATURE + 4), ARM_L1);
	assert.equal(patched.data.readUInt32LE(ARM_L1), ARM_NOP, "empty input enters the existing native body");
	assert.equal(patched.data.readUInt32LE(ARM_L1 + 8), 0xb40006a4, "the question guard tests the image count");
	assert.equal(arm64Target(patched.data, ARM_L1 + 8), arm64Target(source, ARM_L1 + 8));
});

test("macOS arm64 continuation matching is structural, unique, and fails closed", () => {
	const noError = machoFixture();
	noError.writeUInt32LE(ARM_NOP, ARM_SIGNATURE + 0x34);
	assert.throws(() => patchAgyNativeContinuation(noError), /found 0/);
	const otherSlot = machoFixture();
	otherSlot.writeUInt32LE(0xf9407be6, ARM_L3); // ldr x6, [sp, #0xf0]
	assert.throws(() => patchAgyNativeContinuation(otherSlot), /found 0/);
	const sameRegister = machoFixture();
	sameRegister.writeUInt32LE(0xb5000501, ARM_SIGNATURE + 4);
	assert.throws(() => patchAgyNativeContinuation(sameRegister), /found 0/);
	const twice = Buffer.alloc(0x800);
	twice.set(machoFixture());
	twice.writeBigUInt64LE(0x500n, 144);
	twice.set(twice.subarray(ARM_SIGNATURE, ARM_L3 + 4), ARM_L3 + 0x10);
	assert.throws(() => patchAgyNativeContinuation(twice), /ambiguous/);
	const macX64 = machoFixture();
	macX64.writeUInt32LE(0x01000007, 4);
	assert.throws(() => patchAgyNativeContinuation(macX64), /supported targets/);
});

test("macOS arm64 continuation derivation is cached by source hash", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-continuation-macho-test-"));
	const sourcePath = path.join(root, "agy");
	const cacheDir = path.join(root, "derived");
	const source = machoFixture();
	fs.writeFileSync(sourcePath, source);
	const derived = await deriveAgyNativeContinuation(sourcePath, { cacheDir });
	assert.equal(path.basename(derived), `agy-${crypto.createHash("sha256").update(source).digest("hex")}-native-continuation`);
	assert.deepEqual(fs.readFileSync(derived), patchAgyNativeContinuation(source).data);
	assert.deepEqual(fs.readFileSync(sourcePath), source);
});
