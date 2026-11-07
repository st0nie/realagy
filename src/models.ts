// Antigravity's ACP model catalog, projected into pi's native Model shape.
// No agy CLI discovery, config file, or second model cache is involved.

import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type AgyEffort = "low" | "medium" | "high";
export const AGY_EFFORT_ORDER: readonly AgyEffort[] = ["low", "medium", "high"];
const EFFORT_RANK: Record<AgyEffort, number> = { low: 0, medium: 1, high: 2 };
const TIER_RE = /^(.+)-(high|medium|low)$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9._-]*$/;
// Base-slug + effort is verified for these families. GPT-OSS currently offers
// only medium, so pi exposes a one-stop thinking toggle rather than hiding it.
const EFFORT_CAPABLE = [/^gemini-/, /^claude-/, /^gpt-oss-/];

export interface AgyModelEntry {
	/** Base slug for effort-driven models, otherwise the exact ACP model id. */
	full: string;
	id: string;
	name?: string;
	efforts?: AgyEffort[];
	contextWindow?: number;
	maxTokens?: number;
}

export interface AcpModelInfo {
	modelId: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export function toAgyEffort(reasoning: ThinkingLevel | undefined, efforts: readonly AgyEffort[]): AgyEffort {
	let wanted: AgyEffort;
	switch (reasoning) {
		case "high":
		case "xhigh":
		case "max":
			wanted = "high";
			break;
		case "medium":
			wanted = "medium";
			break;
		case "minimal":
		case "low":
			wanted = "low";
			break;
		default:
			wanted = efforts.includes("medium") ? "medium" : (efforts[0] ?? "low");
	}
	if (efforts.includes(wanted)) return wanted;
	const start = AGY_EFFORT_ORDER.indexOf(wanted);
	for (let i = start; i < AGY_EFFORT_ORDER.length; i++) if (efforts.includes(AGY_EFFORT_ORDER[i])) return AGY_EFFORT_ORDER[i];
	for (let i = start - 1; i >= 0; i--) if (efforts.includes(AGY_EFFORT_ORDER[i])) return AGY_EFFORT_ORDER[i];
	return efforts[0] ?? "low";
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Group tier variants into one pi model. Unknown families stay exact-slug and
 * fixed-thinking, so a future model never receives an unverified effort. */
export function entriesFromRaw(raw: string): AgyModelEntry[] {
	const groups = new Map<string, { variants: string[]; tiers: Set<AgyEffort> }>();
	for (const line of raw.split("\n")) {
		const full = line.trim().split(/\s+/)[0] ?? "";
		if (!MODEL_ID_RE.test(full)) continue;
		const match = TIER_RE.exec(full);
		const base = match?.[1] ?? full;
		const tier = match?.[2] as AgyEffort | undefined;
		const group = groups.get(base) ?? { variants: [], tiers: new Set<AgyEffort>() };
		group.variants.push(full);
		if (tier) group.tiers.add(tier);
		groups.set(base, group);
	}
	const entries: AgyModelEntry[] = [];
	for (const [base, group] of groups) {
		const efforts = [...group.tiers].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
		if (efforts.length > 0 && EFFORT_CAPABLE.some((re) => re.test(base))) {
			entries.push({ full: base, id: slugify(base), efforts });
		} else {
			for (const full of group.variants) entries.push({ full, id: slugify(full) });
		}
	}
	return entries.filter((entry) => entry.id.length > 0);
}

/** Convert ACP's availableModels directly, preserving any upstream token limits
 * captured from the Cloud Code model catalog. */
export function entriesFromAcpModels(models: readonly AcpModelInfo[]): AgyModelEntry[] {
	const entries = entriesFromRaw(models.map((m) => m.modelId).join("\n"));
	return entries.map((entry) => {
		const variants = models.filter((m) =>
			entry.efforts
				? TIER_RE.exec(m.modelId)?.[1] === entry.full || m.modelId === entry.full
				: m.modelId === entry.full,
		);
		const named = variants.find((m) => m.name !== undefined);
		const rawName = named?.name
			? entry.efforts
				? named.name.replace(/\s+\((?:High|Medium|Low)\)$/i, "")
				: named.name
			: undefined;
		const contextWindow = variants.find((m) => m.contextWindow !== undefined)?.contextWindow;
		const maxTokens = variants.find((m) => m.maxTokens !== undefined)?.maxTokens;
		const result: AgyModelEntry = { ...entry };
		if (rawName !== undefined) result.name = rawName || entry.full;
		if (contextWindow !== undefined) result.contextWindow = contextWindow;
		if (maxTokens !== undefined) result.maxTokens = maxTokens;
		return result;
	});
}

function thinkingLevelMapFor(efforts: readonly AgyEffort[]): ThinkingLevelMap {
	const map: Record<string, string | null> = { off: null, minimal: null };
	for (const level of AGY_EFFORT_ORDER) if (!efforts.includes(level)) map[level] = null;
	return map as ThinkingLevelMap;
}

/** Per-family limits from live Cloud Code model metadata (verified 2026-11).
 * Used before live discovery finishes or when the catalog proxy is disabled. */
export function familyLimits(full: string): { contextWindow: number; maxTokens: number } {
	if (/^gpt-oss-/.test(full)) return { contextWindow: 131_072, maxTokens: 32_768 };
	if (/^claude-/.test(full)) return { contextWindow: 1_000_000, maxTokens: 128_000 };
	return { contextWindow: 1_048_576, maxTokens: 65_536 };
}

/** Optional Pi-side metadata overrides from ~/.pi/agent/realagy/config.json.
 * Omitted fields follow each model's real context window and output limit. */
export interface ModelLimitOverrides {
	contextWindow?: number;
	maxOutputTokens?: number;
}

/** GPT-OSS is text-only: it cannot see images, not even through agy's native
 *  read_file (verified live with agy 1.5.1). */
function familyInput(full: string): Array<"text" | "image"> {
	return /^gpt-oss-/.test(full) ? ["text"] : ["text", "image"];
}

export function toPiModel(entry: AgyModelEntry, overrides?: ModelLimitOverrides): Model<Api> {
	const effortDriven = !!entry.efforts?.length;
	const defaults = familyLimits(entry.full);
	return {
		id: entry.id,
		name: entry.name ?? entry.full,
		api: "agy-bridge" as Api,
		provider: "antigravity",
		baseUrl: "agy-bridge://antigravity",
		reasoning: effortDriven,
		...(effortDriven ? { thinkingLevelMap: thinkingLevelMapFor(entry.efforts!) } : {}),
		input: familyInput(entry.full),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides?.contextWindow ?? entry.contextWindow ?? defaults.contextWindow,
		maxTokens: overrides?.maxOutputTokens ?? entry.maxTokens ?? defaults.maxTokens,
	};
}

/** Offline/auth-pending catalog. ACP replaces it with the account's live list
 * at session_start; keeping these entries makes the picker useful immediately. */
export const FALLBACK_MODELS: AgyModelEntry[] = [
	{ full: "gemini-4-argon", id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
	{ full: "gemini-3.8-flash", id: "gemini-3-8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
	{ full: "gemini-3.1-pro", id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", efforts: ["low", "high"] },
	{ full: "claude-opus-5-5", id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
	{ full: "claude-sonnet-5-5", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
	{ full: "gpt-oss-120b", id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] },
];
