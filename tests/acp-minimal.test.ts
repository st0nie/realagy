import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AcpConnection } from "../src/acp/connection.js";
import { AcpDriver } from "../src/acp/driver.js";

function fixture(): { capture: string; binArgs: string[] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-acp-test-"));
	const capture = path.join(dir, "requests.ndjson");
	fs.writeFileSync(capture, "");
	return { capture, binArgs: [path.join(process.cwd(), "tests/helpers/fake-acp-server.mjs"), capture] };
}

function requests(capture: string): Array<{ method: string; params: Record<string, unknown> }> {
	return fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("ACP initialize enables third-party models and session metadata disables native tools", async () => {
	const { capture, binArgs } = fixture();
	const connection = new AcpConnection({
		bin: process.execPath,
		binArgs,
		cwd: process.cwd(),
		enabledTools: () => [],
		mcpServers: () => [{ name: "pi-bridge", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] }],
		log: () => {},
		onUpdate: () => {},
		onExit: () => {},
	});
	try {
		await connection.start();
		const session = await connection.newSession(process.cwd());
		assert.ok(session.availableModels.some((model) => model.modelId.startsWith("claude-")));
		assert.ok(session.availableModels.some((model) => model.modelId.startsWith("gpt-oss-")));
		const wire = requests(capture);
		const init = wire.find((request) => request.method === "initialize")!;
		assert.equal((init.params.clientInfo as { name: string }).name, "zed");
		const created = wire.find((request) => request.method === "session/new")!;
		const meta = (created.params._meta as { antigravity: Record<string, unknown> }).antigravity;
		assert.deepEqual(meta.enabledTools, []);
		assert.deepEqual(meta.eagerMcpServers, ["pi-bridge"]);
		assert.equal((created.params.mcpServers as Array<{ name: string }>)[0].name, "pi-bridge");
	} finally {
		connection.kill();
	}
});

test("AcpDriver lists all families and sends GPT's full medium model slug", async () => {
	const { capture, binArgs } = fixture();
	const driver = new AcpDriver({ bin: process.execPath, binArgs, enabledTools: () => [] });
	try {
		const models = await driver.listModels(process.cwd());
		assert.equal(models.length, 3);
		const handle = await driver.run({ cwd: process.cwd(), model: "gpt-oss-120b", effort: "medium", mode: "accept-edits", skipPermissions: true, prompt: "Reply" });
		const activities = [];
		for await (const activity of { async *[Symbol.asyncIterator]() { for (;;) { const next = await handle.next(); if (!next) return; yield next; } } }) activities.push(activity);
		assert.deepEqual(activities.filter((activity) => activity.type !== "usage").map((activity) => activity.type), ["thought", "text"]);
		assert.equal((await handle.outcome).status, "OK");
		const modelConfig = requests(capture).find((request) => request.method === "session/set_config_option" && (request.params as { configId?: string }).configId === "model")!;
		assert.equal(modelConfig.params.value, "gpt-oss-120b-medium");
	} finally {
		await driver.close("shutdown");
	}
});
