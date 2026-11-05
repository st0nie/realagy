// Opt-in usage/context diagnostics. REALAGY_TRACE_USAGE=1 appends JSON lines
// to ~/.pi/agent/realagy/usage-trace.jsonl; an absolute path selects another
// file. Records only counts and ids, never prompt or tool content.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tracePath(): string | undefined {
	const value = process.env.REALAGY_TRACE_USAGE?.trim();
	if (!value || value === "0" || value === "false") return undefined;
	return path.isAbsolute(value) ? value : path.join(os.homedir(), ".pi", "agent", "realagy", "usage-trace.jsonl");
}

export function traceUsage(event: string, data: Record<string, unknown>): void {
	const file = tracePath();
	if (!file) return;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`);
	} catch {
		/* diagnostics must never break a turn */
	}
}
