import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(), listModels: vi.fn(), close: vi.fn(), register: vi.fn(),
}));
vi.mock("../src/acp/setup.js", () => ({ ensureAgyReady: mocks.ensure, resolveAgyBinary: () => "agy", MANUAL_SETUP: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }));
vi.mock("../src/acp/connection.js", () => ({ resolveAcpBinary: () => "agy" }));
vi.mock("../src/quota.js", () => ({ fetchCliUsage: vi.fn(async () => []), UsageMeter: class { setQuota() {} report() { return "REPORT"; } } }));
vi.mock("../src/acp/driver.js", () => ({ AcpDriver: class {
	listModels = mocks.listModels;
	close = mocks.close;
} }));
vi.mock("../src/mcp-server.js", () => ({ startMcpServer: async () => ({ ok: true, handle: { port: 1, token: "test", close: vi.fn() } }), TOKEN_HEADER: "token" }));
vi.mock("../src/provider.js", () => ({ createStreamSimple: vi.fn(), POLL_TOOL_NAME: "poll", ToolRoundTrips: class { failAll() {} clearImages() {} } }));

import extension from "../extensions/index.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function start() {
	const handlers = new Map<string, (...args: any[]) => void>();
	const commands = new Map<string, any>();
	const pi = { on: (name: string, cb: (...args: any[]) => void) => handlers.set(name, cb), registerProvider: mocks.register, registerCommand: (name: string, command: unknown) => commands.set(name, command) };
	await extension(pi as never);
	let stale = false;
	const ui = { setStatus: vi.fn(), notify: vi.fn() };
	const ctx = { hasUI: true, model: undefined, get ui() { if (stale) throw new Error("stale context"); return ui; } };
	handlers.get("session_start")!({}, ctx);
	return { shutdown: () => { handlers.get("session_shutdown")!(); stale = true; }, ui, commands, ctx };
}

beforeEach(() => { vi.clearAllMocks(); mocks.close.mockResolvedValue(undefined); });

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

	it("registers /agy with usage completion and report", async () => {
		mocks.ensure.mockReturnValue({ ok: true, bin: "agy" });
		mocks.listModels.mockResolvedValue([]);
		const session = await start();
		const agy = session.commands.get("agy");
		expect([...session.commands.keys()]).toEqual(["agy"]);
		expect(agy.getArgumentCompletions("u")).toEqual([{ value: "usage", label: "usage", description: "Cache hits and plan quota" }]);
		expect(agy.getArgumentCompletions("").map((item: { value: string }) => item.value)).toEqual(["setup", "usage"]);
		expect(agy.getArgumentCompletions("x")).toBeNull();
		await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
		await agy.handler("usage", session.ctx);
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
