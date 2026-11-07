import type { BridgeResult } from "./mcp-server.js";

export const PARALLEL_TOOL_NAME = "parallel";
export const MAX_PARALLEL_CALLS = 16;

export interface ParallelToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ParallelResolvedCall extends ParallelToolCall {
	callId: string;
}

export const PARALLEL_TOOL_INFO = {
	name: PARALLEL_TOOL_NAME,
	description: "Run 1-16 independent Pi tools in one batch. Pi applies normal permissions and runs eligible calls concurrently (sequential tools stay sequential). Do not use for dependent or conflicting work, nested parallel calls, or bridge_poll_result. Results are returned in input order.",
	parameters: {
		type: "object",
		properties: {
			calls: {
				type: "array",
				minItems: 1,
				maxItems: MAX_PARALLEL_CALLS,
				items: {
					type: "object",
					properties: {
						name: { type: "string", minLength: 1 },
						arguments: { type: "object", additionalProperties: true },
					},
					required: ["name"],
					additionalProperties: false,
				},
			},
		},
		required: ["calls"],
		additionalProperties: false,
	},
} as const;

export type ParallelCallsParseResult =
	| { ok: true; calls: ParallelToolCall[] }
	| { ok: false; error: string };

export function parseParallelCalls(
	args: Record<string, unknown>,
	reservedNames: readonly string[] = [],
): ParallelCallsParseResult {
	if (Object.keys(args).some((key) => key !== "calls")) {
		return { ok: false, error: "parallel accepts only the calls property" };
	}
	if (!Array.isArray(args.calls) || args.calls.length < 1 || args.calls.length > MAX_PARALLEL_CALLS) {
		return { ok: false, error: `parallel.calls must contain 1-${MAX_PARALLEL_CALLS} tool calls` };
	}
	const calls: ParallelToolCall[] = [];
	for (let index = 0; index < args.calls.length; index++) {
		const value: unknown = args.calls[index];
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { ok: false, error: `parallel.calls[${index}] must be an object` };
		}
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some((key) => key !== "name" && key !== "arguments")) {
			return { ok: false, error: `parallel.calls[${index}] accepts only name and arguments` };
		}
		if (typeof record.name !== "string" || record.name.trim().length === 0) {
			return { ok: false, error: `parallel.calls[${index}].name must be a non-empty string` };
		}
		if (record.name === PARALLEL_TOOL_NAME || reservedNames.includes(record.name)) {
			return { ok: false, error: `parallel.calls[${index}] cannot invoke ${record.name}` };
		}
		const toolArguments = record.arguments ?? {};
		if (typeof toolArguments !== "object" || toolArguments === null || Array.isArray(toolArguments)) {
			return { ok: false, error: `parallel.calls[${index}].arguments must be an object` };
		}
		calls.push({ name: record.name, arguments: toolArguments as Record<string, unknown> });
	}
	return { ok: true, calls };
}

export function parallelErrorResult(message: string): BridgeResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function formatParallelResults(
	calls: readonly ParallelResolvedCall[],
	results: readonly BridgeResult[],
): { text: string; isError: boolean; images: Array<{ data: string; mimeType: string }> } {
	if (calls.length !== results.length) throw new Error("parallel result count does not match its calls");
	const images: Array<{ data: string; mimeType: string }> = [];
	const entries = calls.map((call, index) => {
		const result = results[index];
		const content = result.content.map((block) => {
			if (block.type === "text") return { type: "text" as const, text: block.text };
			images.push({ data: block.data, mimeType: block.mimeType });
			return { type: "image" as const, index: images.length, mimeType: block.mimeType };
		});
		return {
			callId: call.callId,
			name: call.name,
			isError: result.isError ?? false,
			content,
		};
	});
	return {
		text: JSON.stringify({ results: entries }, null, 2),
		isError: entries.some((entry) => entry.isError),
		images,
	};
}
