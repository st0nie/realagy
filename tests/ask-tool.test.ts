// Tests for the AskAntigravity tool's catalog parsing and alias resolution.
//
// agy prints TWO columns per line: "<slug>  <display label>". --model takes
// only the slug (col 1); the label is display-only. Gemini bases split their
// tier out to a separate --effort (the base slug alone is invalid); fixed
// families (claude-*, gpt-oss-*) keep agy's exact slug with NO --effort.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import { buildFinalPrompt, resolveModel, toolModelsFromRaw } from "../src/ask-tool.js";
import { toAgyEffort } from "../src/models.js";

// The REAL `agy models` stdout shape (verified live via `ct agy models`).
const RAW = [
	"gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
	"gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
	"gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
	"gemini-3.5-flash-high     Gemini 3.5 Flash (High)",
	"gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)",
	"gemini-3.5-flash-low      Gemini 3.5 Flash (Low)",
	"gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
	"gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
	"claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
	"claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)",
	"gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
].join("\n");

const entries = toolModelsFromRaw(RAW);
const DEFAULT_THINKING = "medium";

test("toolModelsFromRaw: splits the slug (col 1) off the display label", () => {
	// The label must never reach --model: full is the slug only.
	const flashHigh = entries.find((e) => e.full === "gemini-3.6-flash-high");
	assert.deepEqual(flashHigh, {
		full: "gemini-3.6-flash-high",
		family: "flash",
		version: "3.6",
		tier: "high",
	});

	// "-thinking" and a bare slug are NOT low/medium/high tiers.
	const opus = entries.find((e) => e.full === "claude-opus-4-6-thinking");
	assert.equal(opus?.tier, null);
	assert.equal(opus?.family, "other");
	const sonnet = entries.find((e) => e.full === "claude-sonnet-4-6");
	assert.equal(sonnet?.tier, null);
});

test("resolveModel: friendly alias splits Gemini base + default effort", () => {
	assert.deepEqual(resolveModel("flash", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "medium",
	});
	// Pro has no medium variant; its family default is high.
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
});

test("resolveModel: explicit tier and pinned version", () => {
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "high",
	});
	assert.deepEqual(resolveModel("3.5 flash low", entries, DEFAULT_THINKING), {
		model: "gemini-3.5-flash",
		effort: "low",
	});
});

test("resolveModel: short aliases resolve to valid agy slugs with NO effort", () => {
	// Fixed-thinking families: agy rejects --effort, so the slug carries any
	// tier suffix itself (gpt-oss-120b-medium) and effort is absent.
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-4-6",
	});
	assert.deepEqual(resolveModel("opus", entries, DEFAULT_THINKING), {
		model: "claude-opus-4-6-thinking",
	});
	assert.deepEqual(resolveModel("gpt-oss", entries, DEFAULT_THINKING), {
		model: "gpt-oss-120b-medium",
	});
});

test("resolveModel: an exact tiered slug splits to base + effort (not passed whole)", () => {
	// Passing the whole tiered slug to --model is what agy rejects; the resolver
	// must split it exactly like an alias would.
	assert.deepEqual(resolveModel("gemini-3.6-flash-high", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "high",
	});
	// A fixed exact slug passes through unchanged.
	assert.deepEqual(resolveModel("claude-sonnet-4-6", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-4-6",
	});
});

test("resolveModel: explicit preferred tier beats alias tier, default, and clamps to the family", () => {
	// thinking/effort param wins over the alias's own tier and the default.
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING, "low"), {
		model: "gemini-3.6-flash",
		effort: "low",
	});
	// Pro has no medium variant; the explicit tier clamps to the nearest
	// listed tier (distance tie low/high -> higher rank wins).
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING, "medium"), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
	// Fixed-thinking families ignore the tier: agy rejects --effort for them.
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING, "high"), {
		model: "claude-sonnet-4-6",
	});
});

test("toAgyEffort: full pi thinking-level vocabulary clamps to agy tiers", () => {
	const all: readonly ("low" | "medium" | "high")[] = ["low", "medium", "high"];
	assert.equal(toAgyEffort("minimal", all), "low");
	assert.equal(toAgyEffort("medium", all), "medium");
	assert.equal(toAgyEffort("xhigh", all), "high");
	assert.equal(toAgyEffort("max", all), "high");
	assert.equal(toAgyEffort(undefined, all), "low");
});

test("resolveModel: short aliases still resolve when agy omits them (static overlay)", () => {
	// agy lists only Gemini here; the static overlay fills in the rest so the
	// aliases never regress to the old human-name format.
	const geminiOnly = toolModelsFromRaw(
		[
			"gemini-3.6-flash-high   Gemini 3.6 Flash (High)",
			"gemini-3.6-flash-medium Gemini 3.6 Flash (Medium)",
			"gemini-3.6-flash-low    Gemini 3.6 Flash (Low)",
		].join("\n"),
	);
	assert.deepEqual(resolveModel("sonnet", geminiOnly, DEFAULT_THINKING), {
		model: "claude-sonnet-4-6",
	});
	assert.deepEqual(resolveModel("gpt-oss", geminiOnly, DEFAULT_THINKING), {
		model: "gpt-oss-120b-medium",
	});
});

// --- Prompt assembly (headless plan-mode hardening) ------------------------
// Root cause probed 2026-09-28: `agy -p --mode plan` soft-denies run_command
// and the turn ends AT the denial (exit 0, empty stdout, no second model
// turn), so one unguarded command attempt kills the whole run. The prompt is
// the only lever the tool owns without touching user config.

test("buildFinalPrompt: plan mode appends the no-commands guard", () => {
	const out = buildFinalPrompt("Review the diff.\n---\ndiff body", "plan", false);
	assert.ok(out.startsWith("Review the diff."));
	// The guard must forbid shell commands outright and point the model back
	// at the prompt material - the only reliably available input.
	assert.match(out, /Do not run shell commands/);
	assert.match(out, /ends the session immediately/);
	assert.ok(
		out.endsWith("state exactly what is missing in your answer instead of trying to fetch it."),
	);
});

test("buildFinalPrompt: plan + digest keeps digest prefix first, guard last", () => {
	const out = buildFinalPrompt("body", "plan", true);
	assert.ok(out.startsWith("(Use compact digests, not full file contents.)\n"));
	assert.ok(out.includes("(Use compact digests, not full file contents.)\nbody\n"));
	assert.ok(out.endsWith("instead of trying to fetch it."));
});

test("buildFinalPrompt: accept-edits never carries the guard", () => {
	// Edit runs keep their tools under skip-permissions; appending the guard
	// would break delegated edits and command use.
	assert.equal(buildFinalPrompt("do the edit", "accept-edits", false), "do the edit");
	assert.equal(
		buildFinalPrompt("do the edit", "accept-edits", true),
		"(Use compact digests, not full file contents.)\ndo the edit",
	);
});
