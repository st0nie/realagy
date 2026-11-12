import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	DEFAULT_REALAGY_CONFIG,
	editRealagyConfigMenu,
	formatConfigLimit,
	formatConfigSummary,
	loadRealagyConfig,
	MODEL_DEFAULT_LABEL,
	normalizeRealagyConfig,
	parsePositiveInt,
	realagyConfigPath,
	RealagySettingsComponent,
	saveRealagyConfig,
	type RealagyConfig,
	type SettingsMenuUI,
} from "../src/settings.js";

test("config defaults enable compaction bypass and agent profile with model-default limits", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-config-"));
	const file = realagyConfigPath(directory);
	try {
		assert.equal(file, path.join(directory, "realagy", "config.json"));
		assert.deepEqual(loadRealagyConfig(file), {
			noAutoCompaction: true,
			fullMcpOutput: true,
			agentProfile: true,
		});
		assert.deepEqual(DEFAULT_REALAGY_CONFIG, {
			noAutoCompaction: true,
			fullMcpOutput: true,
			agentProfile: true,
		});

		const saved = saveRealagyConfig(
			{
				noAutoCompaction: false,
				fullMcpOutput: false,
				agentProfile: false,
				contextWindow: 256_000,
				contextWindowOverrides: { "gemini-4-argon": 900_000 },
				maxOutputTokens: 32_000,
				maxOutputTokensOverrides: { "gemini-4-argon": 48_000 },
			},
			file,
		);
		assert.deepEqual(saved, {
			noAutoCompaction: false,
			fullMcpOutput: false,
			agentProfile: false,
			contextWindow: 256_000,
			contextWindowOverrides: { "gemini-4-argon": 900_000 },
			maxOutputTokens: 32_000,
			maxOutputTokensOverrides: { "gemini-4-argon": 48_000 },
		});
		assert.deepEqual(loadRealagyConfig(file), saved);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);

		// Clearing overrides omits limit keys from config.json so models follow their real windows.
		const reset = saveRealagyConfig({ noAutoCompaction: true, fullMcpOutput: true, agentProfile: true }, file);
		assert.deepEqual(reset, { noAutoCompaction: true, fullMcpOutput: true, agentProfile: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
			noAutoCompaction: true,
			fullMcpOutput: true,
			agentProfile: true,
		});

		fs.writeFileSync(file, "not json");
		assert.deepEqual(loadRealagyConfig(file), DEFAULT_REALAGY_CONFIG);
		assert.deepEqual(
			normalizeRealagyConfig({
				noAutoCompaction: "bad",
				fullMcpOutput: "bad",
				agentProfile: false,
				contextWindow: "500,000",
				contextWindowOverrides: {
					"gemini-4-argon": "900,000",
					"claude-sonnet-5-5": 200_000,
					"invalid-zero": 0,
					"invalid-type": false,
					"": 100_000,
				},
				maxOutputTokens: -5,
				maxOutputTokensOverrides: { "gemini-4-argon": "48,000", "invalid-output": -1 },
			}),
			{
				noAutoCompaction: true,
				fullMcpOutput: true,
				agentProfile: false,
				contextWindow: 500_000,
				contextWindowOverrides: {
					"gemini-4-argon": 900_000,
					"claude-sonnet-5-5": 200_000,
				},
				maxOutputTokensOverrides: { "gemini-4-argon": 48_000 },
			},
		);
		assert.equal(parsePositiveInt("1_048_576"), 1_048_576);
		assert.equal(parsePositiveInt("0"), undefined);
		assert.equal(formatConfigLimit(undefined), MODEL_DEFAULT_LABEL);
		assert.equal(formatConfigLimit(1_048_576), "1,048,576");
		assert.match(formatConfigSummary(DEFAULT_REALAGY_CONFIG, file), /Pi context window: model default/);
		assert.match(formatConfigSummary(saved, file), /Pi context window \(gemini-4-argon\): 900,000/);
		assert.match(formatConfigSummary(saved, file), /Pi max output tokens \(gemini-4-argon\): 48,000/);
		assert.equal(normalizeRealagyConfig({ contextWindowOverrides: {} }).contextWindowOverrides, undefined);
		assert.equal(normalizeRealagyConfig({ contextWindowOverrides: [] }).contextWindowOverrides, undefined);
		assert.equal(normalizeRealagyConfig({ maxOutputTokensOverrides: {} }).maxOutputTokensOverrides, undefined);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("RealagySettingsComponent renders TUI list, toggles booleans, edits custom limits, and propagates focus", () => {
	initTheme();
	const changes: RealagyConfig[] = [];
	let closed = false;
	let renders = 0;
	const tui = { requestRender: () => { renders += 1; } } as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	const component = new RealagySettingsComponent({
		tui,
		theme,
		config: { ...DEFAULT_REALAGY_CONFIG, contextWindowOverrides: { "gemini-4-argon": 900_000 } },
		modelIds: ["gemini-4-argon", "claude-sonnet-5-5"],
		configPath: "/tmp/realagy/config.json",
		onChange: (next) => changes.push(next),
		onClose: () => { closed = true; },
	});
	component.focused = true;
	assert.equal(component.focused, true);

	const initialLines = component.render(100).join("\n");
	assert.match(initialLines, /Antigravity Settings/);
	assert.match(initialLines, /Bypass Agy auto-compaction.*true/);
	assert.match(initialLines, /Full MCP output \(binary patch\).*true/);
	assert.match(initialLines, /Pi-only agent profile.*true/);
	assert.match(initialLines, /Pi context window.*model default/);
	assert.match(initialLines, /Per-model context windows.*1 override/);
	assert.match(initialLines, /Per-model output tokens.*none/);
	assert.doesNotMatch(initialLines, /Context · gemini-4-argon/);

	// Toggle noAutoCompaction (row 0) with Enter.
	component.handleInput("\r");
	assert.equal(changes.at(-1)?.noAutoCompaction, false);

	// Full MCP output defaults on and can be disabled independently (row 1).
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.equal(changes.at(-1)?.fullMcpOutput, false);

	// Move down to agentProfile (row 2) and toggle with Enter.
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.equal(changes.at(-1)?.agentProfile, false);

	// Move down to contextWindow (row 3), open submenu, navigate to Custom… (last item), and submit custom value.
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
	component.handleInput("\r");

	// Invalid input shows validation error without calling onChange.
	const countBeforeInvalid = changes.length;
	for (const ch of "abc") component.handleInput(ch);
	component.handleInput("\r");
	assert.equal(changes.length, countBeforeInvalid);
	assert.match(component.render(100).join("\n"), /positive whole number/);

	// Clear invalid text (Ctrl+U) and enter 300000.
	component.handleInput("\x15");
	for (const ch of "300000") component.handleInput(ch);
	component.handleInput("\r");
	assert.equal(changes.at(-1)?.contextWindow, 300_000);
	assert.deepEqual(changes.at(-1)?.contextWindowOverrides, { "gemini-4-argon": 900_000 });

	// Reopen contextWindow submenu and pick "model default" (index 0) after moving up to row 0.
	component.handleInput("\r");
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[A");
	component.handleInput("\r");
	assert.equal(changes.at(-1)?.contextWindow, undefined);

	// The main list contains only grouped entries. Open context models, clear argon, then set Claude.
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	const contextModels = component.render(100).join("\n");
	assert.match(contextModels, /gemini-4-argon.*900,000/);
	assert.match(contextModels, /claude-sonnet-5-5.*inherit global/);
	component.handleInput("\r");
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[A");
	component.handleInput("\r");
	assert.equal(changes.at(-1)?.contextWindowOverrides, undefined);
	assert.match(component.render(100).join("\n"), /Per-model context windows.*none/);

	component.handleInput("\r");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
	component.handleInput("\r");
	for (const ch of "450000") component.handleInput(ch);
	component.handleInput("\r");
	assert.deepEqual(changes.at(-1)?.contextWindowOverrides, { "claude-sonnet-5-5": 450_000 });
	assert.match(component.render(100).join("\n"), /Per-model context windows.*1 override/);

	// Output tokens have an independent grouped submenu and presets.
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.match(component.render(100).join("\n"), /gemini-4-argon.*inherit global/);
	component.handleInput("\r");
	for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
	component.handleInput("\r");
	for (const ch of "48000") component.handleInput(ch);
	component.handleInput("\r");
	assert.deepEqual(changes.at(-1)?.maxOutputTokensOverrides, { "gemini-4-argon": 48_000 });
	const perModelLines = component.render(100).join("\n");
	assert.match(perModelLines, /Per-model context windows.*1 override/);
	assert.match(perModelLines, /Per-model output tokens.*1 override/);
	assert.doesNotMatch(perModelLines, /Context · gemini-4-argon/);

	// Esc closes the main settings list.
	component.handleInput("\x1b");
	assert.equal(closed, true);
	assert.ok(renders > 0);
});

test("fallback menu edits global and grouped per-model limits, resets inheritance, and cancels cleanly", async () => {
	const modelIds = ["gemini-4-argon", "claude-sonnet-5-5"];
	const initial: RealagyConfig = {
		...DEFAULT_REALAGY_CONFIG,
		contextWindowOverrides: { "gemini-4-argon": 900_000 },
		maxOutputTokensOverrides: { "gemini-4-argon": 64_000 },
	};
	const ui = menuUi([0, 1, 2, 3, 4, 7], ["300000", "32000"]);
	const result = await editRealagyConfigMenu(ui, initial, modelIds);
	assert.deepEqual(result, {
		noAutoCompaction: false,
		fullMcpOutput: false,
		agentProfile: false,
		contextWindow: 300_000,
		contextWindowOverrides: { "gemini-4-argon": 900_000 },
		maxOutputTokens: 32_000,
		maxOutputTokensOverrides: { "gemini-4-argon": 64_000 },
	});
	assert.equal(ui.messages.length, 0);

	const resetUi = menuUi([3, 3, 7], ["not-a-number", ""]);
	const resetResult = await editRealagyConfigMenu(resetUi, result!, modelIds);
	assert.deepEqual(resetResult, {
		noAutoCompaction: false,
		fullMcpOutput: false,
		contextWindowOverrides: { "gemini-4-argon": 900_000 },
		agentProfile: false,
		maxOutputTokens: 32_000,
		maxOutputTokensOverrides: { "gemini-4-argon": 64_000 },
	});
	assert.equal(resetUi.messages.length, 1);

	const perModelUi = menuUi(
		[5, 0, 5, 1, 5, 2, 6, 0, 6, 0, 6, 2, 7],
		["", "450000", "not-a-number", "48000"],
	);
	const perModelResult = await editRealagyConfigMenu(perModelUi, result!, modelIds);
	assert.deepEqual(perModelResult?.contextWindowOverrides, { "claude-sonnet-5-5": 450_000 });
	assert.deepEqual(perModelResult?.maxOutputTokensOverrides, { "gemini-4-argon": 48_000 });
	assert.equal(perModelUi.messages.length, 1);
	assert.match(perModelUi.messages[0], /inherit global/);

	const cancelled = menuUi([8], []);
	assert.equal(await editRealagyConfigMenu(cancelled, DEFAULT_REALAGY_CONFIG, modelIds), undefined);
});

function menuUi(selections: number[], inputs: string[]): SettingsMenuUI & { messages: string[] } {
	let selection = 0;
	let input = 0;
	const messages: string[] = [];
	return {
		messages,
		select: async (_title, options) => options[selections[selection++]],
		input: async () => inputs[input++],
		notify: (message) => messages.push(message),
	};
}

test("legacy reclaim keys are ignored", () => {
	assert.deepEqual(normalizeRealagyConfig({
		...DEFAULT_REALAGY_CONFIG,
		reclaimContext: false,
		reclaimMinTokens: 1,
		reclaimMinPercent: 0,
		reclaimColdMinutes: 0,
	}), DEFAULT_REALAGY_CONFIG);
	assert.doesNotMatch(formatConfigSummary(DEFAULT_REALAGY_CONFIG, "/x"), /Release context dropped/);
});

test("inactivityMin accepts positive minutes and 0 (guard off), drops invalid values", () => {
	assert.equal(normalizeRealagyConfig({ inactivityMin: 10 }).inactivityMin, 10);
	assert.equal(normalizeRealagyConfig({ inactivityMin: "15" }).inactivityMin, 15);
	assert.equal(normalizeRealagyConfig({ inactivityMin: 0 }).inactivityMin, 0);
	assert.equal(normalizeRealagyConfig({ inactivityMin: -1 }).inactivityMin, undefined);
	assert.equal(normalizeRealagyConfig({ inactivityMin: 1.5 }).inactivityMin, undefined);
	assert.equal(normalizeRealagyConfig({ inactivityMin: "abc" }).inactivityMin, undefined);
	assert.match(formatConfigSummary(DEFAULT_REALAGY_CONFIG, "/x"), /Inactivity timeout: 5 min \(default\)/);
	assert.match(formatConfigSummary({ ...DEFAULT_REALAGY_CONFIG, inactivityMin: 0 }, "/x"), /Inactivity timeout: disabled/);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-inactivity-"));
	try {
		const file = realagyConfigPath(directory);
		const saved = saveRealagyConfig({ ...DEFAULT_REALAGY_CONFIG, inactivityMin: 10 }, file);
		assert.deepEqual(loadRealagyConfig(file), saved);
		assert.equal(saved.inactivityMin, 10);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
