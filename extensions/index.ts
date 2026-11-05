// Minimal realagy provider: official ACP transport, pi-native tools.
// There is intentionally no config panel, stream-json engine, delegation tool,
// or global MCP registration. Only the native image/file viewer is enabled.

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../src/acp/driver.js";
import { fetchCliUsage, UsageMeter } from "../src/quota.js";
import type { AcpSessions } from "../src/provider.js";
import { defaultConversationsDir } from "../src/acp/step-usage.js";
import { resolveAcpBinary } from "../src/acp/connection.js";
import { ensureAgyReady } from "../src/acp/setup.js";
import { bridgedPiTools } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import { entriesFromAcpModels, FALLBACK_MODELS, toPiModel, type AgyModelEntry } from "../src/models.js";
import { createStreamSimple, POLL_TOOL_NAME, ToolRoundTrips } from "../src/provider.js";

import { normalizeSchema } from "../src/schema.js";

/** Plan quota changes slowly; `agy --print /usage` takes ~10 s. */
const QUOTA_REFRESH_MS = 2 * 60_000;

export default async function (pi: ExtensionAPI): Promise<void> {
	const entries: AgyModelEntry[] = [...FALLBACK_MODELS];
	let bin = resolveAcpBinary("");
	let bridge: McpServerHandle | null = null;
	let ui: ExtensionUIContext | null = null;
	let stopped = false;

	const driver = new AcpDriver({
		bin: () => bin,
		enabledTools: () => ["view_file"], // native viewer delivers pixels that MCP offloads
		mcpServers: () => bridge ? [{
			name: "pi-bridge",
			type: "http",
			url: `http://127.0.0.1:${bridge.port}/mcp`,
			headers: [{ name: TOKEN_HEADER, value: bridge.token }],
		}] : [],
		// Exact per-call usage comes from the server's conversation store;
		// unmeasured messages are left to pi's own transcript estimate.
		conversationsDir: () => defaultConversationsDir(),
	});
	const roundTrips = new ToolRoundTrips(driver);
	driver.onTurnEnd = (outcome) => {
		if (outcome.aborted || outcome.status === "ERROR") roundTrips.failAll(outcome.error ?? "Antigravity turn ended");
	};

	const activeTools = () => bridgedPiTools(pi.getAllTools(), pi.getActiveTools());
	const started = await startMcpServer({
		listTools: () => [
			...activeTools().map((tool) => {
				let inputSchema: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: true };
				try {
					if (tool.parameters) inputSchema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
				} catch { /* retain the permissive schema */ }
				inputSchema = normalizeSchema(inputSchema);
				return { name: tool.name, description: tool.description ?? tool.name, inputSchema };
			}),
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

	const sessions: AcpSessions = {};
	const meter = new UsageMeter();
	let usageShown = false;
	let modelId: string | undefined;
	const updateUsageStatus = (): void => {
		const status = meter.status(modelId);
		if (stopped || !ui || (!status && !usageShown)) return;
		ui.setStatus("realagy-usage", status);
		usageShown = status !== undefined;
	};
	meter.onChange = updateUsageStatus;
	const selectModel = (model: { provider: string; id: string } | undefined): void => {
		modelId = model?.provider === "antigravity" ? model.id : undefined;
		updateUsageStatus();
	};
	let ready = false;
	let quotaAt = 0;
	let quotaRun: Promise<void> | null = null;
	let quotaError: string | undefined;
	const refreshQuota = (force = false): Promise<void> => {
		if (!ready || stopped) return Promise.resolve();
		if (quotaRun || (!force && Date.now() - quotaAt < QUOTA_REFRESH_MS)) return quotaRun ?? Promise.resolve();
		quotaAt = Date.now();
		quotaRun = fetchCliUsage(bin)
			.then((groups) => { quotaError = undefined; if (!stopped) meter.setQuota(groups); })
			// Quota is decoration; turns surface real failures. /agy usage shows it.
			.catch((error: unknown) => { quotaError = error instanceof Error ? error.message : String(error); })
			.finally(() => { quotaRun = null; });
		return quotaRun;
	};
	const streamSimple = createStreamSimple({ entries, driver, roundTrips, sessions, meter });
	const registerModels = () => {
		const models = entries.map((entry) => toPiModel(entry));
		pi.registerProvider("antigravity", {
			name: "realagy",
			baseUrl: "agy-bridge://antigravity",
			apiKey: "not-used",
			api: "agy-bridge",
			models: models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
			streamSimple,
		});
	};
	registerModels();

	let refresh: Promise<void> | null = null;
	const refreshCatalog = async (ctx: { hasUI: boolean; ui: ExtensionUIContext }): Promise<void> => {
		const status = ensureAgyReady();
		if (!status.ok) {
			ctx.ui.notify(`Antigravity: ${status.error}.\n${status.manual}`, "warning");
			return;
		}
		bin = status.bin;
		ready = true;
		void refreshQuota(true);
		try {
			const discovered = entriesFromAcpModels(await driver.listModels(process.cwd()));
			if (stopped) return;
			if (discovered.length > 0) {
				entries.splice(0, entries.length, ...discovered);
				registerModels();
			}
		} catch (error) {
			if (stopped) return;
			ctx.ui.notify(`Antigravity model discovery failed: ${error instanceof Error ? error.message : String(error)}. Sign in by running \`agy\` in a terminal.`, "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : null;
		selectModel(ctx.model);
		refresh ??= refreshCatalog(ctx).catch((error: unknown) => {
			if (!stopped && ctx.hasUI) ctx.ui.notify(`Antigravity setup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}).finally(() => { refresh = null; });
	});
	pi.on("session_shutdown", () => {
		stopped = true;
		if (usageShown) ui?.setStatus("realagy-usage", undefined);
		ui = null;
		meter.onChange = undefined;
		sessions.warm = undefined;
		roundTrips.failAll("pi session shut down");
		roundTrips.clearImages();
		void driver.close("shutdown");
		if (bridge) void bridge.close();
		bridge = null;
	});

	pi.on("model_select", (event) => {
		selectModel(event.model);
		if (modelId) void refreshQuota();
	});
	pi.on("agent_end", () => {
		if (modelId) void refreshQuota();
	});

	pi.registerCommand("agy", {
		description: "Antigravity: /agy usage (cache hits and plan quota)",
		getArgumentCompletions: (prefix) => {
			const items = [{ value: "usage", label: "usage", description: "Cache hits and plan quota" }];
			const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (args.trim() !== "usage") {
				ctx.ui.notify("Usage: /agy usage", "info");
				return;
			}
			if (!ready) {
				const status = ensureAgyReady();
				ctx.ui.notify(status.ok ? "Antigravity is still starting; try again shortly." : `Antigravity: ${status.error}.\n${status.manual}`, "warning");
				return;
			}
			await refreshQuota(true);
			if (stopped) return;
			ctx.ui.notify(`${meter.report()}${quotaError ? `\n\nQuota unavailable: ${quotaError}` : ""}`, "info");
		},
	});
}
