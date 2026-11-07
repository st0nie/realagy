import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	agentProfile,
	agentProfileDir,
	installAgentProfile,
	PROFILE_MAX_IDLE_MS,
	PROFILE_PROMPT,
} from "../src/agent-profile.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "realagy-profile-test-"));

test("the profile replaces agy's prompt, hides itself, and makes every bridged tool eager", () => {
	const { name, content } = agentProfile(["bash", "read", "bash", "", "bridge_poll_result"]);
	assert.match(name, /^realagy-[0-9a-f]{12}$/);
	const [, frontmatter, body] = content.split(/^---$/m);
	assert.ok(frontmatter.includes(`name: "${name}"`));
	assert.match(frontmatter, /^hidden: true$/m);
	assert.match(frontmatter, /^excludeDefaultComponents: true$/m);
	// agy only loads the list form; one eager entry per tool.
	assert.match(frontmatter, /^mcpServers:\n {2}- name: pi-bridge\n {4}tools:\n/m);
	for (const tool of ["bash", "read", "bridge_poll_result"]) assert.ok(frontmatter.includes(`      "${tool}":\n        eager: true\n`), tool);
	assert.equal(frontmatter.match(/"bash":/g)?.length, 1);
	assert.equal(body.trim(), PROFILE_PROMPT);
	assert.match(PROFILE_PROMPT, /<pi-system>/);
	assert.match(PROFILE_PROMPT, /Never use file:\/\/ URLs or Markdown links for local files or code symbols/);
});

test("the profile name follows the tool set only", () => {
	assert.equal(agentProfile(["a", "b"]).name, agentProfile(["a", "b"]).name);
	assert.notEqual(agentProfile(["a", "b"]).name, agentProfile(["a", "c"]).name);
});

test("install writes once, refreshes mtime, and prunes only idle realagy profiles", () => {
	const dir = tmp();
	const now = Date.now();
	const logs: string[] = [];
	const name = installAgentProfile(["bash"], { dir, now, log: (msg) => logs.push(msg) });
	assert.ok(name);
	const file = path.join(dir, `${name}.md`);
	assert.equal(fs.readFileSync(file, "utf8"), agentProfile(["bash"]).content);
	assert.deepEqual(logs, ["agent-profile-written"]);

	// Unchanged: no rewrite, only the use time moves.
	const old = new Date(now - 1000 * 60 * 60);
	fs.utimesSync(file, old, old);
	assert.equal(installAgentProfile(["bash"], { dir, now, log: (msg) => logs.push(msg) }), name);
	assert.deepEqual(logs, ["agent-profile-written"]);
	assert.ok(Math.abs(fs.statSync(file).mtimeMs - now) < 2000);

	// Another instance's profiles: idle ones go, fresh ones and foreign files stay.
	const idle = installAgentProfile(["read"], { dir, now })!;
	const fresh = installAgentProfile(["edit"], { dir, now })!;
	const ancient = new Date(now - PROFILE_MAX_IDLE_MS - 1000);
	fs.utimesSync(path.join(dir, `${idle}.md`), ancient, ancient);
	const foreign = path.join(dir, "realagy-000000000000.md");
	fs.writeFileSync(foreign, "---\nname: realagy-000000000000\ndescription: mine\n---\nUser agent.\n");
	fs.utimesSync(foreign, ancient, ancient);
	fs.writeFileSync(path.join(dir, "my-agent.md"), "---\nname: my-agent\n---\n");
	installAgentProfile(["bash"], { dir, now });
	assert.deepEqual(fs.readdirSync(dir).sort(), [`${fresh}.md`, `${name}.md`, "my-agent.md", "realagy-000000000000.md"].sort());
});

test("install reports failure instead of throwing", () => {
	const dir = tmp();
	const blocker = path.join(dir, "agents");
	fs.writeFileSync(blocker, "not a directory");
	const logs: string[] = [];
	assert.equal(installAgentProfile(["bash"], { dir: blocker, log: (msg) => logs.push(msg) }), undefined);
	assert.deepEqual(logs, ["agent-profile-failed"]);
});

test("profile location honors GEMINI_HOME", () => {
	assert.equal(agentProfileDir({ GEMINI_HOME: path.join("/g") }), path.join("/g", "config", "agents"));
	assert.equal(agentProfileDir({}), path.join(os.homedir(), ".gemini", "config", "agents"));
});
