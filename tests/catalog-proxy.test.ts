import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import { CatalogProxy, extractCatalogModelLimits, isModelCatalogPath, rewriteModelCatalog } from "../src/acp/catalog-proxy.js";

function fixture() {
	return {
		models: {
			"gpt-oss-120b-medium": {
				maxTokens: 131_072,
				maxOutputTokens: 32_768,
				modelExperiments: {
					experiments: {
						CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
							stringValue: JSON.stringify({ enabled: true, max_token_limit: "80000", token_threshold: "50000" }),
						},
						unrelated: { stringValue: JSON.stringify({ enabled: true }) },
					},
				},
			},
			plain: { maxTokens: 42 },
		},
	};
}

test("catalog rewrite disables checkpointing and defeats both local clamps", () => {
	const payload = fixture();
	assert.deepEqual(extractCatalogModelLimits(payload).get("gpt-oss-120b-medium"), {
		contextWindow: 131_072,
		maxTokens: 32_768,
	});
	assert.equal(rewriteModelCatalog(payload), 1);
	const model = payload.models["gpt-oss-120b-medium"];
	assert.equal(model.maxTokens, 1_000_000_000);
	assert.equal(model.maxOutputTokens, 32_768);
	const experiments = model.modelExperiments.experiments;
	const config = JSON.parse(experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue);
	assert.deepEqual(config, { enabled: false, max_token_limit: "2147483647", token_threshold: "50000" });
	assert.equal(experiments.unrelated.stringValue, JSON.stringify({ enabled: true }));
	assert.equal(payload.models.plain.maxTokens, 42);
	assert.equal(rewriteModelCatalog(payload), 0);
});

test("catalog rewrite handles suffixed, response-wrapped, and malformed values", () => {
	const payload = {
		response: {
			models: {
				claude: {
					max_tokens: 1_000_000,
					modelExperiments: {
						experiments: {
							"CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k": { enabled: true, max_token_limit: "840000" },
							CASCADE_USE_EXPERIMENT_CHECKPOINTER: { stringValue: "not json" },
						},
					},
				},
			},
		},
	};
	assert.equal(rewriteModelCatalog(payload), 1);
	const experiments = payload.response.models.claude.modelExperiments.experiments;
	assert.deepEqual(experiments["CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k"], {
		enabled: false,
		max_token_limit: "2147483647",
	});
	assert.equal(experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue, "not json");
	assert.equal(payload.response.models.claude.max_tokens, 1_000_000_000);
	assert.equal(isModelCatalogPath("/v1internal:fetchAvailableModels?alt=json"), true);
	assert.equal(isModelCatalogPath("/v1internal:streamGenerateContent?alt=sse"), false);
});

test("loopback proxy rewrites gzip catalogs and streams other RPCs unchanged", async () => {
	let authorization: string | undefined;
	let requestBody = "";
	const catalog = Buffer.from(JSON.stringify(fixture()));
	const upstream = http.createServer((req, res) => {
		authorization = req.headers.authorization;
		req.setEncoding("utf8");
		req.on("data", (chunk) => (requestBody += chunk));
		req.on("end", () => {
			if (req.url === "/v1internal:fetchAvailableModels") {
				const body = gzipSync(catalog);
				res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": body.length });
				res.end(body);
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: first\n\n");
			setTimeout(() => res.end("data: second\n\n"), 5);
		});
	});
	await listen(upstream);
	const proxy = new CatalogProxy({
		upstream: `http://127.0.0.1:${port(upstream)}`,
		env: {},
		log: () => {},
	});
	try {
		const endpoint = await proxy.start();
		const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers: { authorization: "Bearer test", "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.models["gpt-oss-120b-medium"].maxTokens, 1_000_000_000);
		assert.deepEqual(proxy.modelLimits("gpt-oss-120b-medium"), {
			contextWindow: 131_072,
			maxTokens: 32_768,
		});
		assert.equal(authorization, "Bearer test");
		assert.equal(requestBody, "{}");

		const streamed = await postChunked(`${endpoint}/v1internal:streamGenerateContent?alt=sse`);
		assert.equal(streamed.status, 200);
		assert.equal(streamed.body, "data: first\n\ndata: second\n\n");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

function postChunked(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = http.request(url, { method: "POST", headers: { "transfer-encoding": "chunked" } }, (response) => {
			response.setEncoding("utf8");
			let body = "";
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", reject);
		request.write("pro");
		request.end("mpt");
	});
}

function port(server: Server): number {
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("server not listening");
	return address.port;
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}
