// Minimal realagy provider: official ACP transport, pi-native tools.
// There is intentionally no config panel, stream-json engine, delegation tool,
// or global MCP registration. agy keeps its own tools; a system-prompt policy
// steers the model to pi's tools, and agy's own tool use stays visible.

import { createProvider } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../src/acp/driver.js";
import { backgroundMessageText, defaultBrainDir } from "../src/acp/background.js";
import { AGY_BACKGROUND_MESSAGE, renderBackgroundCard, type BackgroundCardDetails } from "../src/background-card.js";
import { fetchCliUsage, UsageMeter } from "../src/quota.js";
import type { AcpSessions } from "../src/provider.js";
import { defaultConversationsDir } from "../src/acp/step-usage.js";
import { ensureAgyReady, MANUAL_SETUP, resolveAgyBinary } from "../src/acp/setup.js";
import { bridgedPiTools, bridgeInputSchema } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import { entriesFromAcpModels, FALLBACK_MODELS, toPiModel, type AgyModelEntry } from "../src/models.js";
import { AgyWorkPanel } from "../src/native-tools.js";
import { createStreamSimple, POLL_TOOL_NAME, ToolRoundTrips } from "../src/provider.js";
import { toolPolicyPrompt } from "../src/tool-policy.js";
import { restoreWarmSessions, WARM_SESSION_ENTRY, type SessionEntryLike, type WarmSession } from "../src/transcript.js";
/** Widget key of the live panel of running agy work. */
const AGY_WORK_WIDGET = "agy-work";

const SIGN_IN = [
	"Sign in with the Antigravity CLI in a terminal (realagy never handles credentials):",
	"  agy                # interactive sign-in on first run",
	"  agy acp --login    # or sign in without starting a chat",
	"Then run /agy setup again.",
].join("\n");

