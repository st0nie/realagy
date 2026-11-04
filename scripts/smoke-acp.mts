// Live smoke (spends account quota): npx tsx scripts/smoke-acp.mts [model-id]
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { AcpDriver } from "../src/acp/driver.js";
import { entriesFromAcpModels, toPiModel } from "../src/models.js";
import { createStreamSimple, ToolRoundTrips } from "../src/provider.js";
import { ensureAcpReady } from "../src/acp/setup.js";

const setup = await ensureAcpReady();
if (!setup.ok) throw new Error(`${setup.error}\n${setup.manual}`);
const driver = new AcpDriver({ bin: setup.bin, enabledTools: () => [] });
try {
	const entries = entriesFromAcpModels(await driver.listModels(process.cwd()));
	console.log("catalog:", entries.map((entry) => `${entry.full}[${entry.efforts?.join("/") ?? "fixed"}]`).join(", "));
	const wanted = process.argv[2] ?? "claude-sonnet-5-5";
	const entry = entries.find((candidate) => candidate.id === wanted);
	if (!entry) throw new Error(`model not found in live ACP catalog: ${wanted}`);
	// SAFETY: this fixture is already normalized: one leading system message,
	// no tool deltas, and no mid-conversation system messages.
	const context = {
		messages: [
			{ role: "system", content: "Reply briefly.", timestamp: Date.now() },
			{ role: "user", content: "Reply with exactly OK.", timestamp: Date.now() },
		],
	} as unknown as TranscriptContext;
	const stream = createStreamSimple({ entries, driver, roundTrips: new ToolRoundTrips(driver) })(
		toPiModel(entry),
		context,
		{ reasoning: "medium" },
	);
	for await (const event of stream) {
		if (event.type === "text_delta") process.stdout.write(event.delta);
		else if (event.type === "thinking_delta") process.stdout.write(`[thinking] ${event.delta}`);
		else if (event.type === "toolcall_end") console.log(`\n[pi tool] ${event.toolCall.name}`);
		else if (event.type === "done") console.log("\nDONE", event.message.stopReason);
		else if (event.type === "error") {
			console.error("\nERROR", event.error.errorMessage);
			process.exitCode = 1;
		}
	}
} finally {
	await driver.close("shutdown");
}
