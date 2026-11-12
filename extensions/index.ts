// Minimal realagy provider: official ACP transport, pi-native tools.
// There is intentionally no stream-json engine, delegation tool, or global
// MCP registration. agy runs realagy's hidden agent profile, which
// replaces agy's own prompt and tools with pi's (src/agent-profile.ts); without
// it, a system-prompt policy steers the model to pi's tools, and agy's own
// tool use stays visible.

import { createProvider } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../src/acp/driver.js";
import { installAgentProfile } from "../src/agent-profile.js";
import { backgroundMessageText, defaultBrainDir } from "../src/acp/background.js";
import { AGY_BACKGROUND_MESSAGE, renderBackgroundCard, type BackgroundCardDetails } from "../src/background-card.js";
import { fetchCliUsage, UsageMeter } from "../src/quota.js";
import type { AcpSessions } from "../src/provider.js";
import { defaultConversationsDir } from "../src/acp/step-usage.js";
import { SessionRetention } from "../src/acp/session-retention.js";
import { ensureAgyReady, MANUAL_SETUP, resolveAgyBinary } from "../src/acp/setup.js";
import { bridgedPiTools, bridgeInputSchema, declaresToolArgument, dispatchablePiTool } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import { entriesFromAcpModels, toPiModel, type AgyModelEntry } from "../src/models.js";
import { loadModelCache, saveModelCache } from "../src/model-cache.js";
import {
	editRealagyConfigMenu,
	formatConfigSummary,
	loadRealagyConfig,
	realagyConfigPath,
	RealagySettingsComponent,
	saveRealagyConfig,
	type RealagyConfig,
} from "../src/settings.js";
import { AgyWorkPanel } from "../src/native-tools.js";
import { createStreamSimple, failParkedCalls, POLL_TOOL_NAME, ToolRoundTrips } from "../src/provider.js";
import { toolPolicyPrompt } from "../src/tool-policy.js";
import {
	PARALLEL_TOOL_INFO,
	PARALLEL_TOOL_NAME,
	parallelErrorResult,
	parseParallelCalls,
} from "../src/parallel.js";
import { LOCKED_REPLAY_BUDGET_BYTES, restoreWarmSessions, UNLOCKED_REPLAY_BUDGET_BYTES, WARM_SESSION_ENTRY, type SessionEntryLike, type WarmSession } from "../src/transcript.js";
import { treeRestoreExtras, type LoadoutEntry } from "../src/tool-loadout.js";
import { traceUsage } from "../src/usage-trace.js";
/** Widget key of the live panel of running agy work. */
const AGY_WORK_WIDGET = "agy-work";

const SIGN_IN = [
	"Sign in with the Antigravity CLI in a terminal (realagy never handles credentials):",
	"  agy                # interactive sign-in on first run",
	"  agy acp --login    # or sign in without starting a chat",
	"Then run /realagy setup again.",
].join("\n");

