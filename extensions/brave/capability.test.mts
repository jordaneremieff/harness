import assert from "node:assert/strict";
import { test } from "node:test";
import { runWebSearch, SEARCH_DISPLAY_LIMITS } from "./capability.ts";

test("web search returns model-visible text without bidi controls in remote titles and snippets", async () => {
	const marked = "alpha\u061cbeta\u200egamma\u200fdelta";
	const result = await runWebSearch({ query: "search" }, undefined, {
		apiKey: "test-key",
		fetch: async () =>
			new Response(
				JSON.stringify({
					query: { original: "search" },
					web: {
						results: [{ title: marked, url: "https://example.com/", description: marked }],
					},
				}),
				{ status: 200 },
			),
	});
	assert.equal(result.details.resultCount, 1);
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].type, "text");
	assert.doesNotMatch(result.content[0].text, /\p{Bidi_Control}/u);
	assert.match(result.content[0].text, /1\. alpha beta gamma delta/);
	assert.match(result.content[0].text, /Snippet: alpha beta gamma delta/);
});

test("web search details carry a bounded ranked title and domain projection", async () => {
	const trailingPair = "\ud83e\udd16"; // one emoji; the clip must never split it
	const result = await runWebSearch({ query: "q", count: 2, offset: 2 }, undefined, {
		apiKey: "test-key",
		fetch: async () =>
			new Response(
				JSON.stringify({
					query: { original: "q" },
					web: {
						results: [
							{ title: "  Clean\t Title ", url: "https://alpha.example.com/a" },
							{ title: `bad\u202e${"x".repeat(116)}${trailingPair}`, url: "https://beta.example.org/b" },
							{ title: "Third", url: "https://third.dev/" },
							{ title: "Fourth", url: "https://fourth.dev/" },
							{ title: "Fifth", url: "https://fifth.dev/" },
						],
					},
				}),
				{ status: 200 },
			),
	});
	const { sources, resultCount } = result.details;
	assert.equal(resultCount, 5);
	assert.ok(Array.isArray(sources));
	assert.equal(sources.length, SEARCH_DISPLAY_LIMITS.sources);
	assert.deepEqual(
		sources.map((source: { rank: number }) => source.rank),
		[5, 6, 7],
	);
	assert.equal(sources[0].title, "Clean Title");
	assert.equal(sources[0].domain, "alpha.example.com");
	assert.equal(sources[1].domain, "beta.example.org");
	assert.ok(sources[1].title.length <= SEARCH_DISPLAY_LIMITS.title);
	assert.doesNotMatch(sources[1].title, /\p{Bidi_Control}|\p{Cc}|\p{Cf}/u);
	assert.doesNotMatch(sources[1].title, /[\uD800-\uDBFF]$/u);
	assert.equal(sources[2].domain, "third.dev");
	assert.deepEqual(JSON.parse(JSON.stringify(result.details.sources)), result.details.sources);
});
