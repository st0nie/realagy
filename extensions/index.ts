// Minimal realagy provider: official ACP transport, pi-native tools.
// There is intentionally no config panel, stream-json engine, delegation tool,
// global MCP registration, or Antigravity-native tool surface.

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../src/acp/driver.js";
import { resolveAcpBinary, setAuthInvalidatedHook } from "../src/acp/connection.js";
import { runAcpAuth } from "../src/acp/auth.js";
import { setupAuthUrlCapture } from "../src/acp/browser-capture.js";
import { clearAcpAuthVerified, ensureAcpReady } from "../src/acp/setup.js";
import { bridgedPiTools } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import { entriesFromAcpModels, FALLBACK_MODELS, toPiModel, type AgyModelEntry } from "../src/models.js";
import { createStreamSimple, POLL_TOOL_NAME, ToolRoundTrips } from "../src/provider.js";

import { normalizeSchema } from "../src/schema.js";
setAuthInvalidatedHook(() => clearAcpAuthVerified());

export default async function (pi: ExtensionAPI): Promise<void> {
	const entries: AgyModelEntry[] = [...FALLBACK_MODELS];
	let bin = resolveAcpBinary("");
	let bridge: McpServerHandle | null = null;
	let ui: ExtensionUIContext | null = null;

	const driver = new AcpDriver({
		bin: () => bin,
		enabledTools: () => [], // official ACP: disable ALL Antigravity builtins
		mcpServers: () => bridge ? [{
			name: "pi-bridge",
			type: "http",
			url: `http://127.0.0.1:${bridge.port}/mcp`,
			headers: [{ name: TOKEN_HEADER, value: bridge.token }],
		}] : [],
		usageEstimate: "estimate",
		log: (message, data) => {
			if (message === "auth-url" && data && typeof data === "object") {
				const url = (data as { url?: unknown }).url;
				if (typeof url === "string") ui?.notify(`Complete the Google sign-in:\n${url}`, "info");
			}
		},
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

	const streamSimple = createStreamSimple({ entries, driver, roundTrips });
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
		ui = ctx.hasUI ? ctx.ui : null;
		const status = await ensureAcpReady({
			onProgress: (message) => { if (ctx.hasUI) ctx.ui.setStatus("antigravity-setup", message); },
		});
		if (ctx.hasUI) ctx.ui.setStatus("antigravity-setup", undefined);
		if (!status.ok) {
			ctx.ui.notify(`Antigravity ACP setup failed: ${status.error}\n${status.manual}`, "warning");
			return;
		}
		bin = status.bin;
		if (status.needsLogin) {
			ctx.ui.notify("Antigravity ACP is installed. Run /realagy auth to complete Google sign-in.", "info");
			return;
		}
		try {
			const discovered = entriesFromAcpModels(await driver.listModels(process.cwd()));
			if (discovered.length > 0) {
				entries.splice(0, entries.length, ...discovered);
				registerModels();
			}
		} catch (error) {
			ctx.ui.notify(`Antigravity model discovery failed: ${error instanceof Error ? error.message : String(error)}. Run /realagy auth if sign-in is required.`, "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : null;
		refresh ??= refreshCatalog(ctx).finally(() => { refresh = null; });
		void refresh;
	});
	pi.on("session_shutdown", () => {
		roundTrips.failAll("pi session shut down");
		void driver.close("shutdown");
		if (bridge) void bridge.close();
		bridge = null;
	});

	pi.registerCommand("realagy", {
		description: "Sign in to Antigravity (/realagy auth)",
		handler: async (args, ctx) => {
			if (args.trim() !== "auth") {
				ctx.ui.notify("Use /realagy auth to sign in. Models and tools need no configuration.", "info");
				return;
			}
			const capture = setupAuthUrlCapture();
			const result = await runAcpAuth({
				bin,
				...(capture ? { extraEnv: capture.browserEnv, authUrlFile: capture.file } : {}),
				log: (message, data) => {
					if (message === "auth-url" && data && typeof data === "object") {
						const url = (data as { url?: unknown }).url;
						if (typeof url === "string") ctx.ui.notify(`Complete the Google sign-in:\n${url}`, "info");
					}
				},
			});
			if (!result.ok) {
				ctx.ui.notify(`Antigravity sign-in failed: ${result.error}`, "warning");
				return;
			}
			ctx.ui.notify(result.note ? `Signed in (${result.note}).` : "Signed in to Antigravity.", "info");
			await driver.close("recycle", "authentication refreshed");
			await refreshCatalog(ctx);
		},
	});
}
