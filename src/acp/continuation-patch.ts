// Derive native empty-prompt continuation separately from the full-output patch.
// agy already has the required continuation control flow; ACP rejects an empty
// prompt before reaching it. The x64 (ELF/PE) and macOS arm64 adapters apply the
// same three-instruction control-flow change: ordinary prompt handling is kept
// and only the empty case is redirected through the existing native path.
// Unknown instruction layouts fail closed without modifying the source.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { inspectExecutable, signMacOSBinary, type ExecutableImage, type ExecutableRegion } from "./binary-image.js";

const CACHE_DIR = path.join(getAgentDir(), "realagy", "derived-bin");
const X64_PREFIX = Buffer.from([0x48, 0x85, 0xf6, 0x0f, 0x85]);
const X64_SUFFIX = Buffer.from([0x48, 0x8b, 0x94, 0x24, 0x78, 0x02, 0x00, 0x00]);
const SECOND_FROM_FIRST = 0xcf;
const THIRD_FROM_SECOND = 0x11;

export interface ContinuationPatchResult {
	data: Buffer;
	format: ExecutableImage["format"];
	arch: ExecutableImage["arch"];
	offsets: number[];
}

function executableTarget(target: number, regions: readonly ExecutableRegion[]): boolean {
	return regions.some((region) => target >= region.vaddr && target < region.vaddr + region.size);
}

function branchTarget(data: Buffer, offset: number, vaddr: number): number {
	return vaddr + 6 + data.readInt32LE(offset + 2);
}

function findX64(source: Buffer, image: ExecutableImage): { offset: number; region: ExecutableRegion } {
	const matches: Array<{ offset: number; region: ExecutableRegion }> = [];
	for (const region of image.executable) {
		const end = region.offset + region.size;
		let from = region.offset;
		while (from < end) {
			const offset = source.indexOf(X64_PREFIX, from);
			if (offset < 0 || offset + SECOND_FROM_FIRST + THIRD_FROM_SECOND + 10 > end) break;
			const suffixAt = offset + X64_PREFIX.length + 4;
			const second = offset + 3 + SECOND_FROM_FIRST;
			const third = second + THIRD_FROM_SECOND;
			if (source.subarray(suffixAt, suffixAt + X64_SUFFIX.length).equals(X64_SUFFIX)
				&& source.subarray(second, second + 5).equals(Buffer.from([0x48, 0x85, 0xf6, 0x0f, 0x84]))
				&& source.subarray(third, third + 5).equals(Buffer.from([0x48, 0x85, 0xd2, 0x0f, 0x84]))) {
				matches.push({ offset, region });
				if (matches.length > 1) throw new Error("Cannot derive native-continuation agy: ACP prompt signature is ambiguous; no bytes were written.");
			}
			from = offset + 1;
		}
	}
	if (matches.length !== 1) {
		throw new Error(`Cannot derive native-continuation agy: expected one ACP prompt signature, found ${matches.length}; no bytes were written.`);
	}
	return matches[0]!;
}

function patchX64(source: Buffer, image: ExecutableImage): ContinuationPatchResult {
	const { offset: signature, region } = findX64(source, image);
	const first = signature + 3;
	const second = first + SECOND_FROM_FIRST;
	const third = second + THIRD_FROM_SECOND;
	const address = (offset: number): number => region.vaddr + offset - region.offset;
	for (const offset of [first, second + 3, third + 3]) {
		if (!executableTarget(branchTarget(source, offset, address(offset)), image.executable)) {
			throw new Error("Cannot derive native-continuation agy: a prompt branch target is outside executable memory; no bytes were written.");
		}
	}
	const data = Buffer.from(source);
	// Empty and nonempty prompts both reach the second test. Nonempty input keeps
	// its original fall-through; empty input takes the existing native body.
	const target = address(second);
	data[first] = 0xe9;
	data.writeInt32LE(target - (address(first) + 5), first + 1);
	data[first + 5] = 0x90;
	// Empty input enters the normal body rather than the error return.
	data.writeInt32LE(0, second + 5);
	// The existing question guard must distinguish an empty prompt, not a nil
	// question pointer. This register substitution was validated by a live ACP
	// cancellation -> same-ID resume -> native generation probe.
	data[third + 2] = 0xf6;
	return { data, format: image.format, arch: image.arch, offsets: [first, second + 5, third + 2] };
}

