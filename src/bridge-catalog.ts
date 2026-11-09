import { normalizeSchema } from "./schema.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	/** pi's ToolExposure; absent means `direct`. */
	exposure?: string;
}

/** Exposures pi declares to the model whenever the tool is active. */
const MODEL_FACING = new Set(["direct", "model-only"]);
const INTERNAL = new Set(["bridge_poll_result", "antigravity", "AskAntigravity"]);

/** The catalog the bridge lists: every registered model-facing pi tool,
 * active or not, plus any other tool that is active now. Builtins are
 * included, so pi's read/bash/edit/write are offered next to agy's own native
 * tools and run as genuine pi tools when the model picks them. agy keeps a
 * session's tool list, so listing tools an extension may activate later
 * (pi-lens's situational tools) keeps them callable without a new session,
 * and the list stays stable for agy's prompt cache. Dispatch is limited to
 * pi's CURRENT active set (dispatchablePiTool). */
export function bridgedPiTools(all: BridgeToolInfo[], active: readonly string[]): BridgeToolInfo[] {
	const enabled = new Set(active);
	return all.filter((tool) => !INTERNAL.has(tool.name) && (enabled.has(tool.name) || MODEL_FACING.has(tool.exposure ?? "direct")));
}

/** Whether a bridged call may run: pi only executes its active tools. */
export function dispatchablePiTool(all: BridgeToolInfo[], active: readonly string[], name: string): boolean {
	return active.includes(name) && bridgedPiTools(all, active).some((tool) => tool.name === name);
}

/** Whether a tool explicitly declares a top-level argument in its schema. */
export function declaresToolArgument(parameters: object | undefined, name: string): boolean {
	const seen = new Set<object>();
	const visit = (schema: unknown): boolean => {
		if (!schema || typeof schema !== "object" || seen.has(schema)) return false;
		seen.add(schema);
		const node = schema as Record<string, unknown>;
		if (node.properties && typeof node.properties === "object" && Object.hasOwn(node.properties, name)) return true;
		return ["allOf", "anyOf", "oneOf"].some((key) => Array.isArray(node[key]) && node[key].some(visit));
	};
	return visit(parameters);
}

const schemaCache = new WeakMap<object, Record<string, unknown>>();

/** MCP input schema for a pi tool: a JSON copy of its parameters (TypeBox
 *  symbols and functions dropped), normalized for agy's model transports.
 *  Cached per parameters object, since ACP lists tools on every session. */
export function bridgeInputSchema(parameters: object | undefined): Record<string, unknown> {
	if (!parameters) return permissiveSchema();
	const cached = schemaCache.get(parameters);
	if (cached) return cached;
	let schema: Record<string, unknown>;
	try {
		const copy: unknown = JSON.parse(JSON.stringify(parameters));
		schema = copy && typeof copy === "object" && !Array.isArray(copy) ? normalizeSchema(copy as Record<string, unknown>) : permissiveSchema();
	} catch {
		schema = permissiveSchema();
	}
	schemaCache.set(parameters, schema);
	return schema;
}

function permissiveSchema(): Record<string, unknown> {
	return { type: "object", properties: {}, additionalProperties: true };
}
