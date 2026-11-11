// Representative test models; production catalogs come exclusively from ACP or its cache.
import type { AgyModelEntry } from "../../src/models.js";

export const TEST_MODELS: AgyModelEntry[] = [
	{ full: "gemini-4-argon", id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
	{ full: "gemini-3.8-flash", id: "gemini-3-8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
	{ full: "gemini-3.1-pro", id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", efforts: ["low", "high"] },
	{ full: "claude-opus-5-5", id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
	{ full: "claude-sonnet-5-5", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
	{ full: "gpt-oss-120b", id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] },
];
