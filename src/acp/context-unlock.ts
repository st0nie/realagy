// Unlock agy's local context-window and USER_INPUT truncation gates in a
// private in-memory derivative. The algorithm is a TypeScript port of DSH's
// agy-context-unlock reference; no Python or external patch process is needed.
// Authentication, client identity, telemetry, signing, and session code are not
// targets. Unknown function or instruction layouts fail closed.

import type { BinaryArch, BinaryFormat } from "./binary-image.js";
import { buildGoFunctions, findGoText, type GoFunctions } from "./go-symbols.js";

const FUNC_OFFERS = "model.SelectorModel.offersContextWindow";
const FUNC_STORE_CW = "store.(*Store).ContextWindow";
const FUNC_STORE_CHOICE = "store.(*Store).ContextWindowChoice";
const FUNC_CHECKPOINT = "utils.GetCheckpointConfig";
const FUNC_EXP_CHECKPOINT = "config.applyFeatureProviderCheckpointOverrideConfig";
const FUNC_SELECT_EXP_KEY = "config.selectCheckpointExperimentKey";
const FUNC_MAX_STEP_TOKENS = "chatconverters.(*TrajectoryChatConverter).getMaxTokensForStep";
const FUNC_ONEHARNESS_STEP = "serializers.DefaultSerializer.stepToMessage";
const FUNC_OVERRIDE = "store.AutoCompactOverride";

const NOP_ARM64 = word(0xd503201f);
const RET_TRUE_ARM64 = Buffer.concat([word(0x52800020), word(0xd65f03c0)]);
const RET_TRUE_X64 = Buffer.from("b801000000c3", "hex");
const CLAMP_256K_ARM64 = Buffer.from("04009dd26400a0f27f00046b04009dd26400a0f26330849a", "hex");
const CLAMP_256K_X64 = Buffer.from("81fa00e80300be00e803000f42f2", "hex");
const PATCH_256K_X64 = Buffer.concat([Buffer.from("89d6", "hex"), Buffer.alloc(12, 0x90)]);
const MOV_X2_XZR = 0xaa1f03e2;
const MOV_X0_X2 = 0xaa0203e0;
const X64_ZERO_EAX = Buffer.from("31c0", "hex");
const ONEHARNESS_BEQ_WORD = 0x540000c0;
const ONEHARNESS_BEQ_PATCHED = 0x54000060;

export interface ContextUnlockGate {
	gate: "1" | "2" | "3A" | "3B" | "4A" | "4B";
	changed: boolean;
	detail: string;
}

export interface ContextUnlockResult {
	data: Buffer;
	format: BinaryFormat;
	arch: BinaryArch;
	gates: ContextUnlockGate[];
}

function word(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeUInt32LE(value >>> 0);
	return result;
}

function words(...values: number[]): Buffer {
	return Buffer.concat(values.map(word));
}

function int32(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeInt32LE(value);
	return result;
}

function fail(message: string): never {
	throw new Error(`Cannot derive context-unlocked agy: ${message}`);
}

function encodeB(pc: number, target: number, link = false): number {
	const delta = target - pc;
	if (delta % 4 !== 0 || delta < -(1 << 27) || delta >= 1 << 27) fail("branch target out of range");
	return ((link ? 0x94000000 : 0x14000000) | ((delta >> 2) & 0x03ffffff)) >>> 0;
}

function decodeBlTarget(pc: number, instruction: number): number | undefined {
	if (((instruction & 0xfc000000) >>> 0) !== 0x94000000) return undefined;
	let immediate = instruction & 0x03ffffff;
	if (immediate & 0x02000000) immediate -= 0x04000000;
	return pc + immediate * 4;
}

function decodeImm19(instruction: number): number {
	let immediate = (instruction >>> 5) & 0x7ffff;
	if (immediate & 0x40000) immediate -= 0x80000;
	return immediate;
}

interface Layout {
	data: Buffer;
	functions: GoFunctions;
	textVa: number;
	textOff: number;
	arch: BinaryArch;
}

function required(layout: Layout, name: string): { entryOff: number; size: number } {
	const fn = layout.functions.get(name);
	if (!fn) fail(`symbol not found: ${name}`);
	return fn;
}