export default async function (pi: ExtensionAPI): Promise<void> {
	const entries: AgyModelEntry[] = [...FALLBACK_MODELS];
	pi.registerMessageRenderer(AGY_BACKGROUND_MESSAGE, renderBackgroundCard);
	// Re-resolved by /agy setup; a missing binary fails the spawn with a
	// pointer to /agy setup.
	let bin = resolveAgyBinary() ?? "agy";
	let bridge: McpServerHandle | null = null;
	let stopped = false;
	const shutdownController = new AbortController();

	const activeTools = () => bridgedPiTools(pi.getAllTools(), pi.getActiveTools());
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

	const driver = new AcpDriver({
		bin: () => bin,
		mcpServers: () => bridge ? [{
			name: "pi-bridge",
			type: "http",
			url: `http://127.0.0.1:${bridge.port}/mcp`,
			headers: [{ name: TOKEN_HEADER, value: bridge.token }],
		}] : [],
		// Exact per-call usage comes from the server's conversation store;
		// unmeasured messages are left to pi's own transcript estimate.
		conversationsDir: () => defaultConversationsDir(),
		systemPrompt: () => toolPolicyPrompt(activeTools().map((tool) => tool.name)),
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
	const roundTrips = new ToolRoundTrips(driver);
	driver.onTurnEnd = (outcome) => {
		if (outcome.aborted || outcome.status === "ERROR") roundTrips.failAll(outcome.error ?? "Antigravity turn ended");
	};
	const started = await startMcpServer({
		listTools: () => [
			...activeTools().map((tool) => ({
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
			if (name !== POLL_TOOL_NAME && !activeTools().some((tool) => tool.name === name)) {
				return Promise.resolve({ content: [{ type: "text" as const, text: `Pi tool ${name} is not active` }], isError: true });
			}
			return roundTrips.onToolCall(callId, name, args, signal);
		},
	});
	if (!started.ok) throw new Error(`Cannot start pi tool bridge: ${started.reason}`);
	bridge = started.handle;

	let pendingWarmEntry: WarmSession | null = null;
	const sessions: AcpSessions = {
		conversationsDir: () => defaultConversationsDir(),
		onWarm: (warm) => {
			pendingWarmEntry = warm;
		},
	};
	const meter = new UsageMeter();
	let ready = false;
	const streamSimple = createStreamSimple({ entries, driver, roundTrips, sessions, meter });
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
					name: "Antigravity CLI sign-in (see /agy setup)",
					resolve: async () => (resolveAgyBinary() ? { auth: {}, source: "agy CLI" } : undefined),
				},
			},
			models: entries.map((entry) => toPiModel(entry)),
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
				registerModels();
			}
			return { ok: true, models: discovered.length };
		} catch (error) {
			return { ok: false, missing: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	const refreshCatalog = async (ctx: { hasUI: boolean; ui: ExtensionUIContext }): Promise<void> => {
		const result = await discover();
		if (stopped || result.ok) return;
		ctx.ui.notify(result.missing
			? `Antigravity: ${result.error}. Run /agy setup for install steps.`
			: `Antigravity model discovery failed: ${result.error}. Run /agy setup to sign in.`, "warning");
	};

	const syncWarmFromSession = (ctx: { sessionManager?: { getBranch?: () => unknown[]; getEntries?: () => unknown[] } }): void => {
		pendingWarmEntry = null;
		sessions.parked = undefined;
		const branch = (ctx.sessionManager?.getBranch?.() ?? []) as readonly SessionEntryLike[];
		const all = (ctx.sessionManager?.getEntries?.() ?? branch) as readonly SessionEntryLike[];
		const restored = restoreWarmSessions(branch, all);
		sessions.warm = restored.warm;
		sessions.checkpoints = restored.checkpoints;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ui = ctx.ui;
		syncWarmFromSession(ctx);
		refresh ??= refreshCatalog(ctx).catch((error: unknown) => {
			if (!stopped && ctx.hasUI) ctx.ui.notify(`Antigravity setup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}).finally(() => { refresh = null; });
	});
	pi.on("session_tree", (_event, ctx) => {
		syncWarmFromSession(ctx);
	});
	pi.on("session_compact", () => {
		pendingWarmEntry = null;
		sessions.parked = undefined;
		sessions.warm = undefined;
		sessions.checkpoints = undefined;
	});
	pi.on("turn_end", () => {
		if (!pendingWarmEntry) return;
		const entry = pendingWarmEntry;
		pendingWarmEntry = null;
		try {
			pi.appendEntry(WARM_SESSION_ENTRY, entry);
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
		sessions.checkpoints = undefined;
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

	pi.registerCommand("agy", {
		description: "Antigravity: /agy setup (install and sign-in help) or /agy usage (cache hits and plan quota)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "setup", label: "setup", description: "Check agy and show how to install it or sign in" },
				{ value: "usage", label: "usage", description: "Cache hits and plan quota" },
			];
			const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "setup") {
				const loaded = await runWithLoader(ctx, "Checking Antigravity CLI…", () => discover());
				if (stopped || loaded.aborted) return;
				const result = loaded.value;
				if (result.ok) {
					ctx.ui.notify(`Antigravity is ready: ${bin} is signed in and offers ${result.models} models. Pick one with /model.`, "info");
				} else if (result.missing) {
					ctx.ui.notify(`Antigravity: ${result.error}.\n\n${MANUAL_SETUP}\n\nThen run /agy setup again.`, "warning");
				} else {
					ctx.ui.notify(`Antigravity: ${bin} is installed but not usable: ${result.error}\n\n${SIGN_IN}`, "warning");
				}
				return;
			}
			if (sub !== "usage") {
				ctx.ui.notify("Usage: /agy setup | /agy usage", "info");
				return;
			}
			if (!ready) {
				const status = ensureAgyReady();
				ctx.ui.notify(status.ok ? "Antigravity is still starting; try again shortly." : `Antigravity: ${status.error}. Run /agy setup for install steps.`, "warning");
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
