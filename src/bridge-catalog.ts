import { normalizeSchema } from "./schema.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	/** pi's ToolExposure; absent means `direct`. */
	exposure?: string;
	/** Where pi got the tool; `builtin` for pi's own tools and builtin extensions. */
	sourceInfo?: { source?: string };
}

/** Which inactive tools the bridge declares (config `toolCatalog`):
 *  - `balanced`: every model-facing tool an extension may activate later, and
 *    pi's core builtins only while active (only the user turns those on);
 *  - `active`: only the active tools (smallest list; a change respawns agy);
 *  - `registered`: every model-facing tool, core builtins included. */
export const TOOL_CATALOGS = ["balanced", "active", "registered"] as const;
export type ToolCatalog = (typeof TOOL_CATALOGS)[number];

export interface CatalogOptions {
	catalog?: ToolCatalog;
	/** Active tools pi leaves out of the model's declarations (a tool's
	 *  `prepareLoadout`, such as codemode's `only` mode). */
	hidden?: ReadonlySet<string>;
}

/** Exposures pi declares to the model whenever the tool is active. */
const MODEL_FACING = new Set(["direct", "model-only"]);
/** pi tools the bridge never lists or dispatches: realagy's own poll helper
 *  and its Antigravity tools (which would call back into agy). */
export const UNBRIDGED_TOOLS: ReadonlySet<string> = new Set(["bridge_poll_result", "antigravity", "AskAntigravity"]);
/** pi's core tools (pi's `allToolNames`): always registered, and active only
 *  when the user selects them (`--tools`, `defaultTools`, `/tools`). Builtin
 *  extensions' tools (`codemode`, `tool_search`) also come from `builtin` but
 *  are activated on demand, so they are not listed here. */
const CORE_BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);

const isCoreBuiltin = (tool: BridgeToolInfo) => tool.sourceInfo?.source === "builtin" && CORE_BUILTINS.has(tool.name);

/** The catalog the bridge lists: the active pi tools pi declares to the model,
 * plus the inactive ones the catalog mode pre-declares. agy keeps a session's
 * tool list, so pre-declaring tools an extension may activate later (pi-lens's
 * situational tools) keeps them callable without respawning agy, and the list
 * stays stable for agy's prompt cache. Dispatch is limited to pi's CURRENT
 * active set (dispatchablePiTool). */
export function bridgedPiTools(all: readonly BridgeToolInfo[], active: readonly string[], opts: CatalogOptions = {}): BridgeToolInfo[] {
	const catalog = opts.catalog ?? "balanced";
	const enabled = new Set(active);
	return all.filter((tool) => {
		if (UNBRIDGED_TOOLS.has(tool.name) || opts.hidden?.has(tool.name)) return false;
		if (enabled.has(tool.name)) return true;
		if (catalog === "active" || !MODEL_FACING.has(tool.exposure ?? "direct")) return false;
		return catalog === "registered" || !isCoreBuiltin(tool);
	});
}

/** Whether a bridged call may run: pi only executes its active tools. */
export function dispatchablePiTool(all: readonly BridgeToolInfo[], active: readonly string[], name: string, opts: CatalogOptions = {}): boolean {
	return active.includes(name) && bridgedPiTools(all, active, opts).some((tool) => tool.name === name);
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
