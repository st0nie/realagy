// Minimal, schema-directed protobuf editing for agy's persisted trajectory steps.
// Only known length-delimited fields are addressed; unknown fields and their order
// are preserved byte-for-byte. This is deliberately not a heuristic protobuf parser.

export interface ProtoField {
	number: number;
	wire: number;
	/** Offset immediately after the field tag, before a length prefix. */
	tagEnd: number;
	start: number;
	valueStart: number;
	valueEnd: number;
}

interface Varint { value: bigint; size: number }

function varint(data: Uint8Array, offset: number): Varint {
	let value = 0n;
	for (let i = 0; i < 10; i++) {
		if (offset + i >= data.length) throw new Error("Truncated protobuf varint");
		const byte = data[offset + i]!;
		value |= BigInt(byte & 0x7f) << BigInt(i * 7);
		if ((byte & 0x80) === 0) return { value, size: i + 1 };
	}
	throw new Error("Invalid protobuf varint");
}

export function encodeVarint(value: number | bigint): Buffer {
	let left = BigInt(value);
	if (left < 0n) throw new Error("Negative protobuf varint");
	const out: number[] = [];
	do {
		const byte = Number(left & 0x7fn);
		left >>= 7n;
		out.push(byte | (left > 0n ? 0x80 : 0));
	} while (left > 0n);
	return Buffer.from(out);
}

export function decodeProtoFields(data: Uint8Array): ProtoField[] {
	const fields: ProtoField[] = [];
	let offset = 0;
	while (offset < data.length) {
		const start = offset;
		const tag = varint(data, offset);
		offset += tag.size;
		const tagEnd = offset;
		const number = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);
		if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid protobuf field number");
		let valueStart = offset;
		let valueEnd: number;
		switch (wire) {
			case 0: {
				const value = varint(data, offset);
				valueEnd = offset + value.size;
				break;
			}
			case 1:
				valueEnd = offset + 8;
				break;
			case 2: {
				const length = varint(data, offset);
				offset += length.size;
				valueStart = offset;
				if (length.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Protobuf field is too large");
				valueEnd = offset + Number(length.value);
				break;
			}
			case 5:
				valueEnd = offset + 4;
				break;
			default:
				throw new Error(`Unsupported protobuf wire type ${wire}`);
		}
		if (valueEnd > data.length) throw new Error("Truncated protobuf field");
		fields.push({ number, wire, start, tagEnd, valueStart, valueEnd });
		offset = valueEnd;
	}
	return fields;
}

function oneField(data: Uint8Array, number: number): { field: ProtoField; value: Buffer } {
	const matches = decodeProtoFields(data).filter((field) => field.number === number);
	if (matches.length !== 1) throw new Error(`Expected one protobuf field ${number}, found ${matches.length}`);
	const field = matches[0]!;
	if (field.wire !== 2) throw new Error(`Protobuf field ${number} is not length-delimited`);
	return { field, value: Buffer.from(data.subarray(field.valueStart, field.valueEnd)) };
}

function replaceField(data: Uint8Array, field: ProtoField, value: Uint8Array): Buffer {
	return Buffer.concat([
		Buffer.from(data.subarray(0, field.tagEnd)),
		encodeVarint(value.length),
		value,
		Buffer.from(data.subarray(field.valueEnd)),
	]);
}

function editNested(data: Uint8Array, path: readonly number[], edit: (value: Buffer) => Buffer): Buffer {
	if (path.length === 0) return edit(Buffer.from(data));
	const { field, value } = oneField(data, path[0]!);
	return replaceField(data, field, editNested(value, path.slice(1), edit));
}

export function protoBytesAt(data: Uint8Array, path: readonly number[]): Buffer {
	if (path.length === 0) return Buffer.from(data);
	return protoBytesAt(oneField(data, path[0]!).value, path.slice(1));
}

/** Read an optional schema field. Missing is allowed; duplicate or malformed
 *  fields still fail closed rather than being mistaken for an absent mirror. */
export function optionalProtoBytesAt(data: Uint8Array, path: readonly number[]): Buffer | undefined {
	if (path.length === 0) return Buffer.from(data);
	const matches = decodeProtoFields(data).filter((field) => field.number === path[0]);
	if (matches.length === 0) return undefined;
	if (matches.length !== 1 || matches[0]!.wire !== 2) {
		throw new Error(`Expected an optional length-delimited protobuf field ${path[0]}`);
	}
	const field = matches[0]!;
	return optionalProtoBytesAt(data.subarray(field.valueStart, field.valueEnd), path.slice(1));
}

export function protoTextAt(data: Uint8Array, path: readonly number[]): string {
	return protoBytesAt(data, path).toString("utf8");
}

