import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, type ReportedModelLimits } from "./models.js";

export interface RealagySettings extends ReportedModelLimits {
	noAutoCompaction: boolean;
}

export const DEFAULT_REALAGY_SETTINGS: RealagySettings = {
	noAutoCompaction: false,
	contextWindow: DEFAULT_CONTEXT_WINDOW,
	maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
};

export interface SettingsMenuUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Environment supplies defaults; explicitly saved menu values win per field. */
export function loadRealagySettings(
	env: NodeJS.ProcessEnv = process.env,
	file = realagySettingsPath(env),
): RealagySettings {
	const settings: RealagySettings = {
		noAutoCompaction: env.REALAGY_NO_COMPACT === "1",
		contextWindow: positiveInteger(env.REALAGY_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveInteger(env.REALAGY_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
	};
	try {
		const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RealagySettings>;
		if (typeof saved.noAutoCompaction === "boolean") settings.noAutoCompaction = saved.noAutoCompaction;
		if (validPositiveInteger(saved.contextWindow)) settings.contextWindow = saved.contextWindow;
		if (validPositiveInteger(saved.maxTokens)) settings.maxTokens = saved.maxTokens;
	} catch {
		// Missing or malformed files fall back to environment/defaults. The menu
		// writes a fresh valid file on its next save.
	}
	return settings;
}

export function realagySettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.REALAGY_SETTINGS_FILE || path.join(os.homedir(), ".pi", "agent", "realagy", "settings.json");
}

export function saveRealagySettings(settings: RealagySettings, file = realagySettingsPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/** Interactive /agy settings editor. Returns a draft only when Save is chosen. */
export async function editRealagySettings(
	ui: SettingsMenuUI,
	initial: RealagySettings,
): Promise<RealagySettings | undefined> {
	const draft = { ...initial };
	for (;;) {
		const choice = await ui.select("Antigravity settings", [
			`Disable Agy auto-compaction: ${draft.noAutoCompaction ? "ON" : "OFF"}`,
			`Pi context window: ${draft.contextWindow} tokens`,
			`Pi max output tokens: ${draft.maxTokens} tokens`,
			"Save and close",
			"Cancel",
		]);
		if (choice === undefined || choice === "Cancel") return undefined;
		if (choice === "Save and close") return draft;
		if (choice.startsWith("Disable Agy auto-compaction:")) {
			draft.noAutoCompaction = !draft.noAutoCompaction;
			continue;
		}
		const context = choice.startsWith("Pi context window:");
		const current = context ? draft.contextWindow : draft.maxTokens;
		const title = context ? "Pi context window (tokens)" : "Pi max output tokens (tokens)";
		const value = await ui.input(title, String(current));
		if (value === undefined) return undefined;
		const parsed = Number(value.trim());
		if (!validPositiveInteger(parsed)) {
			ui.notify("Enter a positive whole number of tokens.", "warning");
			continue;
		}
		if (context) draft.contextWindow = parsed;
		else draft.maxTokens = parsed;
	}
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return validPositiveInteger(parsed) ? parsed : fallback;
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
