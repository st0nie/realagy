// Footer status: cache-hit rate from exact per-model-call usage (step_usage)
// and plan quota from `agy --print /usage`, plus agy's fixed "Usage Limit
// Reached" notice, which arrives as ordinary model text.

import { execFile } from "node:child_process";
import type { AgyStepUsage } from "./driver-types.js";

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

/** Parse `agy --print /usage --output-format json`. */
export function parseCliUsage(stdout: string): UsageGroup[] {
	let root: Record<string, unknown> | undefined;
	try {
		root = record(JSON.parse(stdout));
	} catch {
		throw new Error("agy /usage did not return JSON");
	}
	const status = str(root?.status);
	if (status && status !== "SUCCESS") throw new Error(str(root?.error) ?? `agy /usage failed (${status})`);
	const groups = record(record(root?.command)?.data)?.groups;
	const result: UsageGroup[] = [];
	for (const value of Array.isArray(groups) ? groups : []) {
		const group = record(value);
		const name = str(group?.name);
		if (!name) continue;
		const buckets: UsageBucket[] = [];
		for (const raw of Array.isArray(group?.buckets) ? group.buckets : []) {
			const bucket = record(raw);
			const fraction = bucket?.remaining_fraction;
			if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
			const resetTime = str(bucket?.reset_time);
			buckets.push({ window: str(bucket?.window) ?? str(bucket?.id) ?? "limit", remainingFraction: fraction, ...(resetTime ? { resetTime } : {}) });
		}
		result.push({ name, description: str(group?.description) ?? "", buckets });
	}
	if (result.length === 0) throw new Error("agy /usage returned no quota groups");
	return result;
}

export function fetchCliUsage(bin: string, timeoutMs = 60_000): Promise<UsageGroup[]> {
	return new Promise((resolve, reject) => {
		execFile(bin, ["--print", "/usage", "--output-format", "json"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) return reject(new Error(`agy /usage failed: ${error.message}`));
			try {
				resolve(parseCliUsage(stdout));
			} catch (parseError) {
				reject(parseError);
			}
		});
	});
}

/** The quota group a model draws from: agy names them "Gemini Models",
 *  "Claude and GPT models", and dedicated groups such as "Gemini 4 Argon". */
export function groupForModel(groups: UsageGroup[], modelId: string): UsageGroup | undefined {
	const id = modelId.toLowerCase().replace(/[-_.]/g, " ");
	const dedicated = groups.find((group) => id.includes(group.name.toLowerCase().replace(/[-_.]/g, " ")));
	if (dedicated) return dedicated;
	const family = /claude|gpt/.test(id) ? /claude|gpt/ : /gemini/;
	return groups.find((group) => family.test(group.name.toLowerCase()));
}

function percent(fraction: number): string {
	return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

export function formatReset(iso: string, now = new Date()): string | undefined {
	const reset = new Date(iso);
	if (Number.isNaN(reset.getTime())) return undefined;
	const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
	return reset.toDateString() === now.toDateString() ? time : `${reset.getDate()} ${MONTHS[reset.getMonth()]} ${time}`;
}

/** Per-extension accumulator behind the footer status. */
export class UsageMeter {
	prompt = 0;
	cacheRead = 0;
	/** Cache-hit ratio of the latest measured model calls (0–1). */
	lastHitRate: number | undefined;
	quota: UsageGroup[] | undefined;
	exhausted: { resetAt?: string } | undefined;
	onChange: (() => void) | undefined;

	addSteps(usage: AgyStepUsage): void {
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (prompt <= 0) return;
		this.prompt += prompt;
		this.cacheRead += usage.cacheRead;
		this.lastHitRate = usage.cacheRead / prompt;
		this.exhausted = undefined;
		this.onChange?.();
	}

	setQuota(groups: UsageGroup[]): void {
		this.quota = groups;
		this.onChange?.();
	}

	setExhausted(info: { resetAt?: string }): void {
		this.exhausted = info;
		this.onChange?.();
	}

	/** e.g. "agy cache 92% (session 78%) · quota 5h 99% · weekly 71%". */
	status(modelId: string | undefined, now = new Date()): string | undefined {
		const parts: string[] = [];
		if (this.prompt > 0) parts.push(`agy cache ${percent(this.lastHitRate ?? 0)} (session ${percent(this.cacheRead / this.prompt)})`);
		if (this.exhausted) {
			const reset = this.exhausted.resetAt ? formatReset(this.exhausted.resetAt, now) : undefined;
			parts.push(`quota exhausted${reset ? ` · resets ${reset}` : ""}`);
		} else if (this.quota && modelId) {
			const group = groupForModel(this.quota, modelId);
			const buckets = group?.buckets.map((bucket) => {
				const reset = bucket.remainingFraction < 1 && bucket.resetTime ? formatReset(bucket.resetTime, now) : undefined;
				return `${bucket.window} ${percent(bucket.remainingFraction)}${reset ? ` (${reset})` : ""}`;
			});
			if (buckets?.length) parts.push(`quota ${buckets.join(" · ")}`);
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
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
