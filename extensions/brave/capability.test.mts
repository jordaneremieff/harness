import assert from "node:assert/strict";
import { test } from "node:test";
import { runWebSearch } from "./capability.ts";

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
