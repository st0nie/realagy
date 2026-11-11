import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelCache, saveModelCache } from "../src/model-cache.js";

const dirs: string[] = [];
function cacheFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realagy-model-cache-"));
	dirs.push(dir);
	return path.join(dir, "realagy", "models.json");
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("model catalog cache", () => {
	const models = [{ full: "gemini-4-carbon", id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "high"] as ("low" | "high")[], contextWindow: 123456, maxTokens: 4096 }];
	it("round-trips discovered metadata and never replaces it with an empty catalog", () => {
		const file = cacheFile();
		expect(loadModelCache(file)).toBeUndefined();
		saveModelCache(models, file);
		expect(loadModelCache(file)).toEqual(models);
		saveModelCache([], file);
		expect(loadModelCache(file)).toEqual(models);
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});
	it("ignores malformed, invalid, and unsupported cache files", () => {
		const file = cacheFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		for (const contents of ["{", JSON.stringify({ version: 2, models }), JSON.stringify({ version: 1, models: [{ ...models[0], efforts: ["extreme"] }] }), JSON.stringify({ version: 1, models: [models[0], models[0]] })]) {
			fs.writeFileSync(file, contents);
			expect(loadModelCache(file)).toBeUndefined();
		}
	});
	it("does not throw when the cache cannot be written", () => {
		const file = cacheFile();
		fs.writeFileSync(path.dirname(file), "not a directory");
		expect(() => saveModelCache(models, file)).not.toThrow();
	});
});
