// ACP `session/update` payload → DriverActivity mapping + stopReason mapping.
//
// Pure functions, no I/O.
//
// Shapes verified live against `agy acp`:
//   session/update params = { sessionId, update: { sessionUpdate: <discriminator>, ... } }
//   - agent_message_chunk  { content: { type: "text", text } }         (pure deltas)
//   - agent_thought_chunk  { content: { type: "text", text } }          (thought TEXT)
//   - user_message_chunk   { content: { type: "text", text } }          (load replay only)
//   - tool_call            { toolCallId, name, args, title, kind, status, content?, locations?, rawInput? }
//   - tool_call_update     { toolCallId, name, status: pending|in_progress|completed|failed, rawOutput?, content? }
//     (name: native `run_command`, pi bridge `mcp_pi-bridge_<tool>`)
//   - plan                 { entries: [...] }
//   - available_commands_update { availableCommands: [...] }
// Token usage arrives in the session/prompt result and as usage_update
// frames; both are handled by the driver, not here.

import { PI_BRIDGE_SERVER } from "../native-tools.js";
import { StreamSanitizer } from "../stream-sanitizer.js";

/** Map one `update` object to a driver-level event, or null when the update
 *  carries nothing the driver consumes (plans and command lists are not
 *  rendered; user_message_chunk is load replay and must never reach pi as
 *  live text). */
/** Native edit diff carried in tool_call content[] (run 6: edits arrive AS
 *  DIFFS: {type:"diff", path, newText, optional oldText}). The provider
 *  formats it in memory — no git subprocess needed on the ACP engine. */
export interface AcpEditDiff {
	path: string;
	oldText?: string;
	newText: string;
}

export type MappedUpdate =
	| { kind: "text"; delta: string }
	| { kind: "thought"; delta: string }
	| { kind: "tool_start"; toolCallId: string; name: string; args: Record<string, unknown>; title?: string; diff?: AcpEditDiff; mcpServer?: string }
	| { kind: "tool_done"; toolCallId: string; output?: string; diff?: AcpEditDiff; mcpServer?: string }
	| { kind: "tool_error"; toolCallId: string; message: string; mcpServer?: string }
	| { kind: "replay_user" }
	| null;

export function mapUpdate(update: unknown): MappedUpdate {
	if (typeof update !== "object" || update === null) return null;
	const u = update as Record<string, unknown>;
	const kind = u.sessionUpdate;
	if (typeof kind !== "string") return null;
	switch (kind) {
		case "agent_message_chunk":
			return { kind: "text", delta: chunkText(u.content) };
		case "agent_thought_chunk":
			return { kind: "thought", delta: chunkText(u.content) };
		case "user_message_chunk":
			return { kind: "replay_user" };
		case "tool_call": {
			const id = stringField(u.toolCallId);
			if (!id) return null;
			const named = frameToolName(u);
			return {
				kind: "tool_start",
				toolCallId: id,
				name: named.name,
				args: rawArguments(u.rawInput ?? u.args),
				...(named.mcpServer ? { mcpServer: named.mcpServer } : {}),
				...(stringField(u.title) ? { title: stringField(u.title) } : {}),
				// Edits carry their native diff HERE, on the pending tool_call
				// frame — the completed update carries only display text.
				diff: contentDiff(u.content),
			};
		}
		case "tool_call_update": {
			const id = stringField(u.toolCallId);
			if (!id) return null;
			if (u.status === "failed") {
				// agy echo: after an allow, the APPROVED call
				// id reports failed with this sentinel while the real work runs
				// under a different id that reports its own lifecycle. Track
				// effects, not ids: drop the echo instead of rendering a bogus
				// failure next to a successful edit.
				const raw = stringField(u.rawOutput);
				if (raw?.includes("approved but never executed")) return null;
				const mcpServer = frameToolName(u).mcpServer;
				return { kind: "tool_error", toolCallId: id, message: raw ?? "tool failed", ...(mcpServer ? { mcpServer } : {}) };
			}
			if (u.status === "completed") {
				// content[] first (edits carry their diff there); rawOutput alone is
				// often just the server's display title, not the result (probe
				// 2026-09-03: completed MCP call, rawOutput "Call bridge_echo").
				const diff = contentDiff(u.content);
				const mcpServer = frameToolName(u).mcpServer;
				return {
					kind: "tool_done",
					toolCallId: id,
					output: contentText(u.content) ?? stringField(u.rawOutput),
					...(mcpServer ? { mcpServer } : {}),
					...(diff ? { diff } : {}),
				};
			}
			return null; // in_progress or unknown status: nothing to render yet
		}
		default:
			// plan / available_commands_update / current_mode_update /
			// config_option_update / session_info_update: nothing pi renders.
			return null;
	}
}

