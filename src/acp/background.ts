// agy's background work: commands it backgrounded and subagents it started
// finish after the prompt ended. agy then writes a message to
// `brain/<sessionId>/.system_generated/messages/<id>.json` (verified with agy
// 1.5.1) and runs its own follow-up turn, but ACP sends nothing while no prompt
// is in flight. This watcher polls the message directory of sessions with
// unfinished background work and reports each poll's new messages together.

import fs from "node:fs";
import path from "node:path";
import { formatDuration } from "../native-tools.js";
import { agyDataDir } from "./setup.js";

export function defaultBrainDir(): string {
	return path.join(agyDataDir(), "brain");
}

/** One native call left running when its prompt ended. */
export interface BackgroundItem {
	/** ACP toolCallId of the call that started the work. */
	id: string;
	tool: string;
	target?: string;
	startedAt: number;
}

export interface BackgroundWork {
	/** Prompt start (ms): messages written earlier belong to earlier work. */
	since: number;
	/** Backgrounded native commands; agy reports them under their toolCallId. */
	tasks: BackgroundItem[];
	/** Subagents started during the prompt; they report from their own conversation. */
	subagents: BackgroundItem[];
}

export interface BackgroundNotice {
	sessionId: string;
	kind: "task" | "subagent" | "message";
	/** toolCallId of the matched work item. */
	workId?: string;
	tool?: string;
	target?: string;
	/** agy's title, e.g. "Sleep and print DONE finished". */
	title: string;
	exitCode?: number;
	/** From the call's start to agy's message. */
	durationMs?: number;
	/** Last 80 lines (at most 8 KB) for the model and the card. */
	output: string;
	/** agy's full task log. */
	logPath?: string;
}

export interface BackgroundMessagesOptions {
	brainDir: () => string | undefined;
	/** The new messages of one poll, never empty. */
	onMessages: (notices: BackgroundNotice[]) => void;
	/** Work dropped without a message (expired, or forgotten after agy exited). */
	onForget?: (workIds: string[]) => void;
	log?: (msg: string, data?: unknown) => void;
	intervalMs?: number;
	/** Stop watching a session this long after its last tracked work. */
	maxAgeMs?: number;
	now?: () => number;
}

interface Tracked {
	dir: string;
	since: number;
	tasks: Map<string, BackgroundItem>;
	subagents: Map<string, BackgroundItem>;
	seen: Set<string>;
	deadline: number;
}

const POLL_MS = 2000;
const MAX_AGE_MS = 12 * 60 * 60_000;
const OUTPUT_LINES = 80;
const OUTPUT_CHARS = 8000;

export class BackgroundMessages {
	#opts: BackgroundMessagesOptions;
	#sessions = new Map<string, Tracked>();
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(opts: BackgroundMessagesOptions) {
		this.#opts = opts;
	}