// The same ACP prompt admission on macOS arm64 (agy 1.5.3):
//   cbnz xText, L1          ; nonempty text
//   cbnz xImages, L2        ; empty text with images
//   ...                     ; "Empty prompt" (-32602) error return
// L1: cbz xImages, L3       ; text without images -> ordinary body
// L2: ldr xQ, [sp, #k]
//   cbz xQ, L4              ; question guard
//   ...                     ; "Images can't answer..." check
// L3: ldr xQ, [sp, #k]
// L4: ordinary body
// Branch displacements, registers and the stack slot are wildcards; the shape,
// the shared slot, L2 = L1 + 4, L4 = L3 + 4 and the -32602 error are required.
const ARM64_NOP = 0xd503201f;
const ARM64_JSONRPC_INVALID_PARAMS = 0x928feb20; // movn xN, #0x7f59 == -32602

type Arm64Signature = { offset: number; region: ExecutableRegion; l1: number; l3: number; images: number };

const arm64Word = (data: Buffer, offset: number): number => data.readUInt32LE(offset);

/** CBZ/CBNZ (64-bit) target as a file offset in the same region, or undefined. */
function arm64CompareBranch(data: Buffer, offset: number, opcode: 0xb4 | 0xb5, region: ExecutableRegion): { reg: number; target: number } | undefined {
	const word = arm64Word(data, offset);
	if (word >>> 24 !== opcode) return undefined;
	const imm = (word >>> 5) & 0x7ffff;
	const target = offset + (imm & 0x40000 ? imm - 0x80000 : imm) * 4;
	if (target < region.offset || target + 4 > region.offset + region.size) return undefined;
	return { reg: word & 31, target };
}

function arm64StackLoad(word: number): boolean {
	return ((word & 0xffc003e0) >>> 0) === 0xf94003e0;
}

function findArm64(source: Buffer, image: ExecutableImage): Arm64Signature {
	const matches: Arm64Signature[] = [];
	for (const region of image.executable) {
		const start = region.offset + ((4 - (region.offset % 4)) % 4);
		const end = region.offset + region.size - 8;
		for (let offset = start; offset < end; offset += 4) {
			const text = arm64CompareBranch(source, offset, 0xb5, region);
			if (!text) continue;
			const images = arm64CompareBranch(source, offset + 4, 0xb5, region);
			const l1 = text.target;
			if (!images || images.reg === text.reg || images.target !== l1 + 4 || l1 <= offset + 8 || l1 + 12 > region.offset + region.size) continue;
			const ordinary = arm64CompareBranch(source, l1, 0xb4, region);
			if (!ordinary || ordinary.reg !== images.reg) continue;
			const load = arm64Word(source, l1 + 4);
			if (!arm64StackLoad(load)) continue;
			const question = arm64CompareBranch(source, l1 + 8, 0xb4, region);
			const l3 = ordinary.target;
			if (!question || question.reg !== (load & 31) || question.reg === images.reg) continue;
			if (l3 + 8 > region.offset + region.size || arm64Word(source, l3) !== load || question.target !== l3 + 4) continue;
			let invalidParams = false;
			for (let at = offset + 8; at < l1; at += 4) {
				if (((arm64Word(source, at) & 0xffffffe0) >>> 0) === ARM64_JSONRPC_INVALID_PARAMS) invalidParams = true;
			}
			if (!invalidParams) continue;
			matches.push({ offset, region, l1, l3, images: images.reg });
			if (matches.length > 1) throw new Error("Cannot derive native-continuation agy: ACP prompt signature is ambiguous; no bytes were written.");
		}
	}
	if (matches.length !== 1) {
		throw new Error(`Cannot derive native-continuation agy: expected one ACP prompt signature, found ${matches.length}; no bytes were written.`);
	}
	return matches[0]!;
}

