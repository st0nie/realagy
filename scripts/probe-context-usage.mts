// Isolated live probe; consumes model quota, with no pi tools or production session.
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../src/acp/driver.js";
import { ensureAgyReady } from "../src/acp/setup.js";
import { FALLBACK_MODELS, toPiModel } from "../src/models.js";
import { createStreamSimple, ToolRoundTrips } from "../src/provider.js";
import type { TranscriptContext } from "@earendil-works/pi-ai";

const setup = ensureAgyReady();
if (!setup.ok) throw new Error(setup.error);
const driver = new AcpDriver({ bin: setup.bin });
try {
 const model = FALLBACK_MODELS.find((entry) => entry.id === "claude-sonnet-5-5");
 if (!model) throw new Error("Sonnet model missing");
 const stream = createStreamSimple({ entries: [...FALLBACK_MODELS], driver, roundTrips: new ToolRoundTrips(driver) });
 // SAFETY: this probe supplies one user message and no tool-state deltas.
 const ctx = { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] } as unknown as TranscriptContext;
 const events = stream(toPiModel(model), ctx);
 for await (const event of events) {
  if (event.type === "error") throw new Error(event.error.errorMessage ?? "Provider error");
  if (event.type === "done") {
   const usage = event.message.usage as typeof event.message.usage & { agyContextTokens?: number; agyCumulativeTotalTokens?: number };
   if (!usage.agyContextTokens) throw new Error("No nonzero agy context update received");
   if (calculateContextTokens(usage) !== usage.agyContextTokens) throw new Error("Pi context count does not match agy");
   console.log(JSON.stringify({ piContext: calculateContextTokens(usage), agyContext: usage.agyContextTokens, cumulative: usage.agyCumulativeTotalTokens }));
  }
 }
} finally {
 await driver.close("shutdown");
}
