import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { deriveAgyFullMcpOutput, patchAgyOutputTruncation } from "../src/acp/output-patch.js";

const SIGNATURE_OFFSET = 0x1100;
const SEGMENT_OFFSET = 0x1000;
const SEGMENT_VADDR = 0x400000;
const SEGMENT_SIZE = 0x1000;

function fixture(): Buffer {
	const data = Buffer.alloc(0x2000);
	data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	data.writeUInt16LE(3, 16); // ET_DYN
	data.writeUInt16LE(62, 18); // EM_X86_64
	data.writeBigUInt64LE(64n, 32); // program headers
	data.writeUInt16LE(56, 54);
	data.writeUInt16LE(1, 56);
	data.writeUInt32LE(1, 64); // PT_LOAD
	data.writeUInt32LE(5, 68); // R + X
	data.writeBigUInt64LE(BigInt(SEGMENT_OFFSET), 72);
	data.writeBigUInt64LE(BigInt(SEGMENT_VADDR), 80);
	data.writeBigUInt64LE(BigInt(SEGMENT_SIZE), 96);
	data.writeBigUInt64LE(BigInt(SEGMENT_SIZE), 104);
	const instruction = Buffer.from([
		0x48, 0x85, 0xd2,
		0x0f, 0x8e, 0x20, 0x00, 0x00, 0x00,
		0x48, 0x89, 0x54, 0x24, 0x38,
		0xb8, 0x28, 0x00, 0x00, 0x00,
	]);
	data.set(instruction, SIGNATURE_OFFSET);
	return data;
}

function peFixture(): Buffer {
	const data = Buffer.alloc(0x400);
	data.write("MZ", 0);
	data.writeUInt32LE(0x80, 0x3c);
	data.write("PE\0\0", 0x80);
	data.writeUInt16LE(0x8664, 0x84); // AMD64
	data.writeUInt16LE(1, 0x86); // one section
	data.writeUInt16LE(0xf0, 0x94);
	data.writeUInt16LE(0x20b, 0x98); // PE32+
	data.writeBigUInt64LE(0x140000000n, 0xb0);
	const section = 0x188;
	data.write(".text", section);
	data.writeUInt32LE(0x1000, section + 12);
	data.writeUInt32LE(0x200, section + 16);
	data.writeUInt32LE(0x200, section + 20);
	data.writeUInt32LE(0x20000000, section + 36); // executable
	data.set(fixture().subarray(SIGNATURE_OFFSET, SIGNATURE_OFFSET + 19), 0x200);
	data.writeInt32LE(0x57, 0x205);
	return data;
}

function machoFixture(): Buffer {
	const data = Buffer.alloc(0x400);
	data.writeUInt32LE(0xfeedfacf, 0);
	data.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
	data.writeUInt32LE(1, 16);
	data.writeUInt32LE(152, 20);
	data.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
	data.writeUInt32LE(152, 36);
	data.write("__TEXT", 40);
	data.writeUInt32LE(1, 96); // one section
	data.write("__text", 104);
	data.write("__TEXT", 120);
	data.writeBigUInt64LE(0x100001000n, 136);
	data.writeBigUInt64LE(0x200n, 144);
	data.writeUInt32LE(0x200, 152);
	data.set(Buffer.from([
		0x3f, 0x00, 0x00, 0xf1, // cmp x1, #0
		0xed, 0x02, 0x00, 0x54, // b.le +0x5c
		0xe1, 0x2f, 0x00, 0xf9,
		0x00, 0x05, 0x80, 0xd2,
	]), 0x200);
	return data;
}

function changedOffsets(before: Buffer, after: Buffer): number[] {
	assert.equal(after.length, before.length);
	const changed: number[] = [];
	for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i);
	return changed;
}

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "realagy-output-patch-test-"));

test("the agy output patch replaces only JLE with a target-preserving JMP and NOP", () => {
	const source = fixture();
	const original = Buffer.from(source);
	const patched = patchAgyOutputTruncation(source);
	assert.deepEqual(source, original, "the input buffer is not mutated");
	assert.equal(patched.offset, SIGNATURE_OFFSET + 3);
	assert.equal(patched.target, SEGMENT_VADDR + SIGNATURE_OFFSET - SEGMENT_OFFSET + 3 + 6 + 0x20);
	assert.deepEqual(changedOffsets(source, patched.data), [
		SIGNATURE_OFFSET + 3,
		SIGNATURE_OFFSET + 4,
		SIGNATURE_OFFSET + 5,
		SIGNATURE_OFFSET + 8,
	]);
	assert.deepEqual([...patched.data.subarray(patched.offset, patched.offset + 6)], [0xe9, 0x21, 0x00, 0x00, 0x00, 0x90]);
});

test("Windows x64 PE preserves the decorator branch target", () => {
	const source = peFixture();
	const patched = patchAgyOutputTruncation(source);
	assert.equal(patched.format, "pe");
	assert.equal(patched.arch, "x64");
	assert.equal(patched.offset, 0x203);
	assert.equal(patched.target, 0x140001060);
	assert.deepEqual(changedOffsets(source, patched.data), [0x203, 0x204, 0x205, 0x208]);
	assert.deepEqual([...patched.data.subarray(0x203, 0x209)], [0xe9, 0x58, 0, 0, 0, 0x90]);
});