function patchArm64(source: Buffer, image: ExecutableImage): ContinuationPatchResult {
	const { offset, l1, images } = findArm64(source, image);
	const data = Buffer.from(source);
	const first = offset + 4;
	// Empty text with images reaches the image test exactly like the x64 path.
	data.writeUInt32LE((0x14000000 | (((l1 - first) / 4) & 0x03ffffff)) >>> 0, first);
	// Empty input enters the normal body rather than the error return.
	data.writeUInt32LE(ARM64_NOP, l1);
	// The question guard tests the image count, mirroring the x64 substitution.
	const third = l1 + 8;
	data.writeUInt32LE(((arm64Word(source, third) & ~31) | images) >>> 0, third);
	return { data, format: image.format, arch: image.arch, offsets: [first, l1, third] };
}

/** Patch only ACP empty-prompt admission, preserving the source buffer. */
export function patchAgyNativeContinuation(source: Buffer): ContinuationPatchResult {
	const image = inspectExecutable(source);
	if ((image.format === "elf" || image.format === "pe") && image.arch === "x64") return patchX64(source, image);
	if (image.format === "macho" && image.arch === "arm64") return patchArm64(source, image);
	throw new Error("Cannot derive native-continuation agy: supported targets are Windows x64, Linux x64, and macOS arm64; no bytes were written.");
}

const sha256 = (data: Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

async function fileSha256(file: string): Promise<string | undefined> {
	try {
		const hash = crypto.createHash("sha256");
		for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

async function validCache(output: string): Promise<boolean> {
	try {
		const expected = (await fs.promises.readFile(`${output}.sha256`, "utf8")).trim();
		return /^[a-f0-9]{64}$/.test(expected) && await fileSha256(output) === expected;
	} catch {
		return false;
	}
}

export interface DeriveContinuationOptions {
	cacheDir?: string;
	log?: (msg: string, data?: unknown) => void;
}

const inFlight = new Map<string, Promise<string>>();

async function derive(sourcePath: string, cacheDir: string, log?: DeriveContinuationOptions["log"]): Promise<string> {
	const source = await fs.promises.readFile(sourcePath);
	const sourceHash = sha256(source);
	const image = inspectExecutable(source);
	const extension = image.format === "pe" ? ".exe" : "";
	const output = path.join(cacheDir, `agy-${sourceHash}-native-continuation${extension}`);
	if (await validCache(output)) return output;
	const patched = patchAgyNativeContinuation(source);
	await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 });
	const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const hashTemporary = `${output}.sha256.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, patched.data, { mode: 0o755 });
		await fs.promises.chmod(temporary, 0o755);
		if (patched.format === "macho") await signMacOSBinary(temporary);
		const outputHash = await fileSha256(temporary);
		if (!outputHash) throw new Error("Cannot hash the derived native-continuation agy executable.");
		await fs.promises.rename(temporary, output);
		await fs.promises.writeFile(hashTemporary, `${outputHash}\n`, { mode: 0o600 });
		await fs.promises.rename(hashTemporary, `${output}.sha256`);
		log?.("native-continuation-derived", { source: sourcePath, sourceSha256: sourceHash, output, outputSha256: outputHash, format: patched.format, arch: patched.arch, offsets: patched.offsets });
		return output;
	} finally {
		await fs.promises.unlink(temporary).catch(() => undefined);
		await fs.promises.unlink(hashTemporary).catch(() => undefined);
	}
}

/** Cache by the exact input bytes, including a prior full-output derivative. */
export function deriveAgyNativeContinuation(sourcePath: string, options: DeriveContinuationOptions = {}): Promise<string> {
	const source = path.resolve(sourcePath);
	const cacheDir = options.cacheDir ?? CACHE_DIR;
	const key = `${source}\0${cacheDir}`;
	let pending = inFlight.get(key);
	if (!pending) {
		pending = derive(source, cacheDir, options.log).finally(() => {
			if (inFlight.get(key) === pending) inFlight.delete(key);
		});
		inFlight.set(key, pending);
	}
	return pending;
}