	/** Sessions currently watched (tests and diagnostics). */
	get watching(): string[] {
		return [...this.#sessions.keys()];
	}

	/** False when there is nowhere to watch (no brain directory). */
	track(sessionId: string, work: BackgroundWork): boolean {
		if (work.tasks.length === 0 && work.subagents.length === 0) return true;
		const root = this.#opts.brainDir();
		if (!root) return false;
		const deadline = this.#now() + (this.#opts.maxAgeMs ?? MAX_AGE_MS);
		let tracked = this.#sessions.get(sessionId);
		if (tracked) {
			tracked.since = Math.min(tracked.since, work.since);
			tracked.deadline = deadline;
		} else {
			tracked = {
				dir: path.join(root, sessionId, ".system_generated", "messages"),
				since: work.since,
				tasks: new Map(),
				subagents: new Map(),
				seen: new Set(),
				deadline,
			};
			this.#sessions.set(sessionId, tracked);
		}
		for (const item of work.tasks) tracked.tasks.set(item.id, item);
		for (const item of work.subagents) tracked.subagents.set(item.id, item);
		this.#log("background-track", { sessionId, tasks: work.tasks.length, subagents: work.subagents.length });
		if (!this.#timer) {
			this.#timer = setInterval(() => this.poll(), this.#opts.intervalMs ?? POLL_MS);
			this.#timer.unref?.();
		}
		return true;
	}

	/** One scan of every watched session (the interval calls this). */
	poll(): void {
		const notices: BackgroundNotice[] = [];
		const forgotten: string[] = [];
		for (const [sessionId, tracked] of this.#sessions) {
			this.#scan(sessionId, tracked, notices);
			if (tracked.tasks.size === 0 && tracked.subagents.size === 0) {
				this.#sessions.delete(sessionId);
				this.#log("background-done", { sessionId });
			} else if (this.#now() > tracked.deadline) {
				this.#sessions.delete(sessionId);
				forgotten.push(...tracked.tasks.keys(), ...tracked.subagents.keys());
				this.#log("background-expired", { sessionId, tasks: tracked.tasks.size, subagents: tracked.subagents.size });
			}
		}
		if (this.#sessions.size === 0) this.#stop();
		if (notices.length > 0) this.#call(() => this.#opts.onMessages(notices));
		if (forgotten.length > 0) this.#forgetIds(forgotten);
	}

	/** Drop all tracked work, e.g. when the agy process that ran it exited. */
	forgetAll(): void {
		const ids = [...this.#sessions.values()].flatMap((tracked) => [...tracked.tasks.keys(), ...tracked.subagents.keys()]);
		this.#sessions.clear();
		this.#stop();
		if (ids.length > 0) this.#forgetIds(ids);
	}

	/** Stop without reporting anything (shutdown). */
	close(): void {
		this.#sessions.clear();
		this.#stop();
	}

	#scan(sessionId: string, tracked: Tracked, notices: BackgroundNotice[]): void {
		let files: string[];
		try {
			files = fs.readdirSync(tracked.dir);
		} catch {
			return; // not created yet
		}
		// agy names messages by time-ordered ids; plain string order is intended.
		for (const file of files.sort((a, b) => a.localeCompare(b))) {
			if (!file.endsWith(".json") || file === "read.json" || tracked.seen.has(file)) continue;
			const message = readMessage(path.join(tracked.dir, file));
			// A file still being written parses next time.
			if (!message) continue;
			tracked.seen.add(file);
			if (message.recipient !== sessionId || !message.sender || message.sender === sessionId) continue;
			if (message.timestamp !== undefined && message.timestamp < tracked.since) continue;
			notices.push(noticeFromMessage(sessionId, message, matchWork(sessionId, tracked, message)));
		}
	}

	#forgetIds(ids: string[]): void {
		const { onForget } = this.#opts;
		if (onForget) this.#call(() => onForget(ids));
	}

	#call(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.#log("background-listener-failed", { message: err instanceof Error ? err.message : String(err) });
		}
	}

	#stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#now(): number {
		return this.#opts.now?.() ?? Date.now();
	}

	#log(msg: string, data?: unknown): void {
		this.#opts.log?.(msg, data);
	}
}

/** The tracked item a message reports on, removed from tracking. A
 *  backgrounded command reports under its toolCallId; a message from another
 *  conversation is a subagent's, matched by its role in agy's title
 *  ("Message from <Role> (<type>)"), else the oldest subagent. */
function matchWork(sessionId: string, tracked: Tracked, message: AgyMessage): { kind: BackgroundNotice["kind"]; item?: BackgroundItem } {
	const task = message.toolCallId ? tracked.tasks.get(message.toolCallId) : undefined;
	if (task) {
		tracked.tasks.delete(task.id);
		return { kind: "task", item: task };
	}
	if (message.sender?.startsWith(`${sessionId}/`)) return { kind: "message" };
	const subagents = [...tracked.subagents.values()];
	const subagent = subagents.find((item) => item.target && message.title?.includes(item.target)) ?? subagents[0];
	if (subagent) tracked.subagents.delete(subagent.id);
	return { kind: "subagent", item: subagent };
}

