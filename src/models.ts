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
}

export interface AcpModelInfo {
	modelId: string;
	name?: string;
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

/** Convert ACP's availableModels directly. Its two fields are modelId and a
 * human label; no CLI subprocess or cached raw catalog is needed. */
export function entriesFromAcpModels(models: readonly AcpModelInfo[]): AgyModelEntry[] {
	const entries = entriesFromRaw(models.map((m) => m.modelId).join("\n"));
	return entries.map((entry) => {
		const source = models.find((m) => m.modelId === entry.full || m.modelId.startsWith(`${entry.full}-`));
		if (!source?.name) return entry;
		const name = entry.efforts ? source.name.replace(/\s+\((?:High|Medium|Low)\)$/i, "") : source.name;
		return { ...entry, name: name || entry.full };
	});
}

function thinkingLevelMapFor(efforts: readonly AgyEffort[]): ThinkingLevelMap {
	const map: Record<string, string | null> = { off: null, minimal: null };
	for (const level of AGY_EFFORT_ORDER) if (!efforts.includes(level)) map[level] = null;
	return map as ThinkingLevelMap;
}

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export interface ReportedModelLimits {
	contextWindow: number;
	maxTokens: number;
}

/** Independent Pi-side metadata. These values do not change Agy's real
 * model limits or whether the catalog proxy is enabled. */

/** GPT-OSS is text-only: it cannot see images, not even through agy's native
 *  read_file (verified live with agy 1.5.1). */
function familyInput(full: string): Array<"text" | "image"> {
	return /^gpt-oss-/.test(full) ? ["text"] : ["text", "image"];
}

export function toPiModel(
	entry: AgyModelEntry,
	limits: ReportedModelLimits = { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_OUTPUT_TOKENS },
): Model<Api> {
	const effortDriven = !!entry.efforts?.length;
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
		contextWindow: limits.contextWindow,
		maxTokens: limits.maxTokens,
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
