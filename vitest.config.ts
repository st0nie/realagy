import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Auth-heavy suites require no module/state leakage across files.
		isolate: true,
		include: ["tests/**/*.test.ts"],
	},
});
