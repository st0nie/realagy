import assert from "node:assert/strict";
import { test } from "vitest";
import { entriesFromAcpModels, FALLBACK_MODELS, toAgyEffort, toPiModel } from "../src/models.js";

const LIVE = [
	{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
	{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
	{ modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
	{ modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
	{ modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
	{ modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
	{ modelId: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
	{ modelId: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
	{ modelId: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
	{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

test("ACP catalog exposes Gemini, Claude, and GPT with correct tiers and labels", () => {
	const entries = entriesFromAcpModels(LIVE);
	assert.deepEqual(entries.map((entry) => [entry.id, entry.name, entry.efforts]), [
		["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
		["claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]],
		["claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]],
		["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
	]);
});

test("pi model metadata matches live family limits and image/reasoning support", () => {
	const entries = entriesFromAcpModels(LIVE);
	const claude = toPiModel(entries.find((entry) => entry.id === "claude-sonnet-5-5")!);
	assert.equal(claude.contextWindow, 1_000_000);
	assert.equal(claude.maxTokens, 128_000);
	assert.deepEqual(claude.input, ["text", "image"]);
	assert.deepEqual(claude.thinkingLevelMap, { off: null, minimal: null });

	const gpt = toPiModel(entries.find((entry) => entry.id === "gpt-oss-120b")!);
	assert.equal(gpt.contextWindow, 131_072);
	assert.equal(gpt.maxTokens, 32_768);
	// GPT-OSS cannot see images, not even through agy's native read_file.
	assert.deepEqual(gpt.input, ["text"]);
	assert.equal(gpt.reasoning, true);
	assert.deepEqual(gpt.thinkingLevelMap, { off: null, minimal: null, low: null, high: null });
	assert.equal(toAgyEffort("high", entries.find((entry) => entry.id === "gpt-oss-120b")!.efforts!), "medium");
});

test("unknown families remain exact-slug fixed models and noise is rejected", () => {
	const entries = entriesFromAcpModels([
		{ modelId: "Available models:" },
		{ modelId: "futuremodel-x-low", name: "Future Low" },
		{ modelId: "futuremodel-x-high", name: "Future High" },
	]);
	assert.deepEqual(entries.map((entry) => [entry.full, entry.efforts]), [
		["futuremodel-x-low", undefined],
		["futuremodel-x-high", undefined],
	]);
	assert.equal(toPiModel(entries[0]).reasoning, false);
});

test("offline fallback also includes every supported family", () => {
	for (const id of ["gemini-4-argon", "gemini-3-8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]) {
		assert.ok(FALLBACK_MODELS.some((entry) => entry.id === id), id);
	}
});
