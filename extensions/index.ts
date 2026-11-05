// Minimal realagy provider: official ACP transport, pi-native tools.
// There is intentionally no config panel, stream-json engine, delegation tool,
// or global MCP registration. Only the native image/file viewer is enabled.

import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../src/acp/driver.js";
import { fetchCliUsage, UsageMeter } from "../src/quota.js";
import type { AcpSessions } from "../src/provider.js";
import { defaultConversationsDir } from "../src/acp/step-usage.js";
import { resolveAcpBinary } from "../src/acp/connection.js";
import { ensureAgyReady, MANUAL_SETUP, resolveAgyBinary } from "../src/acp/setup.js";
import { bridgedPiTools } from "../src/bridge-catalog.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import { entriesFromAcpModels, FALLBACK_MODELS, toPiModel, type AgyModelEntry } from "../src/models.js";
import { createStreamSimple, POLL_TOOL_NAME, ToolRoundTrips } from "../src/provider.js";

import { normalizeSchema } from "../src/schema.js";

const SIGN_IN = [
	"Sign in with the Antigravity CLI in a terminal (realagy never handles credentials):",
	"  agy                # interactive sign-in on first run",
	"  agy acp --login    # or sign in without starting a chat",
	"Then run /agy setup again.",
].join("\n");

export default async function (pi: ExtensionAPI): Promise<void> {
	const entries: AgyModelEntry[] = [...FALLBACK_MODELS];
	let bin = resolveAcpBinary("");
	let bridge: McpServerHandle | null = null;
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

	pi.on("session_start", (_event, ctx) => {
		refresh ??= refreshCatalog(ctx).catch((error: unknown) => {
			if (!stopped && ctx.hasUI) ctx.ui.notify(`Antigravity setup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}).finally(() => { refresh = null; });
	});
	pi.on("session_shutdown", () => {
		stopped = true;
		sessions.warm = undefined;
		roundTrips.failAll("pi session shut down");
		roundTrips.clearImages();
		void driver.close("shutdown");
		if (bridge) void bridge.close();
		bridge = null;
	});

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
				const result = await discover();
				if (stopped) return;
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
			// On demand only: `agy --print /usage` takes ~10 s.
			let quotaError = "";
			try {
				meter.setQuota(await fetchCliUsage(bin));
			} catch (error) {
				quotaError = `\n\nQuota unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (stopped) return;
			ctx.ui.notify(`${meter.report()}${quotaError}`, "info");
		},
	});
}
