export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
}

/** Catalog and dispatch both read pi's CURRENT active set. Builtins are
 * included: Antigravity's own builtins are disabled, so read/bash/edit/write
 * must come through this bridge to run as genuine pi tools. */
export function bridgedPiTools(all: BridgeToolInfo[], active: readonly string[]): BridgeToolInfo[] {
	const enabled = new Set(active);
	return all.filter((tool) => enabled.has(tool.name) && tool.name !== "bridge_poll_result" && tool.name !== "antigravity" && tool.name !== "AskAntigravity");
}
