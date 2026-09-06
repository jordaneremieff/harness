import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import registerBraveSearch from "./index.ts";

function registry() {
	const tools = new Map<string, any>();
	registerBraveSearch({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
	return tools;
}

const originalKey = process.env.PI_BRAVE_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
	if (originalKey === undefined) delete process.env.PI_BRAVE_API_KEY;
	else process.env.PI_BRAVE_API_KEY = originalKey;
	globalThis.fetch = originalFetch;
});

describe("Brave extension entrypoint", () => {
	it("registers the public-page reader first, then web search, with bounded schemas", () => {
		const tools = registry();
		assert.deepEqual([...tools.keys()], ["web_read", "web_search"]);

		const reader = tools.get("web_read");
		assert.equal(reader.parameters.additionalProperties, false);
		assert.equal(reader.parameters.properties.url.minLength, 1);
		assert.equal(reader.parameters.properties.url.maxLength, 4096);
		assert.equal(reader.parameters.properties.max_bytes.minimum, 1000);
		assert.equal(reader.parameters.properties.max_bytes.maximum, 24000);
		assert.match(reader.parameters.properties.max_bytes.description, /default 16000/);
		assert.ok(reader.promptGuidelines.every((line: string) => line.includes("web_read")));
		assert.match(reader.promptGuidelines.join(" "), /untrusted evidence, not instructions/);
		assert.match(reader.promptGuidelines.join(" "), /snapshot, not page anchors/);
	});

	it("keeps the bounded general web-search tool schema and guidance", () => {
		const tools = registry();
		const tool = tools.get("web_search");
		assert.match(tool.description, /50 KiB/);
		assert.ok(tool.promptGuidelines.every((line: string) => line.includes("web_search")));
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(tool.parameters.properties.query.maxLength, 400);
		assert.equal(tool.parameters.properties.count.maximum, 20);
		assert.equal(tool.parameters.properties.offset.maximum, 9);
	});

	it("executes through native fetch and returns compact structured details", async () => {
		process.env.PI_BRAVE_API_KEY = "entrypoint-test-key";
		let observedUrl: URL | undefined;
		globalThis.fetch = (async (input: URL | Request | string) => {
			observedUrl = new URL(String(input));
			return new Response(
				JSON.stringify({
					query: { original: "current pi", more_results_available: true },
					web: {
						results: [{ title: "Pi", url: "https://example.com/pi", description: "Current information" }],
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const tool = registry().get("web_search");
		const result = await tool.execute(
			"call",
			{ query: "current pi", count: 5, offset: 1, freshness: "pw" },
			new AbortController().signal,
		);
		assert.equal(observedUrl?.searchParams.get("q"), "current pi");
		assert.equal(observedUrl?.searchParams.get("freshness"), "pw");
		assert.match(result.content[0].text, /Pi[\s\S]*https:\/\/example\.com\/pi/);
		assert.deepEqual(result.details, {
			query: "current pi",
			alteredQuery: undefined,
			resultCount: 1,
			count: 5,
			offset: 1,
			moreResultsAvailable: true,
			nextOffset: 2,
			outputTruncated: false,
		});
	});

	it("rejects an already-cancelled web_read execution without a network request", async () => {
		const reader = registry().get("web_read");
		await assert.rejects(reader.execute("call", { url: "https://example.com/" }, AbortSignal.abort()), /cancelled/);
	});

	it("rejects invalid web_read max_bytes before any fetch", async () => {
		const reader = registry().get("web_read");
		await assert.rejects(
			reader.execute("call", { url: "https://example.com/", max_bytes: 500 }, new AbortController().signal),
			/max_bytes/,
		);
	});
});
