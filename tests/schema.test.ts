import { test, expect } from "vitest";
import { normalizeSchema } from "../src/schema.js";

test("normalizes literal unions and disjoint unions without mutating input", () => {
	const schema = { type: "object", properties: {
		const: { type: "string" },
		notify: { description: "policy", anyOf: [{ type: "string", const: "wake" }, { type: "string", const: "silent" }] },
		refresh: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["all", "none"] }] },
		offset: { anyOf: [{ type: "integer" }, { type: "string" }] },
		from: { anyOf: [{ type: "string", const: "cursor" }, { type: "string", const: "start" }, { type: "number" }] },
		overlap: { anyOf: [{ type: "number" }, { type: "integer" }] },
	} };
	const original = structuredClone(schema);
	expect(normalizeSchema(schema)).toEqual({ type: "object", properties: {
		const: { type: "string" },
		notify: { description: "policy", type: "string", enum: ["wake", "silent"] },
		refresh: { oneOf: [{ type: "boolean" }, { type: "string", enum: ["all", "none"] }] },
		offset: { oneOf: [{ type: "integer" }, { type: "string" }] },
		from: { oneOf: [{ type: "string", enum: ["cursor", "start"] }, { type: "number" }] },
		overlap: { anyOf: [{ type: "number" }, { type: "integer" }] },
	} });
	expect(schema).toEqual(original);
});
