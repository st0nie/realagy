import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ensureAgyReady, resolveAgyBinary } from "../src/acp/setup.js";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "realagy-setup-test-"));
}

test("ensureAgyReady finds AGY_BIN or PATH agy and never installs", () => {
	const dir = tmp();
	const bin = path.join(dir, "agy");
	fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
	assert.equal(resolveAgyBinary({ PATH: dir }), bin);
	assert.equal(resolveAgyBinary({ AGY_BIN: bin, PATH: "" }), bin);
	assert.equal(resolveAgyBinary({ AGY_BIN: path.join(dir, "missing"), PATH: dir }), null);

	const home = { PATH: dir, GEMINI_HOME: path.join(dir, "gemini") };
	assert.deepEqual(ensureAgyReady(home), { ok: true, bin });
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "gemini", "antigravity-cli", "settings.json"), "utf8")).queuedMessages, "send-immediately");

	const missing = ensureAgyReady({ AGY_BIN: path.join(dir, "nope"), PATH: dir });
	assert.equal(missing.ok, false);
	const absent = ensureAgyReady({ PATH: path.join(dir, "empty"), HOME: dir });
	if (!absent.ok) assert.match(absent.manual, /install\.sh/);
});
