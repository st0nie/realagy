// agy's background work: commands it backgrounded and subagents it started
// finish after the prompt ended. agy then writes a message to
// `brain/<sessionId>/.system_generated/messages/<id>.json` (verified with agy
// 1.5.1) and runs its own follow-up turn, but ACP sends nothing while no prompt
// is in flight. This watcher polls the message directory of sessions with
// unfinished background work and reports each new message once.

import fs from "node:fs";
import path from "node:path";
import { agyDataDir } from "./setup.js";

export function defaultBrainDir(): string {
	return path.join(agyDataDir(), "brain");
}

export interface BackgroundNotice {
	sessionId: string;
	title: string;
	exitCode?: number;
	/** Last lines of the command output or message text. */
	tail: string;
}

export interface BackgroundWork {
	/** Prompt start (ms): messages written earlier belong to earlier work. */
	since: number;
	/** toolCallIds of native calls still running when the prompt ended. */
	taskIds: string[];
	/** Subagents started during the prompt. */
	subagents: number;
}

export interface BackgroundMessagesOptions {
	brainDir: () => string | undefined;
	onMessage: (notice: BackgroundNotice) => void;
	log?: (msg: string, data?: unknown) => void;
	intervalMs?: number;
	/** Stop watching a session this long after its last tracked work. */
	maxAgeMs?: number;
	now?: () => number;
}

interface Tracked {
	dir: string;
	since: number;
	taskIds: Set<string>;
	subagents: number;
	seen: Set<string>;
	deadline: number;
}

const POLL_MS = 2000;
const MAX_AGE_MS = 12 * 60 * 60_000;
const TAIL_LINES = 6;
const TAIL_CHARS = 600;

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

	track(sessionId: string, work: BackgroundWork): void {
		if (work.taskIds.length === 0 && work.subagents <= 0) return;
		const root = this.#opts.brainDir();
		if (!root) return;
		const now = this.#now();
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			for (const id of work.taskIds) existing.taskIds.add(id);
			existing.subagents += Math.max(0, work.subagents);
			existing.since = Math.min(existing.since, work.since);
			existing.deadline = now + (this.#opts.maxAgeMs ?? MAX_AGE_MS);
		} else {
			this.#sessions.set(sessionId, {
				dir: path.join(root, sessionId, ".system_generated", "messages"),
				since: work.since,
				taskIds: new Set(work.taskIds),
				subagents: Math.max(0, work.subagents),
				seen: new Set(),
				deadline: now + (this.#opts.maxAgeMs ?? MAX_AGE_MS),
			});
		}
		this.#log("background-track", { sessionId, tasks: work.taskIds.length, subagents: work.subagents });
		if (!this.#timer) {
			this.#timer = setInterval(() => this.poll(), this.#opts.intervalMs ?? POLL_MS);
			this.#timer.unref?.();
		}
	}

	/** One scan of every watched session (the interval calls this). */
	poll(): void {
		for (const [sessionId, tracked] of this.#sessions) {
			this.#scan(sessionId, tracked);
			if (tracked.taskIds.size === 0 && tracked.subagents === 0) {
				this.#sessions.delete(sessionId);
				this.#log("background-done", { sessionId });
			} else if (this.#now() > tracked.deadline) {
				this.#sessions.delete(sessionId);
				this.#log("background-expired", { sessionId, tasks: tracked.taskIds.size, subagents: tracked.subagents });
			}
		}
		if (this.#sessions.size === 0) this.#stop();
	}

	close(): void {
		this.#sessions.clear();
		this.#stop();
	}

	#scan(sessionId: string, tracked: Tracked): void {
		let files: string[];
		try {
			files = fs.readdirSync(tracked.dir);
		} catch {
			return; // not created yet
		}
		for (const file of files.sort()) {
			if (!file.endsWith(".json") || file === "read.json" || tracked.seen.has(file)) continue;
			const message = readMessage(path.join(tracked.dir, file));
			// A file still being written parses next time.
			if (!message) continue;
			tracked.seen.add(file);
			if (message.recipient !== sessionId || !message.sender || message.sender === sessionId) continue;
			if (message.timestamp !== undefined && message.timestamp < tracked.since) continue;
			// A backgrounded native call reports under its toolCallId; anything
			// else from another conversation is a subagent's message.
			const finishedTask = message.toolCallId !== undefined && tracked.taskIds.delete(message.toolCallId);
			if (!finishedTask && !message.sender.startsWith(`${sessionId}/`)) {
				tracked.subagents = Math.max(0, tracked.subagents - 1);
			}
			const notice = noticeFromMessage(sessionId, message);
			try {
				this.#opts.onMessage(notice);
			} catch (err) {
				this.#log("background-listener-failed", { message: err instanceof Error ? err.message : String(err) });
			}
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

/** Title, exit code, and output tail of one agy message. Task messages read
 *  "Command exited with code N.\n\nCommand output:\n…\n\nLog: file://…". */
export function noticeFromMessage(sessionId: string, message: Pick<AgyMessage, "title" | "content" | "sender">): BackgroundNotice {
	const content = message.content.replace(/\r/g, "");
	const exit = /Command exited with code (-?\d+)\.?/.exec(content);
	const outputAt = content.indexOf("Command output:\n");
	// The exit code is reported separately, so it is not repeated in the tail.
	const body = (outputAt >= 0 ? content.slice(outputAt + "Command output:\n".length) : content.replace(exit?.[0] ?? "", ""))
		.replace(/\n+Log: file:\/\/\S+\s*$/, "");
	const lines = body.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
	let tail = lines.slice(-TAIL_LINES).join("\n");
	if (tail.length > TAIL_CHARS) tail = `…${tail.slice(-(TAIL_CHARS - 1))}`;
	return {
		sessionId,
		title: message.title ?? `Message from ${message.sender ?? "agy"}`,
		...(exit ? { exitCode: Number(exit[1]) } : {}),
		tail,
	};
}

/** One pi notice for a background message. */
export function formatBackgroundNotice(notice: BackgroundNotice): string {
	const exit = notice.exitCode === undefined ? "" : ` (exit code ${notice.exitCode})`;
	return `Antigravity background: ${notice.title}${exit}${notice.tail ? `\n${notice.tail}` : ""}`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
