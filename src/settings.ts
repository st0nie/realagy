// User configuration in ~/.pi/agent/realagy/config.json and `/realagy settings`.
// Compaction bypass and the Pi-only agent profile are enabled by default; model
// context and output limits follow each model's real window unless overridden.

import fs from "node:fs";
import path from "node:path";
import {
	DynamicBorder,
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	SettingsList,
	type Component,
	type Focusable,
	type SelectItem,
	type SettingItem,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ModelLimitOverrides } from "./models.js";

export interface RealagyConfig extends ModelLimitOverrides {
	/** Rewrite Agy's model catalog on loopback to disable local automatic
	 * compaction, unlocking Agy's full context window so Pi handles compaction. */
	noAutoCompaction: boolean;
	/** Run Agy with realagy's hidden agent profile (Pi's prompt and tools only)
	 * instead of Agy's default agent. */
	agentProfile: boolean;
}

export const DEFAULT_REALAGY_CONFIG: Readonly<RealagyConfig> = {
	noAutoCompaction: true,
	agentProfile: true,
};

export const MODEL_DEFAULT_LABEL = "model default";
const CUSTOM_VALUE = "__custom__";
const INHERIT_GLOBAL_LABEL = "inherit global";
const MODEL_CONTEXT_SETTING_PREFIX = "contextWindowOverride:";

const CONTEXT_PRESETS: readonly SelectItem[] = [
	{
		value: MODEL_DEFAULT_LABEL,
		label: MODEL_DEFAULT_LABEL,
		description: "Follow each model's real window (Gemini 1M, Claude 1M, GPT-OSS 128k)",
	},
	{ value: "131,072", label: "131,072", description: "128k tokens" },
	{ value: "256,000", label: "256,000", description: "256k tokens" },
	{ value: "512,000", label: "512,000", description: "512k tokens" },
	{ value: "1,000,000", label: "1,000,000", description: "1M tokens" },
	{ value: "1,048,576", label: "1,048,576", description: "1Mi tokens" },
	{ value: CUSTOM_VALUE, label: "Custom…", description: "Enter an exact positive token limit" },
];

const MODEL_CONTEXT_PRESETS: readonly SelectItem[] = CONTEXT_PRESETS.map((item, index) =>
	index === 0
		? {
			...item,
			value: INHERIT_GLOBAL_LABEL,
			label: INHERIT_GLOBAL_LABEL,
			description: "Use the global contextWindow, then the catalog or family default",
		}
		: item,
);

const OUTPUT_PRESETS: readonly SelectItem[] = [
	{
		value: MODEL_DEFAULT_LABEL,
		label: MODEL_DEFAULT_LABEL,
		description: "Follow each model's real output limit (Gemini 64k, Claude 128k, GPT-OSS 32k)",
	},
	{ value: "16,384", label: "16,384", description: "16k tokens" },
	{ value: "32,768", label: "32,768", description: "32k tokens" },
	{ value: "65,536", label: "65,536", description: "64k tokens" },
	{ value: "128,000", label: "128,000", description: "128k tokens" },
	{ value: CUSTOM_VALUE, label: "Custom…", description: "Enter an exact positive token limit" },
];

export function realagyConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "realagy", "config.json");
}

