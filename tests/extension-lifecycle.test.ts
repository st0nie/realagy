import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(), listModels: vi.fn(), close: vi.fn(), restart: vi.fn(), register: vi.fn(), fetchCliUsage: vi.fn(),
	driverOptions: undefined as undefined | Record<string, any>,
	driver: undefined as undefined | Record<string, any>,
	bridge: undefined as undefined | Record<string, any>,
	roundTrips: undefined as undefined | Record<string, any>,
	onToolCall: vi.fn(), failParkedCalls: vi.fn(),
}));
vi.mock("../src/acp/setup.js", () => ({ ensureAgyReady: mocks.ensure, resolveAgyBinary: () => "agy", MANUAL_SETUP: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }));
vi.mock("../src/acp/connection.js", () => ({ resolveAcpBinary: () => "agy" }));
vi.mock("../src/quota.js", () => ({ fetchCliUsage: mocks.fetchCliUsage, UsageMeter: class { setQuota() {} report() { return "REPORT"; } } }));
vi.mock("../src/acp/driver.js", () => ({ AcpDriver: class {
	pid = 4242;
	listModels = mocks.listModels;
	close = mocks.close;
	restart = mocks.restart;
	activeHandle = null;
	constructor(options: Record<string, any>) { mocks.driverOptions = options; mocks.driver = this; }
} }));
vi.mock("../src/mcp-server.js", () => ({
	startMcpServer: async (deps: Record<string, any>) => {
		mocks.bridge = deps;
		return { ok: true, handle: { port: 1, token: "test", close: vi.fn() } };
	},
	TOKEN_HEADER: "token",
}));
vi.mock("../src/provider.js", () => ({
	createStreamSimple: vi.fn(),
	failParkedCalls: mocks.failParkedCalls,
	POLL_TOOL_NAME: "poll",
	ToolRoundTrips: class {
		constructor() { mocks.roundTrips = this; }
		onToolCall = mocks.onToolCall;
		failAll() {}
	},
}));

import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

type FakeTool = { name: string; description?: string; exposure?: string; parameters?: object };

let tempAgentDirs: string[] = [];

async function start(
	tools: { all: FakeTool[]; active: string[] } = { all: [], active: [] },
	config?: Record<string, unknown>,
) {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-ext-agent-"));
	if (config) {
		const configFile = path.join(agentDir, "realagy", "config.json");
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify(config));
	}
	tempAgentDirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const handlers = new Map<string, (...args: any[]) => void>();
	const commands = new Map<string, any>();
	const renderers = new Map<string, any>();
	const sendMessage = vi.fn();
	const pi = {
		on: (name: string, cb: (...args: any[]) => void) => handlers.set(name, cb),
		registerProvider: mocks.register,
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		sendMessage,
		getAllTools: () => tools.all,
		getActiveTools: () => [...tools.active],
		setActiveTools: vi.fn((names: string[]) => { tools.active = [...names]; }),
		appendEntry: vi.fn(),
	};
	await extension(pi as never);
	let stale = false;
	const ui = { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), theme: undefined };
	const ctx = { hasUI: true, model: undefined, get ui() { if (stale) throw new Error("stale context"); return ui; } };
	handlers.get("session_start")!({}, ctx);
	return { agentDir, shutdown: () => { handlers.get("session_shutdown")!(); stale = true; }, ui, commands, ctx, renderers, sendMessage, driver: mocks.driverOptions!, handlers, pi, tools };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.close.mockResolvedValue(undefined);
	mocks.restart.mockResolvedValue(undefined);
	mocks.fetchCliUsage.mockResolvedValue([]);
	for (const dir of tempAgentDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});
const finished = {
	sessionId: "s",
	kind: "task" as const,
	workId: "bg1",
	tool: "run_command",
	target: "sleep 15 && echo DONE",
	title: "Sleep and print DONE finished",
	exitCode: 0,
	durationMs: 15_200,
	output: "DONE",
	logPath: "/tmp/task-4.log",
};

