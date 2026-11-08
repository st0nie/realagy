// User configuration in ~/.pi/agent/realagy/config.json and `/realagy settings`.
// Compaction bypass, complete MCP output, and the Pi-only agent profile default
// on; model context and output limits follow each model's real window.

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
import { BYTES_PER_TOKEN, type ReclaimPolicy } from "./transcript.js";

export interface RealagyConfig extends ModelLimitOverrides {
	/** Rewrite Agy's model catalog on loopback to disable local automatic
	 * compaction, unlocking Agy's full context window so Pi handles compaction. */
	noAutoCompaction: boolean;
	/** Derive a private agy copy that sends complete individual and parallel MCP
	 * results to the model instead of agy's truncated preview. Default on. */
	fullMcpOutput: boolean;
	/** Run Agy with realagy's hidden agent profile (Pi's prompt and tools only)
	 * instead of Agy's default agent. */
	agentProfile: boolean;
	/** Restart an agy session on a fresh one once pi's context managers (such
	 * as realctx) dropped or summarized enough of what it holds. Default on. */
	reclaimContext?: boolean;
	/** Least reclaimable context, in tokens, worth a fresh session. */
	reclaimMinTokens?: number;
	/** ...that is also at least this percentage of the session's context... */
	reclaimMinPercent?: number;
	/** ...unless the latest reply is at least this many minutes old (0 = off). */
	reclaimColdMinutes?: number;
}

export const DEFAULT_REALAGY_CONFIG: Readonly<RealagyConfig> = {
	noAutoCompaction: true,
	fullMcpOutput: true,
	agentProfile: true,
};

export type ReclaimSettings = Required<Pick<RealagyConfig, "reclaimContext" | "reclaimMinTokens" | "reclaimMinPercent" | "reclaimColdMinutes">>;
export const RECLAIM_SETTING_KEYS = ["reclaimContext", "reclaimMinTokens", "reclaimMinPercent", "reclaimColdMinutes"] as const;
type ReclaimSettingKey = (typeof RECLAIM_SETTING_KEYS)[number];

/** Defaults of the reclaim settings; config files omit keys equal to them. */
export const DEFAULT_RECLAIM_SETTINGS: Readonly<ReclaimSettings> = {
	reclaimContext: true,
	reclaimMinTokens: 8_000,
	reclaimMinPercent: 50,
	reclaimColdMinutes: 5,
};

const RECLAIM_TOKEN_VALUES = ["2,000", "4,000", "8,000", "16,000", "32,000", "64,000"];
const RECLAIM_PERCENT_VALUES = ["0%", "10%", "20%", "30%", "50%", "75%"];
const RECLAIM_COLD_VALUES = ["off", "1 min", "5 min", "10 min", "15 min", "30 min", "60 min"];
/** Reclaim entries of the fallback (non-TUI) settings menu. */
const RECLAIM_MENU: ReadonlyArray<{ key: ReclaimSettingKey; label: string; values: readonly string[]; hint: string }> = [
	{ key: "reclaimContext", label: "Release dropped context", values: ["true", "false"], hint: "true or false" },
	{ key: "reclaimMinTokens", label: "Release: minimum tokens", values: RECLAIM_TOKEN_VALUES, hint: "a positive whole number of tokens" },
	{ key: "reclaimMinPercent", label: "Release: minimum share", values: RECLAIM_PERCENT_VALUES, hint: "a percentage from 0 to 100" },
	{ key: "reclaimColdMinutes", label: "Release: cold cache after", values: RECLAIM_COLD_VALUES, hint: "minutes, or off" },
];

/** The reclaim settings in effect, defaults filled in. */
export function reclaimSettings(config: RealagyConfig): ReclaimSettings {
	return {
		reclaimContext: config.reclaimContext ?? DEFAULT_RECLAIM_SETTINGS.reclaimContext,
		reclaimMinTokens: config.reclaimMinTokens ?? DEFAULT_RECLAIM_SETTINGS.reclaimMinTokens,
		reclaimMinPercent: config.reclaimMinPercent ?? DEFAULT_RECLAIM_SETTINGS.reclaimMinPercent,
		reclaimColdMinutes: config.reclaimColdMinutes ?? DEFAULT_RECLAIM_SETTINGS.reclaimColdMinutes,
	};
}

/** The provider's reclaim policy for `config`; null when reclaiming is off. */
export function reclaimPolicy(config: RealagyConfig): ReclaimPolicy | null {
	const settings = reclaimSettings(config);
	if (!settings.reclaimContext) return null;
	return {
		minBytes: settings.reclaimMinTokens * BYTES_PER_TOKEN,
		minShare: settings.reclaimMinPercent / 100,
		coldMs: settings.reclaimColdMinutes * 60_000,
	};
}