export function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}
	if (typeof value === "string") {
		const normalized = value.trim().replace(/[,_\s]/g, "");
		if (!/^\d+$/.test(normalized)) return undefined;
		const parsed = Number(normalized);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

function normalizeContextWindowOverrides(value: unknown): Record<string, number> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).flatMap(([modelId, rawLimit]) => {
		const limit = parsePositiveInt(rawLimit);
		return modelId.length > 0 && limit !== undefined ? [[modelId, limit] as const] : [];
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseLimitChoice(value: string): number | undefined {
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "" || trimmed === "model" || trimmed === "default" || trimmed === MODEL_DEFAULT_LABEL || trimmed === INHERIT_GLOBAL_LABEL) {
		return undefined;
	}
	return parsePositiveInt(value);
}

export function normalizeRealagyConfig(raw: unknown): RealagyConfig {
	const record = typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {};
	const noAutoCompaction = typeof record.noAutoCompaction === "boolean"
		? record.noAutoCompaction
		: DEFAULT_REALAGY_CONFIG.noAutoCompaction;
	const agentProfile = typeof record.agentProfile === "boolean"
		? record.agentProfile
		: DEFAULT_REALAGY_CONFIG.agentProfile;
	const contextWindow = parsePositiveInt(record.contextWindow);
	const contextWindowOverrides = normalizeContextWindowOverrides(record.contextWindowOverrides);
	const maxOutputTokens = parsePositiveInt(record.maxOutputTokens);
	const result: RealagyConfig = { noAutoCompaction, agentProfile };
	if (contextWindow !== undefined) result.contextWindow = contextWindow;
	if (contextWindowOverrides !== undefined) result.contextWindowOverrides = contextWindowOverrides;
	if (maxOutputTokens !== undefined) result.maxOutputTokens = maxOutputTokens;
	return result;
}

export function loadRealagyConfig(file: string = realagyConfigPath()): RealagyConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return normalizeRealagyConfig(raw);
	} catch {
		return { ...DEFAULT_REALAGY_CONFIG };
	}
}

export function saveRealagyConfig(config: RealagyConfig, file: string = realagyConfigPath()): RealagyConfig {
	const normalized = normalizeRealagyConfig(config);
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// Temporary file may not have been created yet.
		}
		throw error;
	}
	return normalized;
}

export function formatConfigLimit(value: number | undefined): string {
	return value !== undefined ? value.toLocaleString("en-US") : MODEL_DEFAULT_LABEL;
}

export function formatConfigSummary(config: RealagyConfig, file: string = realagyConfigPath()): string {
	return [
		`Antigravity settings (${file}):`,
		`  Bypass Agy auto-compaction: ${config.noAutoCompaction ? "ON" : "OFF"}`,
		`  Pi-only agent profile: ${config.agentProfile ? "ON" : "OFF"}`,
		`  Pi context window: ${formatConfigLimit(config.contextWindow)}`,
		...Object.entries(config.contextWindowOverrides ?? {}).map(
			([modelId, limit]) => `  Pi context window (${modelId}): ${formatConfigLimit(limit)}`,
		),
		`  Pi max output tokens: ${formatConfigLimit(config.maxOutputTokens)}`,
	].join("\n");
}

function withUpdatedSetting(current: RealagyConfig, id: string, rawValue: string): RealagyConfig {
	if (id.startsWith(MODEL_CONTEXT_SETTING_PREFIX)) {
		const modelId = id.slice(MODEL_CONTEXT_SETTING_PREFIX.length);
		const contextWindowOverrides = { ...current.contextWindowOverrides };
		const limit = parseLimitChoice(rawValue);
		if (limit === undefined) delete contextWindowOverrides[modelId];
		else contextWindowOverrides[modelId] = limit;
		const next = { ...current };
		if (Object.keys(contextWindowOverrides).length > 0) next.contextWindowOverrides = contextWindowOverrides;
		else delete next.contextWindowOverrides;
		return next;
	}

	let noAutoCompaction = current.noAutoCompaction;
	let agentProfile = current.agentProfile;
	let contextWindow = current.contextWindow;
	let maxOutputTokens = current.maxOutputTokens;
	if (id === "noAutoCompaction") noAutoCompaction = rawValue === "true";
	else if (id === "agentProfile") agentProfile = rawValue === "true";
	else if (id === "contextWindow") contextWindow = parseLimitChoice(rawValue);
	else if (id === "maxOutputTokens") maxOutputTokens = parseLimitChoice(rawValue);
	const next: RealagyConfig = { noAutoCompaction, agentProfile };
	if (contextWindow !== undefined) next.contextWindow = contextWindow;
	if (maxOutputTokens !== undefined) next.maxOutputTokens = maxOutputTokens;
	if (current.contextWindowOverrides !== undefined) next.contextWindowOverrides = current.contextWindowOverrides;
	return next;
}