/** MCP tools wrap their args in an `arguments` envelope
 *  ({arguments:{...}}); native tools carry them directly (probe 2026-09-03:
 *  bridge_echo rawInput {arguments:{text}}, edit_file rawInput {file_path}). */
function rawArguments(rawInput: unknown): Record<string, unknown> {
	const rec = recordField(rawInput);
	const args = rec.arguments;
	return typeof args === "object" && args !== null && !Array.isArray(args)
		? (args as Record<string, unknown>)
		: rec;
}

/** Tool name and MCP server of a tool frame. agy 1.5 sends `name` (native
 *  `run_command`, bridge `mcp_pi-bridge_bash`); `_meta.mcp` and the title are
 *  older shapes. Only the pi bridge's prefix is split off: other servers'
 *  names may contain underscores, and their calls count as agy's own. */
function frameToolName(u: Record<string, unknown>): { name: string; mcpServer?: string } {
	const mcp = recordField(recordField(u._meta).mcp);
	const metaTool = stringField(mcp.tool);
	const metaServer = stringField(mcp.server);
	if (metaTool) return { name: metaTool, ...(metaServer ? { mcpServer: metaServer } : {}) };
	const name = stringField(u.name);
	const bridgePrefix = `mcp_${PI_BRIDGE_SERVER}_`;
	if (name?.startsWith(bridgePrefix) && name.length > bridgePrefix.length) {
		return { name: name.slice(bridgePrefix.length), mcpServer: PI_BRIDGE_SERVER };
	}
	return { name: name ?? toolName(u.title, u.kind), ...(metaServer ? { mcpServer: metaServer } : {}) };
}

/** First diff entry of a completed tool call: edits carry their native diff
 *  in content[] as {type:"diff", path, newText, optional oldText} (run 6). */
function contentDiff(content: unknown): AcpEditDiff | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const entry of content) {
		const e = recordField(entry);
		if (e.type !== "diff") continue;
		const path = stringField(e.path);
		const newText = stringField(e.newText);
		if (!path || newText === undefined) continue;
		const oldText = stringField(e.oldText);
		return oldText !== undefined ? { path, oldText, newText } : { path, newText };
	}
	return undefined;
}

/** Display text of a completed tool call. content[] entries wrap their
 *  payload ({type:"content", content:{type:"text", text}}); diff entries
 *  carry no text and are skipped. */
