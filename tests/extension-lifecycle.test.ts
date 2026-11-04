import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensure: vi.fn(), listModels: vi.fn(), close: vi.fn(), register: vi.fn(),
}));
vi.mock("../src/acp/setup.js", () => ({ ensureAcpReady: mocks.ensure, clearAcpAuthVerified: vi.fn() }));
vi.mock("../src/acp/connection.js", () => ({ resolveAcpBinary: () => "agy", setAuthInvalidatedHook: vi.fn() }));
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
	const pi = { on: (name: string, cb: (...args: any[]) => void) => handlers.set(name, cb), registerProvider: mocks.register, registerCommand: vi.fn() };
	await extension(pi as never);
	let stale = false;
	const ui = { setStatus: vi.fn(), notify: vi.fn() };
	const ctx = { hasUI: true, get ui() { if (stale) throw new Error("stale context"); return ui; } };
	handlers.get("session_start")!({}, ctx);
	return { shutdown: () => { handlers.get("session_shutdown")!(); stale = true; }, ui };
}

beforeEach(() => { vi.clearAllMocks(); mocks.close.mockResolvedValue(undefined); });

describe("extension session lifecycle", () => {
	it("ignores setup progress and completion after shutdown", async () => {
		const setup = deferred<{ ok: boolean; bin: string; needsLogin: boolean }>();
		mocks.ensure.mockReturnValue(setup.promise);
		const session = await start();
		const progress = mocks.ensure.mock.calls[0][0].onProgress;
		session.shutdown();
		expect(() => progress("working")).not.toThrow();
		setup.resolve({ ok: true, bin: "agy", needsLogin: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mocks.listModels).not.toHaveBeenCalled();
		expect(session.ui.setStatus).not.toHaveBeenCalled();
	});

	it("ignores model discovery completion after shutdown", async () => {
		const discovery = deferred<never[]>();
		mocks.ensure.mockResolvedValue({ ok: true, bin: "agy", needsLogin: false });
		mocks.listModels.mockReturnValue(discovery.promise);
		const session = await start();
		await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalled());
		session.shutdown();
		discovery.resolve([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mocks.register).toHaveBeenCalledTimes(1);
		expect(session.ui.notify).not.toHaveBeenCalled();
	});
});