describe("agy background work in pi", () => {
	it("wakes pi's agent with a follow-up message that renders as a card", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const session = await start();
		session.driver.onBackgroundMessages([finished]);
		expect(session.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = session.sendMessage.mock.calls[0]!;
		expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(message).toMatchObject({ customType: "agy-background", display: true, details: { items: [finished] } });
		expect(message.content).toMatch(/^Antigravity background work .* finished:\n\n- Background command run_command `sleep 15 && echo DONE` .*exit code 0, ran 15s\.\nOutput \(last lines\):\n```\nDONE\n```\nFull log: \/tmp\/task-4\.log$/s);
		expect(session.renderers.has("agy-background")).toBe(true);
	});

	it("shows running agy work in a widget above the editor and clears it on shutdown", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const session = await start();
		session.driver.onNativeTool({ type: "start", id: "a", tool: "run_command", target: "npm test", startedAt: Date.now() });
		const [key, factory] = session.ui.setWidget.mock.lastCall!;
		expect(key).toBe("agy-work");
		const requestRender = vi.fn();
		const widget = factory({ requestRender }, { fg: (_color: string, text: string) => text });
		expect(widget.render(80)).toEqual([expect.stringMatching(/agy {2}run_command {2}npm test {2}0\.0s$/)]);
		session.driver.onNativeTool({ type: "start", id: "a2", tool: "read_file", startedAt: Date.now() });
		expect(session.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalled();
		session.driver.onNativeTool({ type: "end", id: "a2" });
		session.driver.onNativeTool({ type: "end", id: "a" });
		expect(session.ui.setWidget).toHaveBeenLastCalledWith("agy-work", undefined);
		session.driver.onNativeTool({ type: "start", id: "b", tool: "read_file", startedAt: Date.now() });
		session.shutdown();
		expect(session.ui.setWidget).toHaveBeenLastCalledWith("agy-work", undefined);
		const calls = session.ui.setWidget.mock.calls.length;
		session.driver.onNativeTool({ type: "start", id: "c", tool: "read_file", startedAt: Date.now() });
		session.driver.onBackgroundMessages([finished]);
		expect(session.ui.setWidget).toHaveBeenCalledTimes(calls);
		expect(session.sendMessage).not.toHaveBeenCalled();
	});
});

