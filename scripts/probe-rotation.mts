// Live probe (spends quota): realagy moves a warm agy session to a fresh one
// before agy compacts it, when a context extension (realctx) shrank pi's view.
//   npx tsx scripts/probe-rotation.mts [model-id]   (default gpt-oss-120b: 80k limit)
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { AcpDriver } from "../src/acp/driver.js";
import { ensureAgyReady } from "../src/acp/setup.js";
import { conversationDbPath, defaultConversationsDir, firstCompactionIdx } from "../src/acp/step-usage.js";
import { entriesFromAcpModels, modelLimitsFromAgy, toPiModel, withModelLimits } from "../src/models.js";
import { createStreamSimple, ToolRoundTrips, type AcpSessions } from "../src/provider.js";
import { fetchAcpModels } from "../src/quota.js";

const wanted = process.argv[2] ?? "gpt-oss-120b";
const setup = ensureAgyReady();
if (!setup.ok) throw new Error(setup.error);
const driver = new AcpDriver({ bin: setup.bin, conversationsDir: () => defaultConversationsDir(), extraEnv: { AGY_CLI_AUTO_COMPACT_OVERRIDE: "100%" } });
const roundTrips = new ToolRoundTrips(driver);
driver.onTurnEnd = () => {};
const rotations: unknown[] = [];
const sessions: AcpSessions = { conversationsDir: () => defaultConversationsDir(), onRotate: (event) => rotations.push(event) };
try {
	let entries = entriesFromAcpModels(await driver.listModels(process.cwd()));
	entries = withModelLimits(entries, modelLimitsFromAgy(await fetchAcpModels(driver.pid!)));
	const entry = entries.find((candidate) => candidate.id === wanted);
	if (!entry) throw new Error(`no model ${wanted}`);
	const model = toPiModel(entry);
	console.log("model", model.id, "contextWindow", model.contextWindow, "maxTokens", model.maxTokens);
	const stream = createStreamSimple({ entries, driver, roundTrips, sessions });
	const filler = (seed: number) => {
		const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet".split(" ");
		let out = "";
		for (let i = seed; out.length < 64 * 1024; i++) out += `${words[i % words.length]}-${(i * 7919) % 10007} `;
		return out;
	};
	const turn = async (messages: Message[], label: string): Promise<AssistantMessage> => {
		const before = driver.pid;
		let final: AssistantMessage | undefined;
		let text = "";
		for await (const event of stream(model, { messages } as unknown as TranscriptContext)) {
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "done") final = event.message;
			if (event.type === "error") throw new Error(event.error.errorMessage);
		}
		const warm = sessions.warm;
		const db = warm ? conversationDbPath(defaultConversationsDir(), warm.sessionId) : undefined;
		console.log(`${label}: session=${warm?.sessionId} context=${warm?.contextTokens} overhead=${warm?.overhead} compactedAt=${db ? firstCompactionIdx(db) : "?"} pid=${before} reply=${JSON.stringify(text.trim().slice(0, 80))}`);
		return final!;
	};
	const ts = () => Date.now();
	const toolTurn = (id: string, body: string): Message[] => [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: ts() } as AssistantMessage,
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: body }], isError: false, timestamp: ts() },
	];
	const system: Message = { role: "system", content: "You are a terse assistant.", timestamp: ts() } as unknown as Message;
	const u = (text: string): Message => ({ role: "user", content: text, timestamp: ts() });

	const m1 = [system, u("Remember this code word: PERIWINKLE-7731. Reply with only OK.")];
	const r1 = await turn(m1, "turn1");
	const m2 = [...m1, r1, u("I read a file for you; ignore its contents and reply with only OK."), ...toolTurn("big1", filler(1))];
	const r2 = await turn(m2, "turn2");
	const m3 = [...m2, r2, u("And another one; reply with only OK."), ...toolTurn("big2", filler(2))];
	const r3 = await turn(m3, "turn3");
	// realctx drops both big tool outputs from pi's view.
	const dropped = (messages: Message[]) => messages.map((message) => message.role === "toolResult"
		? { ...message, content: [{ type: "text" as const, text: `[#${message.toolCallId} dropped · read ${message.toolCallId}.txt · 16k tok]` }] }
		: message);
	const m4 = [...dropped(m3), r3, u("What was the code word I gave you at the start? Reply with only the code word.")];
	await turn(m4, "turn4");
	console.log("rotations", JSON.stringify(rotations));
} finally {
	await driver.close();
}