function functionBody(layout: Layout, name: string, fallbackSize: number): {
	offset: number;
	va: number;
	body: Buffer;
} {
	const fn = required(layout, name);
	const offset = layout.textOff + fn.entryOff;
	const size = fn.size || fallbackSize;
	if (offset < 0 || offset + size > layout.data.length) fail(`function range is outside the executable: ${name}`);
	return { offset, va: layout.textVa + fn.entryOff, body: layout.data.subarray(offset, offset + size) };
}

function gate1(layout: Layout): ContextUnlockGate {
	const fn = required(layout, FUNC_OFFERS);
	const offset = layout.textOff + fn.entryOff;
	const patch = layout.arch === "arm64" ? RET_TRUE_ARM64 : RET_TRUE_X64;
	const changed = !layout.data.subarray(offset, offset + patch.length).equals(patch);
	if (changed) patch.copy(layout.data, offset);
	return { gate: "1", changed, detail: `${FUNC_OFFERS}: return true` };
}

function tryArm64RichGate2(layout: Layout): ContextUnlockGate | undefined {
	if (!layout.functions.has(FUNC_OVERRIDE)) return undefined;
	const cw = required(layout, FUNC_STORE_CW);
	const choice = required(layout, FUNC_STORE_CHOICE);
	const override = required(layout, FUNC_OVERRIDE);
	if (cw.size < 0x100) return undefined;
	const { offset: fnOff, va: fnVa, body } = functionBody(layout, FUNC_STORE_CW, 0x100);
	const choiceVa = layout.textVa + choice.entryOff;
	const overrideVa = layout.textVa + override.entryOff;

	let loadReceiver: number | undefined;
	for (let rel = 0; rel < Math.min(0x40, cw.size); rel += 4) {
		const instruction = body.readUInt32LE(rel);
		if (((instruction & 0xffc003ff) >>> 0) === 0xf90003e0) {
			loadReceiver = (0xf94003e0 | (instruction & 0x003ffc00)) >>> 0;
			break;
		}
	}
	if (loadReceiver === undefined) return undefined;

	let argonBranch: number | undefined;
	for (let rel = 0x40; rel + 8 <= cw.size; rel += 4) {
		const first = body.readUInt32LE(rel);
		const second = body.readUInt32LE(rel + 4);
		if (first === 0x92800000 && (((second & 0xfff8001f) >>> 0) === 0xb7f80000 || second === 0xd503201f)) {
			argonBranch = rel + 4;
			break;
		}
	}
	if (argonBranch === undefined) return undefined;

	let overrideCall: number | undefined;
	for (let rel = argonBranch + 4; rel + 24 <= cw.size; rel += 4) {
		if (decodeBlTarget(fnVa + rel, body.readUInt32LE(rel)) === overrideVa) {
			overrideCall = rel;
			break;
		}
	}
	if (overrideCall === undefined) return undefined;
	const cbnz = body.readUInt32LE(overrideCall + 4);
	if (((cbnz & 0xff00001f) >>> 0) !== 0xb5000001) return undefined;
	const epilogue = overrideCall + 4 + decodeImm19(cbnz) * 4;
	if (epilogue <= 0 || epilogue > cw.size - 12) return undefined;
	const epilogueWords = [body.readUInt32LE(epilogue), body.readUInt32LE(epilogue + 4), body.readUInt32LE(epilogue + 8)];
	if (epilogueWords[2] !== 0xd65f03c0) return undefined;
	let tail = overrideCall + 8;
	if (body.readUInt32LE(tail) === 0xd503201f) tail += 4;
	if (tail + 16 > epilogue) return undefined;
	const tailPatch = words(loadReceiver, epilogueWords[0]!, epilogueWords[1]!, encodeB(fnVa + tail + 12, choiceVa));
	const alreadyNop = body.subarray(argonBranch, argonBranch + 4).equals(NOP_ARM64);
	const alreadyTail = body.subarray(tail, tail + 16).equals(tailPatch);
	if (!alreadyNop || !alreadyTail) {
		NOP_ARM64.copy(layout.data, fnOff + argonBranch);
		tailPatch.copy(layout.data, fnOff + tail);
	}
	return {
		gate: "2",
		changed: !alreadyNop || !alreadyTail,
		detail: `${FUNC_STORE_CW}: whitelist bypass and AutoCompactOverride-preserving tail call`,
	};
}

