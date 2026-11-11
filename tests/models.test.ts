import assert from "node:assert/strict";
import { test } from "vitest";
import { entriesFromAcpModels, familyLimits, toAgyEffort, toPiModel } from "../src/models.js";

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

test("Pi models follow each model's real window by default and honor optional config overrides", () => {
	const entries = entriesFromAcpModels(LIVE);
	const argonEntry = entries.find((entry) => entry.id === "gemini-4-argon")!;
	const argon = toPiModel(argonEntry);
	assert.equal(argon.contextWindow, 1_048_576);
	assert.equal(argon.maxTokens, 65_536);

	const claudeEntry = entries.find((entry) => entry.id === "claude-sonnet-5-5")!;
	const claude = toPiModel(claudeEntry);
	assert.equal(claude.contextWindow, 1_000_000);
	assert.equal(claude.maxTokens, 128_000);
	assert.equal(toPiModel(claudeEntry, { contextWindow: 256_000 }).contextWindow, 256_000);
	assert.equal(toPiModel(claudeEntry, { contextWindow: 256_000 }).maxTokens, 128_000);
	assert.equal(toPiModel(claudeEntry, { maxOutputTokens: 32_000 }).maxTokens, 32_000);
	assert.deepEqual(claude.input, ["text", "image"]);
	assert.deepEqual(claude.thinkingLevelMap, { off: null, minimal: null });

	const gptEntry = entries.find((entry) => entry.id === "gpt-oss-120b")!;
	const gpt = toPiModel(gptEntry);
	assert.equal(gpt.contextWindow, 131_072);
	assert.equal(gpt.maxTokens, 32_768);
	// GPT-OSS cannot see images, not even through agy's native read_file.
	assert.deepEqual(gpt.input, ["text"]);
	assert.equal(gpt.reasoning, true);
	assert.deepEqual(gpt.thinkingLevelMap, { off: null, minimal: null, low: null, high: null });
	assert.equal(toAgyEffort("high", gptEntry.efforts!), "medium");

	// Upstream catalog limits captured by CatalogProxy win over family fallbacks,
	// while explicit config overrides still take precedence.
	const liveWithLimits = entriesFromAcpModels([
		{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", contextWindow: 2_097_152, maxTokens: 98_304 },
	]);
	assert.equal(toPiModel(liveWithLimits[0]).contextWindow, 2_097_152);
	assert.equal(toPiModel(liveWithLimits[0]).maxTokens, 98_304);
	assert.equal(toPiModel(liveWithLimits[0], { contextWindow: 500_000 }).contextWindow, 500_000);
	assert.deepEqual(familyLimits("gemini-4-argon"), { contextWindow: 1_048_576, maxTokens: 65_536 });
});

test("per-model context windows take precedence over the global fallback with exact Pi ID matching", () => {
	const entries = entriesFromAcpModels(LIVE);
	const argon = entries.find((entry) => entry.id === "gemini-4-argon")!;
	const claude = entries.find((entry) => entry.id === "claude-sonnet-5-5")!;
	const overrides = {
		contextWindow: 512_000,
		contextWindowOverrides: { "gemini-4-argon": 900_000 },
	};

	assert.equal(toPiModel(argon, overrides).contextWindow, 900_000);
	assert.equal(toPiModel(argon, overrides).maxTokens, 65_536);
	assert.equal(toPiModel(claude, overrides).contextWindow, 512_000);
	assert.equal(toPiModel(claude, overrides).maxTokens, 128_000);

	// Matching is case-sensitive and uses the grouped Pi ID, not an ACP tier ID.
	assert.equal(toPiModel(argon, { contextWindowOverrides: { "Gemini-4-argon": 800_000 } }).contextWindow, 1_048_576);
	assert.equal(toPiModel(argon, { contextWindowOverrides: { "gemini-4-argon-high": 800_000 } }).contextWindow, 1_048_576);
	assert.equal(toPiModel(argon, { contextWindowOverrides: { "gemini-4-argon": 800_000 } }).contextWindow, 800_000);
});

test("per-model output tokens take precedence over the global fallback with exact Pi ID matching", () => {
	const entries = entriesFromAcpModels(LIVE);
	const argon = entries.find((entry) => entry.id === "gemini-4-argon")!;
	const claude = entries.find((entry) => entry.id === "claude-sonnet-5-5")!;
	const overrides = {
		maxOutputTokens: 64_000,
		maxOutputTokensOverrides: { "gemini-4-argon": 48_000 },
	};

	assert.equal(toPiModel(argon, overrides).maxTokens, 48_000);
	assert.equal(toPiModel(argon, overrides).contextWindow, 1_048_576);
	assert.equal(toPiModel(claude, overrides).maxTokens, 64_000);
	assert.equal(toPiModel(claude, overrides).contextWindow, 1_000_000);
	assert.equal(toPiModel(argon, { maxOutputTokensOverrides: { "Gemini-4-argon": 48_000 } }).maxTokens, 65_536);
	assert.equal(toPiModel(argon, { maxOutputTokensOverrides: { "gemini-4-argon-high": 48_000 } }).maxTokens, 65_536);
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
