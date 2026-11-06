import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(), listModels: vi.fn(), close: vi.fn(), register: vi.fn(), fetchCliUsage: vi.fn(),
	driverOptions: undefined as undefined | Record<string, any>,
}));
vi.mock("../src/acp/setup.js", () => ({ ensureAgyReady: mocks.ensure, resolveAgyBinary: () => "agy", MANUAL_SETUP: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }));
vi.mock("../src/acp/connection.js", () => ({ resolveAcpBinary: () => "agy" }));
vi.mock("../src/quota.js", () => ({ fetchCliUsage: mocks.fetchCliUsage, UsageMeter: class { setQuota() {} report() { return "REPORT"; } } }));
vi.mock("../src/acp/driver.js", () => ({ AcpDriver: class {
	listModels = mocks.listModels;
	close = mocks.close;
	constructor(options: Record<string, any>) { mocks.driverOptions = options; }
} }));
vi.mock("../src/mcp-server.js", () => ({ startMcpServer: async () => ({ ok: true, handle: { port: 1, token: "test", close: vi.fn() } }), TOKEN_HEADER: "token" }));
vi.mock("../src/provider.js", () => ({ createStreamSimple: vi.fn(), POLL_TOOL_NAME: "poll", ToolRoundTrips: class { failAll() {} } }));

import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function start() {
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
		getAllTools: () => [],
		getActiveTools: () => [],
	};
	await extension(pi as never);
	let stale = false;
	const ui = { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), theme: undefined };
	const ctx = { hasUI: true, model: undefined, get ui() { if (stale) throw new Error("stale context"); return ui; } };
	handlers.get("session_start")!({}, ctx);
	return { shutdown: () => { handlers.get("session_shutdown")!(); stale = true; }, ui, commands, ctx, renderers, sendMessage, driver: mocks.driverOptions! };
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
	tail: "DONE",
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

	it("registers /agy with usage completion, immediate loading notice, and final report", async () => {
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
		expect(session.ui.notify).toHaveBeenCalledWith("REPORT\n\nLoading plan quota from agy…", "info");
		quota.resolve([]);
		await pending;
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
