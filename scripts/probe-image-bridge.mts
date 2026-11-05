// Live Sonnet test of actual pi read -> MCP -> staged native viewer, in ONE ACP session.
// Consumes quota. Usage: bun run scripts/probe-image-bridge.mts /path/to/image.png
import { createReadTool, calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { AcpDriver } from "../src/acp/driver.js";
import { ensureAgyReady } from "../src/acp/setup.js";
import { startMcpServer, TOKEN_HEADER } from "../src/mcp-server.js";
import { FALLBACK_MODELS, toPiModel } from "../src/models.js";
import { createStreamSimple, ToolRoundTrips } from "../src/provider.js";

const path = process.argv[2];
if (!path) throw new Error("Expected image path");
const setup = ensureAgyReady();
if (!setup.ok) throw new Error(setup.error);
let bridge: { port: number; token: string; close(): Promise<void> } | undefined;
let nativeViews = 0;
const driver = new AcpDriver({
 bin: setup.bin, enabledTools: () => ["view_file"],
 mcpServers: () => bridge ? [{ name: "pi-bridge", type: "http", url: `http://127.0.0.1:${bridge.port}/mcp`, headers: [{ name: TOKEN_HEADER, value: bridge.token }] }] : [],
});
const trips = new ToolRoundTrips(driver);
driver.onTurnEnd = (outcome) => { if (outcome.status === "ERROR" || outcome.aborted) trips.failAll(outcome.error ?? "Turn failed"); };
const started = await startMcpServer({
 listTools: () => [{ name: "read", description: "Read a local file, including image files. Use this for the original file. Images will include instructions for the native viewer.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
 onToolCall: trips.onToolCall,
});
if (!started.ok) throw new Error(started.reason);
bridge = started.handle;
try {
 const model = FALLBACK_MODELS.find((entry) => entry.id === "claude-sonnet-5-5");
 if (!model) throw new Error("No Sonnet model");
 const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: trips });
 const messages: Message[] = [{ role: "user", content: `First use pi-bridge read to read ${JSON.stringify(path)}. Then follow the returned image-viewing instructions and describe the actual visible contents in at most 80 words. Do not use view_file on the original path. Do not guess.`, timestamp: Date.now() }];
 const reader = createReadTool(process.cwd());
 for (let step = 0; step < 5; step++) {
  let final: Extract<Message, { role: "assistant" }> | undefined;
  // SAFETY: the probe supplies a complete message list with no system/tool declaration deltas.
  const ctx = { messages } as unknown as TranscriptContext;
  for await (const event of stream(toPiModel(model), ctx, {
   onProviderStreamEvent(activity: unknown) {
    const a = activity as { type?: string; name?: string };
    if (a.type === "tool_start" && a.name === "view_file") nativeViews++;
   },
  })) {
   if (event.type === "error") throw new Error(event.error.errorMessage ?? "Provider error");
   if (event.type === "done") final = event.message;
  }
  if (!final) throw new Error("No final response");
  messages.push(final);
  if (final.stopReason !== "toolUse") {
   const snapshot = driver.snapshot();
   console.log(JSON.stringify({ response: final.content, piContext: calculateContextTokens(final.usage), usage: final.usage, nativeViews, sessionsCreated: snapshot.acp?.sessionsCreated, turns: snapshot.stats.turns }));
   if (snapshot.acp?.sessionsCreated !== 1 || snapshot.stats.turns !== 1 || nativeViews < 1) throw new Error("Expected one ACP turn/session and a native image view");
   break;
  }
  for (const call of final.content) {
   if (call.type !== "toolCall") continue;
   if (call.name !== "read") throw new Error(`Unexpected tool ${call.name}`);
   const result = await reader.execute(call.id, { path: String(call.arguments.path) });
   messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: false, timestamp: Date.now() });
  }
  if (step === 4) throw new Error("Too many pi tool rounds");
 }
} finally {
 trips.failAll("Probe finished");
 await driver.close("shutdown");
 trips.clearImages();
 await bridge.close();
}