/** A non-negative number from config or UI text: `10`, `"10%"`, `"5 min"`;
 *  `"off"` is 0. Percentages above `max` are rejected. */
function parseNonNegative(value: unknown, max = Number.POSITIVE_INFINITY): number | undefined {
	let parsed: number | undefined;
	if (typeof value === "number") parsed = value;
	else if (typeof value === "string") {
		const normalized = value.trim().toLowerCase().replace(/[,_]/g, "");
		if (normalized === "off") parsed = 0;
		else {
			const match = /^(\d+(?:\.\d+)?)\s*(?:%|m|min|mins|minutes?)?$/.exec(normalized);
			if (match) parsed = Number(match[1]);
		}
	}
	return parsed !== undefined && Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
}

/** Parse one reclaim setting; undefined when the value is invalid. */
function parseReclaimValue(key: ReclaimSettingKey, value: unknown): boolean | number | undefined {
	switch (key) {
		case "reclaimContext":
			if (typeof value === "boolean") return value;
			if (value === "true" || value === "false") return value === "true";
			return undefined;
		case "reclaimMinTokens":
			return parsePositiveInt(value);
		case "reclaimMinPercent":
			return parseNonNegative(value, 100);
		case "reclaimColdMinutes":
			return parseNonNegative(value);
	}
}

/** Copy `key` into `target` when valid and not the default. */
function setReclaimValue(target: RealagyConfig, key: ReclaimSettingKey, value: unknown): void {
	const parsed = parseReclaimValue(key, value);
	if (parsed === undefined || parsed === DEFAULT_RECLAIM_SETTINGS[key]) delete target[key];
	else (target as unknown as Record<string, unknown>)[key] = parsed;
}

/** Display text of a reclaim setting, as offered by the settings UI. */
export function formatReclaimValue(key: ReclaimSettingKey, config: RealagyConfig): string {
	const value = reclaimSettings(config)[key];
	switch (key) {
		case "reclaimContext":
			return value ? "true" : "false";
		case "reclaimMinTokens":
			return (value as number).toLocaleString("en-US");
		case "reclaimMinPercent":
			return `${value as number}%`;
		case "reclaimColdMinutes":
			return value === 0 ? "off" : `${value as number} min`;
	}
}

function formatReclaimSummary(config: RealagyConfig): string {
	const settings = reclaimSettings(config);
	if (!settings.reclaimContext) return "OFF";
	const cold = settings.reclaimColdMinutes > 0 ? `, or any such amount after ${formatReclaimValue("reclaimColdMinutes", config)} idle` : "";
	return `ON (≥ ${formatReclaimValue("reclaimMinTokens", config)} tokens and ≥ ${formatReclaimValue("reclaimMinPercent", config)} of the session${cold})`;
}

export const MODEL_DEFAULT_LABEL = "model default";
const CUSTOM_VALUE = "__custom__";
const INHERIT_GLOBAL_LABEL = "inherit global";
const MODEL_LIMIT_SETTING_PREFIXES = {
	contextWindowOverrides: "contextWindowOverride:",
	maxOutputTokensOverrides: "maxOutputTokenOverride:",
} as const;
type ModelLimitOverridesKey = keyof typeof MODEL_LIMIT_SETTING_PREFIXES;

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

const MODEL_OUTPUT_PRESETS: readonly SelectItem[] = OUTPUT_PRESETS.map((item, index) =>
	index === 0
		? {
			...item,
			value: INHERIT_GLOBAL_LABEL,
			label: INHERIT_GLOBAL_LABEL,
			description: "Use the global maxOutputTokens, then the catalog or family default",
		}
		: item,
);

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