function gate2(layout: Layout): ContextUnlockGate {
	const cw = required(layout, FUNC_STORE_CW);
	const choice = required(layout, FUNC_STORE_CHOICE);
	const offset = layout.textOff + cw.entryOff;
	const va = layout.textVa + cw.entryOff;
	const choiceVa = layout.textVa + choice.entryOff;
	if (layout.arch === "arm64") {
		const entryJump = word(encodeB(va, choiceVa));
		if (layout.data.subarray(offset, offset + 4).equals(entryJump)) {
			return { gate: "2", changed: false, detail: `${FUNC_STORE_CW}: entry jump already applied` };
		}
		const rich = tryArm64RichGate2(layout);
		if (rich) return rich;
		entryJump.copy(layout.data, offset);
		return { gate: "2", changed: true, detail: `${FUNC_STORE_CW}: branch to ${FUNC_STORE_CHOICE}` };
	}
	const displacement = choiceVa - (va + 5);
	if (displacement < -(2 ** 31) || displacement >= 2 ** 31) fail("Store.ContextWindow jmp rel32 out of range");
	const entryJump = Buffer.concat([Buffer.from([0xe9]), int32(displacement)]);
	const changed = !layout.data.subarray(offset, offset + 5).equals(entryJump);
	if (changed) entryJump.copy(layout.data, offset);
	return { gate: "2", changed, detail: `${FUNC_STORE_CW}: jump to ${FUNC_STORE_CHOICE}` };
}

function genericArm64Clamp(body: Buffer): Array<{ offset: number; length: number }> {
	const hits: Array<{ offset: number; length: number }> = [];
	for (let rel = 0; rel + 24 <= body.length; rel += 4) {
		const first = body.readUInt32LE(rel);
		const second = body.readUInt32LE(rel + 4);
		if (((first & 0xffffffe0) >>> 0) !== 0xd29d0000 || ((second & 0xffffffe0) >>> 0) !== 0xf2a00060) continue;
		const limit = first & 0x1f;
		if ((second & 0x1f) !== limit) continue;
		for (let end = rel + 12; end < Math.min(rel + 32, body.length); end += 4) {
			const instruction = body.readUInt32LE(end);
			if (((instruction & 0xffe0fc00) >>> 0) !== 0x9a803000) continue;
			const destination = instruction & 0x1f;
			const source = (instruction >>> 5) & 0x1f;
			const registerLimit = (instruction >>> 16) & 0x1f;
			if (destination === source && registerLimit === limit) {
				hits.push({ offset: rel, length: end + 4 - rel });
				break;
			}
		}
	}
	return hits;
}

function gate3a(layout: Layout): ContextUnlockGate {
	const { offset, va, body } = functionBody(layout, FUNC_CHECKPOINT, 0x600);
	if (layout.arch === "arm64") {
		const index = body.indexOf(CLAMP_256K_ARM64);
		if (index >= 0) {
			if (body.indexOf(CLAMP_256K_ARM64, index + 1) >= 0) fail(`${FUNC_CHECKPOINT}: multiple 256K clamps found`);
			Buffer.concat(Array(6).fill(NOP_ARM64)).copy(layout.data, offset + index);
			return { gate: "3A", changed: true, detail: `${FUNC_CHECKPOINT}: removed 256K clamp at ${va + index}` };
		}
		const generic = genericArm64Clamp(body);
		if (generic.length === 1) {
			const hit = generic[0]!;
			for (let rel = 0; rel < hit.length; rel += 4) NOP_ARM64.copy(layout.data, offset + hit.offset + rel);
			return { gate: "3A", changed: true, detail: `${FUNC_CHECKPOINT}: removed generic 256K clamp` };
		}
		if (body.indexOf(Buffer.concat(Array(6).fill(NOP_ARM64))) >= 0) {
			return { gate: "3A", changed: false, detail: `${FUNC_CHECKPOINT}: already patched` };
		}
		fail(`${FUNC_CHECKPOINT}: arm64 256K clamp not found`);
	}
	const index = body.indexOf(CLAMP_256K_X64);
	if (index >= 0) {
		if (body.indexOf(CLAMP_256K_X64, index + 1) >= 0) fail(`${FUNC_CHECKPOINT}: multiple 256K clamps found`);
		PATCH_256K_X64.copy(layout.data, offset + index);
		return { gate: "3A", changed: true, detail: `${FUNC_CHECKPOINT}: removed 256K clamp` };
	}
	if (body.indexOf(PATCH_256K_X64) >= 0) return { gate: "3A", changed: false, detail: `${FUNC_CHECKPOINT}: already patched` };
	fail(`${FUNC_CHECKPOINT}: x86-64 256K clamp not found`);
}

