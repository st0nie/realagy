// Minimal Go pclntab reader for realagy's private context-unlock derivative.
// It resolves function entry offsets without depending on Go, Python, or symbols
// left in an executable's platform symbol table.

import type { BinaryArch, BinaryFormat } from "./binary-image.js";

export interface GoText {
	format: BinaryFormat;
	arch: BinaryArch;
	textVa: number;
	textOff: number;
}

export interface GoFunction {
	entryOff: number;
	size: number;
}

export type GoFunctions = ReadonlyMap<string, GoFunction>;

const PCLNTAB_MAGIC = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00]);
const LC_SEGMENT_64 = 0x19;

function bounded(data: Buffer, offset: number, size: number): boolean {
	return Number.isSafeInteger(offset) && Number.isSafeInteger(size)
		&& offset >= 0 && size >= 0 && offset + size <= data.length;
}

function u64(data: Buffer, offset: number): number {
	if (!bounded(data, offset, 8)) throw new Error("Invalid agy binary: truncated 64-bit field.");
	const value = data.readBigUInt64LE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported agy binary: address is too large.");
	return Number(value);
}

function cstring(data: Buffer, offset: number, limit = 1024): string | undefined {
	if (offset < 0 || offset >= data.length) return undefined;
	const end = data.indexOf(0, offset);
	if (end < 0 || end > offset + limit) return undefined;
	return data.toString("ascii", offset, end);
}

interface Pclntab {
	base: number;
	nfunc: number;
}

function findPclntab(data: Buffer): Pclntab {
	let from = 0;
	for (;;) {
		const base = data.indexOf(PCLNTAB_MAGIC, from);
		if (base < 0) throw new Error("Cannot derive context-unlocked agy: Go pclntab not found.");
		from = base + 1;
		if (!bounded(data, base, 72)) continue;
		if (![1, 2, 4].includes(data[base + 6]!) || data[base + 7] !== 8) continue;
		const nfunc = u64(data, base + 8);
		if (nfunc <= 1000 || nfunc >= 5_000_000) continue;
		const namesOff = u64(data, base + 32);
		if (!bounded(data, base + namesOff, 16)) continue;
		const head = data.subarray(base + namesOff, base + namesOff + 16);
		if (![...head].every((byte) => byte === 0 || (byte >= 0x20 && byte < 0x7f))) continue;
		return { base, nfunc };
	}
}

/** Map the trailing package-qualified Go function name to its text-relative range. */
export function buildGoFunctions(data: Buffer): GoFunctions {
	const { base, nfunc } = findPclntab(data);
	const names = base + u64(data, base + 32);
	const pcln = base + u64(data, base + 64);
	const functions = new Map<string, GoFunction>();
	for (let index = 0; index < nfunc; index++) {
		const offset = pcln + index * 8;
		if (!bounded(data, offset, 16)) break;
		const entryOff = data.readUInt32LE(offset);
		const funcOff = data.readUInt32LE(offset + 4);
		const nextEntryOff = data.readUInt32LE(offset + 8);
		const record = pcln + funcOff;
		if (!bounded(data, record, 8)) continue;
		const name = cstring(data, names + data.readInt32LE(record + 4));
		if (!name) continue;
		const shortName = name.slice(name.lastIndexOf("/") + 1);
		if (!functions.has(shortName)) functions.set(shortName, { entryOff, size: Math.max(0, nextEntryOff - entryOff) });
	}
	if (functions.size === 0) throw new Error("Cannot derive context-unlocked agy: functab produced no symbols.");
	return functions;
}

function fixedString(data: Buffer, offset: number, size: number): string {
	if (!bounded(data, offset, size)) throw new Error("Invalid agy binary: truncated section name.");
	return data.toString("ascii", offset, offset + size).replace(/\0.*$/s, "");
}

