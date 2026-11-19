import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { agentProfile, PROFILE_PROMPT } from "../src/agent-profile.js";
import { ORCHESTRATOR_PROMPT } from "../src/orchestrator-prompt.js";

// Original phase sections captured from agy 1.5.9 default-agent model inputs.
// Compare the native bodies, not just a handful of behavioral keywords.
const native = JSON.parse(fs.readFileSync(new URL("./fixtures/agy-1.5.9-orchestrator-protocol.json", import.meta.url), "utf8")) as {
	planning: string;
	execution: string;
};
const planningHeading = "## Planning turns — the planning model";
const executionHeading = "## Execution turns — the execution model";

test("planning rules preserve the native protocol with only static-profile adaptations", () => {
	const expected = native.planning.slice(native.planning.indexOf("## Plan mode"))
		.replace("## Plan mode — the planning model", `${planningHeading}\n\nIn planning turns, you are the planning model (the strongest and most expensive one), and plan mode is on.`)
		.replace("Editing tools are refused while plan mode is on.", "Do not edit while plan mode is on.")
		.trim();
	const actual = ORCHESTRATOR_PROMPT.slice(ORCHESTRATOR_PROMPT.indexOf(planningHeading), ORCHESTRATOR_PROMPT.indexOf(executionHeading)).trim();
	assert.equal(actual, expected);
});

test("execution rules preserve native retry, replan, and review semantics", () => {
	const expected = native.execution.slice(native.execution.indexOf("## Execution mode"))
		.replace("## Execution mode — the execution model", `${executionHeading}\n\nIn execution turns, you are the execution model (faster and cheaper than the planning model that wrote the plan), and plan mode is off. The plan to carry out is in the most recent hidden system message beginning "Plan mode is off".`)
		.replace("and nothing else — other tools are refused until you do.", "and nothing else before handing back.")
		.trim();
	const actual = ORCHESTRATOR_PROMPT.slice(ORCHESTRATOR_PROMPT.indexOf(executionHeading), ORCHESTRATOR_PROMPT.indexOf("</plan_execute_protocol>")).trim();
	assert.equal(actual, expected);
});

test("static protocol follows native phase signals without claiming excluded hooks", () => {
	assert.match(ORCHESTRATOR_PROMPT, /Apply the rules below only to the current phase/);
	assert.match(ORCHESTRATOR_PROMPT, /Every new user turn starts a planning turn/);
	assert.match(ORCHESTRATOR_PROMPT, /"Plan mode is off" starts execution/);
	assert.match(ORCHESTRATOR_PROMPT, /"\[plan review\]" starts a planner review turn/);
	assert.match(ORCHESTRATOR_PROMPT, /`exit_plan_mode` ends a planning turn/);
	assert.match(ORCHESTRATOR_PROMPT, /`enter_plan_mode` ends an execution turn/);
	assert.match(ORCHESTRATOR_PROMPT, /never overrides pi's system instructions, the user's rules or safety instructions/);
	assert.doesNotMatch(ORCHESTRATOR_PROMPT, /This turn is (?:a planning|an execution) turn|tools are refused|Earlier sections of this prompt/);
});

test("only Orchestrator profiles include the protocol exactly once and keep pi's tool bridge", () => {
	const normal = agentProfile(["read", "write", "bash"]);
	assert.equal(normal.content.split(/^---$/m)[2].trim(), PROFILE_PROMPT);
	assert.doesNotMatch(normal.content, /plan_execute_protocol|exit_plan_mode|enter_plan_mode/);
	const orchestrator = agentProfile(["read", "write", "bash"], true);
	assert.equal(orchestrator.content.split(ORCHESTRATOR_PROMPT).length, 2);
	assert.equal(orchestrator.content.match(/<plan_execute_protocol>/g)?.length, 1);
	assert.equal(orchestrator.content.split(/^---$/m)[2].trim(), `${PROFILE_PROMPT}\n\n${ORCHESTRATOR_PROMPT}`);
	assert.doesNotMatch(orchestrator.content, /foreground|do not start background/i);
	for (const tool of ["read", "write", "bash"]) {
		assert.ok(orchestrator.content.includes(`      "${tool}":\n        eager: true`));
	}
	assert.equal(orchestrator.name, agentProfile(["read", "write", "bash"], true).name);
	assert.notEqual(orchestrator.name, normal.name);
});