interface AgyMessage {
	recipient?: string;
	sender?: string;
	timestamp?: number;
	title?: string;
	content: string;
	toolCallId?: string;
}

function readMessage(file: string): AgyMessage | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	const m = record(raw);
	const time = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : Number.NaN;
	const toolCall = record(record(record(m.sourceMetadata).tool).toolCall);
	return {
		recipient: str(m.recipient),
		sender: str(m.sender),
		timestamp: Number.isFinite(time) ? time : undefined,
		title: str(record(m.renderDetails).messageTitle),
		content: typeof m.content === "string" ? m.content : "",
		toolCallId: str(toolCall.id),
	};
}

function lastLines(lines: string[], count: number, chars: number): string {
	const text = lines.slice(-count).join("\n");
	return text.length > chars ? `…${text.slice(-(chars - 1))}` : text;
}

/** Title, exit code, output, and log path of one agy message. Task messages
 *  read "Command exited with code N.\n\nCommand output:\n…\n\nLog: file://…". */
export function noticeFromMessage(
	sessionId: string,
	message: Pick<AgyMessage, "title" | "content" | "sender" | "timestamp">,
	work: { kind: BackgroundNotice["kind"]; item?: BackgroundItem } = { kind: "message" },
): BackgroundNotice {
	const content = message.content.replace(/\r/g, "");
	const exit = /Command exited with code (-?\d+)\.?/.exec(content);
	const log = /\n*Log: file:\/\/(\S+)\s*$/.exec(content);
	const outputAt = content.indexOf("Command output:\n");
	// The exit code and log path are reported separately, not in the output.
	const body = (outputAt >= 0 ? content.slice(outputAt + "Command output:\n".length) : content.replace(exit?.[0] ?? "", ""))
		.replace(/\n*Log: file:\/\/\S+\s*$/, "");
	const lines = body.split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
	while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
	const { item } = work;
	return {
		sessionId,
		kind: work.kind,
		...(item ? { workId: item.id, tool: item.tool, ...(item.target ? { target: item.target } : {}) } : {}),
		title: message.title ?? `Message from ${message.sender ?? "agy"}`,
		...(exit ? { exitCode: Number(exit[1]) } : {}),
		...(item && message.timestamp !== undefined ? { durationMs: Math.max(0, message.timestamp - item.startedAt) } : {}),
		output: lastLines(lines, OUTPUT_LINES, OUTPUT_CHARS),
		...(log ? { logPath: decodeURI(log[1]!) } : {}),
	};
}

/** True when the work failed (a non-zero exit code). */
export function noticeFailed(notice: BackgroundNotice): boolean {
	return notice.exitCode !== undefined && notice.exitCode !== 0;
}

/** The text pi's model reads: what finished, how, and its output. */
export function backgroundMessageText(notices: BackgroundNotice[]): string {
	const parts = notices.map((notice) => {
		const what = notice.tool
			? `${notice.kind === "subagent" ? "Subagent" : "Background command"} ${notice.tool}${notice.target ? ` \`${notice.target}\`` : ""} (agy: "${notice.title}")`
			: `agy message "${notice.title}"`;
		const facts = [
			notice.exitCode !== undefined ? `exit code ${notice.exitCode}` : undefined,
			notice.durationMs !== undefined ? `ran ${formatDuration(notice.durationMs)}` : undefined,
		].filter(Boolean).join(", ");
		const output = notice.output ? `\n${notice.kind === "subagent" ? "Reply" : "Output (last lines)"}:\n\`\`\`\n${notice.output}\n\`\`\`` : "\n(no output)";
		const log = notice.logPath ? `\nFull log: ${notice.logPath}` : "";
		return `- ${what} finished${facts ? `: ${facts}` : ""}.${output}${log}`;
	});
	return [`Antigravity background work started earlier in this conversation finished:`, ...parts].join("\n\n");
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