function machoText(data: Buffer): GoText {
	if (!bounded(data, 0, 32)) throw new Error("Invalid agy Mach-O header.");
	const cpu = data.readUInt32LE(4);
	const arch = cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : undefined;
	if (!arch) throw new Error(`Unsupported agy Mach-O CPU: ${cpu}.`);
	const commands = data.readUInt32LE(16);
	let offset = 32;
	for (let index = 0; index < commands; index++) {
		if (!bounded(data, offset, 8)) throw new Error("Invalid agy Mach-O load command.");
		const command = data.readUInt32LE(offset);
		const size = data.readUInt32LE(offset + 4);
		if (size < 8 || !bounded(data, offset, size)) throw new Error("Invalid agy Mach-O load command size.");
		if (command === LC_SEGMENT_64) {
			if (size < 72) throw new Error("Invalid agy Mach-O segment.");
			const sections = data.readUInt32LE(offset + 64);
			if (!bounded(data, offset + 72, sections * 80)) throw new Error("Invalid agy Mach-O section table.");
			for (let sectionIndex = 0; sectionIndex < sections; sectionIndex++) {
				const section = offset + 72 + sectionIndex * 80;
				if (fixedString(data, section, 16) !== "__text") continue;
				return { format: "macho", arch, textVa: u64(data, section + 32), textOff: data.readUInt32LE(section + 48) };
			}
		}
		offset += size;
	}
	throw new Error("Cannot derive context-unlocked agy: __text section not found in Mach-O.");
}

interface ElfSection {
	name: string;
	type: number;
	addr: number;
	offset: number;
	size: number;
	link: number;
	entsize: number;
}

function elfSections(data: Buffer): { sections: ElfSection[]; text: ElfSection } {
	if (!bounded(data, 0, 64) || data[4] !== 2 || data[5] !== 1) {
		throw new Error("Unsupported agy binary: expected a 64-bit little-endian ELF executable.");
	}
	const shoff = u64(data, 40);
	const shentsize = data.readUInt16LE(58);
	const shnum = data.readUInt16LE(60);
	const shstrndx = data.readUInt16LE(62);
	if (shentsize < 64 || !bounded(data, shoff, shentsize * shnum) || shstrndx >= shnum) {
		throw new Error("Invalid agy ELF section table.");
	}
	const shstr = shoff + shstrndx * shentsize;
	const strings = u64(data, shstr + 24);
	const sections: ElfSection[] = [];
	for (let index = 0; index < shnum; index++) {
		const offset = shoff + index * shentsize;
		const name = cstring(data, strings + data.readUInt32LE(offset), 4096) ?? "";
		sections.push({
			name,
			type: data.readUInt32LE(offset + 4),
			addr: u64(data, offset + 16),
			offset: u64(data, offset + 24),
			size: u64(data, offset + 32),
			link: data.readUInt32LE(offset + 40),
			entsize: u64(data, offset + 56),
		});
	}
	const text = sections.find((section) => section.name === ".text");
	if (!text) throw new Error("Cannot derive context-unlocked agy: .text section not found in ELF.");
	return { sections, text };
}

function elfFileToVa(data: Buffer, fileOffset: number): number | undefined {
	const phoff = u64(data, 32);
	const phentsize = data.readUInt16LE(54);
	const phnum = data.readUInt16LE(56);
	if (phentsize < 56 || !bounded(data, phoff, phentsize * phnum)) return undefined;
	for (let index = 0; index < phnum; index++) {
		const header = phoff + index * phentsize;
		if (data.readUInt32LE(header) !== 1) continue;
		const offset = u64(data, header + 8);
		const vaddr = u64(data, header + 16);
		const size = u64(data, header + 32);
		if (offset <= fileOffset && fileOffset < offset + size) return vaddr + fileOffset - offset;
	}
	return undefined;
}

