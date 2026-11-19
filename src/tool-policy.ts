// Tool policy appended to agy's system prompt (session/new, resume, load:
// `_meta.antigravity.systemPrompt.append`).
//
// The policy states how pi's tools reach the model; how and when to use them
// (background work, delegation, batching) is pi's system prompt's call. With
// realagy's agent profile (src/agent-profile.ts) agy has none of its own
// prompt and almost none of its tools, so the policy only names the pi tools.
// With agy's default agent, `agy acp` ignores tool allowlists, so the model is
// asked to prefer pi's tools (agy's own tools stay usable) and to ignore the
// default prompt's file:// link rules. The user's `instructions` come last.

/** agy 1.5's own file and shell tools, which pi's tools replace. */
const AGY_FILE_AND_SHELL_TOOLS = ["run_command", "read_file", "write_file", "edit_file"];
/** agy 1.5's delegation and scheduling tools (the browser agent, when
 *  enabled, is a subagent too). */
const AGY_DELEGATION_TOOLS = ["invoke_subagent", "define_subagent", "manage_subagents", "schedule", "manage_task"];

/** Counters agy's default <communication_style> and artifact "File Links"
 *  rules, which pi's terminal renders as `name (file:///abs/path#L1-L2)`. */
export const PLAIN_PATHS_RULE =
	"Formatting (this replaces your communication_style and artifacts rules on file links): write file references as plain paths, relative to the working directory when possible (src/app.ts, src/app.ts:10-20), absolute only outside it, and code symbols as inline code (`ClassName`). Never use file:// URLs or Markdown links for local files or code symbols.";

/** The declared catalog may hold tools pi has not activated yet; the transcript
 *  says which are callable (src/transcript.ts). */
const ACTIVE_TOOLS_RULE = "The pi tools you can call right now are listed in <pi-tools> (changes arrive in <pi-tools-update>); the others are declared so pi can activate them later.";

export interface ToolPolicyOptions {
	/** The serving process runs realagy's agent profile. */
	profile?: boolean;
	/** The user's own rules (config `instructions`). */
	instructions?: string;
	/** Tools the bridge itself serves (`parallel`, `bridge_poll_result`):
	 *  never in pi's transcript, so never in <pi-tools>. */
	helpers?: readonly string[];
}

function helpersRule(helpers: readonly string[]): string[] {
	if (helpers.length === 0) return [];
	if (helpers.length === 1) return [`The bridge's own ${helpers[0]} is not a pi tool: <pi-tools> never lists it, and it stays callable.`];
	return [`The bridge's own ${helpers.slice(0, -1).join(", ")} and ${helpers.at(-1)} are not pi tools: <pi-tools> never lists them, and they stay callable.`];
}

/** The policy for the bridged pi tools, or undefined when there is nothing to
 *  say (no pi tools or helpers, no profile-free formatting override, no
 *  instructions). */
export function toolPolicyPrompt(toolNames: readonly string[], opts: ToolPolicyOptions = {}): string | undefined {
	const names = [...new Set(toolNames.filter((name) => name.length > 0))];
	const instructions = opts.instructions?.trim() ? [`<user-instructions>\n${opts.instructions.trim()}\n</user-instructions>`] : [];
	// The bridge lists its helpers whether or not pi offers tools.
	const helpers = helpersRule(opts.helpers ?? []);
	let policy: string[];
	if (opts.profile) {
		policy = names.length === 0 ? helpers : [
			"pi's tools declared in this session, served by the pi-bridge MCP server (you call them as mcp_pi-bridge_<name>; pi's transcript names them without the prefix):",
			names.join(", "),
			ACTIVE_TOOLS_RULE,
			...helpers,
		];
	} else if (names.length === 0) {
		policy = [...helpers, PLAIN_PATHS_RULE];
	} else {
		policy = [
			"Client tool policy: this session runs inside the pi coding agent, which provides its tools through the pi-bridge MCP server:",
			names.join(", "),
			ACTIVE_TOOLS_RULE,
			...helpers,
			"Use these pi tools for all file and shell work: read files (including images) with them, run every shell command (including directory listings) with them, and create, edit, move or delete files with them, so the user sees and approves that work in pi.",
			// Naming agy's own tools measurably helps GPT-OSS follow the policy.
			`Do not use your built-in ${AGY_FILE_AND_SHELL_TOOLS.join(", ")} tools for anything a pi tool can do.`,
			`For delegation, background work, and scheduling, use the pi tools pi's system prompt names, not your built-in ${AGY_DELEGATION_TOOLS.join(", ")}, or the browser agent.`,
			"Use a built-in tool only for a job no pi tool can do.",
			PLAIN_PATHS_RULE,
		];
	}
	const text = [...policy, ...instructions].join("\n");
	return text || undefined;
}
