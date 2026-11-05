import { normalizeSchema } from "./schema.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
}

/** Catalog and dispatch both read pi's CURRENT active set. Builtins are
 * included, so pi's read/bash/edit/write are offered next to agy's own native
 * tools and run as genuine pi tools when the model picks them. */
export function bridgedPiTools(all: BridgeToolInfo[], active: readonly string[]): BridgeToolInfo[] {
	const enabled = new Set(active);
	return all.filter((tool) => enabled.has(tool.name) && tool.name !== "bridge_poll_result" && tool.name !== "antigravity" && tool.name !== "AskAntigravity");
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
