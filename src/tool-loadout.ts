// Pi's `/tree` tool restore, corrected for situational extension tools.
//
// `/tree` restores the target branch's tool loadout from its system
// messages (`_restoreToolsFromTranscript()`), and additionally activates every
// registered extension tool the branch never declared, assuming it was
// installed later. Tools an extension keeps inactive until needed (pi-lens's
// situational tools) are never declared either, so a rewind would activate
// them and the next request would add a `<tools>` system message declaring
// them. This finds those spurious activations.

/** The parts of a pi session entry this module reads. */
export interface LoadoutEntry {
	type?: string;
	message?: {
		role?: string;
		toolsAdded?: ReadonlyArray<{ name: string }>;
		toolsRemoved?: ReadonlyArray<{ name: string }>;
	};
}

/** Tools active after a `/tree` navigation that were inactive before it and
 *  that the target branch never declared: pi activated them only because the
 *  branch does not mention them. Deactivating them restores the branch's
 *  recorded tool set (what its warm snapshot holds as `tools`), while tools
 *  that were already active, such as a newly installed extension's, stay. */
export function treeRestoreExtras(branch: readonly LoadoutEntry[], before: ReadonlySet<string>, active: readonly string[]): string[] {
	const declared = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "system") continue;
		for (const tool of entry.message.toolsAdded ?? []) declared.add(tool.name);
		for (const tool of entry.message.toolsRemoved ?? []) declared.add(tool.name);
	}
	return active.filter((name) => !before.has(name) && !declared.has(name));
}
