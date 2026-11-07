import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	DEFAULT_REALAGY_SETTINGS,
	editRealagySettings,
	loadRealagySettings,
	saveRealagySettings,
	type SettingsMenuUI,
} from "../src/settings.js";

test("settings load env defaults and saved per-field overrides", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-settings-"));
	const file = path.join(directory, "settings.json");
	try {
		const env = {
			REALAGY_NO_COMPACT: "1",
			REALAGY_CONTEXT_WINDOW: "100000",
			REALAGY_MAX_OUTPUT_TOKENS: "32000",
		};
		assert.deepEqual(loadRealagySettings(env, file), {
			noAutoCompaction: true,
			contextWindow: 100_000,
			maxTokens: 32_000,
		});
		fs.writeFileSync(file, JSON.stringify({ noAutoCompaction: false, contextWindow: 200_000 }));
		assert.deepEqual(loadRealagySettings(env, file), {
			noAutoCompaction: false,
			contextWindow: 200_000,
			maxTokens: 32_000,
		});

		const saved = { noAutoCompaction: true, contextWindow: 300_000, maxTokens: 48_000 };
		saveRealagySettings(saved, file);
		assert.deepEqual(loadRealagySettings({}, file), saved);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		fs.writeFileSync(file, "not json");
		assert.deepEqual(loadRealagySettings({}, file), DEFAULT_REALAGY_SETTINGS);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("interactive menu edits all three settings independently", async () => {
	const selections = [0, 1, 2, 3];
	const inputs = ["300000", "32000"];
	const ui = menuUi(selections, inputs);
	const result = await editRealagySettings(ui, DEFAULT_REALAGY_SETTINGS);
	assert.deepEqual(result, { noAutoCompaction: true, contextWindow: 300_000, maxTokens: 32_000 });
	assert.equal(ui.messages.length, 0);
	// Editing the draft does not mutate the active settings object.
	assert.deepEqual(DEFAULT_REALAGY_SETTINGS, { noAutoCompaction: false, contextWindow: 256_000, maxTokens: 64_000 });
});

test("interactive menu rejects invalid numbers and supports cancel", async () => {
	const invalid = menuUi([1, 1, 3], ["not-a-number", "125000"]);
	assert.deepEqual(await editRealagySettings(invalid, DEFAULT_REALAGY_SETTINGS), {
		...DEFAULT_REALAGY_SETTINGS,
		contextWindow: 125_000,
	});
	assert.deepEqual(invalid.messages, ["Enter a positive whole number of tokens."]);

	const cancelled = menuUi([4], []);
	assert.equal(await editRealagySettings(cancelled, DEFAULT_REALAGY_SETTINGS), undefined);
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
