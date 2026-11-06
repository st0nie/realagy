import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(), listModels: vi.fn(), close: vi.fn(), register: vi.fn(), fetchCliUsage: vi.fn(),
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

async function start(tools: { all: FakeTool[]; active: string[] } = { all: [], active: [] }) {
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
	return { shutdown: () => { handlers.get("session_shutdown")!(); stale = true; }, ui, commands, ctx, renderers, sendMessage, driver: mocks.driverOptions!, handlers, pi, tools };
}

beforeEach(() => { vi.clearAllMocks(); mocks.close.mockResolvedValue(undefined); mocks.fetchCliUsage.mockResolvedValue([]); });

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
		expect(session.ui.notify.mock.calls[0][0]).toMatch(/not installed.*\/agy setup/);
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

	it("registers /agy with usage completion and notifies only after fresh quota resolves", async () => {
		const quota = deferred<never[]>();
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockResolvedValue([]);
		mocks.fetchCliUsage.mockReturnValueOnce(quota.promise);
		const session = await start();
		const agy = session.commands.get("agy");
		expect([...session.commands.keys()]).toEqual(["agy"]);
		expect(agy.getArgumentCompletions("u")).toEqual([{ value: "usage", label: "usage", description: "Cache hits and plan quota" }]);
		expect(agy.getArgumentCompletions("").map((item: { value: string }) => item.value)).toEqual(["setup", "usage"]);
		expect(agy.getArgumentCompletions("x")).toBeNull();
		await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
		const pending = agy.handler("usage", session.ctx);
		expect(session.ui.notify).not.toHaveBeenCalled();
		expect(mocks.fetchCliUsage).toHaveBeenCalledWith("agy", expect.objectContaining({ pid: 4242 }));
		quota.resolve([]);
		await pending;
		expect(session.ui.notify).toHaveBeenCalledTimes(1);
		expect(session.ui.notify).toHaveBeenLastCalledWith("REPORT", "info");
	});

	it("shows a cancellable TUI loader during /agy usage and aborts fetchCliUsage on Esc", async () => {
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
		await session.commands.get("agy").handler("usage", { ...session.ctx, mode: "tui", ui: { ...session.ui, custom } });
		expect(custom).toHaveBeenCalledTimes(1);
		expect(capturedSignal?.aborted).toBe(true);
		expect(session.ui.notify).toHaveBeenLastCalledWith("REPORT", "info");
	});

	it("/agy setup explains install, sign-in, or readiness", async () => {
		mocks.ensure.mockReturnValue({ ok: false, error: "the Antigravity CLI (agy) is not installed", manual: "" });
		const session = await start();
		const agy = session.commands.get("agy");
		await agy.handler("setup", session.ctx);
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/not installed[\s\S]*install\.sh[\s\S]*\/agy setup again/);

		mocks.ensure.mockReturnValue({ ok: true, bin: "/bin/agy" });
		mocks.listModels.mockRejectedValueOnce(new Error("ACP authentication required"));
		await agy.handler("setup", session.ctx);
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/not usable[\s\S]*agy acp --login/);

		mocks.listModels.mockResolvedValue([{ modelId: "gemini-3.8-flash-low" }, { modelId: "gemini-3.8-flash-high" }]);
		await agy.handler("setup", session.ctx);
		expect(session.ui.notify.mock.lastCall?.[0]).toMatch(/ready: \/bin\/agy is signed in and offers 1 models/);
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
		expect(listed()).toEqual(["bash", "read", "pi_lens_activate_tools", "lens_symbols", "poll"]);
		const policy = session.driver.systemPrompt();
		expect(policy).toMatch(/bash, read, pi_lens_activate_tools, lens_symbols/);

		const inactive = await mocks.bridge!.onToolCall("c1", "lens_symbols", {}, new AbortController().signal);
		expect(inactive).toEqual({ content: [{ type: "text", text: "Pi tool lens_symbols is not active in pi right now. Active pi tools: bash, read, pi_lens_activate_tools." }], isError: true });
		expect(mocks.onToolCall).not.toHaveBeenCalled();

		// pi_lens_activate_tools mid-session: same list and policy, now callable.
		session.tools.active.push("lens_symbols");
		expect(listed()).toEqual(["bash", "read", "pi_lens_activate_tools", "lens_symbols", "poll"]);
		expect(session.driver.systemPrompt()).toBe(policy);
		mocks.onToolCall.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
		const signal = new AbortController().signal;
		await mocks.bridge!.onToolCall("c2", "lens_symbols", { name: "x" }, signal);
		expect(mocks.onToolCall).toHaveBeenCalledWith("c2", "lens_symbols", { name: "x" }, signal);
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
