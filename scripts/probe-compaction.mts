// Live probe (spends quota): does `agy acp` auto-compact a long session, and
// does AGY_CLI_AUTO_COMPACT_OVERRIDE change its trigger?
//   npx tsx scripts/probe-compaction.mts [override] [rounds] [kbPerRound] [model]
// e.g. `20000 5 30` sends five ~30 KB prompts with the trigger at 20k tokens.
import { AcpConnection } from "../src/acp/connection.js";
import { ensureAgyReady } from "../src/acp/setup.js";
import { conversationDbPath, defaultConversationsDir } from "../src/acp/step-usage.js";
import { createRequire } from "node:module";

const [override = "", roundsArg = "5", kbArg = "30", wantedModel = "gemini-3.8-flash"] = process.argv.slice(2);
const setup = ensureAgyReady();
if (!setup.ok) throw new Error(setup.error);
const updates: Array<{ kind: string; data: unknown }> = [];
let answer = "";
const conn = new AcpConnection({
	cwd: process.cwd(),
	bin: setup.bin,
	...(override ? { extraEnv: { AGY_CLI_AUTO_COMPACT_OVERRIDE: override } } : {}),
	log: () => {},
	onUpdate: (_id, update) => {
		const u = update as Record<string, unknown>;
		const kind = String(u.sessionUpdate ?? "?");
		if (kind === "agent_message_chunk") answer += String((u.content as { text?: string } | undefined)?.text ?? "");
		if (kind === "usage_update") updates.push({ kind, data: { used: u.used, size: u.size } });
		else if (kind === "available_commands_update") updates.push({ kind, data: (u.availableCommands as Array<{ name: string }> | undefined)?.map((c) => c.name) });
		else if (!/chunk$/.test(kind)) updates.push({ kind, data: JSON.stringify(u).slice(0, 300) });
	},
	onExit: () => {},
	permissions: () => "auto",
});
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
function stepTypes(sessionId: string): Record<number, number> {
	const db = new DatabaseSync(conversationDbPath(defaultConversationsDir(), sessionId)!, { readOnly: true });
	try {
		const rows = db.prepare("SELECT step_type, COUNT(*) AS n FROM steps GROUP BY step_type").all() as Array<{ step_type: number; n: number }>;
		return Object.fromEntries(rows.map((row) => [row.step_type, row.n]));
	} finally {
		db.close();
	}
}
const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");
function filler(kb: number, seed: number): string {
	let out = "";
	let i = seed;
	while (out.length < kb * 1024) {
		out += `${words[i % words.length]}-${(i * 7919) % 10007} `;
		i++;
	}
	return out;
}
try {
	await conn.start();
	const session = await conn.newSession(process.cwd());
	const model = session.availableModels.find((m) => m.modelId.includes(wantedModel)) ?? session.availableModels[0];
	if (model) await conn.setConfigOption(session.sessionId, "model", model.modelId);
	console.log("session", session.sessionId, "model", model?.modelId, "override", override || "(none)");
	const rounds = Number(roundsArg);
	for (let round = 1; round <= rounds; round++) {
		const secret = round === 1 ? "Remember this secret code word for later: PERIWINKLE-7731. " : "";
		const res = await conn.prompt(session.sessionId, `${secret}Below is filler data; ignore it and reply with only OK.\n\n${filler(Number(kbArg), round * 1000)}`);
		console.log(`round ${round}`, res.stopReason, JSON.stringify(res.usage), "steps", JSON.stringify(stepTypes(session.sessionId)));
		console.log("  updates", JSON.stringify(updates.splice(0)));
	}
	answer = "";
	const res = await conn.prompt(session.sessionId, "What was the secret code word I gave you in my first message? If you cannot see it, say UNKNOWN.");
	console.log("answer:", answer.trim());
	console.log("final", res.stopReason, JSON.stringify(res.usage), "steps", JSON.stringify(stepTypes(session.sessionId)));
	console.log("  updates", JSON.stringify(updates.splice(0)));
} finally {
	conn.kill();
}