export default async function (pi: ExtensionAPI): Promise<void> {
	const entries: AgyModelEntry[] = [...(loadModelCache() ?? [])];
	const configPath = realagyConfigPath();
	let config = loadRealagyConfig(configPath);
	pi.registerMessageRenderer(AGY_BACKGROUND_MESSAGE, renderBackgroundCard);
	// Re-resolved by /realagy setup; a missing binary fails the spawn with a
	// pointer to /realagy setup.
	let bin = resolveAgyBinary() ?? "agy";
	let bridge: McpServerHandle | null = null;
	let stopped = false;
	const shutdownController = new AbortController();

	// Every tool an extension may activate is listed, so a mid-session
	// activation never needs a new ACP session; only active ones run.
	const bridgedTools = () => [...bridgedPiTools(pi.getAllTools(), pi.getActiveTools()), PARALLEL_TOOL_INFO];
	// UI of this runtime, for the live agy panel. pi replaces the runtime on
	// /new, /resume, /fork, and /reload after session_shutdown, so `stopped`
	// guards every use.
	let ui: ExtensionUIContext | undefined;
	const workPanel = new AgyWorkPanel({
		show: (widget) => {
			if (!stopped) ui?.setWidget(AGY_WORK_WIDGET, widget);
		},
		hide: () => {
			if (!stopped) ui?.setWidget(AGY_WORK_WIDGET, undefined);
		},
	});

	const sessionRetention = new SessionRetention({ conversationsDir: defaultConversationsDir(), log: (event, data) => traceUsage(event, { detail: data }) });
	const driver = new AcpDriver({
		bin: () => bin,
		fullMcpOutput: () => config.fullMcpOutput,
		noAutoCompaction: () => config.noAutoCompaction,
		mcpServers: () => bridge ? [{
			name: "pi-bridge",
			type: "http",
			url: `http://127.0.0.1:${bridge.port}/mcp`,
			headers: [{ name: TOKEN_HEADER, value: bridge.token }],
		}] : [],
		// Exact per-call usage comes from the server's conversation store;
		// unmeasured messages are left to pi's own transcript estimate.
		conversationsDir: () => defaultConversationsDir(),
		sessionRetention,
		systemPrompt: (agent) => toolPolicyPrompt(bridgedTools().map((tool) => tool.name), { profile: agent !== undefined }),
		// Every bridged tool (and the poll helper) is marked eager in the
		// profile; without the bridge, agy's default agent keeps its own tools.
		agent: () =>
			bridge && config.agentProfile
				? installAgentProfile([...bridgedTools().map((tool) => tool.name), POLL_TOOL_NAME])
				: undefined,
		onNativeTool: (event) => workPanel.update(event),
		brainDir: () => defaultBrainDir(),
		// Finished background work wakes pi's agent: an idle agent starts a
		// turn now, a busy one gets the message after its current work.
		onBackgroundMessages: (items) => {
			if (stopped) return;
			pi.sendMessage<BackgroundCardDetails>(
				{ customType: AGY_BACKGROUND_MESSAGE, content: backgroundMessageText(items), display: true, details: { items } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});
	const roundTrips = new ToolRoundTrips(driver, {
		preserveToolSummary: (name) => declaresToolArgument(pi.getAllTools().find((tool) => tool.name === name)?.parameters, "toolSummary"),
	});
	driver.onTurnEnd = (outcome) => failParkedCalls(roundTrips, outcome);
	const started = await startMcpServer({
		listTools: () => [
			...bridgedTools().map((tool) => ({
				name: tool.name,
				description: tool.description ?? tool.name,
				inputSchema: bridgeInputSchema(tool.parameters),
			})),
			{
				name: POLL_TOOL_NAME,
				description: "Fetch a slow pi tool result using the callId from a STILL RUNNING response.",
				inputSchema: { type: "object", properties: { callId: { type: "string" } }, required: ["callId"] },
			},
		],
		onToolCall: (callId, name, args, signal) => {
			const active = pi.getActiveTools();
			if (name === PARALLEL_TOOL_NAME) {
				const parsed = parseParallelCalls(args, [POLL_TOOL_NAME]);
				if (!parsed.ok) return Promise.resolve(parallelErrorResult(parsed.error));
				const inactive = parsed.calls.find((call) => !dispatchablePiTool(pi.getAllTools(), active, call.name));
				if (inactive) {
					const usable = bridgedTools().filter((tool) => active.includes(tool.name)).map((tool) => tool.name);
					return Promise.resolve({
						content: [{ type: "text" as const, text: `Pi tool ${inactive.name} is not active in pi right now. Active pi tools: ${usable.join(", ") || "none"}.` }],
						isError: true,
					});
				}
				return roundTrips.onToolCall(callId, name, args, signal);
			}
			if (name !== POLL_TOOL_NAME && !dispatchablePiTool(pi.getAllTools(), active, name)) {
				const usable = bridgedTools().filter((tool) => active.includes(tool.name)).map((tool) => tool.name);
				return Promise.resolve({
					content: [{ type: "text" as const, text: `Pi tool ${name} is not active in pi right now. Active pi tools: ${usable.join(", ") || "none"}.` }],
					isError: true,
				});
			}
			return roundTrips.onToolCall(callId, name, args, signal);
		},
	});
	if (!started.ok) throw new Error(`Cannot start pi tool bridge: ${started.reason}`);
	bridge = started.handle;

	let pendingWarmEntry: WarmSession | null = null;
	let pendingWarmCanRetire = false;
	const sessions: AcpSessions = {
		onWarm: (warm, canRetire) => {
			pendingWarmEntry = warm;
			pendingWarmCanRetire = canRetire;
		},
	};
	const meter = new UsageMeter();
	let ready = false;
	const streamSimple = createStreamSimple({
		entries, driver, roundTrips, sessions, meter,
		replayBudgetBytes: () => config.noAutoCompaction ? UNLOCKED_REPLAY_BUDGET_BYTES : LOCKED_REPLAY_BUDGET_BYTES,
		inactivityMin: () => config.inactivityMin,
	});
	const registerModels = () => {
		// Sign-in belongs to the agy CLI. Ambient-only auth (no `login`) means pi
		// never prompts for or stores a key; the provider counts as configured
		// whenever an agy binary is present.
		pi.registerProvider(createProvider({
			id: "antigravity",
			name: "realagy",
			baseUrl: "agy-bridge://antigravity",
			auth: {
				apiKey: {
					name: "Antigravity CLI sign-in (see /realagy setup)",
					resolve: async () => (resolveAgyBinary() ? { auth: {}, source: "agy CLI" } : undefined),
				},
			},
			models: entries.map((entry) => toPiModel(entry, config)),
			api: { stream: (model, context, options) => streamSimple(model, context, options), streamSimple },
		}));
	};
	registerModels();

	let refresh: Promise<void> | null = null;
	/** Find agy and load the live catalog. Startup stays quiet on success. */
	const discover = async (): Promise<{ ok: true; models: number } | { ok: false; missing: boolean; error: string }> => {
		const status = ensureAgyReady();
		if (!status.ok) return { ok: false, missing: true, error: status.error };
		bin = status.bin;
		ready = true;
		try {
			const discovered = entriesFromAcpModels(await driver.listModels(process.cwd()));
			if (!stopped && discovered.length > 0) {
				entries.splice(0, entries.length, ...discovered);
				saveModelCache(discovered);
				registerModels();
			}
			return { ok: true, models: discovered.length };
		} catch (error) {
			return { ok: false, missing: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	const refreshCatalog = async (ctx: { hasUI: boolean; ui: ExtensionUIContext }): Promise<void> => {
		const result = await discover();
		if (stopped || !ctx.hasUI) return;
		if (result.ok) {
			if (result.models === 0 && entries.length === 0) ctx.ui.notify("Antigravity returned no models. Run /realagy refresh to try again.", "warning");
			return;
		}
		ctx.ui.notify(result.missing
			? `Antigravity: ${result.error}. Run /realagy setup for install steps.`
			: `Antigravity model discovery failed: ${result.error}. Run /realagy setup to sign in.`, "warning");
	};

	const syncWarmFromSession = (ctx: { sessionManager?: { getBranch?: () => unknown[]; getEntries?: () => unknown[] } }): boolean => {
		pendingWarmEntry = null;
		sessions.parked = undefined;
		const branch = (ctx.sessionManager?.getBranch?.() ?? []) as readonly SessionEntryLike[];
		const restored = restoreWarmSessions(branch);
		sessions.warm = restored.warm;
		// Protect a restored checkpoint as soon as Pi opens its branch, even if
		// the user does not send the next model request for several days.
		return !sessions.warm || sessionRetention.acquire(sessions.warm.sessionId);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ui = ctx.ui;
		// Do not sweep if we could not protect the restored checkpoint.
		if (syncWarmFromSession(ctx)) sessionRetention.sweep();
		if (!refresh && ctx.hasUI && entries.length === 0) ctx.ui.setStatus("realagy-model-discovery", "Antigravity: discovering models…");
		refresh ??= refreshCatalog(ctx).catch((error: unknown) => {
			if (!stopped && ctx.hasUI) ctx.ui.notify(`Antigravity setup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}).finally(() => { refresh = null; if (!stopped && ctx.hasUI) ctx.ui.setStatus("realagy-model-discovery", undefined); });
	});
	// Active tools before a /tree navigation, to undo the situational tools
	// pi's restore activates (src/tool-loadout.ts).
	let toolsBeforeTree: ReadonlySet<string> | undefined;
	pi.on("session_before_tree", () => {
		toolsBeforeTree = new Set(pi.getActiveTools());
	});
	pi.on("session_tree", (_event, ctx) => {
		// Rewind/edit invalidates the native cache unconditionally. The next turn
		// rebuilds from Pi's effective <pi_history> instead of forking agy's DB.
		if (sessions.warm) (sessions.retirementCandidates ??= new Set()).add(sessions.warm.sessionId);
		sessions.warm = undefined;
		sessions.parked = undefined;
		const before = toolsBeforeTree;
		toolsBeforeTree = undefined;
		if (!before) return;
		const active = pi.getActiveTools();
		const branch = (ctx.sessionManager?.getBranch?.() ?? []) as readonly LoadoutEntry[];
		const extras = new Set(treeRestoreExtras(branch, before, active));
		if (extras.size > 0) pi.setActiveTools(active.filter((name) => !extras.has(name)));
	});
	pi.on("session_compact", () => {
		pendingWarmEntry = null;
		sessions.parked = undefined;
		if (sessions.warm) (sessions.retirementCandidates ??= new Set()).add(sessions.warm.sessionId);
		sessions.warm = undefined;
	});
	pi.on("turn_end", () => {
		if (!pendingWarmEntry) return;
		const entry = pendingWarmEntry;
		const canRetire = pendingWarmCanRetire;
		pendingWarmCanRetire = false;
		pendingWarmEntry = null;
		try {
			pi.appendEntry(WARM_SESSION_ENTRY, entry);
			if (canRetire) for (const id of sessions.retirementCandidates ?? []) {
				if (id === entry.sessionId) continue;
				driver.retireSession(id);
				sessions.retirementCandidates?.delete(id);
			}
		} catch { /* ephemeral or read-only session */ }
	});
	pi.on("session_shutdown", () => {
		// The event's context is still valid here: clear the panel before
		// this runtime lets go of the UI.
		workPanel.close();
		if (!stopped) ui?.setWidget(AGY_WORK_WIDGET, undefined);
		stopped = true;
		ui = undefined;
		shutdownController.abort();
		pendingWarmEntry = null;
		sessions.parked = undefined;
		sessions.warm = undefined;
		roundTrips.failAll("pi session shut down", { includeEscalated: true });
		void driver.close();
		if (bridge) void bridge.close();
		bridge = null;
	});

	const runWithLoader = async <T>(
		ctx: ExtensionCommandContext,
		message: string,
		task: (signal: AbortSignal) => Promise<T>,
	): Promise<{ aborted: true } | { aborted: false; value: T }> => {
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (shutdownController.signal.aborted) controller.abort();
		else shutdownController.signal.addEventListener("abort", abort, { once: true });
		try {
			if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
				return await ctx.ui.custom<{ aborted: true } | { aborted: false; value: T }>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, message);
					const cancel = () => {
						controller.abort();
						done({ aborted: true });
					};
					loader.onAbort = cancel;
					if (controller.signal.aborted) cancel();
					else {
						void task(controller.signal).then(
							(value) => done(controller.signal.aborted ? { aborted: true } : { aborted: false, value }),
							() => done({ aborted: true }),
						);
					}
					return loader;
				});
			}
			const value = await task(controller.signal);
			return controller.signal.aborted ? { aborted: true } : { aborted: false, value };
		} finally {
			shutdownController.signal.removeEventListener("abort", abort);
		}
	};

	const applySavedConfig = (next: RealagyConfig, ctx: ExtensionCommandContext): boolean => {
		try {
			config = saveRealagyConfig(next, configPath);
			registerModels();
			return true;
		} catch (error) {
			ctx.ui.notify(`Could not save ${configPath}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	};

	pi.registerCommand("realagy", {
		description: "Antigravity: /realagy settings, /realagy setup, /realagy refresh, or /realagy usage",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "settings", label: "settings", description: "Configure compaction bypass, agent profile, Pi token limits, and context release" },
				{ value: "setup", label: "setup", description: "Check agy and show how to install it or sign in" },
				{ value: "refresh", label: "refresh", description: "Refresh the Antigravity model catalog" },
				{ value: "usage", label: "usage", description: "Cache hits and plan quota" },
			];
			const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			let sub = args.trim();
			if (!sub && ctx.hasUI && typeof ctx.ui.select === "function") {
				const selected = await ctx.ui.select("Antigravity", ["Settings", "Usage", "Setup"]);
				if (stopped || selected === undefined) return;
				sub = selected.toLowerCase();
			}
			if (sub === "settings") {
				const before = { ...config };
				if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
					await ctx.ui.custom<void>(
						(tui, theme, _kb, done) =>
							new RealagySettingsComponent({
								tui,
								theme,
								config,
								modelIds: entries.map((entry) => entry.id),
								configPath,
								onChange: (next) => {
									applySavedConfig(next, ctx);
								},
								onClose: () => done(undefined),
							}),
						{ blocked: { kind: "question", message: "Antigravity settings" } },
					);
				} else if (ctx.hasUI && typeof ctx.ui.select === "function" && typeof ctx.ui.input === "function") {
					const draft = await editRealagyConfigMenu(ctx.ui, config, entries.map((entry) => entry.id));
					if (stopped || !draft) return;
					if (!applySavedConfig(draft, ctx)) return;
				} else {
					ctx.ui.notify(formatConfigSummary(config, configPath), "info");
					return;
				}
				if (stopped) return;
				const modelLimitsChanged = (["contextWindowOverrides", "maxOutputTokensOverrides"] as const).some((key) => {
					const beforeOverrides = before[key] ?? {};
					const afterOverrides = config[key] ?? {};
					return Object.keys(beforeOverrides).length !== Object.keys(afterOverrides).length ||
						Object.entries(afterOverrides).some(([modelId, limit]) => beforeOverrides[modelId] !== limit);
				});
				const changed =
					config.noAutoCompaction !== before.noAutoCompaction ||
					config.fullMcpOutput !== before.fullMcpOutput ||
					config.agentProfile !== before.agentProfile ||
					config.contextWindow !== before.contextWindow ||
					config.maxOutputTokens !== before.maxOutputTokens ||
					modelLimitsChanged;
				if (!changed) return;
				const restartAgy =
					config.noAutoCompaction !== before.noAutoCompaction ||
					config.fullMcpOutput !== before.fullMcpOutput ||
					config.agentProfile !== before.agentProfile;
				if (restartAgy && !driver.activeHandle) await driver.restart();
				if (stopped) return;
				ctx.ui.notify(
					[
						formatConfigSummary(config, configPath),
						...(restartAgy ? ["Agy will use the updated process settings on its next turn."] : []),
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "setup") {
				const loaded = await runWithLoader(ctx, "Checking Antigravity CLI…", () => discover());
				if (stopped || loaded.aborted) return;
				const result = loaded.value;
				if (result.ok) {
					if (result.models === 0) {
						ctx.ui.notify("Antigravity returned no models. Run /realagy refresh to try again.", "warning");
						return;
					}
					ctx.ui.notify(`Antigravity is ready: ${bin} is signed in and offers ${result.models} models. Pick one with /model.`, "info");
				} else if (result.missing) {
					ctx.ui.notify(`Antigravity: ${result.error}.\n\n${MANUAL_SETUP}\n\nThen run /realagy setup again.`, "warning");
				} else {
					ctx.ui.notify(`Antigravity: ${bin} is installed but not usable: ${result.error}\n\n${SIGN_IN}`, "warning");
				}
				return;
			}
			if (sub === "refresh") {
				const loaded = await runWithLoader(ctx, "Refreshing Antigravity models…", () => discover());
				if (stopped || loaded.aborted) return;
				const result = loaded.value;
				if (!result.ok) ctx.ui.notify(`Antigravity model refresh failed: ${result.error}. Previous models retained.`, "warning");
				else if (result.models === 0) ctx.ui.notify("Antigravity returned no models. Previous models retained.", "warning");
				else ctx.ui.notify(`Antigravity model catalog refreshed: ${result.models} models. Pick one with /model.`, "info");
				return;
			}
			if (sub !== "usage") {
				ctx.ui.notify("Usage: /realagy settings | /realagy setup | /realagy refresh | /realagy usage", "info");
				return;
			}
			if (!ready) {
				const status = ensureAgyReady();
				ctx.ui.notify(status.ok ? "Antigravity is still starting; try again shortly." : `Antigravity: ${status.error}. Run /realagy setup for install steps.`, "warning");
				return;
			}
			let quotaError = "";
			const loaded = await runWithLoader(ctx, "Loading Antigravity plan quota…", async (signal) => {
				try {
					meter.setQuota(await fetchCliUsage(bin, { signal, pid: driver.pid }));
				} catch (error) {
					if (!signal.aborted) {
						quotaError = `\n\nQuota unavailable: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			});
			if (stopped) return;
			ctx.ui.notify(loaded.aborted ? meter.report() : `${meter.report()}${quotaError}`, "info");
		},
	});
}