class LimitSubmenu implements Component {
	readonly capturesViewportInput = true;
	#title: string;
	#theme: Theme;
	#tui: TUI;
	#selectList: SelectList;
	#input: Input | undefined;
	#error: string | undefined;
	#setActiveInput: (input: Input | undefined) => void;
	#done: (selectedValue?: string) => void;

	constructor(opts: {
		title: string;
		currentValue: string;
		presets: readonly SelectItem[];
		theme: Theme;
		tui: TUI;
		setActiveInput: (input: Input | undefined) => void;
		done: (selectedValue?: string) => void;
	}) {
		this.#title = opts.title;
		this.#theme = opts.theme;
		this.#tui = opts.tui;
		this.#setActiveInput = opts.setActiveInput;
		this.#done = (value) => {
			this.#setActiveInput(undefined);
			opts.done(value);
		};

		const items = [...opts.presets];
		const existingIndex = items.findIndex((item) => item.value === opts.currentValue);
		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		if (existingIndex >= 0) {
			this.#selectList.setSelectedIndex(existingIndex);
		} else {
			const customIndex = items.findIndex((item) => item.value === CUSTOM_VALUE);
			if (customIndex >= 0) this.#selectList.setSelectedIndex(customIndex);
		}
		this.#selectList.onSelect = (item) => {
			if (item.value === CUSTOM_VALUE) {
				this.#openCustomInput(opts.currentValue);
				return;
			}
			this.#done(item.value);
		};
		this.#selectList.onCancel = () => this.#done(undefined);
	}

	#openCustomInput(currentValue: string): void {
		const input = new Input({
			prompt: "  > ",
			placeholder: "Positive token count (leave empty for model default)",
		});
		const existing = parsePositiveInt(currentValue);
		if (existing !== undefined) input.setValue(String(existing));
		input.onSubmit = (raw) => {
			const trimmed = raw.trim().toLowerCase();
			if (trimmed === "" || trimmed === "model" || trimmed === "default" || trimmed === MODEL_DEFAULT_LABEL) {
				this.#done(MODEL_DEFAULT_LABEL);
				return;
			}
			const parsed = parsePositiveInt(raw);
			if (parsed === undefined) {
				this.#error = "Enter a positive whole number of tokens, or leave empty for model default.";
				this.#tui.requestRender();
				return;
			}
			this.#done(formatConfigLimit(parsed));
		};
		input.onEscape = () => {
			this.#input = undefined;
			this.#error = undefined;
			this.#setActiveInput(undefined);
			this.#tui.requestRender();
		};
		this.#error = undefined;
		this.#input = input;
		this.#setActiveInput(input);
		this.#tui.requestRender();
	}

	invalidate(): void {
		this.#selectList.invalidate();
		this.#input?.invalidate();
	}

	render(width: number): string[] {
		const lines = [`  ${this.#theme.fg("accent", this.#theme.bold(this.#title))}`, ""];
		if (this.#input) {
			lines.push(...this.#input.render(width));
			if (this.#error) lines.push(`  ${this.#theme.fg("error", this.#error)}`);
			lines.push("");
			lines.push(`  ${this.#theme.fg("dim", "Enter to apply · Esc to return")}`);
			return lines;
		}
		lines.push(...this.#selectList.render(width));
		lines.push("");
		lines.push(`  ${this.#theme.fg("dim", "Up/Down to move · Enter to select · Esc to cancel")}`);
		return lines;
	}

	handleInput(data: string): void {
		if (this.#input) this.#input.handleInput(data);
		else this.#selectList.handleInput(data);
		this.#tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.#input ? this.#input.handleMouse(event) : this.#selectList.handleMouse(event);
		this.#tui.requestRender();
		return result;
	}
}

export interface RealagySettingsDialogOptions {
	tui: TUI;
	theme: Theme;
	config: RealagyConfig;
	modelIds: readonly string[];
	configPath: string;
	onChange: (next: RealagyConfig) => void;
	onClose: () => void;
}

export class RealagySettingsComponent implements Component, Focusable {
	readonly capturesViewportInput = true;
	#container = new Container();
	#settingsList: SettingsList;
	#tui: TUI;
	#state: RealagyConfig;
	#focused = false;
	#activeInput: Input | undefined;

	constructor(opts: RealagySettingsDialogOptions) {
		this.#tui = opts.tui;
		this.#state = { ...opts.config };

		const setActiveInput = (input: Input | undefined): void => {
			if (this.#activeInput && this.#activeInput !== input) this.#activeInput.focused = false;
			this.#activeInput = input;
			if (input) input.focused = this.#focused;
		};

		const items: SettingItem[] = [
			{
				id: "noAutoCompaction",
				label: "Bypass Agy auto-compaction",
				description: "Intercept fetchAvailableModels on loopback to unlock Agy's full context window so Pi handles compaction",
				currentValue: this.#state.noAutoCompaction ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "agentProfile",
				label: "Pi-only agent profile",
				description: "Run Agy with realagy's hidden agent profile (Pi's prompt and tools only); false keeps Agy's default agent",
				currentValue: this.#state.agentProfile ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "contextWindow",
				label: "Pi context window",
				description: "Global fallback reported to Pi for planning/compaction; per-model rows below take precedence",
				currentValue: formatConfigLimit(this.#state.contextWindow),
				submenu: (currentValue, done) =>
					new LimitSubmenu({
						title: "Pi context window",
						currentValue,
						presets: CONTEXT_PRESETS,
						theme: opts.theme,
						tui: opts.tui,
						setActiveInput,
						done,
					}),
			},
			{
				id: "maxOutputTokens",
				label: "Pi max output tokens",
				description: "Output limit reported to Pi; model default follows each model's real output limit (64k Gemini, 128k Claude, 32k GPT-OSS)",
				currentValue: formatConfigLimit(this.#state.maxOutputTokens),
				submenu: (currentValue, done) =>
					new LimitSubmenu({
						title: "Pi max output tokens",
						currentValue,
						presets: OUTPUT_PRESETS,
						theme: opts.theme,
						tui: opts.tui,
						setActiveInput,
						done,
					}),
			},
		];

		const modelIds = [...new Set([...opts.modelIds, ...Object.keys(this.#state.contextWindowOverrides ?? {})])];
		for (const modelId of modelIds) {
			const override = this.#state.contextWindowOverrides?.[modelId];
			items.push({
				id: `${MODEL_CONTEXT_SETTING_PREFIX}${modelId}`,
				label: `Context · ${modelId}`,
				description: "Per-model context window; takes precedence over the global Pi context window",
				currentValue: override !== undefined ? formatConfigLimit(override) : INHERIT_GLOBAL_LABEL,
				submenu: (currentValue, done) =>
					new LimitSubmenu({
						title: `Context · ${modelId}`,
						currentValue,
						presets: MODEL_CONTEXT_PRESETS,
						theme: opts.theme,
						tui: opts.tui,
						setActiveInput,
						done,
					}),
			});
		}

		this.#container.addChild(new DynamicBorder());
		this.#container.addChild({
			render: () => [
				`  ${opts.theme.fg("accent", opts.theme.bold("Antigravity Settings"))} ${opts.theme.fg("dim", `(${opts.configPath})`)}`,
				"",
			],
			invalidate: () => {},
		});
		this.#settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const next = withUpdatedSetting(this.#state, id, newValue);
				this.#state = next;
				opts.onChange({ ...next });
			},
			() => {
				setActiveInput(undefined);
				opts.onClose();
			},
		);
		this.#container.addChild(this.#settingsList);
		this.#container.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		if (this.#activeInput) this.#activeInput.focused = value;
	}

	invalidate(): void {
		this.#container.invalidate();
	}

	render(width: number): string[] {
		return this.#container.render(width);
	}

	handleInput(data: string): void {
		this.#settingsList.handleInput(data);
		this.#tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.#settingsList.handleMouse(event);
		this.#tui.requestRender();
		return result;
	}
}

export interface SettingsMenuUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Fallback `/realagy settings` menu for non-TUI interactive hosts (such as RPC). */
export async function editRealagyConfigMenu(
	ui: SettingsMenuUI,
	initial: RealagyConfig,
	modelIds: readonly string[],
): Promise<RealagyConfig | undefined> {
	let draft = { ...initial };
	for (;;) {
		const choice = await ui.select("Antigravity settings", [
			`Bypass Agy auto-compaction: ${draft.noAutoCompaction ? "ON" : "OFF"}`,
			`Pi-only agent profile: ${draft.agentProfile ? "ON" : "OFF"}`,
			`Pi context window: ${formatConfigLimit(draft.contextWindow)}`,
			"Per-model context windows…",
			`Pi max output tokens: ${formatConfigLimit(draft.maxOutputTokens)}`,
			"Save and close",
			"Cancel",
		]);
		if (choice === undefined || choice === "Cancel") return undefined;
		if (choice === "Save and close") return draft;
		if (choice.startsWith("Bypass Agy auto-compaction:")) {
			draft = withUpdatedSetting(draft, "noAutoCompaction", draft.noAutoCompaction ? "false" : "true");
			continue;
		}
		if (choice.startsWith("Pi-only agent profile:")) {
			draft = withUpdatedSetting(draft, "agentProfile", draft.agentProfile ? "false" : "true");
			continue;
		}

		let id: string;
		let current: number | undefined;
		let title: string;
		if (choice === "Per-model context windows…") {
			const modelChoice = await ui.select("Per-model context windows", [
				...modelIds.map((modelId) => {
					const limit = draft.contextWindowOverrides?.[modelId];
					return `${modelId}: ${limit !== undefined ? formatConfigLimit(limit) : INHERIT_GLOBAL_LABEL}`;
				}),
				"Back",
			]);
			if (modelChoice === undefined) return undefined;
			if (modelChoice === "Back") continue;
			const modelId = modelIds.find((candidate) => modelChoice.startsWith(`${candidate}: `));
			if (modelId === undefined) continue;
			id = `${MODEL_CONTEXT_SETTING_PREFIX}${modelId}`;
			current = draft.contextWindowOverrides?.[modelId];
			title = `Context · ${modelId} (positive tokens, or empty to inherit global)`;
		} else {
			const isContext = choice.startsWith("Pi context window:");
			id = isContext ? "contextWindow" : "maxOutputTokens";
			current = isContext ? draft.contextWindow : draft.maxOutputTokens;
			title = isContext
				? "Pi context window (positive tokens, or empty for model default)"
				: "Pi max output tokens (positive tokens, or empty for model default)";
		}

		const defaultLabel = id.startsWith(MODEL_CONTEXT_SETTING_PREFIX) ? INHERIT_GLOBAL_LABEL : MODEL_DEFAULT_LABEL;
		const defaultAction = defaultLabel === INHERIT_GLOBAL_LABEL ? "inherit global" : "use the model default";
		const value = await ui.input(title, current !== undefined ? String(current) : defaultLabel);
		if (value === undefined) return undefined;
		const trimmed = value.trim().toLowerCase();
		if (trimmed === "" || trimmed === "model" || trimmed === "default" || trimmed === MODEL_DEFAULT_LABEL || trimmed === INHERIT_GLOBAL_LABEL) {
			draft = withUpdatedSetting(draft, id, MODEL_DEFAULT_LABEL);
			continue;
		}
		const parsed = parsePositiveInt(value);
		if (parsed === undefined) {
			ui.notify(`Enter a positive whole number of tokens, or leave empty to ${defaultAction}.`, "warning");
			continue;
		}
		draft = withUpdatedSetting(draft, id, String(parsed));
	}
}
