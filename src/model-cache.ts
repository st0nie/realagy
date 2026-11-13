// Last successful ACP catalog, used only until live discovery succeeds.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAgyEffort, type AgyModelEntry } from "./models.js";

export function modelCachePath(): string {
	return path.join(getAgentDir(), "realagy", "models.json");
}

function validEntry(value: unknown): value is AgyModelEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	const positive = (n: unknown) => n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n > 0);
	return typeof entry.full === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.full)
		&& typeof entry.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)
		&& (entry.name === undefined || typeof entry.name === "string")
		&& (entry.efforts === undefined || (Array.isArray(entry.efforts) && entry.efforts.length > 0 && entry.efforts.every(isAgyEffort)))
		&& positive(entry.contextWindow) && positive(entry.maxTokens);
}

export function loadModelCache(file = modelCachePath()): AgyModelEntry[] | undefined {
	try {
		const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!data || typeof data !== "object") return undefined;
		const cache = data as { version?: unknown; models?: unknown };
		if (cache.version !== 1 || !Array.isArray(cache.models) || cache.models.length === 0 || !cache.models.every(validEntry)) return undefined;
		if (new Set(cache.models.map((entry: AgyModelEntry) => entry.id)).size !== cache.models.length) return undefined;
		return cache.models;
	} catch {
		return undefined;
	}
}

export function saveModelCache(models: readonly AgyModelEntry[], file = modelCachePath()): void {
	if (models.length === 0 || !models.every(validEntry) || new Set(models.map((entry) => entry.id)).size !== models.length) return;
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(temp, JSON.stringify({ version: 1, models }), { mode: 0o600 });
		fs.renameSync(temp, file);
	} catch {
		// A read-only or unavailable cache must not break live discovery.
		try { fs.unlinkSync(temp); } catch { /* Nothing to clean up. */ }
	}
}
