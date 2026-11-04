// Isolated live probe; consumes model quota. No pi bridge or production config changes.
// bun run scripts/probe-native-image.mts /absolute/path/to/image.png [full-model-id]
import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { AcpConnection } from "../src/acp/connection.js";
import { ensureAcpReady } from "../src/acp/setup.js";

const arg = process.argv[2];
if (!arg) throw new Error("Usage: bun run scripts/probe-native-image.mts <image-path> [full-model-id]");
const imagePath = await realpath(resolve(arg));
await access(imagePath);
const wanted = process.argv[3] ?? "claude-sonnet-5-5";
const setup = await ensureAcpReady();
if (!setup.ok) throw new Error(`${setup.error}\n${setup.manual}`);

// This isolated session exposes native view_file, which can also read text files.
// Permission requests are denied unless PROBE_ALLOW_NATIVE=1; this is isolated from pi.
const conn = new AcpConnection({
 cwd: process.cwd(), bin: setup.bin,
 enabledTools: () => ["view_file"], permissions: () => process.env.PROBE_ALLOW_NATIVE === "1" ? "auto" : "deny",
 log: (name, data) => console.error("[acp]", name, data ?? ""),
 onExit: ({ code, signal }) => console.error("[exit]", code, signal),
 onUpdate: (_session, update) => console.log("[update]", JSON.stringify(update, (key, value) => key === "data" && typeof value === "string" ? `[data omitted: ${value.length} chars]` : value)),
});
try {
 await conn.start();
 const session = await conn.newSession(process.cwd());
 const model = session.availableModels.find((entry) => entry.modelId === wanted)
  ?? session.availableModels.find((entry) => entry.modelId.startsWith(`${wanted}-`));
 if (!model) throw new Error(`Model ${wanted} not found. Available: ${session.availableModels.map((m) => m.modelId).join(", ")}`);
 console.log(`[probe] model=${model.modelId}; native allowlist=view_file; image is NOT sent as an ACP attachment`);
 await conn.setConfigOption(session.sessionId, "model", model.modelId);
 await conn.setConfigOption(session.sessionId, "mode", "default");
 const result = await conn.prompt(session.sessionId, `Use your native view_file tool to inspect the image at ${JSON.stringify(imagePath)}. Describe the visible contents. Do not guess if you cannot see it.`);
 console.log("[result]", JSON.stringify(result));
 await conn.closeSession(session.sessionId);
} finally {
 conn.kill();
}
