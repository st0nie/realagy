// Derive realagy's private agy executable when context unlocking or full MCP
// output is enabled. The source is read once, all enabled patches are applied
// to the same in-memory copy, then the result is signed once, verified by
// SHA-256, and cached in derived-bin/. A patch failure aborts startup; the
// installed agy is never opened for writing. With both patches disabled the
// source path is returned.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { inspectExecutable, signMacOSBinary } from "./binary-image.js";
import { patchAgyContextUnlock } from "./context-unlock.js";
import { patchAgyOutputTruncation } from "./output-patch.js";

const CACHE_DIR = path.join(getAgentDir(), "realagy", "derived-bin");
const CONTEXT_PATCH = "context-unlock";
const OUTPUT_PATCH = "full-mcp-output";
export interface DeriveAgyOptions {
	/** Apply the full-MCP-output patch; failure to apply it is an error. */
	fullMcpOutput: boolean;
	/** Apply the context-window and USER_INPUT unlock patch. Default false. */
	contextUnlock?: boolean;
	cacheDir?: string;
	log?: (msg: string, data?: unknown) => void;
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

/** Remove every other derivative (older agy versions, other patch sets); a
 *  running executable that cannot be removed (Windows) is left for later. */
async function pruneOthers(cacheDir: string, keep: string, log?: DeriveAgyOptions["log"]): Promise<void> {
	const keepName = path.basename(keep);
	let names: string[];
	try {
		names = await fs.promises.readdir(cacheDir);
	} catch {
		return;
	}
	const removed: string[] = [];
	for (const name of names) {
		if (!name.startsWith("agy-") || name.endsWith(".tmp") || name === keepName || name === `${keepName}.sha256`) continue;
		try {
			await fs.promises.unlink(path.join(cacheDir, name));
			removed.push(name);
		} catch {
			// Still in use or already gone; a later start retries.
		}
	}
	if (removed.length > 0) log?.("derived-agy-pruned", { removed });
}

async function write(output: string, data: Buffer, macho: boolean): Promise<string> {
	// Same-content racing writers are harmless; rename exposes only a complete
	// executable to other pi processes.
	const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const hashTemporary = `${output}.sha256.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, data, { mode: 0o755 });
		await fs.promises.chmod(temporary, 0o755);
		if (macho) await signMacOSBinary(temporary);
		const outputHash = await fileSha256(temporary);
		if (!outputHash) throw new Error("Cannot hash the derived agy executable.");
		await fs.promises.rename(temporary, output);
		await fs.promises.writeFile(hashTemporary, `${outputHash}\n`, { mode: 0o600 });
		await fs.promises.rename(hashTemporary, `${output}.sha256`);
		return outputHash;
	} finally {
		await fs.promises.unlink(temporary).catch(() => undefined);
		await fs.promises.unlink(hashTemporary).catch(() => undefined);
	}
}

async function derive(sourcePath: string, options: DeriveAgyOptions, cacheDir: string): Promise<string> {
	const { fullMcpOutput, contextUnlock = false, log } = options;
	const source = await fs.promises.readFile(sourcePath);
	const sourceHash = sha256(source);
	const image = inspectExecutable(source);
	const patches = [...(contextUnlock ? [CONTEXT_PATCH] : []), ...(fullMcpOutput ? [OUTPUT_PATCH] : [])];
	const output = path.join(cacheDir, `agy-${sourceHash}-${patches.join("+")}${image.format === "pe" ? ".exe" : ""}`);
	if (!(await validCache(output))) {
		// Any patch that does not apply aborts derivation; nothing is written.
		let data: Buffer = source;
		const details: Record<string, unknown> = {};
		if (contextUnlock) {
			const patched = patchAgyContextUnlock(data);
			data = patched.data;
			details.context = patched.gates;
		}
		if (fullMcpOutput) {
			const patched = patchAgyOutputTruncation(data);
			data = patched.data;
			details.output = { offset: patched.offset, target: patched.target };
		}
		await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 });
		const outputSha256 = await write(output, data, image.format === "macho");
		log?.("agy-derived", { source: sourcePath, sourceSha256: sourceHash, output, outputSha256, format: image.format, arch: image.arch, patches, ...details });
	}
	await pruneOthers(cacheDir, output, log);
	return output;
}

const inFlight = new Map<string, Promise<string>>();

/** Return realagy's verified single derivative of `sourcePath`, deriving it
 *  when agy's bytes or the requested patches changed. */
export function deriveAgy(sourcePath: string, options: DeriveAgyOptions): Promise<string> {
	const source = path.resolve(sourcePath);
	if (!options.fullMcpOutput && !options.contextUnlock) return Promise.resolve(source);
	const cacheDir = options.cacheDir ?? CACHE_DIR;
	const key = `${source}\0${cacheDir}\0${options.fullMcpOutput}\0${options.contextUnlock === true}`;
	let pending = inFlight.get(key);
	if (!pending) {
		pending = derive(source, options, cacheDir).finally(() => {
			if (inFlight.get(key) === pending) inFlight.delete(key);
		});
		inFlight.set(key, pending);
	}
	return pending;
}
