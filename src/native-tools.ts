// Visibility of agy's own (native) tool calls in pi: a compact label per call,
// the thinking-block line written when a call finishes, and the live panel
// that lists running calls, background commands, and subagents.

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** The bridge server that serves pi's tools; its calls are pi tool calls. */
export const PI_BRIDGE_SERVER = "pi-bridge";

const TARGET_MAX = 80;
const PANEL_TARGET_MAX = 60;
const PANEL_MAX_ROWS = 5;
const MIN_SHOWN_MS = 100;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Argument keys that name what a native call works on, most specific first
 *  (agy 1.5: run_command CommandLine, read_file/write_file Path, search_web
 *  query, invoke_subagent Role). */
const TARGET_KEYS = [
	"CommandLine", "command", "Path", "AbsolutePath", "TargetFile", "FilePath", "file_path", "path",
	"DirectoryPath", "SearchPath", "Url", "url", "Query", "query", "Role", "TaskName",
];

/** What a native call works on: from its arguments, else from a title that is
 *  more than agy's generic `Run <tool>`. Whitespace is collapsed. */
export function nativeToolTarget(name: string, args: Record<string, unknown>, title?: string): string | undefined {
	let target: string | undefined;
	for (const key of TARGET_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			target = value;
			break;
		}
	}
	if (target === undefined && title && title !== name && !/^Run(?:ning)?\s/i.test(title)) target = title;
	return target === undefined ? undefined : target.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `<tool> <target>`, the target clipped to 80 characters. */
export function nativeToolLabel(name: string, target: string | undefined): string {
	return target ? `${name} ${clip(target, TARGET_MAX)}` : name;
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

/** Kinds of agy work the panel shows. */
export type AgyWorkKind = "call" | "task" | "subagent";

export type NativeToolEvent =
	/** A native call of the current turn started. */
	| { type: "start"; id: string; tool: string; target?: string; startedAt: number }
	/** A started call keeps running after the prompt ended: a backgrounded
	 *  command (task) or a subagent. */
	| { type: "background"; id: string; kind: "task" | "subagent" }
	| { type: "end"; id: string };

/** The subset of pi's Theme the panel uses. */
export interface PanelStyle {
	fg(color: "accent" | "muted" | "dim" | "toolTitle", text: string): string;
}

/** The panel's widget as pi's setWidget factory receives it. */
export type PanelWidget = (tui: { requestRender(): void }, theme: PanelStyle) => Component & { dispose(): void };

/** Where the panel lives: pi's editor widget slot. */
export interface PanelHost {
	show(widget: PanelWidget): void;
	hide(): void;
}

interface PanelItem {
	tool: string;
	target?: string;
	kind: AgyWorkKind;
	startedAt: number;
}

const PANEL_KIND_NAME: Record<"task" | "subagent", string> = { task: "background", subagent: "subagent" };

/** The live panel of running agy work. It is mounted once when work starts
 *  and removed when the last item ends; in between, a timer turns the spinner
 *  and asks pi's TUI to redraw (pi coalesces redraws), only while items run. */
export class AgyWorkPanel {
	#items = new Map<string, PanelItem>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#frame = 0;
	#closed = false;
	#mounted = false;
	#requestRender: (() => void) | undefined;
	readonly #host: PanelHost;
	readonly #now: () => number;
	readonly #intervalMs: number;

	constructor(host: PanelHost, options: { now?: () => number; intervalMs?: number } = {}) {
		this.#host = host;
		this.#now = options.now ?? Date.now;
		this.#intervalMs = options.intervalMs ?? 100;
	}

	get size(): number {
		return this.#items.size;
	}

	update(event: NativeToolEvent): void {
		if (this.#closed) return;
		if (event.type === "start") {
			this.#items.set(event.id, { tool: event.tool, target: event.target, kind: "call", startedAt: event.startedAt });
		} else if (event.type === "background") {
			const item = this.#items.get(event.id);
			if (!item) return;
			item.kind = event.kind;
		} else if (!this.#items.delete(event.id)) {
			return;
		}
		if (this.#items.size === 0) {
			this.#unmount();
			return;
		}
		if (this.#mounted) {
			this.#requestRender?.();
			return;
		}
		this.#mounted = true;
		this.#host.show((tui, theme) => {
			this.#requestRender = () => tui.requestRender();
			return {
				render: (width) => this.lines(theme).map((line) => truncateToWidth(` ${line}`, width)),
				invalidate: () => {},
				dispose: () => {
					this.#requestRender = undefined;
				},
			};
		});
		this.#timer = setInterval(() => {
			this.#frame = (this.#frame + 1) % SPINNER.length;
			this.#requestRender?.();
		}, this.#intervalMs);
		this.#timer.unref?.();
	}

	/** One row per running item (at most five, then a summary). */
	lines(style: PanelStyle): string[] {
		const items = [...this.#items.values()];
		if (items.length === 0) return [];
		const shown = items.slice(0, PANEL_MAX_ROWS);
		const names = shown.map((item) => (item.kind === "call" ? item.tool : PANEL_KIND_NAME[item.kind]));
		const width = Math.max(...names.map((name) => name.length));
		const spinner = style.fg("accent", SPINNER[this.#frame]!);
		const lines = shown.map((item, i) => {
			const target = item.target ? `  ${clip(item.target, PANEL_TARGET_MAX)}` : "";
			const elapsed = style.fg("dim", formatDuration(this.#now() - item.startedAt));
			return `${spinner} ${style.fg("muted", "agy")}  ${style.fg("toolTitle", names[i]!.padEnd(width))}${target}  ${elapsed}`;
		});
		if (items.length > shown.length) lines.push(style.fg("dim", `  … ${items.length - shown.length} more`));
		return lines;
	}

	/** Stop for good without touching the UI (pi may have replaced it). */
	close(): void {
		this.#closed = true;
		this.#items.clear();
		this.#stopTimer();
		this.#requestRender = undefined;
	}

	#unmount(): void {
		this.#stopTimer();
		if (!this.#mounted) return;
		this.#mounted = false;
		this.#requestRender = undefined;
		this.#host.hide();
	}

	#stopTimer(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}
}
