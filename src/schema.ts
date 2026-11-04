/** Normalize equivalent JSON Schema constructs that ACP's downstream Claude
 * transport otherwise rejects. Never mutate pi's original tool definition. */
export function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
	function visit(value: unknown): Record<string, unknown> | string | number | boolean | null | undefined | unknown[] {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value as string | number | boolean | null | undefined | unknown[];
		const source = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(source)) {
			if (key === "const" && !("enum" in source)) result.enum = [entry];
			else if (key === "const") result.const = entry;
			else if (["properties", "patternProperties", "$defs", "definitions"].includes(key) && entry && typeof entry === "object" && !Array.isArray(entry)) {
				result[key] = Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, visit(child)]));
			} else if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key) && Array.isArray(entry)) {
				result[key] = entry.map(visit);
			} else if (["items", "additionalProperties", "not", "if", "then", "else", "contains"].includes(key)) {
				result[key] = visit(entry);
			} else result[key] = entry;
		}
		const branches = source.anyOf;
		if (!("type" in source) && !("enum" in source) && Array.isArray(branches) && branches.length > 0 && branches.every((item) =>
			item && typeof item === "object" && !Array.isArray(item) && typeof item.const === "string" && Object.keys(item).every((key) => key === "type" || key === "const") && (item.type === undefined || item.type === "string"),
		)) {
			delete result.anyOf;
			result.type = "string";
			result.enum = branches.map((item) => item.const);
		} else if (Array.isArray(branches) && branches.length > 0) {
			// Merge simple string literals first (e.g. cursor | start | number).
			const literals = branches.filter((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.const === "string" && Object.keys(item).every((key) => key === "type" || key === "const") && (item.type === undefined || item.type === "string"));
			const rest = branches.filter((item) => !literals.includes(item));
			const merged = literals.length ? [{ type: "string", enum: literals.map((item) => item.const) }, ...rest.map(visit)] : branches.map(visit);
			// Distinct primitive types cannot overlap, so oneOf is equivalent.
			const types = merged.map((branch) => branch && typeof branch === "object" && !Array.isArray(branch) ? branch.type : undefined);
			const disjoint = types.every((type) => typeof type === "string" && ["string", "boolean", "object", "array", "null", "number", "integer"].includes(type))
				&& new Set(types).size === types.length && !(types.includes("number") && types.includes("integer"));
			if (disjoint && !("oneOf" in source)) {
				result.oneOf = merged;
				delete result.anyOf;
			}
		}
		return result;
	}
	return visit(schema) as Record<string, unknown>;
}
