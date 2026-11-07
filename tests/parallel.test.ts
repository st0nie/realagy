import assert from "node:assert/strict";
import { test } from "vitest";
import {
	formatParallelResults,
	MAX_PARALLEL_CALLS,
	PARALLEL_TOOL_NAME,
	parseParallelCalls,
} from "../src/parallel.js";

test("parallel validates its complete batch before execution", () => {
	const parsed = parseParallelCalls({ calls: [{ name: "read" }, { name: "bash", arguments: { command: "pwd" } }] });
	assert.deepEqual(parsed, {
		ok: true,
		calls: [{ name: "read", arguments: {} }, { name: "bash", arguments: { command: "pwd" } }],
	});

	const invalid: unknown[] = [
		{},
		{ calls: [] },
		{ calls: [{ name: "read" }], extra: true },
		{ calls: Array.from({ length: MAX_PARALLEL_CALLS + 1 }, () => ({ name: "read" })) },
		{ calls: [null] },
		{ calls: [{ arguments: {} }] },
		{ calls: [{ name: "read", arguments: [] }] },
		{ calls: [{ name: PARALLEL_TOOL_NAME }] },
		{ calls: [{ name: "bridge_poll_result" }] },
	];
	for (const args of invalid) {
		const result = parseParallelCalls(args as Record<string, unknown>, ["bridge_poll_result"]);
		assert.equal(result.ok, false, JSON.stringify(args));
		if (!result.ok) assert.ok(result.error.length > 0);
	}
});

test("parallel formats ordered results, preserves failures, and appends referenced images", () => {
	const formatted = formatParallelResults(
		[
			{ callId: "batch:1", name: "read", arguments: { path: "a" } },
			{ callId: "batch:2", name: "read", arguments: { path: "b" } },
		],
		[
			{ content: [{ type: "text", text: "first" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
			{ content: [{ type: "text", text: "second failed" }], isError: true },
		],
	);
	assert.equal(formatted.isError, true);
	assert.deepEqual(formatted.images, [{ data: "aW1hZ2U=", mimeType: "image/png" }]);
	const payload = JSON.parse(formatted.text);
	assert.deepEqual(payload.results.map((result: { callId: string }) => result.callId), ["batch:1", "batch:2"]);
	assert.deepEqual(payload.results.map((result: { isError: boolean }) => result.isError), [false, true]);
	assert.deepEqual(payload.results[0].content[1], { type: "image", index: 1, mimeType: "image/png" });
	assert.equal(payload.results[1].content[0].text, "second failed");
});