describe("extension session lifecycle", () => {
	it("prompts with install instructions when agy is missing and does not install", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "the Antigravity CLI (agy) is not installed", manual: "curl -fsSL https://antigravity.google/cli/install.sh | bash" });
		const session = await start();
		await vi.waitFor(() => expect(session.ui.notify).toHaveBeenCalled());
		expect(session.ui.notify.mock.calls[0][0]).toMatch(/not installed.*\/realagy setup/);
		expect(mocks.listModels).not.toHaveBeenCalled();
	});

	it("ignores model discovery completion after shutdown", async () => {
		const discovery = deferred<never[]>();
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockReturnValue(discovery.promise);
		const session = await start();
		await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
		session.shutdown();
		discovery.resolve([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mocks.register).toHaveBeenCalledTimes(1);
		expect(session.ui.notify).not.toHaveBeenCalled();
	});

	it("opens Settings, Usage, or Setup from bare /realagy and honors menu cancellation", async () => {
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockResolvedValue([]);
		const session = await start();
		let selected: string | undefined;
		const select = vi.fn(async (title: string, _options: string[]) => {
			if (title === "Antigravity") return selected;
			if (title === "Antigravity settings") return "Cancel";
			throw new Error(`Unexpected menu: ${title}`);
		});
		const ui = { ...session.ui, select, input: vi.fn() };
		const invoke = () => session.commands.get("realagy").handler("", { ...session.ctx, mode: "rpc", ui });

		selected = "Settings";
		await invoke();
		expect(select).toHaveBeenCalledWith("Antigravity", ["Settings", "Usage", "Setup"]);
		expect(select).toHaveBeenCalledWith("Antigravity settings", expect.any(Array));

		selected = "Usage";
		await invoke();
		expect(session.ui.notify).toHaveBeenLastCalledWith("REPORT", "info");

		selected = "Setup";
		await invoke();
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/Antigravity is ready: agy is signed in/);

		const callCount = select.mock.calls.length;
		selected = undefined;
		await invoke();
		expect(select).toHaveBeenCalledTimes(callCount + 1);
	});

	it("registers /realagy with completions and notifies only after fresh quota resolves", async () => {
		const quota = deferred<never[]>();
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockResolvedValue([]);
		mocks.fetchCliUsage.mockReturnValueOnce(quota.promise);
		const session = await start();
		const realagy = session.commands.get("realagy");
		expect([...session.commands.keys()]).toEqual(["realagy"]);
		expect(realagy.getArgumentCompletions("u")).toEqual([{ value: "usage", label: "usage", description: "Cache hits and plan quota" }]);
		expect(realagy.getArgumentCompletions("").map((item: { value: string }) => item.value)).toEqual(["settings", "setup", "usage"]);
		expect(realagy.getArgumentCompletions("x")).toBeNull();
		await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
		const pending = realagy.handler("usage", session.ctx);
		expect(session.ui.notify).not.toHaveBeenCalled();
		expect(mocks.fetchCliUsage).toHaveBeenCalledWith("agy", expect.objectContaining({ pid: 4242 }));
		quota.resolve([]);
		await pending;
		expect(session.ui.notify).toHaveBeenCalledTimes(1);
		expect(session.ui.notify).toHaveBeenLastCalledWith("REPORT", "info");
	});

	it("shows a cancellable TUI loader during /realagy usage and aborts fetchCliUsage on Esc", async () => {
		initTheme();
		let capturedSignal: AbortSignal | undefined;
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockResolvedValue([]);
		mocks.fetchCliUsage.mockImplementationOnce((_bin: string, opts?: { signal?: AbortSignal }) => {
			capturedSignal = opts?.signal;
			return new Promise<never[]>(() => {});
		});
		const session = await start();
		await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
		const custom = vi.fn(async (factory: any) => {
			let result: unknown;
			const loader = factory(
				{ requestRender: vi.fn() },
				{ fg: (_c: string, s: string) => s },
				{},
				(val: unknown) => { result = val; },
			);
			loader.handleInput("\x1b");
			loader.dispose();
			return result;
		});
		await session.commands.get("realagy").handler("usage", { ...session.ctx, mode: "tui", ui: { ...session.ui, custom } });
		expect(custom).toHaveBeenCalledTimes(1);
		expect(capturedSignal?.aborted).toBe(true);
		expect(session.ui.notify).toHaveBeenLastCalledWith("REPORT", "info");
	});

	it("/realagy setup explains install, sign-in, or readiness", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "the Antigravity CLI (agy) is not installed", manual: "" });
		const session = await start();
		const realagy = session.commands.get("realagy");
		await realagy.handler("setup", session.ctx);
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/not installed[\s\S]*install\.sh[\s\S]*\/realagy setup again/);

		mocks.ensure.mockReturnValue({ ok: true, bin: "/bin/agy" });
		mocks.listModels.mockRejectedValueOnce(new Error("ACP authentication required"));
		await realagy.handler("setup", session.ctx);
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/not usable[\s\S]*agy acp --login/);

		mocks.listModels.mockResolvedValue([{ modelId: "gemini-3.8-flash-low" }, { modelId: "gemini-3.8-flash-high" }]);
		await realagy.handler("setup", session.ctx);
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/ready: \/bin\/agy is signed in and offers 1 models/);
	});

	it("registers per-model context overrides and preserves them when editing the global fallback", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const session = await start(
			{ all: [], active: [] },
			{
				contextWindow: 400_000,
				contextWindowOverrides: { "gemini-4-argon": 700_000 },
			},
		);
		const initialModels = mocks.register.mock.calls[0][0].getModels();
		expect(initialModels.find((m: { id: string }) => m.id === "gemini-4-argon").contextWindow).toBe(700_000);
		expect(initialModels.find((m: { id: string }) => m.id === "claude-sonnet-5-5").contextWindow).toBe(400_000);

		const choices = ["Pi context window: 400,000", "Save and close"];
		await session.commands.get("realagy").handler("settings", {
			...session.ctx,
			mode: "rpc",
			ui: {
				...session.ui,
				select: vi.fn(async () => choices.shift()),
				input: vi.fn(async () => "500000"),
			},
		});

		const updatedModels = mocks.register.mock.lastCall![0].getModels();
		expect(updatedModels.find((m: { id: string }) => m.id === "gemini-4-argon").contextWindow).toBe(700_000);
		expect(updatedModels.find((m: { id: string }) => m.id === "claude-sonnet-5-5").contextWindow).toBe(500_000);
		expect(mocks.restart).not.toHaveBeenCalled();
		const perModelChoices = [
			"Per-model context windows…",
			"claude-sonnet-5-5: inherit global",
			"Save and close",
		];
		await session.commands.get("realagy").handler("settings", {
			...session.ctx,
			mode: "rpc",
			ui: {
				...session.ui,
				select: vi.fn(async () => perModelChoices.shift()),
				input: vi.fn(async () => "250000"),
			},
		});
		const perModelModels = mocks.register.mock.lastCall![0].getModels();
		expect(perModelModels.find((m: { id: string }) => m.id === "gemini-4-argon").contextWindow).toBe(700_000);
		expect(perModelModels.find((m: { id: string }) => m.id === "claude-sonnet-5-5").contextWindow).toBe(250_000);
		expect(perModelModels.find((m: { id: string }) => m.id === "gpt-oss-120b").contextWindow).toBe(500_000);
		expect(mocks.restart).not.toHaveBeenCalled();
		const outputChoices = [
			"Per-model output tokens…",
			"claude-sonnet-5-5: inherit global",
			"Save and close",
		];
		await session.commands.get("realagy").handler("settings", {
			...session.ctx,
			mode: "rpc",
			ui: {
				...session.ui,
				select: vi.fn(async () => outputChoices.shift()),
				input: vi.fn(async () => "24000"),
			},
		});
		const outputModels = mocks.register.mock.lastCall![0].getModels();
		expect(outputModels.find((m: { id: string }) => m.id === "claude-sonnet-5-5").maxTokens).toBe(24_000);
		expect(outputModels.find((m: { id: string }) => m.id === "gemini-4-argon").maxTokens).toBe(65_536);
		expect(mocks.restart).not.toHaveBeenCalled();
		expect(JSON.parse(fs.readFileSync(path.join(session.agentDir, "realagy", "config.json"), "utf8"))).toEqual({
			noAutoCompaction: true,
			fullMcpOutput: true,
			agentProfile: true,
			contextWindow: 500_000,
			contextWindowOverrides: {
				"gemini-4-argon": 700_000,
				"claude-sonnet-5-5": 250_000,
			},
			maxOutputTokensOverrides: { "claude-sonnet-5-5": 24_000 },
		});
	});

	it("enables compaction bypass and 1M Argon window by default, and persists /realagy settings to config.json", async () => {
		initTheme();
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const session = await start({ all: [{ name: "bash", exposure: "direct" }], active: ["bash"] });
		expect(session.driver.noAutoCompaction()).toBe(true);
		expect(session.driver.fullMcpOutput()).toBe(true);
		const initialProvider = mocks.register.mock.calls[0][0];
		const argon = initialProvider.getModels().find((m: { id: string }) => m.id === "gemini-4-argon");
		expect(argon.contextWindow).toBe(1_048_576);
		expect(argon.maxTokens).toBe(65_536);

		// Open /realagy settings in TUI mode, toggle noAutoCompaction off, and close with Esc.
		const custom = vi.fn(async (factory: any) => {
			let doneCalled = false;
			const component = factory(
				{ requestRender: vi.fn() },
				{ fg: (_c: string, s: string) => s, bold: (s: string) => s },
				{},
				() => { doneCalled = true; },
			);
			component.handleInput("\r"); // toggle noAutoCompaction -> false
			component.handleInput("\x1b"); // close
			expect(doneCalled).toBe(true);
		});
		await session.commands.get("realagy").handler("settings", { ...session.ctx, mode: "tui", ui: { ...session.ui, custom } });
		expect(session.driver.noAutoCompaction()).toBe(false);
		expect(mocks.restart).toHaveBeenCalledTimes(1);
		const savedFile = path.join(session.agentDir, "realagy", "config.json");
		expect(JSON.parse(fs.readFileSync(savedFile, "utf8"))).toEqual({
			noAutoCompaction: false,
			fullMcpOutput: true,
			agentProfile: true,
		});

		// Changing only contextWindow re-registers models immediately without restarting agy.
		const choices = ["Pi context window: model default", "Save and close"];
		await session.commands.get("realagy").handler("settings", {
			...session.ctx,
			mode: "rpc",
			ui: {
				...session.ui,
				select: vi.fn(async () => choices.shift()),
				input: vi.fn(async () => "500000"),
			},
		});
		expect(mocks.restart).toHaveBeenCalledTimes(1);
		const updatedProvider = mocks.register.mock.lastCall![0];
		expect(updatedProvider.getModels().find((m: { id: string }) => m.id === "gemini-4-argon").contextWindow).toBe(500_000);
	});

	it("exposes full MCP output as a default-on setting and restarts agy when disabled", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const session = await start({ all: [], active: [] });
		expect(session.driver.fullMcpOutput()).toBe(true);
		const choices = ["Full MCP output (binary patch): ON", "Save and close"];
		await session.commands.get("realagy").handler("settings", {
			...session.ctx,
			mode: "rpc",
			ui: { ...session.ui, select: vi.fn(async () => choices.shift()), input: vi.fn() },
		});
		expect(session.driver.fullMcpOutput()).toBe(false);
		expect(mocks.restart).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fs.readFileSync(path.join(session.agentDir, "realagy", "config.json"), "utf8"))).toMatchObject({
			fullMcpOutput: false,
		});
	});

	it("bridges every tool an extension may activate, with a stable policy, and dispatches only active tools", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const session = await start({
			all: [
				{ name: "bash", exposure: "direct" },
				{ name: "read", exposure: "direct" },
				{ name: "pi_lens_activate_tools", exposure: "direct" },
				{ name: "lens_symbols", exposure: "direct" },
				{ name: "mcp__docs__search", exposure: "deferred" },
			],
			active: ["bash", "read", "pi_lens_activate_tools"],
		});
		const listed = () => mocks.bridge!.listTools().map((tool: { name: string }) => tool.name);
		expect(listed()).toEqual(["bash", "read", "pi_lens_activate_tools", "lens_symbols", "parallel", "poll"]);
		const policy = session.driver.systemPrompt();
		expect(policy).toMatch(/bash, read, pi_lens_activate_tools, lens_symbols/);
		expect(policy).toMatch(/use parallel once with \{calls:/);

		const inactive = await mocks.bridge!.onToolCall("c1", "lens_symbols", {}, new AbortController().signal);
		expect(inactive).toEqual({ content: [{ type: "text", text: "Pi tool lens_symbols is not active in pi right now. Active pi tools: bash, read, pi_lens_activate_tools." }], isError: true });
		expect(mocks.onToolCall).not.toHaveBeenCalled();
		const invalidBatch = await mocks.bridge!.onToolCall("batch-0", "parallel", { calls: [] }, new AbortController().signal);
		expect(invalidBatch.isError).toBe(true);
		const inactiveBatch = await mocks.bridge!.onToolCall("batch-1", "parallel", {
			calls: [{ name: "bash", arguments: {} }, { name: "lens_symbols", arguments: {} }],
		}, new AbortController().signal);
		expect(inactiveBatch).toEqual({ content: [{ type: "text", text: "Pi tool lens_symbols is not active in pi right now. Active pi tools: bash, read, pi_lens_activate_tools." }], isError: true });
		expect(mocks.onToolCall).not.toHaveBeenCalled();

		// pi_lens_activate_tools mid-session: same list and policy, now callable.
		session.tools.active.push("lens_symbols");
		expect(listed()).toEqual(["bash", "read", "pi_lens_activate_tools", "lens_symbols", "parallel", "poll"]);
		expect(session.driver.systemPrompt()).toBe(policy);
		mocks.onToolCall.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
		const signal = new AbortController().signal;
		await mocks.bridge!.onToolCall("c2", "lens_symbols", { name: "x" }, signal);
		expect(mocks.onToolCall).toHaveBeenCalledWith("c2", "lens_symbols", { name: "x" }, signal);
		mocks.onToolCall.mockResolvedValueOnce({ content: [{ type: "text", text: "batch ok" }] });
		const batchArgs = { calls: [{ name: "lens_symbols", arguments: { name: "x" } }, { name: "read" }] };
		await mocks.bridge!.onToolCall("batch-2", "parallel", batchArgs, signal);
		expect(mocks.onToolCall).toHaveBeenCalledWith("batch-2", "parallel", batchArgs, signal);
	});

	it("runs agy with a hidden profile that marks every bridged tool eager, unless opted out", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-ext-profile-"));
		vi.stubEnv("GEMINI_HOME", home);
		try {
			const session = await start({ all: [{ name: "bash", exposure: "direct" }, { name: "read", exposure: "direct" }], active: ["bash", "read"] });
			const agent = session.driver.agent();
			expect(agent).toMatch(/^realagy-[0-9a-f]{12}$/);
			const profile = fs.readFileSync(path.join(home, "config", "agents", `${agent}.md`), "utf8");
			for (const tool of ["bash", "read", "parallel", "poll"]) expect(profile).toContain(`"${tool}":\n        eager: true`);
			expect(session.driver.systemPrompt(agent)).toMatch(/mcp_pi-bridge_<name>/);
			expect(session.driver.systemPrompt(undefined)).toMatch(/Do not use your built-in run_command/);
			const selectChoices = ["Pi-only agent profile: ON", "Save and close"];
			await session.commands.get("realagy").handler("settings", {
				...session.ctx,
				mode: "rpc",
				ui: {
					...session.ui,
					select: vi.fn(async () => selectChoices.shift()),
					input: vi.fn(),
				},
			});
			expect(session.driver.agent()).toBeUndefined();
			expect(mocks.restart).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("fails a settled turn's parked calls through failParkedCalls", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		await start();
		const outcome = { status: "OK", response: "", aborted: true };
		mocks.driver!.onTurnEnd(outcome);
		expect(mocks.failParkedCalls).toHaveBeenCalledWith(mocks.roundTrips, outcome);
	});

	it("/tree rewind deactivates the pi-lens tools pi's restore activated, keeping tools active before or declared by the branch", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "x", manual: "y" });
		const lens = ["lens_symbols", "lens_references", "lens_diagnostics", "lens_rename", "lens_outline"];
		const session = await start({
			all: ["bash", "read", "new_ext_tool", "lens_declared", ...lens].map((name) => ({ name })),
			active: ["bash", "read", "new_ext_tool"],
		});
		const warm = { sessionId: "s1", cwd: "/w", count: 3, hash: "h", systemPrompt: "Rules", tools: "bash,lens_declared,read" };
		const branch = [
			{ type: "message", message: { role: "system", content: "Rules", toolsAdded: [{ name: "bash" }, { name: "read" }] } },
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "system", content: "", toolsAdded: [{ name: "lens_declared" }] } },
			{ type: "custom", customType: "realagy-warm-session", data: warm },
		];
		const ctx = { ...session.ctx, sessionManager: { getBranch: () => branch, getEntries: () => branch } };
		session.handlers.get("session_before_tree")!({}, ctx);
		// pi's _restoreToolsFromTranscript(): the recorded loadout plus every
		// extension tool the branch never mentions.
		session.tools.active = ["bash", "read", "lens_declared", "new_ext_tool", ...lens];
		session.handlers.get("session_tree")!({}, ctx);
		expect(session.pi.setActiveTools).toHaveBeenCalledTimes(1);
		expect(session.tools.active).toEqual(["bash", "read", "lens_declared", "new_ext_tool"]);

		// Nothing to undo when the navigation activated nothing new.
		session.handlers.get("session_before_tree")!({}, ctx);
		session.handlers.get("session_tree")!({}, ctx);
		expect(session.pi.setActiveTools).toHaveBeenCalledTimes(1);
	});

	it("registers a provider whose auth is ambient (no /login key prompt)", async () => {
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockResolvedValue([]);
		await start();
		const provider = mocks.register.mock.calls[0][0];
		expect(provider.id).toBe("antigravity");
		expect(provider.auth.oauth).toBeUndefined();
		expect(provider.auth.apiKey.login).toBeUndefined();
		expect(await provider.auth.apiKey.resolve({})).toEqual({ auth: {}, source: "agy CLI" });
	});
});
