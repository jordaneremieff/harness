import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSearchResults } from "./format.ts";
import type { BraveWebSearchResponse } from "./client.ts";

function response(overrides: Partial<BraveWebSearchResponse> = {}): BraveWebSearchResponse {
	return {
		originalQuery: "pi extensions",
		moreResultsAvailable: false,
		results: [],
		...overrides,
	};
}

describe("Brave Search result formatting", () => {
	it("renders ranked sources, correction context, excerpts, and pagination guidance", () => {
		const formatted = formatSearchResults(
			response({
				alteredQuery: "pi coding agent extensions",
				moreResultsAvailable: true,
				results: [
					{
						title: "Extensions",
						url: "https://example.com/extensions",
						description: "Current extension documentation.",
						age: "2026-07-26",
						extraSnippets: ["Tool registration", "Lifecycle"],
					},
				],
			}),
			{ query: "pi extnsions", count: 5, offset: 3, extra_snippets: true },
		);
		assert.match(formatted.text, /used corrected query "pi coding agent extensions"/);
		assert.match(formatted.text, /1\. Extensions/);
		assert.match(formatted.text, /URL: https:\/\/example\.com\/extensions/);
		assert.match(formatted.text, /Published: 2026-07-26/);
		assert.match(formatted.text, /Additional excerpts:[\s\S]*Tool registration/);
		assert.match(formatted.text, /offset 4/);
		assert.equal(formatted.outputTruncated, false);
	});

	it("makes remote terminal and bidi controls inert", () => {
		const formatted = formatSearchResults(
			response({
				results: [
					{
						title: "safe\u001b[31m title\u202e",
						url: "https://example.com/\u2066path",
						description: "line\u0007 two",
						extraSnippets: [],
					},
				],
			}),
			{ query: "safe" },
		);
		assert.doesNotMatch(formatted.text, /[\u001b\u0007\u202e\u2066]/);
		assert.match(formatted.text, /safe \[31m title/);
	});

	it("returns an explicit empty result", () => {
		const formatted = formatSearchResults(response(), { query: "nothing" });
		assert.match(formatted.text, /No web results found/);
	});

	it("keeps adversarially large multi-byte results below the Pi output limit", () => {
		const huge = "🙂".repeat(5000);
		const results = Array.from({ length: 20 }, (_, index) => ({
			title: `Result ${index} ${huge}`,
			url: `https://example.com/${index}`,
			description: huge,
			age: "today",
			extraSnippets: Array.from({ length: 5 }, () => huge),
		}));
		const formatted = formatSearchResults(
			response({ results, moreResultsAvailable: true }),
			{ query: "large", count: 20, extra_snippets: true },
		);
		assert.ok(Buffer.byteLength(formatted.text, "utf8") <= 50 * 1024);
		assert.equal(formatted.outputTruncated, true);
		assert.equal(formatted.fieldsShortened, true);
		assert.match(formatted.text, /Search output truncated|fields were shortened/);
	});
});
