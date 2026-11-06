// Tool policy appended to agy's system prompt (session/new, resume, load:
// `_meta.antigravity.systemPrompt.append`).
//
// With realagy's agent profile (src/agent-profile.ts) agy has no file, shell,
// or delegation tools and none of its own prompt, so the policy only names
// the pi tools. With agy's default agent, `agy acp` ignores tool allowlists,
// so the model is asked to prefer pi's tools (agy's own tools stay usable)
// and to ignore the default prompt's file:// link rules.

/** agy 1.5's own file and shell tools, which pi's tools replace. */
const AGY_FILE_AND_SHELL_TOOLS = ["run_command", "read_file", "write_file", "edit_file"];
/** agy 1.5's delegation and scheduling tools (the browser agent, when
 *  enabled, is a subagent too). */
const AGY_DELEGATION_TOOLS = ["invoke_subagent", "define_subagent", "manage_subagents", "schedule", "manage_task"];

/** Counters agy's default <communication_style> and artifact "File Links"
 *  rules, which pi's terminal renders as `name (file:///abs/path#L1-L2)`. */
export const PLAIN_PATHS_RULE =
	"Formatting (this replaces your communication_style and artifacts rules on file links): write file references as plain paths, relative to the working directory when possible (src/app.ts, src/app.ts:10-20), absolute only outside it, and code symbols as inline code (`ClassName`). Never use file:// URLs or Markdown links for local files or code symbols.";

export interface ToolPolicyOptions {
	/** The serving process runs realagy's agent profile. */
	profile?: boolean;
}

/** The policy for the bridged pi tools, or undefined when pi offers none
 *  (and no profile-free formatting override is needed). */
export function toolPolicyPrompt(toolNames: readonly string[], opts: ToolPolicyOptions = {}): string | undefined {
	const names = [...new Set(toolNames.filter((name) => name.length > 0))];
	if (opts.profile) {
		if (names.length === 0) return undefined;
		return [
			"pi's tools in this session, served by the pi-bridge MCP server (you call them as mcp_pi-bridge_<name>; pi's transcript names them without the prefix):",
			names.join(", "),
		].join("\n");
	}
	if (names.length === 0) return PLAIN_PATHS_RULE;
	return [
		"Client tool policy: this session runs inside the pi coding agent, which provides its tools through the pi-bridge MCP server:",
		names.join(", "),
		"Use these pi tools for all file and shell work: read files (including images) with them, run every shell command (including directory listings) with them, and create, edit, move or delete files with them, so the user sees and approves that work in pi.",
		// Naming agy's own tools measurably helps GPT-OSS follow the policy.
		`Do not use your built-in ${AGY_FILE_AND_SHELL_TOOLS.join(", ")} tools for anything a pi tool can do.`,
		`Do the work yourself, in the foreground: do not start subagents, the browser agent, background tasks, or scheduled tasks (${AGY_DELEGATION_TOOLS.join(", ")}).`,
		"Use a built-in tool only for a job no pi tool can do.",
		PLAIN_PATHS_RULE,
	].join("\n");
}