function contentText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const entry of content) {
		const inner = recordField(recordField(entry).content ?? entry);
		if (typeof inner.text === "string" && inner.text.length > 0) parts.push(inner.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Extract the text of a content block ({type:"text", text}). */
function chunkText(content: unknown): string {
	if (typeof content === "object" && content !== null) {
		const c = content as Record<string, unknown>;
		if (typeof c.text === "string") return c.text;
	}
	return "";
}

function stringField(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function recordField(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

/** Derive a tool name from the title ("Run create_file?", "Running edit_file")
 *  with the kind as fallback. Titles observed live: "Run create_file?",
 *  "Running edit_file", "Running read_file". */
export function toolName(title: unknown, kind: unknown): string {
	if (typeof title === "string") {
		const m = /(?:Run|Running)\s+([A-Za-z_][\w.]*)/i.exec(title);
		if (m) return m[1] as string;
	}
	return typeof kind === "string" && kind.length > 0 ? kind : "tool";
}

/** agy inserts this line as a message chunk of its own when the model
 *  produced a malformed tool call, then retries (seen with GPT-OSS on agy
 *  1.5.1). It is agy's status, not reply text. */
const AGY_RETRY_NOTICE = "⚠ Model produced invalid output.";

export function isAgyRetryNotice(delta: string): boolean {
	return delta.trim() === AGY_RETRY_NOTICE;
}

/** agy answers with this notice as reply text, and stopReason end_turn, when
 *  its backend is out of capacity (seen on agy 1.5.1). */
const AGY_CAPACITY_NOTICE = /^⚠\s*(Our servers are experiencing high traffic[^\n]*)$/;

/** The capacity notice when it is the whole reply, else undefined. */
export function agyCapacityNotice(response: string): string | undefined {
	return AGY_CAPACITY_NOTICE.exec(response.trim())?.[1];
}

/** Map a `session/prompt` result stopReason to a TurnOutcome shape.
 *  Verified live: `end_turn`, and `cancelled` after a session/cancel
 *  notification. The schema also enumerates max_tokens / max_turn_requests /
 *  refusal. */
export function mapStopReason(stopReason: unknown): {
	status: "OK" | "ERROR";
	aborted: boolean;
	error?: string;
} {
	switch (stopReason) {
		case "end_turn":
			return { status: "OK", aborted: false };
		case "cancelled":
			return { status: "OK", aborted: true };
		case "max_tokens":
			return { status: "OK", aborted: false, error: "ACP: response hit the token cap" };
		case "refusal":
			return { status: "ERROR", aborted: false, error: "ACP: the model refused the request" };
		case "max_turn_requests":
			return { status: "ERROR", aborted: false, error: "ACP: turn exceeded the request limit" };
		default:
			return { status: "OK", aborted: false };
	}
}

/** Defensive accumulation with the cumulative-resend port. agy streams pure
 *  deltas (verified: mid-token splits across stress streams), so on
 *  a compliant server the resend branch stays inert; it exists because the
 *  same backend's private protocol exhibited exactly this failure mode.
 *
 *  Two guards keep a misflip from corrupting the rest of the turn:
 *  - the flip requires the accumulated text to be at least FLIP_MIN_CHARS,
 *    because short prefixes ("**", "\n", "#") are trivially extended by
 *    ordinary markdown deltas;
 *  - in cumulative mode, a frame that no longer extends the accumulator is
 *    evidence of a misflip: fall back to append mode instead of slicing. */
const FLIP_MIN_CHARS = 32;

export class TextAccumulator {
	#rawAcc = "";
	#sanitizedAcc = "";
	#cumulative: boolean | undefined;
	#sanitizer = new StreamSanitizer();

	/** Returns the delta to emit, or null when nothing new should be emitted. */
	append(delta: string): string | null {
		let rawEmit: string | null = null;
		if (this.#cumulative === undefined) this.#cumulative = false;
		else if (
			!this.#cumulative &&
			this.#rawAcc.length >= FLIP_MIN_CHARS &&
			delta.length > this.#rawAcc.length &&
			delta.startsWith(this.#rawAcc)
		) {
			this.#cumulative = true;
		}
		if (this.#cumulative) {
			if (!delta.startsWith(this.#rawAcc)) {
				// Misflip evidence: back to deltas.
				this.#cumulative = false;
				this.#rawAcc += delta;
				rawEmit = delta;
			} else if (delta.length <= this.#rawAcc.length) {
				return null; // duplicate frame
			} else {
				rawEmit = delta.slice(this.#rawAcc.length);
				this.#rawAcc = delta;
			}
		} else {
			this.#rawAcc += delta;
			rawEmit = delta;
		}

		if (rawEmit === null) return null;
		const sanitized = this.#sanitizer.push(rawEmit);
		if (sanitized.length > 0) {
			this.#sanitizedAcc += sanitized;
			return sanitized;
		}
		return null;
	}

	flush(): string | null {
		const flushed = this.#sanitizer.flush();
		if (flushed.length > 0) {
			this.#sanitizedAcc += flushed;
			return flushed;
		}
		return null;
	}

	get text(): string {
		return this.#sanitizedAcc;
	}
}