/** Go functab entry offsets are relative to runtime.text, not necessarily .text. */
function elfGoTextVa(data: Buffer, sections: ElfSection[], text: ElfSection): number {
	const { base } = findPclntab(data);
	const textStart = u64(data, base + 24);
	if (text.addr <= textStart && textStart < text.addr + text.size) return textStart;
	const pclnVa = elfFileToVa(data, base);
	if (pclnVa !== undefined) {
		const funcnameVa = pclnVa + u64(data, base + 32);
		const needle = Buffer.alloc(8);
		needle.writeBigUInt64LE(BigInt(pclnVa));
		for (const rela of sections.filter((section) => section.type === 4)) {
			const entsize = rela.entsize || 24;
			if (entsize < 24 || !bounded(data, rela.offset, rela.size)) continue;
			let from = rela.offset;
			const end = rela.offset + rela.size;
			for (;;) {
				const hit = data.indexOf(needle, from);
				if (hit < 0 || hit >= end) break;
				from = hit + 1;
				if ((hit - rela.offset) % entsize !== 16) continue;
				const entry = hit - 16;
				if (entry < rela.offset || !bounded(data, entry, entsize * 2)) continue;
				const moduleVa = u64(data, entry);
				const second = entry + entsize;
				if (u64(data, second) !== moduleVa + 8) continue;
				const addend = data.readBigInt64LE(second + 16);
				if (addend !== BigInt(funcnameVa)) continue;
				let moduleText: number | undefined;
				let moduleEtext: number | undefined;
				for (let index = 2; index < 24 && bounded(data, entry + (index + 1) * entsize, 0); index++) {
					const relocation = entry + index * entsize;
					if (relocation + entsize > end) break;
					const target = u64(data, relocation);
					const value = Number(data.readBigInt64LE(relocation + 16));
					if (target === moduleVa + 0xb0) moduleText = value;
					else if (target === moduleVa + 0xb8) moduleEtext = value;
				}
				if (moduleText !== undefined && moduleEtext !== undefined
					&& text.addr <= moduleText && moduleText < moduleEtext && moduleEtext <= text.addr + text.size) return moduleText;
			}
		}
		const pair = Buffer.alloc(16);
		pair.writeBigUInt64LE(BigInt(pclnVa), 0);
		pair.writeBigUInt64LE(BigInt(funcnameVa), 8);
		let from = 0;
		for (;;) {
			const hit = data.indexOf(pair, from);
			if (hit < 0) break;
			from = hit + 1;
			if (!bounded(data, hit, 0xc0)) break;
			const moduleText = u64(data, hit + 0xb0);
			const moduleEtext = u64(data, hit + 0xb8);
			if (text.addr <= moduleText && moduleText < moduleEtext && moduleEtext <= text.addr + text.size) return moduleText;
		}
	}
	for (const symtab of sections.filter((section) => section.type === 2 && section.link < sections.length)) {
		const strings = sections[symtab.link]!.offset;
		const entsize = symtab.entsize || 24;
		if (entsize < 24 || !bounded(data, symtab.offset, symtab.size)) continue;
		for (let offset = symtab.offset; offset + 24 <= symtab.offset + symtab.size; offset += entsize) {
			if (!bounded(data, offset, 24)) break;
			const name = cstring(data, strings + data.readUInt32LE(offset), 64);
			if (name !== "runtime.text") continue;
			const value = u64(data, offset + 8);
			if (text.addr <= value && value < text.addr + text.size) return value;
		}
	}
	throw new Error("Cannot derive context-unlocked agy: cannot locate Go runtime.text base in ELF.");
}

function elfText(data: Buffer): GoText {
	const machine = data.readUInt16LE(18);
	const arch = machine === 0xb7 ? "arm64" : machine === 0x3e ? "x64" : undefined;
	if (!arch) throw new Error(`Unsupported agy ELF machine: ${machine}.`);
	const { sections, text } = elfSections(data);
	const textVa = elfGoTextVa(data, sections, text);
	return { format: "elf", arch, textVa, textOff: text.offset + textVa - text.addr };
}

function peText(data: Buffer): GoText {
	if (!bounded(data, 0, 0x40)) throw new Error("Invalid agy PE header.");
	const pe = data.readUInt32LE(0x3c);
	if (!bounded(data, pe, 24) || data.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Invalid agy PE signature.");
	const machine = data.readUInt16LE(pe + 4);
	const arch = machine === 0xaa64 ? "arm64" : machine === 0x8664 ? "x64" : undefined;
	if (!arch) throw new Error(`Unsupported agy PE machine: ${machine}.`);
	const sections = data.readUInt16LE(pe + 6);
	const optionalSize = data.readUInt16LE(pe + 20);
	const optional = pe + 24;
	if (optionalSize < 32 || !bounded(data, optional, optionalSize)) throw new Error("Invalid agy PE optional header.");
	const imageBase = u64(data, optional + 24);
	const table = optional + optionalSize;
	if (!bounded(data, table, sections * 40)) throw new Error("Invalid agy PE section table.");
	for (let index = 0; index < sections; index++) {
		const section = table + index * 40;
		if (fixedString(data, section, 8) !== ".text") continue;
		return {
			format: "pe",
			arch,
			textVa: imageBase + data.readUInt32LE(section + 12),
			textOff: data.readUInt32LE(section + 20),
		};
	}
	throw new Error("Cannot derive context-unlocked agy: .text section not found in PE.");
}

export function findGoText(data: Buffer): GoText {
	if (data.length >= 4 && data.readUInt32LE(0) === 0xfeedfacf) return machoText(data);
	if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return elfText(data);
	if (data.length >= 2 && data.toString("ascii", 0, 2) === "MZ") return peText(data);
	throw new Error("Cannot derive context-unlocked agy: expected ELF, PE32+, or 64-bit Mach-O.");
}