function gate3b(layout: Layout): ContextUnlockGate {
	const { offset, va, body } = functionBody(layout, FUNC_EXP_CHECKPOINT, 0x200);
	if (layout.arch === "arm64") {
		for (let rel = 4; rel + 16 <= body.length; rel += 4) {
			const first = body.readUInt32LE(rel);
			const second = body.readUInt32LE(rel + 4);
			if (((first & 0xff00001f) >>> 0) === 0xb4000000 && second === 0xb9000c1f) {
				return { gate: "3B", changed: false, detail: `${FUNC_EXP_CHECKPOINT}: already patched` };
			}
			if (((first & 0xff00001f) >>> 0) !== 0xb4000001) continue;
			const span = decodeImm19(first) * 4;
			if (span < 8 || span > 64 || rel + span + 8 > body.length) continue;
			const merge0 = body.readUInt32LE(rel + span);
			const merge1 = body.readUInt32LE(rel + span + 4);
			if (((merge0 & 0xffc003ff) >>> 0) === 0xf94003e1 && merge1 === 0xaa0003e2) {
				const patch = Buffer.concat([words((first & 0xffffffe0) >>> 0, 0xb9000c1f), Buffer.concat(Array((span - 8) / 4).fill(NOP_ARM64))]);
				patch.copy(layout.data, offset + rel);
				return { gate: "3B", changed: true, detail: `${FUNC_EXP_CHECKPOINT}: zeroed experimental maxTokenLimit` };
			}
		}
		const selector = layout.functions.get(FUNC_SELECT_EXP_KEY);
		if (selector) {
			const selectorVa = layout.textVa + selector.entryOff;
			for (let rel = 0; rel + 16 <= body.length; rel += 4) {
				if (decodeBlTarget(va + rel, body.readUInt32LE(rel)) !== selectorVa) continue;
				for (let scan = rel + 4; scan < Math.min(rel + 72, body.length - 4); scan += 4) {
					const indirect = body.readUInt32LE(scan);
					const branch = body.readUInt32LE(scan + 4);
					if (((indirect & 0xfffffc1f) >>> 0) !== 0xd63f0000) continue;
					if (branch === 0xd503201f) return { gate: "3B", changed: false, detail: `${FUNC_EXP_CHECKPOINT}: already patched` };
					if ((branch & 0xfffe001f) === 0x37000000 || (branch & 0x7f00001f) === 0x35000000) {
						NOP_ARM64.copy(layout.data, offset + scan + 4);
						return { gate: "3B", changed: true, detail: `${FUNC_EXP_CHECKPOINT}: bypassed HasFlag override` };
					}
				}
			}
		}
		fail(`${FUNC_EXP_CHECKPOINT}: arm64 override site not found`);
	}
	const selector = required(layout, FUNC_SELECT_EXP_KEY);
	const selectorVa = layout.textVa + selector.entryOff;
	for (let rel = 0; rel + 12 <= body.length; rel++) {
		if (body[rel] !== 0xe8) continue;
		const displacement = body.readInt32LE(rel + 1);
		if (va + rel + 5 + displacement !== selectorVa) continue;
		const window = body.subarray(rel + 5, Math.min(body.length, rel + 105));
		const test = window.indexOf(Buffer.from("84c0", "hex"));
		if (test < 0) continue;
		const branch = rel + 5 + test + 2;
		if (body.subarray(branch, branch + 2).equals(Buffer.from([0x90, 0x90]))) {
			return { gate: "3B", changed: false, detail: `${FUNC_EXP_CHECKPOINT}: already patched` };
		}
		if (body[branch] === 0x75) {
			layout.data.fill(0x90, offset + branch, offset + branch + 2);
			return { gate: "3B", changed: true, detail: `${FUNC_EXP_CHECKPOINT}: bypassed HasFlag override` };
		}
		if (body[branch] === 0x0f && body[branch + 1] === 0x85) {
			layout.data.fill(0x90, offset + branch, offset + branch + 6);
			return { gate: "3B", changed: true, detail: `${FUNC_EXP_CHECKPOINT}: bypassed HasFlag override` };
		}
	}
	fail(`${FUNC_EXP_CHECKPOINT}: x86-64 override site not found`);
}

