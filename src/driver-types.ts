// Turn-driver contract between the provider (src/provider.ts) and the ACP
// driver (src/acp/driver.ts). The provider's stream loop, the MCP round-trip
// store, and the extension wiring depend on this interface only, so tests can
// substitute a scripted driver.

import type { NativeToolResult } from "./native-tools.js";
export interface DriverTurnRequest {
	cwd: string;
	/** Base model slug (effort tier separate) or the exact ACP model id. */
	model: string;
	effort?: string;
	/** pi's agent mode: "plan" maps to agy's `plan` mode, "default" to
	 *  `accept-edits` with skipPermissions, else agy's `default`. */
	mode: "default" | "plan";
	/** Approve agy's permission requests for its native tools. */
	skipPermissions: boolean;
	/** ACP session to continue: reused when live in the current process,
	 *  otherwise resumed (or loaded); a lost session falls back to a new one. */
	conversationId?: string | null;
	prompt: string;
	/** Image blocks riding with the prompt, as typed ACP content blocks. */
	images?: Array<{ data: string; mimeType: string }>;
	/** Pi-side context delivered as an embedded `resource` block. */
	contextBlock?: { uri: string; text: string };
	/** The complete input to send instead when `conversationId` cannot be
	 *  continued and a fresh session is created. Without it a delta prompt
	 *  would reach a session that never saw the earlier turns. */
	fallback?: { prompt: string; images?: Array<{ data: string; mimeType: string }>; contextBlock?: { uri: string; text: string } };
	signal?: AbortSignal;
	/** Inactivity cap in minutes (default 5; parked tool calls pause it).
	 *  Fractional values are valid. 0 disables the cap. */
	inactivityMin?: number;
}

export type AgyUsage = {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	total_tokens?: number;
};

/** ACP-reported context occupancy, not cumulative per-model-call token usage. */
export type AgyContextUsage = { used: number; size: number };

export type AgyStepUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Context held by the latest model call (input + cache + output). */
	contextTokens: number;
	steps: number;
};

export type DriverActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	/** agy's native tool lifecycle (agy runs these itself; pi renders no card). */
	| { type: "tool_start"; toolCallId: string; name: string; args: Record<string, unknown>; mcpServer?: string }
	| {
			type: "tool_done";
			toolCallId: string;
			name: string;
			args: Record<string, unknown>;
			mcpServer?: string;
			output?: string;
			/** The server's native edit diff from `tool_call` content[]. */
			diff?: { path: string; oldText?: string; newText: string };
	  }
	| { type: "tool_error"; toolCallId: string; name: string; message: string; mcpServer?: string }
	/** One of agy's own tool calls finished, or was still running when the
	 *  prompt ended (pi tool calls over the bridge are excluded). */
	| ({ type: "native_tool"; toolCallId: string } & NativeToolResult)
	/** Turn-cumulative PromptResponse.usage. */
	| { type: "usage"; usage: AgyUsage }
	| { type: "context_usage"; contextUsage: AgyContextUsage }
	/** Exact usage of the model calls completed since the previous one, read
	 *  from the server's conversation store. */
	| { type: "step_usage"; usage: AgyStepUsage }
	/** Injected by the round-trip store when the MCP bridge receives a pi tool
	 *  call. Parks the turn: output is expected to stall while pi executes
	 *  the tool, so the driver suspends its inactivity guard. */
	| { type: "bridge_call"; callId: string; name: string; args: Record<string, unknown> };

export interface TurnOutcome {
	conversationId?: string;
	status: "OK" | "ERROR";
	response: string;
	error?: string;
	usage?: AgyUsage;
	contextUsage?: AgyContextUsage;
	aborted: boolean;
	/** Highest `steps.idx` in `<conversationId>.db` when this turn settled. */
	maxStepIdx?: number;
}

export interface TurnHandle {
	id: string;
	/** Resolves when the turn settles (result, exit, abort, close). */
	outcome: Promise<TurnOutcome>;
	/** Pull the next activity. Resolves null once the activity stream closes. */
	next(): Promise<DriverActivity | null>;
	/** Inject a synthetic activity (bridge inbox). No-op after settle. */
	pushExternal(activity: DriverActivity): void;
}

export interface TurnDriver {
	readonly activeHandle: TurnHandle | null;
	/** Start a turn. Turns are serialized: this waits for the previous one. */
	run(request: DriverTurnRequest): Promise<TurnHandle>;
	/** Re-attach to the active turn (pi toolUse continuation). */
	reentry(): TurnHandle | null;
	/** Resume the inactivity guard after a parked pi tool call settles. */
	kickIdle(): void;
	/** Abort the active turn (if any) and resolve once it has settled. */
	cancelActive(reason: string): Promise<void>;
	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined);
	close(): Promise<void>;
}