test("macOS arm64 Mach-O replaces only B.LE with a target-preserving B", () => {
	const source = machoFixture();
	const patched = patchAgyOutputTruncation(source);
	assert.equal(patched.format, "macho");
	assert.equal(patched.arch, "arm64");
	assert.equal(patched.offset, 0x204);
	assert.equal(patched.target, 0x100001060);
	assert.deepEqual(changedOffsets(source, patched.data), [0x204, 0x205, 0x207]);
	assert.equal(patched.data.readUInt32LE(0x204), 0x14000017);
});

test("unverified architecture and format combinations are rejected", () => {
	const linuxArm = fixture();
	linuxArm.writeUInt16LE(183, 18);
	assert.throws(() => patchAgyOutputTruncation(linuxArm), /supported targets/);
	const macX64 = machoFixture();
	macX64.writeUInt32LE(0x01000007, 4);
	assert.throws(() => patchAgyOutputTruncation(macX64), /supported targets/);
});

test("signature matching is mandatory, unique, and confined to executable data", () => {
	assert.throws(() => patchAgyOutputTruncation(Buffer.alloc(128)), /expected ELF, PE32\+/);
	assert.throws(() => patchAgyOutputTruncation(Buffer.alloc(0x2000)), /expected ELF, PE32\+/);

	const missing = fixture();
	missing.fill(0, SIGNATURE_OFFSET, SIGNATURE_OFFSET + 19);
	assert.throws(() => patchAgyOutputTruncation(missing), /found 0/);

	const ambiguous = fixture();
	ambiguous.set(ambiguous.subarray(SIGNATURE_OFFSET, SIGNATURE_OFFSET + 19), SIGNATURE_OFFSET + 0x100);
	assert.throws(() => patchAgyOutputTruncation(ambiguous), /found 2/);

	const outside = fixture();
	outside.writeUInt32LE(4, 68); // PT_LOAD without execute permission
	assert.throws(() => patchAgyOutputTruncation(outside), /no executable instruction region/);
});

test("an out-of-text branch target is rejected instead of patched", () => {
	const source = fixture();
	source.writeInt32LE(SEGMENT_SIZE, SIGNATURE_OFFSET + 5);
	assert.throws(() => patchAgyOutputTruncation(source), /outside executable memory/);
});

test("derivation is atomic, cached by source hash, and never modifies the source", async () => {
	const root = tempDir();
	const sourcePath = path.join(root, "agy");
	const cacheDir = path.join(root, "cache");
	const source = fixture();
	fs.writeFileSync(sourcePath, source);
	const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
	const logs: Array<{ msg: string; data: unknown }> = [];
	const options = { cacheDir, log: (msg: string, data: unknown) => logs.push({ msg, data }) };

	const [first, concurrent] = await Promise.all([
		deriveAgyFullMcpOutput(sourcePath, options),
		deriveAgyFullMcpOutput(sourcePath, options),
	]);
	assert.equal(first, concurrent);
	assert.equal(path.basename(first), `agy-${sourceHash}-full-mcp-output`);
	assert.deepEqual(fs.readFileSync(sourcePath), source);
	assert.equal(changedOffsets(source, fs.readFileSync(first)).length, 4);
	assert.ok(fs.statSync(first).mode & 0o111);
	assert.deepEqual(logs.map((entry) => entry.msg), ["output-patch-derived"]);

	const before = fs.statSync(first).mtimeMs;
	assert.equal(await deriveAgyFullMcpOutput(sourcePath, options), first);
	assert.equal(fs.statSync(first).mtimeMs, before, "a verified cache entry is reused");
	assert.equal(logs.length, 1);

	// A changed source is treated as an upgrade and gets a distinct derivative;
	// the previous version's cache entry is not overwritten.
	const upgraded = fixture();
	upgraded[0x1800] = 0x42;
	fs.writeFileSync(sourcePath, upgraded);
	const second = await deriveAgyFullMcpOutput(sourcePath, options);
	assert.notEqual(second, first);
	assert.equal(changedOffsets(upgraded, fs.readFileSync(second)).length, 4);
	assert.deepEqual(fs.readFileSync(first), patchAgyOutputTruncation(source).data);
	assert.equal(logs.length, 2);
});

test("a corrupt cache artifact is rebuilt from the unmodified source", async () => {
	const root = tempDir();
	const sourcePath = path.join(root, "agy");
	const cacheDir = path.join(root, "cache");
	fs.writeFileSync(sourcePath, fixture());
	const output = await deriveAgyFullMcpOutput(sourcePath, { cacheDir });
	fs.writeFileSync(output, fixture());
	assert.equal(await deriveAgyFullMcpOutput(sourcePath, { cacheDir }), output);
	assert.equal(changedOffsets(fixture(), fs.readFileSync(output)).length, 4);
});