function scanArm64StepDispatch(body: Buffer): { branch: number; nonUser: number } | undefined {
	for (let rel = 0; rel + 16 <= body.length; rel += 4) {
		const compare8 = body.readUInt32LE(rel);
		const equal = body.readUInt32LE(rel + 4);
		const compare19 = body.readUInt32LE(rel + 8);
		const notEqual = body.readUInt32LE(rel + 12);
		if (compare8 !== 0x7100201f || compare19 !== 0x71004c1f) continue;
		if (((equal & 0xff00001f) >>> 0) !== 0x54000000 || ((notEqual & 0xff00001f) >>> 0) !== 0x54000001) continue;
		const branch = rel + 12;
		return { branch, nonUser: branch + decodeImm19(notEqual) * 4 };
	}
	return undefined;
}

function scanX64StepDispatch(body: Buffer): { user: number; nonUser: number } | undefined {
	for (let rel = 0; rel + 24 <= body.length; rel++) {
		if (!body.subarray(rel, rel + 3).equals(Buffer.from([0x83, 0xf8, 0x08]))) continue;
		const compare19 = body.indexOf(Buffer.from([0x83, 0xf8, 0x13]), rel + 3);
		if (compare19 < 0 || compare19 >= rel + 19) continue;
		const branch = compare19 + 3;
		if (body[branch] === 0x75 && branch + 2 <= body.length) {
			return { user: branch + 2, nonUser: branch + 2 + body.readInt8(branch + 1) };
		}
		if (body[branch] === 0x0f && body[branch + 1] === 0x85 && branch + 6 <= body.length) {
			return { user: branch + 6, nonUser: branch + 6 + body.readInt32LE(branch + 2) };
		}
	}
	return undefined;
}

function findX64Epilogue(body: Buffer, start: number): { jump: number } | undefined {
	const end = Math.min(body.length, start + 64);
	const pop = body.indexOf(Buffer.from([0x5d, 0xc3]), start);
	const leave = body.indexOf(Buffer.from([0xc9, 0xc3]), start);
	if (leave >= 0 && leave < end && (pop < 0 || leave < pop)) return { jump: leave };
	if (pop < start + 4 || pop >= end) return undefined;
	let add: number | undefined;
	for (let rel = Math.max(0, pop - 16); rel < pop - 2; rel++) {
		if (body[rel] === 0x48 && body[rel + 1] === 0x83 && body[rel + 2] === 0xc4) add = rel;
		else if (body[rel] === 0x48 && body[rel + 1] === 0x81 && body[rel + 2] === 0xc4) add = rel;
	}
	return { jump: add ?? pop };
}

function gate4a(layout: Layout): ContextUnlockGate {
	const { offset, va, body } = functionBody(layout, FUNC_MAX_STEP_TOKENS, 0x100);
	if (layout.arch === "arm64") {
		const dispatch = scanArm64StepDispatch(body);
		if (!dispatch) fail(`${FUNC_MAX_STEP_TOKENS}: arm64 step-type dispatch not found`);
		if (dispatch.nonUser <= 0 || dispatch.nonUser > body.length - 8) fail(`${FUNC_MAX_STEP_TOKENS}: invalid non-user target`);
		if (body.readUInt32LE(dispatch.nonUser + 4) !== MOV_X0_X2) fail(`${FUNC_MAX_STEP_TOKENS}: non-user branch has unexpected epilogue`);
		const patchRel = dispatch.branch + 4;
		const patch = words(MOV_X2_XZR, encodeB(va + patchRel + 4, va + dispatch.nonUser + 4));
		const changed = !body.subarray(patchRel, patchRel + 8).equals(patch);
		if (changed) patch.copy(layout.data, offset + patchRel);
		return { gate: "4A", changed, detail: `${FUNC_MAX_STEP_TOKENS}: disabled USER_INPUT clamp` };
	}
	const dispatch = scanX64StepDispatch(body);
	if (!dispatch) fail(`${FUNC_MAX_STEP_TOKENS}: x86-64 step-type dispatch not found`);
	if (dispatch.nonUser <= 0 || dispatch.nonUser > body.length - 1) fail(`${FUNC_MAX_STEP_TOKENS}: invalid non-user target`);
	const epilogue = findX64Epilogue(body, dispatch.nonUser);
	if (!epilogue) fail(`${FUNC_MAX_STEP_TOKENS}: x86-64 epilogue not found`);
	const displacement = va + epilogue.jump - (va + dispatch.user + 7);
	if (displacement < -(2 ** 31) || displacement >= 2 ** 31) fail(`${FUNC_MAX_STEP_TOKENS}: epilogue jump out of range`);
	const patch = Buffer.concat([X64_ZERO_EAX, Buffer.from([0xe9]), int32(displacement)]);
	const changed = !body.subarray(dispatch.user, dispatch.user + patch.length).equals(patch);
	if (changed) patch.copy(layout.data, offset + dispatch.user);
	return { gate: "4A", changed, detail: `${FUNC_MAX_STEP_TOKENS}: disabled USER_INPUT clamp` };
}

