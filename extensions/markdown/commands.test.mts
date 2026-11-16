import assert from "node:assert/strict";
import { test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { markdownCompletions, markdownHelp } from "./commands.ts";

test("every option has individual help in the supported completion description field", () => {
	const items = markdownCompletions("");
	assert.ok(items);
	assert.deepEqual(items.map((item) => item.value.trim()), ["new", "recent", "published", "edit", "copy", "file", "window", "help"]);
	assert.equal(new Set(items.map((item) => item.description)).size, items.length);
	for (const item of items) assert.ok(item.description && item.description.length > 20);
	assert.deepEqual(markdownCompletions("pub")?.map((item) => item.value), ["published"]);
	assert.equal(markdownCompletions("unknown"), null);
});

test("file and ID usage preserve the complete typed argument", () => {
	for (const prefix of ["file ", 'file "notes and diagrams.md"', "md-012345", 'window file "a b.md"', "window md-012345", "edit md-012345", 'edit file "a b.md"', "copy md-012345", "window copy md-012345"]) {
		const item = markdownCompletions(prefix)?.[0];
		assert.ok(item);
		assert.equal(item.value, prefix);
		assert.ok(item.description);
	}
	assert.match(markdownHelp("file"), /session directory; expand a leading ~/u);
	assert.match(markdownHelp("id"), /unique prefix needs at least six characters/u);
	assert.throws(() => markdownHelp("missing"), /help new \| recent/u);
});

test("Pi applies only the completion value and retains its individual description", async () => {
	const provider = new CombinedAutocompleteProvider([{ name: "markdown", getArgumentCompletions: markdownCompletions }], process.cwd());
	const suggestions = await provider.getSuggestions(["/markdown help f"], 0, 16, { signal: new AbortController().signal });
	assert.ok(suggestions);
	assert.equal(suggestions.prefix, "help f");
	assert.equal(suggestions.items[0].value, "help file");
	assert.match(suggestions.items[0].description ?? "", /UTF-8/u);
	const result = provider.applyCompletion(["/markdown help f"], 0, 16, suggestions.items[0], suggestions.prefix);
	assert.deepEqual(result.lines, ["/markdown help file"]);
});
