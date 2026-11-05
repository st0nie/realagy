// The ACP server is the user's local Antigravity CLI: `agy acp`. It shares the
// CLI's sign-in, settings, and data dir (~/.gemini/antigravity-cli). realagy
// never installs or signs in agy; it only finds it and explains when missing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureQueuedMessagesInFile } from "../queued-messages.js";

export const MANUAL_SETUP = [
	"Install the Antigravity CLI and sign in once, then restart pi:",
	"  curl -fsSL https://antigravity.google/cli/install.sh | bash",
	"  agy",
	"Set AGY_BIN if agy is not on PATH or in ~/.local/bin.",
].join("\n");

export function agyDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.GEMINI_HOME || path.join(os.homedir(), ".gemini"), "antigravity-cli");
}

function executableFile(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function expandTilde(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** AGY_BIN > `agy` on PATH > ~/.local/bin/agy (install.sh's default; pi may
 *  run without the user's shell PATH). null when none is executable. */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string | null {
	const explicit = env.AGY_BIN?.trim();
	if (explicit) return executableFile(expandTilde(explicit)) ? expandTilde(explicit) : null;
	const name = process.platform === "win32" ? "agy.exe" : "agy";
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (dir && executableFile(path.join(dir, name))) return path.join(dir, name);
	}
	const local = path.join(os.homedir(), ".local", "bin", name);
	return executableFile(local) ? local : null;
}

export type AgySetupStatus = { ok: true; bin: string } | { ok: false; error: string; manual: string };

/** Find agy and default its queued-message delivery to send-immediately so
 *  pi steering works. */
export function ensureAgyReady(env: NodeJS.ProcessEnv = process.env): AgySetupStatus {
	const bin = resolveAgyBinary(env);
	if (!bin) {
		const error = env.AGY_BIN?.trim() ? `AGY_BIN is not an executable file: ${env.AGY_BIN}` : "the Antigravity CLI (agy) is not installed";
		return { ok: false, error, manual: MANUAL_SETUP };
	}
	ensureQueuedMessagesInFile(path.join(agyDataDir(env), "settings.json"));
	return { ok: true, bin };
}