function scanOneharnessArm64(body: Buffer): { branch: number; instruction: number } | undefined {
	for (let rel = 0; rel + 20 <= body.length; rel += 4) {
		const compare14 = body.readUInt32LE(rel);
		const equal = body.readUInt32LE(rel + 4);
		const compare23 = body.readUInt32LE(rel + 8);
		const notEqual = body.readUInt32LE(rel + 12);
		const zero = body.readUInt32LE(rel + 16);
		if (((compare14 & 0xfffffc1f) >>> 0) !== 0x7100381f) continue;
		if (((equal & 0xff00001f) >>> 0) !== 0x54000000 || ![ONEHARNESS_BEQ_WORD, ONEHARNESS_BEQ_PATCHED].includes(equal)) continue;
		if (compare23 !== (0x71005c1f | (compare14 & 0x03e0))) continue;
		if (((notEqual & 0xff00001f) >>> 0) !== 0x54000001 || ((zero & 0xffffffe0) >>> 0) !== 0xaa1f03e0) continue;
		return { branch: rel + 4, instruction: equal };
	}
	return undefined;
}

function matchX64Compare(body: Buffer, offset: number, rex: number | undefined, modrm: number, immediate: number): number | undefined {
	if (rex !== undefined) {
		return body[offset] === rex && body[offset + 1] === 0x83 && body[offset + 2] === modrm && body[offset + 3] === immediate ? offset + 4 : undefined;
	}
	return body[offset] === 0x83 && body[offset + 1] === modrm && body[offset + 2] === immediate ? offset + 3 : undefined;
}

function x64ZeroLength(body: Buffer, offset: number): number {
	if (body[offset] === 0x31) {
		const modrm = body[offset + 1]!;
		if (modrm >> 6 === 3 && ((modrm >> 3) & 7) === (modrm & 7)) return 2;
	}
	if (body[offset] === 0x45 && body[offset + 1] === 0x31) {
		const modrm = body[offset + 2]!;
		if (modrm >> 6 === 3 && ((modrm >> 3) & 7) === (modrm & 7)) return 3;
	}
	return 0;
}

function findX64ZeroingXor(body: Buffer, start: number): number | undefined {
	for (let rel = start; rel < Math.min(body.length - 2, start + 48); rel++) if (x64ZeroLength(body, rel) > 0) return rel;
	return undefined;
}

type OneharnessX64 = { kind: "je"; branch: number; zero: number } | { kind: "fallthrough"; start: number; patch: Buffer };

