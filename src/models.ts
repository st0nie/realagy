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
	/** Live limits from agy's model metadata (see modelLimitsFromAgy). */
	limits?: AgyModelLimits;
}

/** What pi should treat as a model's window and output cap. */
export interface AgyModelLimits {
	/** Usable context: agy's automatic compaction limit, not the model's raw
	 *  window. Past it agy replaces the session's history with its own summary,
	 *  so pi (and context extensions) must manage the transcript below it. */
	contextWindow: number;
	maxTokens: number;
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

/** Offline limits: agy's compaction limit (`max_token_limit` of the model's
 *  CASCADE_USE_EXPERIMENT_CHECKPOINTER config) and output cap, read from
 *  agy 1.5.2's GetAvailableModels on 2026-11-07. The raw windows are larger
 *  (1M for Gemini and Claude, 131k for GPT-OSS), but agy compacts a session
 *  once its context passes the limit. Unknown families get the smallest
 *  Gemini limit. */
export function familyLimits(full: string): AgyModelLimits {
	if (/^gpt-oss-/.test(full)) return { contextWindow: 80_000, maxTokens: 32_768 };
	if (/^claude-/.test(full)) return { contextWindow: 256_000, maxTokens: 128_000 };
	if (/^gemini-(?:3\.8|4)-/.test(full)) return { contextWindow: 256_000, maxTokens: 65_536 };
	return { contextWindow: 128_000, maxTokens: 65_536 };
}

/** Per-ACP-model limits from the body of agy's language-server RPC
 *  `GetAvailableModels`: the compaction limit when agy compacts the model's
 *  sessions (capped by the raw window), else the raw window. */
export function modelLimitsFromAgy(body: string): Map<string, AgyModelLimits> {
	const out = new Map<string, AgyModelLimits>();
	let models: unknown;
	try {
		models = (JSON.parse(body) as { response?: { models?: unknown } })?.response?.models;
	} catch {
		return out;
	}
	if (!models || typeof models !== "object") return out;
	for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const model = raw as { maxTokens?: unknown; maxOutputTokens?: unknown; modelExperiments?: { experiments?: Record<string, { stringValue?: unknown }> } };
		const window = positive(model.maxTokens);
		const maxTokens = positive(model.maxOutputTokens);
		if (!window || !maxTokens) continue;
		let contextWindow = window;
		const checkpointer = model.modelExperiments?.experiments?.CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue;
		if (typeof checkpointer === "string") {
			try {
				const config = JSON.parse(checkpointer) as { enabled?: unknown; max_token_limit?: unknown };
				const limit = positive(config.max_token_limit);
				if (config.enabled !== false && limit) contextWindow = Math.min(window, limit);
			} catch { /* keep the raw window */ }
		}
		out.set(id, { contextWindow, maxTokens: Math.min(maxTokens, Math.floor(contextWindow / 2)) });
	}
	return out;
}

function positive(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Attach live limits to catalog entries: an effort-driven entry gets the
 *  smallest limits of its tiers. Entries agy reports nothing for keep none. */
export function withModelLimits(entries: readonly AgyModelEntry[], limits: ReadonlyMap<string, AgyModelLimits>): AgyModelEntry[] {
	return entries.map((entry) => {
		const ids = entry.efforts?.length ? entry.efforts.map((effort) => `${entry.full}-${effort}`) : [entry.full];
		const found = ids.flatMap((id) => {
			const value = limits.get(id);
			return value ? [value] : [];
		});
		if (found.length === 0) return entry;
		return {
			...entry,
			limits: {
				contextWindow: Math.min(...found.map((value) => value.contextWindow)),
				maxTokens: Math.min(...found.map((value) => value.maxTokens)),
			},
		};
	});
}

/** GPT-OSS is text-only: it cannot see images, not even through agy's native
 *  read_file (verified live with agy 1.5.1). */
function familyInput(full: string): Array<"text" | "image"> {
	return /^gpt-oss-/.test(full) ? ["text"] : ["text", "image"];
}

export function toPiModel(entry: AgyModelEntry): Model<Api> {
	const effortDriven = !!entry.efforts?.length;
	const limits = entry.limits ?? familyLimits(entry.full);
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