function normalizeModelLimitOverrides(value: unknown): Record<string, number> | undefined {
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
	const fullMcpOutput = typeof record.fullMcpOutput === "boolean"
		? record.fullMcpOutput
		: DEFAULT_REALAGY_CONFIG.fullMcpOutput;
	const agentProfile = typeof record.agentProfile === "boolean"
		? record.agentProfile
		: DEFAULT_REALAGY_CONFIG.agentProfile;
	const contextWindow = parsePositiveInt(record.contextWindow);
	const contextWindowOverrides = normalizeModelLimitOverrides(record.contextWindowOverrides);
	const maxOutputTokens = parsePositiveInt(record.maxOutputTokens);
	const maxOutputTokensOverrides = normalizeModelLimitOverrides(record.maxOutputTokensOverrides);
	const result: RealagyConfig = { noAutoCompaction, fullMcpOutput, agentProfile };
	if (contextWindow !== undefined) result.contextWindow = contextWindow;
	if (contextWindowOverrides !== undefined) result.contextWindowOverrides = contextWindowOverrides;
	if (maxOutputTokens !== undefined) result.maxOutputTokens = maxOutputTokens;
	if (maxOutputTokensOverrides !== undefined) result.maxOutputTokensOverrides = maxOutputTokensOverrides;
	for (const key of RECLAIM_SETTING_KEYS) setReclaimValue(result, key, record[key]);
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

function formatOverrideCount(overrides: Readonly<Record<string, number>> | undefined): string {
	const count = Object.keys(overrides ?? {}).length;
	return count === 0 ? "none" : `${count} override${count === 1 ? "" : "s"}`;
}

function modelLimitKeyForSettingId(id: string): ModelLimitOverridesKey | undefined {
	if (id.startsWith(MODEL_LIMIT_SETTING_PREFIXES.contextWindowOverrides)) return "contextWindowOverrides";
	if (id.startsWith(MODEL_LIMIT_SETTING_PREFIXES.maxOutputTokensOverrides)) return "maxOutputTokensOverrides";
	return undefined;
}

export function formatConfigLimit(value: number | undefined): string {
	return value !== undefined ? value.toLocaleString("en-US") : MODEL_DEFAULT_LABEL;
}

export function formatConfigSummary(config: RealagyConfig, file: string = realagyConfigPath()): string {
	return [
		`Antigravity settings (${file}):`,
		`  Bypass Agy auto-compaction: ${config.noAutoCompaction ? "ON" : "OFF"}`,
		`  Full MCP output (binary patch): ${config.fullMcpOutput ? "ON" : "OFF"}`,
		`  Pi-only agent profile: ${config.agentProfile ? "ON" : "OFF"}`,
		`  Pi context window: ${formatConfigLimit(config.contextWindow)}`,
		...Object.entries(config.contextWindowOverrides ?? {}).map(
			([modelId, limit]) => `  Pi context window (${modelId}): ${formatConfigLimit(limit)}`,
		),
		`  Pi max output tokens: ${formatConfigLimit(config.maxOutputTokens)}`,
		...Object.entries(config.maxOutputTokensOverrides ?? {}).map(
			([modelId, limit]) => `  Pi max output tokens (${modelId}): ${formatConfigLimit(limit)}`,
		),
		`  Release context dropped by pi extensions: ${formatReclaimSummary(config)}`,
	].join("\n");
}

function withUpdatedSetting(current: RealagyConfig, id: string, rawValue: string): RealagyConfig {
	const modelLimitKey = modelLimitKeyForSettingId(id);
	if (modelLimitKey) {
		const modelId = id.slice(MODEL_LIMIT_SETTING_PREFIXES[modelLimitKey].length);
		const overrides = { ...current[modelLimitKey] };
		const limit = parseLimitChoice(rawValue);
		if (limit === undefined) delete overrides[modelId];
		else overrides[modelId] = limit;
		const next = { ...current };
		if (Object.keys(overrides).length > 0) next[modelLimitKey] = overrides;
		else delete next[modelLimitKey];
		return next;
	}

	let noAutoCompaction = current.noAutoCompaction;
	let fullMcpOutput = current.fullMcpOutput;
	let agentProfile = current.agentProfile;
	let contextWindow = current.contextWindow;
	let maxOutputTokens = current.maxOutputTokens;
	if (id === "noAutoCompaction") noAutoCompaction = rawValue === "true";
	else if (id === "fullMcpOutput") fullMcpOutput = rawValue === "true";
	else if (id === "agentProfile") agentProfile = rawValue === "true";
	else if (id === "contextWindow") contextWindow = parseLimitChoice(rawValue);
	else if (id === "maxOutputTokens") maxOutputTokens = parseLimitChoice(rawValue);
	const next: RealagyConfig = { noAutoCompaction, fullMcpOutput, agentProfile };
	if (contextWindow !== undefined) next.contextWindow = contextWindow;
	if (maxOutputTokens !== undefined) next.maxOutputTokens = maxOutputTokens;
	if (current.contextWindowOverrides !== undefined) next.contextWindowOverrides = current.contextWindowOverrides;
	if (current.maxOutputTokensOverrides !== undefined) next.maxOutputTokensOverrides = current.maxOutputTokensOverrides;
	for (const key of RECLAIM_SETTING_KEYS) {
		setReclaimValue(next, key, id === key ? rawValue : current[key]);
	}
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

class ModelLimitSubmenu implements Component {
	readonly capturesViewportInput = true;
	#container = new Container();
	#settingsList: SettingsList;
	#tui: TUI;

	constructor(opts: {
		title: string;
		modelIds: readonly string[];
		overrides: Readonly<Record<string, number>> | undefined;
		presets: readonly SelectItem[];
		theme: Theme;
		tui: TUI;
		setActiveInput: (input: Input | undefined) => void;
		onChange: (modelId: string, value: string) => void;
		done: () => void;
	}) {
		this.#tui = opts.tui;
		const items: SettingItem[] = opts.modelIds.map((modelId) => ({
			id: modelId,
			label: modelId,
			currentValue: opts.overrides?.[modelId] !== undefined
				? formatConfigLimit(opts.overrides[modelId])
				: INHERIT_GLOBAL_LABEL,
			submenu: (currentValue, done) => new LimitSubmenu({
				title: `${opts.title} · ${modelId}`,
				currentValue,
				presets: opts.presets,
				theme: opts.theme,
				tui: opts.tui,
				setActiveInput: opts.setActiveInput,
				done,
			}),
		}));
		this.#container.addChild({
			render: () => [`  ${opts.theme.fg("accent", opts.theme.bold(opts.title))}`, ""],
			invalidate: () => {},
		});
		this.#settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(modelId, value) => {
				opts.onChange(modelId, value);
				opts.done();
			},
			() => opts.done(),
		);
		this.#container.addChild(this.#settingsList);
	}

	invalidate(): void {
		this.#settingsList.invalidate();
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
				id: "fullMcpOutput",
				label: "Full MCP output (binary patch)",
				description: "Use a private patched agy copy so individual and parallel MCP results reach the model without agy's preview truncation",
				currentValue: this.#state.fullMcpOutput ? "true" : "false",
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
				description: "Global fallback reported to Pi for planning/compaction; the per-model submenu takes precedence",
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

		const modelIds = [...new Set([
			...opts.modelIds,
			...Object.keys(this.#state.contextWindowOverrides ?? {}),
			...Object.keys(this.#state.maxOutputTokensOverrides ?? {}),
		])];
		const addModelLimitMenu = (
			id: ModelLimitOverridesKey,
			label: string,
			presets: readonly SelectItem[],
		): void => {
			items.push({
				id,
				label,
				description: "Choose a model to set or clear its override",
				currentValue: formatOverrideCount(this.#state[id]),
				submenu: (_currentValue, done) => new ModelLimitSubmenu({
					title: label,
					modelIds,
					overrides: this.#state[id],
					presets,
					theme: opts.theme,
					tui: opts.tui,
					setActiveInput,
					onChange: (modelId, value) => {
						const next = withUpdatedSetting(
							this.#state,
							`${MODEL_LIMIT_SETTING_PREFIXES[id]}${modelId}`,
							value,
						);
						this.#state = next;
						this.#settingsList.updateValue(id, formatOverrideCount(next[id]));
						opts.onChange({ ...next });
					},
					done,
				}),
			});
		};
		addModelLimitMenu("contextWindowOverrides", "Per-model context windows", MODEL_CONTEXT_PRESETS);
		addModelLimitMenu("maxOutputTokensOverrides", "Per-model output tokens", MODEL_OUTPUT_PRESETS);
		items.push(
			{
				id: "reclaimContext",
				label: "Release dropped context",
				description: "Start a fresh agy session once pi extensions (such as realctx) dropped or summarized enough of what the current one holds; false keeps sessions warm",
				currentValue: formatReclaimValue("reclaimContext", this.#state),
				values: ["true", "false"],
			},
			{
				id: "reclaimMinTokens",
				label: "Release: minimum tokens",
				description: "Least dropped context, in tokens, worth re-sending the smaller transcript to a fresh session (more values in config.json)",
				currentValue: formatReclaimValue("reclaimMinTokens", this.#state),
				values: RECLAIM_TOKEN_VALUES,
			},
			{
				id: "reclaimMinPercent",
				label: "Release: minimum share",
				description: "...that is also at least this share of the session's context while the prompt cache is warm (0% = tokens alone decide)",
				currentValue: formatReclaimValue("reclaimMinPercent", this.#state),
				values: RECLAIM_PERCENT_VALUES,
			},
			{
				id: "reclaimColdMinutes",
				label: "Release: cold cache after",
				description: "After this long without a reply the prompt cache is cold, so the minimum tokens alone decide (off = always require the share)",
				currentValue: formatReclaimValue("reclaimColdMinutes", this.#state),
				values: RECLAIM_COLD_VALUES,
			},
		);

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
			11,
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
	const allModelIds = [...new Set([
		...modelIds,
		...Object.keys(initial.contextWindowOverrides ?? {}),
		...Object.keys(initial.maxOutputTokensOverrides ?? {}),
	])];
	for (;;) {
		const choice = await ui.select("Antigravity settings", [
			`Bypass Agy auto-compaction: ${draft.noAutoCompaction ? "ON" : "OFF"}`,
			`Full MCP output (binary patch): ${draft.fullMcpOutput ? "ON" : "OFF"}`,
			`Pi-only agent profile: ${draft.agentProfile ? "ON" : "OFF"}`,
			`Pi context window: ${formatConfigLimit(draft.contextWindow)}`,
			`Pi max output tokens: ${formatConfigLimit(draft.maxOutputTokens)}`,
			"Per-model context windows…",
			"Per-model output tokens…",
			...RECLAIM_MENU.map((entry) => `${entry.label}: ${formatReclaimValue(entry.key, draft)}`),
			"Save and close",
			"Cancel",
		]);
		if (choice === undefined || choice === "Cancel") return undefined;
		if (choice === "Save and close") return draft;
		if (choice.startsWith("Bypass Agy auto-compaction:")) {
			draft = withUpdatedSetting(draft, "noAutoCompaction", draft.noAutoCompaction ? "false" : "true");
			continue;
		}
		if (choice.startsWith("Full MCP output (binary patch):")) {
			draft = withUpdatedSetting(draft, "fullMcpOutput", draft.fullMcpOutput ? "false" : "true");
			continue;
		}
		if (choice.startsWith("Pi-only agent profile:")) {
			draft = withUpdatedSetting(draft, "agentProfile", draft.agentProfile ? "false" : "true");
			continue;
		}
		const reclaimEntry = RECLAIM_MENU.find((entry) => choice.startsWith(`${entry.label}: `));
		if (reclaimEntry) {
			if (reclaimEntry.key === "reclaimContext") {
				draft = withUpdatedSetting(draft, "reclaimContext", reclaimSettings(draft).reclaimContext ? "false" : "true");
				continue;
			}
			const picked = await ui.select(reclaimEntry.label, [...reclaimEntry.values, "Custom…", "Back"]);
			if (picked === undefined) return undefined;
			if (picked === "Back") continue;
			let raw = picked;
			if (picked === "Custom…") {
				const typed = await ui.input(`${reclaimEntry.label} (${reclaimEntry.hint})`, formatReclaimValue(reclaimEntry.key, draft));
				if (typed === undefined) return undefined;
				raw = typed;
			}
			if (parseReclaimValue(reclaimEntry.key, raw) === undefined) {
				ui.notify(`Enter ${reclaimEntry.hint}.`, "warning");
				continue;
			}
			draft = withUpdatedSetting(draft, reclaimEntry.key, raw);
			continue;
		}

		let id: string;
		let current: number | undefined;
		let title: string;
		const isModelContext = choice === "Per-model context windows…";
		const isModelOutput = choice === "Per-model output tokens…";
		if (isModelContext || isModelOutput) {
			const key: ModelLimitOverridesKey = isModelContext ? "contextWindowOverrides" : "maxOutputTokensOverrides";
			const menuTitle = isModelContext ? "Per-model context windows" : "Per-model output tokens";
			const limitLabel = isModelContext ? "Context" : "Output tokens";
			const modelChoice = await ui.select(menuTitle, [
				...allModelIds.map((modelId) => {
					const limit = draft[key]?.[modelId];
					return `${modelId}: ${limit !== undefined ? formatConfigLimit(limit) : INHERIT_GLOBAL_LABEL}`;
				}),
				"Back",
			]);
			if (modelChoice === undefined) return undefined;
			if (modelChoice === "Back") continue;
			const modelId = allModelIds.find((candidate) => modelChoice.startsWith(`${candidate}: `));
			if (modelId === undefined) continue;
			id = `${MODEL_LIMIT_SETTING_PREFIXES[key]}${modelId}`;
			current = draft[key]?.[modelId];
			title = `${limitLabel} · ${modelId} (positive tokens, or empty to inherit global)`;
		} else {
			const isContext = choice.startsWith("Pi context window:");
			id = isContext ? "contextWindow" : "maxOutputTokens";
			current = isContext ? draft.contextWindow : draft.maxOutputTokens;
			title = isContext
				? "Pi context window (positive tokens, or empty for model default)"
				: "Pi max output tokens (positive tokens, or empty for model default)";
		}

		const defaultLabel = modelLimitKeyForSettingId(id) !== undefined ? INHERIT_GLOBAL_LABEL : MODEL_DEFAULT_LABEL;
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