function scanOneharnessX64(body: Buffer): OneharnessX64 | undefined {
	for (let rel = 0; rel + 16 <= body.length; rel++) {
		let rex: number | undefined;
		let modrm: number;
		let compare: number;
		let branch: number;
		if (body[rel] === 0x83) {
			modrm = body[rel + 1]!; compare = rel; branch = rel + 3;
		} else if (body[rel] === 0x41 && body[rel + 1] === 0x83) {
			rex = 0x41; modrm = body[rel + 2]!; compare = rel + 1; branch = rel + 4;
		} else continue;
		if (modrm < 0xf8 || modrm > 0xff || body[compare + 2] !== 0x0e || branch + 1 >= body.length) continue;
		const operation = body[branch];
		if (operation === 0x74) {
			const notEqual = matchX64Compare(body, branch + 2, rex, modrm, 0x17);
			if (notEqual === undefined || body[notEqual] !== 0x75) continue;
			const zero = findX64ZeroingXor(body, notEqual + 2);
			if (zero !== undefined) return { kind: "je", branch, zero };
		} else if (operation === 0x75) {
			const displacement = body[branch + 1]!;
			if (displacement < 4 || displacement > 32) continue;
			const start = branch + 2;
			const compare23 = start + displacement;
			if (compare23 > body.length || body[compare23 - 2] !== 0xeb) continue;
			const merge14 = compare23 + body.readInt8(compare23 - 1);
			const notEqual = matchX64Compare(body, compare23, rex, modrm, 0x17);
			if (notEqual === undefined || body[notEqual] !== 0x75) continue;
			const zero = notEqual + 2;
			const zeroLength = x64ZeroLength(body, zero);
			const jump23 = zero + zeroLength;
			if (zeroLength === 0 || body[jump23] !== 0xeb) continue;
			const merge23 = jump23 + 2 + body.readInt8(jump23 + 1);
			const slotLength = compare23 - 2 - start;
			if (merge14 !== merge23 || slotLength < zeroLength) continue;
			return { kind: "fallthrough", start, patch: Buffer.concat([body.subarray(zero, zero + zeroLength), Buffer.alloc(slotLength - zeroLength, 0x90)]) };
		}
	}
	return undefined;
}

function gate4b(layout: Layout): ContextUnlockGate {
	if (!layout.functions.has(FUNC_ONEHARNESS_STEP)) {
		return { gate: "4B", changed: false, detail: `${FUNC_ONEHARNESS_STEP}: absent in this agy, skipped` };
	}
	const { offset, body } = functionBody(layout, FUNC_ONEHARNESS_STEP, 0x100);
	if (layout.arch === "arm64") {
		const dispatch = scanOneharnessArm64(body);
		if (!dispatch) fail(`${FUNC_ONEHARNESS_STEP}: arm64 OneHarness dispatch not found`);
		const changed = dispatch.instruction !== ONEHARNESS_BEQ_PATCHED;
		if (changed) layout.data.writeUInt32LE(ONEHARNESS_BEQ_PATCHED, offset + dispatch.branch);
		return { gate: "4B", changed, detail: `${FUNC_ONEHARNESS_STEP}: USER_INPUT uses zero token limit` };
	}
	const dispatch = scanOneharnessX64(body);
	if (!dispatch) fail(`${FUNC_ONEHARNESS_STEP}: x86-64 OneHarness dispatch not found`);
	if (dispatch.kind === "fallthrough") {
		const changed = !body.subarray(dispatch.start, dispatch.start + dispatch.patch.length).equals(dispatch.patch);
		if (changed) dispatch.patch.copy(layout.data, offset + dispatch.start);
		return { gate: "4B", changed, detail: `${FUNC_ONEHARNESS_STEP}: USER_INPUT uses zero token limit` };
	}
	const displacement = dispatch.zero - (dispatch.branch + 2);
	if (displacement < 0 || displacement > 0x7f) fail(`${FUNC_ONEHARNESS_STEP}: x86-64 je target out of range`);
	const changed = body[dispatch.branch + 1] !== displacement;
	if (changed) layout.data[dispatch.branch + 1 + offset] = displacement;
	return { gate: "4B", changed, detail: `${FUNC_ONEHARNESS_STEP}: USER_INPUT uses zero token limit` };
}

/** Apply every context gate to a copy of `source`; the source Buffer is untouched. */
export function patchAgyContextUnlock(source: Buffer): ContextUnlockResult {
	const text = findGoText(source);
	const layout: Layout = {
		data: Buffer.from(source),
		functions: buildGoFunctions(source),
		textVa: text.textVa,
		textOff: text.textOff,
		arch: text.arch,
	};
	const serverOnly = !layout.functions.has(FUNC_OFFERS) && !layout.functions.has(FUNC_STORE_CW);
	const patches = serverOnly ? [gate3a, gate3b, gate4a, gate4b] : [gate1, gate2, gate3a, gate3b, gate4a, gate4b];
	const gates = patches.map((patch) => patch(layout));
	return { data: layout.data, format: text.format, arch: text.arch, gates };
}