/** Replace one known text field, allowing arbitrary UTF-8 length changes. */
export function setProtoText(data: Uint8Array, path: readonly number[], text: string): Buffer {
	if (path.length === 0) throw new Error("A protobuf text field path is required");
	return editNested(data, path.slice(0, -1), (parent) => {
		const { field } = oneField(parent, path.at(-1)!);
		return replaceField(parent, field, Buffer.from(text, "utf8"));
	});
}


/** Rewrite one text block within a repeated message field, preserving other
 *  blocks. Require the complete original concatenation and a unique block. */
export function replaceRepeatedProtoTextPart(
	data: Uint8Array, parentPath: readonly number[], repeatedNumber: number,
	textNumber: number, expected: string, replacements: readonly { oldPart: string; newPart: string }[],
): Buffer {
	return editNested(data, parentPath, (parent) => {
		const fields = decodeProtoFields(parent).filter((field) => field.number === repeatedNumber);
		if (fields.length === 0 || fields.some((field) => field.wire !== 2)) throw new Error("Missing or malformed repeated text blocks");
		const parts = fields.map((field) => oneField(parent.subarray(field.valueStart, field.valueEnd), textNumber).value.toString("utf8"));
		const matches = parts.flatMap((part, index) => replacements.filter((entry) => entry.oldPart === part).map((entry) => ({ index, entry })));
		if (parts.join("") !== expected || matches.length !== 1) throw new Error("Repeated text blocks do not uniquely match the expected content");
		const match = matches[0]!;
		const field = fields[match.index]!;
		const child = parent.subarray(field.valueStart, field.valueEnd);
		return replaceField(parent, field, setProtoText(child, [textNumber], match.entry.newPart));
	});
}
/** Values of every occurrence of a repeated length-delimited field. A missing
 *  parent yields none; duplicate parents or malformed fields fail closed. */
export function repeatedProtoBytesAt(data: Uint8Array, path: readonly number[]): Buffer[] {
	if (path.length === 0) throw new Error("A protobuf field path is required");
	const parent = optionalProtoBytesAt(data, path.slice(0, -1));
	if (parent === undefined) return [];
	const fields = decodeProtoFields(parent).filter((field) => field.number === path.at(-1));
	if (fields.some((field) => field.wire !== 2)) throw new Error(`Protobuf field ${path.at(-1)} is not length-delimited`);
	return fields.map((field) => Buffer.from(parent.subarray(field.valueStart, field.valueEnd)));
}

/** Rewrite every occurrence of one repeated length-delimited field in order.
 *  `edit` receives all values and returns one entry per value: a replacement,
 *  or `null` to remove it. Other fields keep their bytes and order. */
export function rewriteRepeatedProtoFields(
	data: Uint8Array, path: readonly number[], edit: (values: Buffer[]) => readonly (Uint8Array | null)[],
): Buffer {
	if (path.length === 0) throw new Error("A protobuf field path is required");
	return editNested(data, path.slice(0, -1), (parent) => {
		const fields = decodeProtoFields(parent).filter((field) => field.number === path.at(-1));
		if (fields.some((field) => field.wire !== 2)) throw new Error(`Protobuf field ${path.at(-1)} is not length-delimited`);
		const next = edit(fields.map((field) => Buffer.from(parent.subarray(field.valueStart, field.valueEnd))));
		if (next.length !== fields.length) throw new Error("Repeated protobuf rewrite must return one entry per field");
		const out: Buffer[] = [];
		let cursor = 0;
		fields.forEach((field, index) => {
			out.push(Buffer.from(parent.subarray(cursor, field.start)));
			const value = next[index];
			if (value) out.push(Buffer.from(parent.subarray(field.start, field.tagEnd)), encodeVarint(value.length), Buffer.from(value));
			cursor = field.valueEnd;
		});
		out.push(Buffer.from(parent.subarray(cursor)));
		return Buffer.concat(out);
	});
}

/** Remove every occurrence of a known repeated media field. */
export function removeProtoFields(data: Uint8Array, path: readonly number[]): Buffer {
	if (path.length === 0) throw new Error("A protobuf field path is required");
	return editNested(data, path.slice(0, -1), (parent) => {
		const number = path.at(-1)!;
		const fields = decodeProtoFields(parent);
		const remove = fields.filter((field) => field.number === number);
		if (remove.length === 0) return parent;
		const out: Buffer[] = [];
		let cursor = 0;
		for (const field of remove) {
			out.push(Buffer.from(parent.subarray(cursor, field.start)));
			cursor = field.valueEnd;
		}
		out.push(Buffer.from(parent.subarray(cursor)));
		return Buffer.concat(out);
	});
}
