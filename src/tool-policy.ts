// Tool policy appended to agy's system prompt (session/new, resume, load:
// `_meta.antigravity.systemPrompt.append`). `agy acp` ignores tool allowlists,
// so the model is asked to prefer pi's tools; agy's own tools stay usable.

/** agy 1.5's own file and shell tools, which pi's tools replace. */
const AGY_FILE_AND_SHELL_TOOLS = ["run_command", "read_file", "write_file", "edit_file"];
/** agy 1.5's delegation and scheduling tools (the browser agent, when
 *  enabled, is a subagent too). */
const AGY_DELEGATION_TOOLS = ["invoke_subagent", "define_subagent", "manage_subagents", "schedule", "manage_task"];

/** The policy for the active pi tools, or undefined when pi offers none. */
export function toolPolicyPrompt(toolNames: readonly string[]): string | undefined {
	const names = [...new Set(toolNames.filter((name) => name.length > 0))];
	if (names.length === 0) return undefined;
	return [
		"Client tool policy: this session runs inside the pi coding agent, which provides its tools through the pi-bridge MCP server:",
		names.join(", "),
		"Use these pi tools for all file and shell work: read files (including images) with them, run every shell command (including directory listings) with them, and create, edit, move or delete files with them, so the user sees and approves that work in pi.",
		// Naming agy's own tools measurably helps GPT-OSS follow the policy.
		`Do not use your built-in ${AGY_FILE_AND_SHELL_TOOLS.join(", ")} tools for anything a pi tool can do.`,
		`Do the work yourself, in the foreground: do not start subagents, the browser agent, background tasks, or scheduled tasks (${AGY_DELEGATION_TOOLS.join(", ")}).`,
		"Use a built-in tool only for a job no pi tool can do.",
	].join("\n");
}
