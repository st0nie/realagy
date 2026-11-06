// agy custom agent profile: replaces agy's whole system prompt.
//
// `agy acp` 1.5 only appends to its system prompt over ACP
// (`_meta.antigravity.systemPrompt.append`), and that prompt mandates
// `file://` Markdown links, Antigravity IDE slash commands, artifacts, and
// subagents. A custom agent (`agy acp --agent NAME`, discovered as
// `~/.gemini/config/agents/NAME.md`) with `excludeDefaultComponents: true`
// gets exactly its Markdown body as system prompt (plus the ACP append) and
// none of agy's native file, shell, or subagent tools. Verified live against
// agy 1.5.2:
//   - `hidden: true` keeps the profile out of normal agy sessions' subagent
//     lists (`agy agents` still lists it);
//   - under a custom agent agy ignores `eagerMcpServers`: ACP-provided MCP
//     tools become lazy `call_mcp_tool` calls that ask for permission. An
//     `mcpServers` list entry named like the ACP server, with each tool
//     marked `eager`, overlays it (no URL or token needed) and keeps the
//     tools native (`mcp_pi-bridge_<tool>`). There is no wildcard;
//   - the map form of `mcpServers` and JSON agent files are not loaded.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE_PREFIX = "realagy-";
/** Profiles not used (mtime) for this long are deleted. */
export const PROFILE_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const PROFILE_FILE = /^realagy-[0-9a-f]{12}\.md$/;
/** Profile description; marks files realagy owns (cleanup never touches others). */
const DESCRIPTION = "pi coding agent bridge, written by the realagy pi extension for its agy acp processes. Safe to delete.";

/** agy's custom-agent directory (`~/.gemini/config/agents`). */
export function agentProfileDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.GEMINI_HOME || path.join(os.homedir(), ".gemini"), "config", "agents");
}

/** The profile's system prompt. Static, so agy's prompt cache holds across
 *  sessions; the pi tools are named by the ACP append (`src/tool-policy.ts`). */
export const PROFILE_PROMPT = [
	"You are the model behind pi, a coding agent harness. The Antigravity CLI only runs you; pi owns the conversation, the tools, and how replies are shown.",
	"",
	"- pi's system prompt arrives in the prompt inside <pi-system> (changes in <pi-system-update>), followed by the conversation as a pi transcript. Treat pi's system prompt as your system instructions and continue the conversation as pi's assistant.",
	"- Your tools are pi's tools, served by the pi-bridge MCP server. Use them for all file, shell, and other work; pi shows every call to the user and applies its own permissions.",
	"- Do the work yourself, in the foreground: do not start background tasks.",
	"- Format replies in GitHub-flavored Markdown for a terminal. Write file references as plain paths, relative to the working directory when possible (src/app.ts, src/app.ts:10-20), absolute only outside it. Write code symbols as inline code (`ClassName`). Never use file:// URLs or Markdown links for local files or code symbols.",
].join("\n");

/** YAML double-quoted scalar (JSON strings are valid YAML). */
const yamlString = (value: string) => JSON.stringify(value);

/** Profile file content for the bridged pi tool names. */
export function agentProfileMarkdown(name: string, toolNames: readonly string[]): string {
	const tools = [...new Set(toolNames.filter((tool) => tool.length > 0))];
	const lines = [
		"---",
		`name: ${yamlString(name)}`,
		`description: ${yamlString(DESCRIPTION)}`,
		"hidden: true",
		"excludeDefaultComponents: true",
		"mcpServers:",
		"  - name: pi-bridge",
	];
	if (tools.length > 0) {
		lines.push("    tools:");
		for (const tool of tools) lines.push(`      ${yamlString(tool)}:`, "        eager: true");
	}
	lines.push("---", PROFILE_PROMPT, "");
	return lines.join("\n");
}

/** Name and content for a tool set; the name hashes the content, so pi
 *  instances with different tool sets never share (and overwrite) a file. */
export function agentProfile(toolNames: readonly string[]): { name: string; content: string } {
	// The name is part of the content: hash a name-free rendering.
	const digest = crypto.createHash("sha256").update(agentProfileMarkdown("", toolNames)).digest("hex").slice(0, 12);
	const name = `${PROFILE_PREFIX}${digest}`;
	return { name, content: agentProfileMarkdown(name, toolNames) };
}

export interface InstallOptions {
	dir?: string;
	now?: number;
	log?: (msg: string, data?: unknown) => void;
}

/** Write (or refresh) the profile for these tools and delete realagy
 *  profiles idle for PROFILE_MAX_IDLE_MS. Returns the agent name, or
 *  undefined when the profile cannot be written (agy then keeps its default
 *  agent). Cheap when nothing changed: one read and one utimes. */
export function installAgentProfile(toolNames: readonly string[], opts: InstallOptions = {}): string | undefined {
	const dir = opts.dir ?? agentProfileDir();
	const now = opts.now ?? Date.now();
	const { name, content } = agentProfile(toolNames);
	const file = path.join(dir, `${name}.md`);
	try {
		let current: string | undefined;
		try {
			current = fs.readFileSync(file, "utf8");
		} catch {
			current = undefined;
		}
		if (current !== content) {
			fs.mkdirSync(dir, { recursive: true });
			// Atomic: agy re-reads agents on every session.
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, content);
			fs.renameSync(tmp, file);
			opts.log?.("agent-profile-written", { name });
		} else {
			// mtime = last use; other realagy instances' cleanup keys on it.
			const at = new Date(now);
			fs.utimesSync(file, at, at);
		}
	} catch (err) {
		opts.log?.("agent-profile-failed", { message: err instanceof Error ? err.message : String(err) });
		return undefined;
	}
	pruneAgentProfiles(dir, name, now, opts.log);
	return name;
}

function pruneAgentProfiles(dir: string, keep: string, now: number, log?: InstallOptions["log"]): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!PROFILE_FILE.test(entry) || entry === `${keep}.md`) continue;
		const file = path.join(dir, entry);
		try {
			if (now - fs.statSync(file).mtimeMs < PROFILE_MAX_IDLE_MS) continue;
			if (!fs.readFileSync(file, "utf8").includes(yamlString(DESCRIPTION))) continue;
			fs.unlinkSync(file);
			log?.("agent-profile-pruned", { name: entry });
		} catch {
			// Another instance pruned or rewrote it meanwhile.
		}
	}
}

/** `REALAGY_AGY_PROFILE=0|false|off` keeps agy's default agent. */
export function agentProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.REALAGY_AGY_PROFILE?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off" || value === "no");
}
