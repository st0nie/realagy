// MCP images are offloaded by agy. Let its native viewer open a byte-for-byte
// copy of pi's image result in an allowed directory, without restarting ACP.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeResult } from "./mcp-server.js";

export type ResultImage = { data: string; mimeType: string };
const EXTENSIONS: Record<string, string> = {
	"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
	"image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
};

export class ImageResults {
	#directory: string | undefined;
	#paths = new Map<string, string>();

	constructor(private readonly root = join(homedir(), ".gemini", "antigravity-acp")) {}

	result(text: string, isError: boolean, images: ResultImage[]): BridgeResult {
		const references: string[] = [];
		try {
			for (const image of images) {
				const extension = EXTENSIONS[image.mimeType.toLowerCase()];
				if (!extension) throw new Error(`Unsupported image type: ${image.mimeType}`);
				const bytes = Buffer.from(image.data, "base64");
				if (bytes.length === 0) throw new Error("Empty image result");
				const key = createHash("sha256").update(bytes).digest("hex") + extension;
				let path = this.#paths.get(key);
				if (!path) {
					if (!this.#directory) {
						mkdirSync(this.root, { recursive: true, mode: 0o700 });
						this.#directory = mkdtempSync(join(this.root, "pi-images-"));
					}
					path = join(this.#directory, key);
					writeFileSync(path, bytes, { mode: 0o600 });
					this.#paths.set(key, path);
				}
				references.push(`Image ${references.length + 1}: ${JSON.stringify(path)}`);
			}
		} catch (error) {
			return { content: [{ type: "text", text: `${text}\nImage delivery failed: ${error instanceof Error ? error.message : String(error)}. Do not guess the image contents.` }], isError: true };
		}
		const instructions = references.length > 0
			? `\n\n${references.join("\n")}\nThese are exact copies of the image bytes returned by pi. To SEE each image, call your native view_file with file_path set to its path above. Do not use MCP read on these copies: MCP images are not visible to you. No session restart is needed.`
			: "";
		return { content: [{ type: "text", text: (text || "(no output)") + instructions }], isError };
	}

	clear(): void {
		if (this.#directory) rmSync(this.#directory, { recursive: true, force: true });
		this.#directory = undefined;
		this.#paths.clear();
	}
}
