// `/agy usage`: cache-hit rate from exact per-model-call usage (step_usage)
// and plan quota from the live `agy acp` Language Server ConnectRPC endpoint
// (with fallback to `agy --print /usage`), plus agy's fixed "Usage Limit
// Reached" notice, which arrives as ordinary model text.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agyDataDir } from "./acp/setup.js";
import type { AgyStepUsage } from "./driver-types.js";

const ACP_QUOTA_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const ACP_QUOTA_TIMEOUT_MS = 15_000;
const ACP_LOG_HEAD_BYTES = 64 * 1024;
const HTTP_PORT_RE = /Language server listening on [^\r\n]+? port at (\d+) for HTTP(?:\r?\n|$)/m;

const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOTICE = new RegExp(
	"(?:^|\\n)Usage Limit Reached\\n\\nYou have reached your current quota for this period\\." +
		"(?: Your limit will reset (?:in ((?:\\d+ (?:day|hour|minute|second)s?(?:, )?)+)" +
		`|on (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) UTC)\\.)?$`,
	"u",
);

export function quotaExhaustion(response: string, now = Date.now()): { resetAt?: string } | undefined {
	const match = NOTICE.exec(response.trim());
	if (!match) return undefined;
	const [, relative, month, day, year, hours, minutes] = match;
	if (relative) {
		let ms = 0;
		for (const [, n, unit] of relative.matchAll(/(\d+) (day|hour|minute|second)/gu)) ms += Number(n) * UNIT_MS[unit!]!;
		return { resetAt: new Date(now + ms).toISOString() };
	}
	if (month) return { resetAt: new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hours), Number(minutes))).toISOString() };
	return {};
}

export interface UsageBucket {
	window: string;
	remainingFraction: number;
	resetTime?: string;
}

export interface UsageGroup {
	name: string;
	description: string;
	buckets: UsageBucket[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function defaultAgyLogDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agyDataDir(env), "log");
}

let cachedAcpPort: { pid: number; logDir: string; port: number } | undefined;

/** Find the in-process Language Server HTTP port logged by `agy acp` on its
 *  first `session/new` (`acp-server-<timestamp>-<pid>.log`). */
export function findAcpHttpPort(pid: number, logDir = defaultAgyLogDir()): number | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (cachedAcpPort?.pid === pid && cachedAcpPort.logDir === logDir) return cachedAcpPort.port;
	let entries: string[];
	try {
		entries = fs.readdirSync(logDir);
	} catch {
		return undefined;
	}
	const suffix = `-${pid}.log`;
	const matches = entries
		.filter((name) => name.startsWith("acp-server-") && name.endsWith(suffix))
		.sort((a, b) => b.localeCompare(a));
	for (const name of matches) {
		try {
			const fd = fs.openSync(path.join(logDir, name), "r");
			let head: string;
			try {
				const buf = Buffer.allocUnsafe(ACP_LOG_HEAD_BYTES);
				const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
				head = buf.subarray(0, bytes).toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
			const match = HTTP_PORT_RE.exec(head);
			const port = match ? Number(match[1]) : NaN;
			if (Number.isInteger(port) && port > 0 && port <= 65535) {
				cachedAcpPort = { pid, logDir, port };
				return port;
			}
		} catch {
			// Try the next candidate or fall back.
		}
	}
	return undefined;
}

/** Parse `agy --print /usage --output-format json` or ConnectRPC `RetrieveUserQuotaSummary`. */
export function parseCliUsage(stdout: string): UsageGroup[] {
	let root: Record<string, unknown> | undefined;
	try {
		root = record(JSON.parse(stdout));
	} catch {
		throw new Error("agy /usage did not return JSON");
	}
	const status = str(root?.status);
	if (status && status !== "SUCCESS") throw new Error(str(root?.error) ?? `agy /usage failed (${status})`);
	const rpcMessage = str(root?.message);
	if (str(root?.code) && rpcMessage) throw new Error(rpcMessage);
	const data = record(record(root?.command)?.data) ?? record(root?.response) ?? root;
	const groups = data?.groups;
	const result: UsageGroup[] = [];
	for (const value of Array.isArray(groups) ? groups : []) {
		const group = record(value);
		const name = str(group?.name) ?? str(group?.displayName);
		if (!name) continue;
		const buckets: UsageBucket[] = [];
		for (const raw of Array.isArray(group?.buckets) ? group.buckets : []) {
			const bucket = record(raw);
			const fraction = bucket?.remaining_fraction ?? bucket?.remainingFraction;
			if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
			const resetTime = str(bucket?.reset_time) ?? str(bucket?.resetTime);
			buckets.push({
				window: str(bucket?.window) ?? str(bucket?.id) ?? str(bucket?.bucketId) ?? "limit",
				remainingFraction: fraction,
				...(resetTime ? { resetTime } : {}),
			});
		}
		result.push({ name, description: str(group?.description) ?? "", buckets });
	}
	if (result.length === 0) throw new Error("agy /usage returned no quota groups");
	return result;
}

