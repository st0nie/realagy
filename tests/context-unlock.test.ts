import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { patchAgyContextUnlock } from "../src/acp/context-unlock.js";
import { deriveAgy } from "../src/acp/derived-agy.js";
import { patchAgyOutputTruncation } from "../src/acp/output-patch.js";

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const agyPath = process.env.AGY_BIN ?? path.join(os.homedir(), ".local", "bin", "agy");
const source = fs.existsSync(agyPath) ? fs.readFileSync(agyPath) : undefined;
// Byte-for-byte oracle from the reference patcher, agy 1.5.2 Linux x64.
const isReferenceBinary = source !== undefined && sha256(source) === "da1751e7658469fa80bf36eda2c60ee61216d8e42b735a184382ba31d1f6b88e";

test.skipIf(!isReferenceBinary)("context unlock matches the Python reference byte-for-byte and is idempotent", () => {
	const before = source!;
	const original = Buffer.from(before);
	const first = patchAgyContextUnlock(before);
	assert.equal(first.format, "elf");
	assert.equal(first.arch, "x64");
	assert.equal(first.gates.length, 6);
	assert.ok(first.gates.every((gate) => gate.changed), JSON.stringify(first.gates));
	assert.equal(sha256(first.data), "8b19ca699b0d1c530ef1da993fb27ee5e4a2c73f42eaaa3d1cf01fc07da8bbe8");
	assert.ok(before.equals(original), "the installed source buffer is never modified");

	const second = patchAgyContextUnlock(first.data);
	assert.ok(second.gates.every((gate) => !gate.changed));
	assert.ok(second.data.equals(first.data));
});

test.skipIf(!isReferenceBinary)("context unlock and full MCP output compose on the same bytes", () => {
	const before = source!;
	const context = patchAgyContextUnlock(before);
	const both = patchAgyOutputTruncation(context.data);
	assert.notEqual(both.offset, 0);
	assert.ok(!both.data.equals(context.data), "the output patch must add its own byte changes");
	assert.equal(sha256(patchAgyContextUnlock(both.data).data), sha256(both.data), "the composed derivative needs no further context changes");
});

test.skipIf(!isReferenceBinary)("derived cache separates context and output patch combinations", async () => {
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-derived-patches-"));
	try {
		const contextOnly = await deriveAgy(agyPath, { fullMcpOutput: false, contextUnlock: true, cacheDir });
		const outputOnly = await deriveAgy(agyPath, { fullMcpOutput: true, contextUnlock: false, cacheDir });
		const both = await deriveAgy(agyPath, { fullMcpOutput: true, contextUnlock: true, cacheDir });
		assert.equal(new Set([contextOnly, outputOnly, both]).size, 3);
		assert.match(path.basename(contextOnly), /-context-unlock$/);
		assert.match(path.basename(outputOnly), /-full-mcp-output$/);
		assert.match(path.basename(both), /-context-unlock\+full-mcp-output$/);
		assert.equal(await deriveAgy(agyPath, { fullMcpOutput: false, contextUnlock: false, cacheDir }), agyPath);
		assert.equal(sha256(fs.readFileSync(agyPath)), sha256(source!), "the installed agy is never rewritten");
	} finally {
		fs.rmSync(cacheDir, { recursive: true, force: true });
	}
}, 30_000);

// Optional official 1.5.3 downloads. Set REALAGY_AGY_FIXTURE_DIR to their directory.
const crossPlatformVectors = [
	{
		file: "agy-darwin-arm64",
		format: "macho",
		arch: "arm64",
		source: "5e4b545bff4a83a93354fc50c54631cf3e8cd02e1a469087af00929f3fdc4d51",
		patched: "f1a643a70cb7876c0f05517b7ccf0d48df069eedb0870387334b8320b28258e9",
	},
	{
		file: "agy-windows-x64.exe",
		format: "pe",
		arch: "x64",
		source: "47b1bec8c4a6d4afa1587177530e329cee4f5c6e76573a12ac9ab47b846e50e6",
		patched: "605a3a6fa961fc40909e4255c4c908e1ddf70346ece9d819ce256626e2b6f607",
	},
] as const;

test.skipIf(!process.env.REALAGY_AGY_FIXTURE_DIR)("official macOS and Windows patches match the reference and are idempotent", () => {
	for (const vector of crossPlatformVectors) {
		const before = fs.readFileSync(path.join(process.env.REALAGY_AGY_FIXTURE_DIR!, vector.file));
		assert.equal(sha256(before), vector.source, `${vector.file}: expected the official agy 1.5.3 source`);
		const first = patchAgyContextUnlock(before);
		assert.equal(first.format, vector.format);
		assert.equal(first.arch, vector.arch);
		assert.equal(first.gates.length, 6);
		assert.ok(first.gates.every((gate) => gate.changed), `${vector.file}: ${JSON.stringify(first.gates)}`);
		assert.equal(sha256(first.data), vector.patched, `${vector.file}: Python-reference hash`);
		const second = patchAgyContextUnlock(first.data);
		assert.ok(second.gates.every((gate) => !gate.changed), `${vector.file}: second pass must be a no-op`);
		assert.ok(second.data.equals(first.data));
	}
});


test("context unlock fails closed on an unknown executable", () => {
	assert.throws(() => patchAgyContextUnlock(Buffer.from("not an agy executable")), /expected ELF, PE32\+, or 64-bit Mach-O/);
});
