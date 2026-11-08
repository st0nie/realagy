// Minimal executable inspection for the supported agy output patch. Only mapped
// instruction bytes are searched; offsets and addresses stay format-specific.

export type BinaryFormat = "elf" | "pe" | "macho";
export type BinaryArch = "x64" | "arm64";
export type ExecutableRegion = { offset: number; vaddr: number; size: number };
export type ExecutableImage = { format: BinaryFormat; arch: BinaryArch; executable: ExecutableRegion[] };

const ELF_MACHINE_X64 = 62;
const ELF_MACHINE_ARM64 = 183;
const PE_MACHINE_X64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;
const MACHO_CPU_X64 = 0x01000007;
const MACHO_CPU_ARM64 = 0x0100000c;
const PE_MEM_EXECUTE = 0x20000000;
const LC_SEGMENT_64 = 0x19;

function bounded(data: Buffer, offset: number, size: number): boolean {
	return Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset + size <= data.length;
}

function u64(data: Buffer, offset: number): number {
	const value = data.readBigUInt64LE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported agy binary: executable mapping is too large.");
	return Number(value);
}

function elfImage(data: Buffer): ExecutableImage {
	if (data.length < 64 || data[4] !== 2 || data[5] !== 1) {
		throw new Error("Unsupported agy binary: expected a 64-bit little-endian ELF executable.");
	}
	const machine = data.readUInt16LE(18);
	let arch: BinaryArch;
	if (machine === ELF_MACHINE_X64) arch = "x64";
	else if (machine === ELF_MACHINE_ARM64) arch = "arm64";
	else throw new Error(`Unsupported agy ELF machine: ${machine}.`);
	const phoff = u64(data, 32);
	const phentsize = data.readUInt16LE(54);
	const phnum = data.readUInt16LE(56);
	if (phentsize < 56 || !bounded(data, phoff, phentsize * phnum)) {
		throw new Error("Invalid agy ELF program header table.");
	}
	const executable: ExecutableRegion[] = [];
	for (let index = 0; index < phnum; index++) {
		const header = phoff + index * phentsize;
		if (data.readUInt32LE(header) !== 1 || !(data.readUInt32LE(header + 4) & 1)) continue;
		const offset = u64(data, header + 8);
		const vaddr = u64(data, header + 16);
		const size = u64(data, header + 32);
		if (!bounded(data, offset, size)) throw new Error("Invalid agy ELF executable segment.");
		executable.push({ offset, vaddr, size });
	}
	return { format: "elf", arch, executable };
}

function peImage(data: Buffer): ExecutableImage {
	if (data.length < 0x40) throw new Error("Invalid agy PE header.");
	const pe = data.readUInt32LE(0x3c);
	if (!bounded(data, pe, 24) || data.toString("ascii", pe, pe + 4) !== "PE\0\0") {
		throw new Error("Invalid agy PE signature.");
	}
	const machine = data.readUInt16LE(pe + 4);
	let arch: BinaryArch;
	if (machine === PE_MACHINE_X64) arch = "x64";
	else if (machine === PE_MACHINE_ARM64) arch = "arm64";
	else throw new Error(`Unsupported agy PE machine: ${machine}.`);
	const sections = data.readUInt16LE(pe + 6);
	const optionalSize = data.readUInt16LE(pe + 20);
	const optional = pe + 24;
	if (optionalSize < 32 || !bounded(data, optional, optionalSize) || data.readUInt16LE(optional) !== 0x20b) {
		throw new Error("Unsupported agy binary: expected a PE32+ executable.");
	}
	const imageBase = u64(data, optional + 24);
	const table = optional + optionalSize;
	if (!bounded(data, table, sections * 40)) throw new Error("Invalid agy PE section table.");
	const executable: ExecutableRegion[] = [];
	for (let index = 0; index < sections; index++) {
		const section = table + index * 40;
		if (!(data.readUInt32LE(section + 36) & PE_MEM_EXECUTE)) continue;
		const vaddr = imageBase + data.readUInt32LE(section + 12);
		const size = data.readUInt32LE(section + 16);
		const offset = data.readUInt32LE(section + 20);
		if (!bounded(data, offset, size) || !Number.isSafeInteger(vaddr)) throw new Error("Invalid agy PE executable section.");
		executable.push({ offset, vaddr, size });
	}
	return { format: "pe", arch, executable };
}

function fixedString(data: Buffer, offset: number): string {
	return data.toString("ascii", offset, offset + 16).replace(/\0.*$/s, "");
}

function machoImage(data: Buffer): ExecutableImage {
	if (data.length < 32) throw new Error("Invalid agy Mach-O header.");
	const cpu = data.readUInt32LE(4);
	let arch: BinaryArch;
	if (cpu === MACHO_CPU_X64) arch = "x64";
	else if (cpu === MACHO_CPU_ARM64) arch = "arm64";
	else throw new Error(`Unsupported agy Mach-O CPU: ${cpu}.`);
	const commands = data.readUInt32LE(16);
	const commandBytes = data.readUInt32LE(20);
	if (!bounded(data, 32, commandBytes)) throw new Error("Invalid agy Mach-O load commands.");
	const executable: ExecutableRegion[] = [];
	let cursor = 32;
	for (let index = 0; index < commands; index++) {
		if (!bounded(data, cursor, 8)) throw new Error("Invalid agy Mach-O load command.");
		const command = data.readUInt32LE(cursor);
		const size = data.readUInt32LE(cursor + 4);
		if (size < 8 || !bounded(data, cursor, size)) throw new Error("Invalid agy Mach-O load command size.");
		if (command === LC_SEGMENT_64) {
			if (size < 72) throw new Error("Invalid agy Mach-O segment.");
			const sectionCount = data.readUInt32LE(cursor + 64);
			if (!bounded(data, cursor + 72, sectionCount * 80)) throw new Error("Invalid agy Mach-O section table.");
			for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
				const section = cursor + 72 + sectionIndex * 80;
				if (fixedString(data, section) !== "__text" || fixedString(data, section + 16) !== "__TEXT") continue;
				const vaddr = u64(data, section + 32);
				const sectionSize = u64(data, section + 40);
				const offset = data.readUInt32LE(section + 48);
				if (!bounded(data, offset, sectionSize)) throw new Error("Invalid agy Mach-O text section.");
				executable.push({ offset, vaddr, size: sectionSize });
			}
		}
		cursor += size;
	}
	return { format: "macho", arch, executable };
}

export function inspectExecutable(data: Buffer): ExecutableImage {
	let image: ExecutableImage;
	if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) image = elfImage(data);
	else if (data.length >= 2 && data.toString("ascii", 0, 2) === "MZ") image = peImage(data);
	else if (data.length >= 4 && data.readUInt32LE(0) === 0xfeedfacf) image = machoImage(data);
	else throw new Error("Unsupported agy binary: expected ELF, PE32+, or 64-bit Mach-O.");
	if (image.executable.length === 0) throw new Error("Invalid agy binary: no executable instruction region.");
	return image;
}
