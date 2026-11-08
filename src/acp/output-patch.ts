// Full-MCP-output patch: disable agy's tool-output decorator. Applied in memory
// by src/acp/derived-agy.ts, which writes realagy's single private agy copy.
//
// agy 1.5.3 stores complete MCP results, but its decorator gives the model a
// truncated preview. The patch replaces only the decorator construction's
// conditional "return the original tool" branch with an unconditional branch
// to the same target. It does not touch auth, client identity, telemetry,
// request signing, session management, or trajectory rendering.
//
// Fixed offsets are deliberately not used: every source is hashed and scanned
// for one unique instruction signature inside executable code. An upgrade works
// only while the relevant machine code is recognisable; otherwise startup fails
// instead of patching an unrelated address.

import { inspectExecutable, type ExecutableImage, type ExecutableRegion } from "./binary-image.js";


interface PatchAdapter {
	prefix: Buffer;
	suffix: Buffer;
	branchOffset: number;
	branchSize: number;
	matchesBranch(data: Buffer, offset: number): boolean;
	patch(data: Buffer, offset: number, vaddr: number, executable: readonly ExecutableRegion[]): number;
}

// newOutputTruncationDecorator.func1 (x86-64):
//   test rdx, rdx
//   jle  return_original_tool
//   mov  [rsp+38], rdx
//   mov  eax, 28
// The allocation immediate and following stores make the signature unique.
// The JLE displacement is relocation/version dependent and is a wildcard.
const X64_ADAPTER: PatchAdapter = {
	prefix: Buffer.from([0x48, 0x85, 0xd2, 0x0f, 0x8e]),
	suffix: Buffer.from([0x48, 0x89, 0x54, 0x24, 0x38, 0xb8, 0x28, 0x00, 0x00, 0x00]),
	branchOffset: 3,
	branchSize: 6,
	matchesBranch: () => true,
	patch(data, offset, vaddr, executable) {
		const target = vaddr + 6 + data.readInt32LE(offset + 2);
		assertExecutableTarget(target, executable);
		// JMP rel32 is one byte shorter than JLE rel32. Adjust the displacement
		// and NOP the sixth byte rather than leaving a tail opcode behind.
		data[offset] = 0xe9;
		data.writeInt32LE(target - (vaddr + 5), offset + 1);
		data[offset + 5] = 0x90;
		return target;
	},
};

// The same decorator on macOS arm64:
//   cmp x1, #0
//   b.le return_original_tool
//   str x1, [sp, #58]
//   mov x0, #28
// Only the conditional branch becomes B; its target remains unchanged.
const ARM64_ADAPTER: PatchAdapter = {
	prefix: Buffer.from([0x3f, 0x00, 0x00, 0xf1]),
	suffix: Buffer.from([0xe1, 0x2f, 0x00, 0xf9, 0x00, 0x05, 0x80, 0xd2]),
	branchOffset: 4,
	branchSize: 4,
	matchesBranch(data, offset) {
		const instruction = data.readUInt32LE(offset);
		return (instruction & 0xff000010) === 0x54000000 && (instruction & 0xf) === 0xd;
	},
	patch(data, offset, vaddr, executable) {
		const instruction = data.readUInt32LE(offset);
		const immediate = (instruction >>> 5) & 0x7ffff;
		const displacement = (immediate & 0x40000 ? immediate - 0x80000 : immediate) * 4;
		const target = vaddr + displacement;
		assertExecutableTarget(target, executable);
		const delta = target - vaddr;
		if (delta % 4 !== 0 || delta < -0x8000000 || delta > 0x7fffffc) {
			throw new Error("Cannot derive full-MCP-output agy: ARM64 branch target is out of range; no bytes were written.");
		}
		data.writeUInt32LE(0x14000000 | ((delta / 4) & 0x03ffffff), offset);
		return target;
	},
};

export interface OutputPatchResult {
	data: Buffer;
	format: ExecutableImage["format"];
	arch: ExecutableImage["arch"];
	/** File offset of the replaced conditional branch. */
	offset: number;
	/** Original and patched control flow both reach this virtual address. */
	target: number;
}

function assertExecutableTarget(target: number, executable: readonly ExecutableRegion[]): void {
	if (!executable.some((item) => target >= item.vaddr && target < item.vaddr + item.size)) {
		throw new Error("Cannot derive full-MCP-output agy: decorator branch target is outside executable memory; no bytes were written.");
	}
}

function adapterFor(image: ExecutableImage): PatchAdapter {
	if ((image.format === "elf" || image.format === "pe") && image.arch === "x64") return X64_ADAPTER;
	if (image.format === "macho" && image.arch === "arm64") return ARM64_ADAPTER;
	throw new Error("Cannot derive full-MCP-output agy: supported targets are Windows x64, Linux x64, and macOS arm64; no bytes were written.");
}

function signatureMatches(data: Buffer, image: ExecutableImage, adapter: PatchAdapter): Array<{ offset: number; region: ExecutableRegion }> {
	const matches: Array<{ offset: number; region: ExecutableRegion }> = [];
	for (const region of image.executable) {
		const end = region.offset + region.size;
		let from = region.offset;
		while (from < end) {
			const offset = data.indexOf(adapter.prefix, from);
			const suffixAt = offset + adapter.branchOffset + adapter.branchSize;
			if (offset < 0 || suffixAt + adapter.suffix.length > end) break;
			if (adapter.matchesBranch(data, offset + adapter.branchOffset)
				&& data.subarray(suffixAt, suffixAt + adapter.suffix.length).equals(adapter.suffix)) {
				matches.push({ offset, region });
				if (matches.length > 1) return matches;
			}
			from = offset + 1;
		}
	}
	return matches;
}

/** Patch a recognised agy image in memory, preserving the branch target. */
export function patchAgyOutputTruncation(source: Buffer): OutputPatchResult {
	const image = inspectExecutable(source);
	const adapter = adapterFor(image);
	const matches = signatureMatches(source, image, adapter);
	if (matches.length !== 1) {
		throw new Error(`Cannot derive full-MCP-output agy: expected one output-decorator signature, found ${matches.length}. This agy version needs a verified adapter; no bytes were written.`);
	}
	const [{ offset: signatureOffset, region }] = matches;
	const offset = signatureOffset + adapter.branchOffset;
	const vaddr = region.vaddr + offset - region.offset;
	const data = Buffer.from(source);
	const target = adapter.patch(data, offset, vaddr, image.executable);
	return { data, format: image.format, arch: image.arch, offset, target };
}