/** Query the live `agy acp` process's local ConnectRPC Language Server for fresh quota. */
export async function fetchAcpQuota(
	port: number,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<UsageGroup[]> {
	const timeoutMs = options.timeoutMs ?? ACP_QUOTA_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const res = await fetch(`http://127.0.0.1:${port}${ACP_QUOTA_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ forceRefresh: true }),
		signal,
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`agy ACP quota HTTP ${res.status}: ${body.slice(0, 200)}`);
	return parseCliUsage(body);
}

export interface FetchUsageOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** PID of the live `agy acp` process, used to find its local HTTP port. */
	pid?: number;
	/** Directory holding `acp-server-*-<pid>.log` (default: `<agyDataDir>/log`). */
	logDir?: string;
	/** Explicit local Language Server HTTP port (skips log discovery). */
	port?: number;
}

export async function fetchCliUsage(
	bin: string,
	options: number | FetchUsageOptions = 60_000,
): Promise<UsageGroup[]> {
	const opts = typeof options === "number" ? { timeoutMs: options } : options;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const signal = opts.signal;
	let port = opts.port;
	if (port === undefined && opts.pid !== undefined) {
		port = findAcpHttpPort(opts.pid, opts.logDir);
	}
	if (port !== undefined) {
		try {
			return await fetchAcpQuota(port, { timeoutMs: Math.min(timeoutMs, ACP_QUOTA_TIMEOUT_MS), signal });
		} catch (error) {
			if (signal?.aborted) throw error;
			if (opts.pid !== undefined && cachedAcpPort?.pid === opts.pid) cachedAcpPort = undefined;
		}
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let output = "";
		const child = execFile(
			bin,
			["--print", "/usage", "--output-format", "json"],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", ...(signal ? { signal } : {}) },
			(error, stdout) => {
				if (settled) return;
				settled = true;
				if (error) return reject(new Error(`agy /usage failed: ${error.message}`));
				try {
					resolve(parseCliUsage(stdout));
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
		// `agy --print /usage` flushes its JSON line before spending ~1-2 s tearing
		// down its local language server; resolve as soon as the JSON is complete.
		child?.stdout?.on("data", (chunk: string | Buffer) => {
			if (settled) return;
			output += String(chunk);
			if (!output.includes("\n")) return;
			try {
				const groups = parseCliUsage(output);
				settled = true;
				resolve(groups);
			} catch {
				// Wait for the remaining chunks or process exit.
			}
		});
	});
}

/** Remaining share, rounded DOWN to 0.1% so a slightly used bucket never
 *  reads 100% (a few prompts can be ~1% of a large weekly quota). */
function percent(fraction: number): string {
	const clamped = Math.min(1, Math.max(0, fraction));
	if (clamped >= 1) return "100%";
	const tenths = Math.floor(clamped * 1000 + 1e-9) / 10;
	return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}%`;
}

export function formatReset(iso: string, now = new Date()): string | undefined {
	const reset = new Date(iso);
	if (Number.isNaN(reset.getTime())) return undefined;
	const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
	return reset.toDateString() === now.toDateString() ? time : `${reset.getDate()} ${MONTHS[reset.getMonth()]} ${time}`;
}

/** Per-extension accumulator behind `/agy usage`. */
export class UsageMeter {
	prompt = 0;
	cacheRead = 0;
	/** Cache-hit ratio of the latest measured model calls (0–1). */
	lastHitRate: number | undefined;
	quota: UsageGroup[] | undefined;
	exhausted: { resetAt?: string } | undefined;

	addSteps(usage: AgyStepUsage): void {
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		// steps === 0: sibling placeholder of an already counted model call.
		if (prompt <= 0 || usage.steps === 0) return;
		this.prompt += prompt;
		this.cacheRead += usage.cacheRead;
		this.lastHitRate = usage.cacheRead / prompt;
		this.exhausted = undefined;
	}

	setQuota(groups: UsageGroup[]): void {
		this.quota = groups;
	}

	setExhausted(info: { resetAt?: string }): void {
		this.exhausted = info;
	}

	/** Multi-line report for `/agy usage`. */
	report(now = new Date()): string {
		const lines: string[] = [];
		lines.push(this.prompt > 0
			? `Cache hits: ${percent(this.lastHitRate ?? 0)} latest · ${percent(this.cacheRead / this.prompt)} this session (${this.cacheRead} of ${this.prompt} prompt tokens)`
			: "Cache hits: no measured Antigravity calls yet");
		if (this.exhausted) lines.push(`Quota exhausted${this.exhausted.resetAt ? ` · resets ${formatReset(this.exhausted.resetAt, now)}` : ""}`);
		for (const group of this.quota ?? []) {
			lines.push("", group.name);
			for (const bucket of group.buckets) {
				const reset = bucket.resetTime ? formatReset(bucket.resetTime, now) : undefined;
				lines.push(`  ${bucket.window}: ${percent(bucket.remainingFraction)} left${reset ? ` · resets ${reset}` : ""}`);
			}
		}
		return lines.join("\n");
	}
}
