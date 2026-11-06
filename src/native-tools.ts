// Visibility of agy's own (native) tool calls in pi: a compact label per call,
// the thinking-block line written when a call finishes, and the live status
// line shown while calls run.

/** The bridge server that serves pi's tools; its calls are pi tool calls. */
export const PI_BRIDGE_SERVER = "pi-bridge";

const TARGET_MAX = 80;
const MIN_SHOWN_MS = 100;
/** Argument keys that name what a native call works on, most specific first
 *  (agy 1.5: run_command CommandLine, read_file/write_file Path, search_web
 *  query, invoke_subagent Role). */
const TARGET_KEYS = [
	"CommandLine", "command", "Path", "AbsolutePath", "TargetFile", "FilePath", "file_path", "path",
	"DirectoryPath", "SearchPath", "Url", "url", "Query", "query", "Role", "TaskName",
];

/** `<tool> <target>`: the target comes from the call's arguments, else from a
 *  title that is more than agy's generic `Run <tool>`. */
export function nativeToolLabel(name: string, args: Record<string, unknown>, title?: string): string {
	let target: string | undefined;
	for (const key of TARGET_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			target = value;
			break;
		}
	}
	if (target === undefined && title && title !== name && !/^Run(?:ning)?\s/i.test(title)) target = title;
	if (target === undefined) return name;
	const flat = target.replace(/\s+/g, " ").trim();
	return `${name} ${flat.length > TARGET_MAX ? `${flat.slice(0, TARGET_MAX - 1)}…` : flat}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

export interface NativeToolResult {
	label: string;
	/** ok/failed: finished during the turn; running: still running when the prompt ended. */
	status: "ok" | "failed" | "running";
	durationMs?: number;
	/** The call left work running after it returned (subagent, backgrounded command). */
	background: boolean;
}

/** The thinking-block line for one native call. */
export function nativeToolLine(result: NativeToolResult): string {
	if (result.status === "running") return `agy → ${result.label} … (runs in background)`;
	const mark = result.status === "ok" ? "✓" : "✗";
	// agy reports some calls (reads) only once they finished, start and end in
	// one burst: a sub-0.1 s figure would measure frame timing, not the call.
	const duration = result.durationMs === undefined || result.durationMs < MIN_SHOWN_MS ? "" : ` ${formatDuration(result.durationMs)}`;
	return `agy → ${result.label} ${mark}${duration}${result.background ? " (runs in background)" : ""}`;
}

export type NativeToolEvent =
	| { type: "start"; id: string; label: string; startedAt: number }
	| { type: "end"; id: string };

/** Live status text for the running native calls, refreshed every second
 *  while any runs. `set(undefined)` clears it. */
export class NativeToolStatus {
	#running = new Map<string, { label: string; startedAt: number }>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#closed = false;

	constructor(
		private readonly set: (text: string | undefined) => void,
		private readonly now: () => number = Date.now,
		private readonly intervalMs = 1000,
	) {}

	update(event: NativeToolEvent): void {
		if (this.#closed) return;
		if (event.type === "start") this.#running.set(event.id, { label: event.label, startedAt: event.startedAt });
		else if (!this.#running.delete(event.id)) return;
		this.#render();
		if (this.#running.size > 0 && !this.#timer) {
			this.#timer = setInterval(() => this.#render(), this.intervalMs);
			this.#timer.unref?.();
		} else if (this.#running.size === 0) this.#stopTimer();
	}

	/** Stop for good without touching the UI (pi may have replaced it). */
	close(): void {
		this.#closed = true;
		this.#running.clear();
		this.#stopTimer();
	}

	#render(): void {
		const first = this.#running.values().next().value;
		if (!first) {
			this.set(undefined);
			return;
		}
		const more = this.#running.size > 1 ? ` (+${this.#running.size - 1} more)` : "";
		this.set(`agy: ${first.label} … ${formatDuration(this.now() - first.startedAt)}${more}`);
	}

	#stopTimer(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}
}
