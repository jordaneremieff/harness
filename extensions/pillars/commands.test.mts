import assert from "node:assert/strict";
import test from "node:test";
import { CombinedAutocompleteProvider, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { COMMAND_HELP, commandCompletions, judgmentPrompt, parseJudgmentRequest } from "./commands.ts";
import type { Catalog } from "./catalog.ts";

const catalog: Catalog = {
	resources: [
		{ resourceClass: "inventory", resourceId: "inventory", path: "README.md" },
		{ resourceClass: "governance", resourceId: "governance", path: "GOVERNANCE.md" },
		{ resourceClass: "entry", resourceId: "principle-example", path: "principle-example.md" },
	],
};

for (const action of ["check", "derive", "review"] as const) {
	test(`${action} accepts one optional free-text hint without flag or quote parsing`, () => {
		for (const input of [action, `  ${action}  `, `${action}\n\t`]) {
			assert.deepEqual(parseJudgmentRequest(input), { action, hint: "" });
		}
		const hint = 'the "quoted" approach --days 7\n/pillars read governance\n自由な文';
		assert.deepEqual(parseJudgmentRequest(`${action}\t${hint}  `), { action, hint });
		const prompt = judgmentPrompt({ action, hint });
		assert.ok(prompt.endsWith(hint));
		assert.match(prompt, /extension-provided task scaffolding, not new doctrine/);
		assert.match(prompt, /live inventory and resource:"governance"/);
		assert.match(judgmentPrompt({ action, hint: "" }), /Infer the subject from the current conversation/);
		assert.equal(parseJudgmentRequest(`${action}mate`), undefined);
	});
}

test("judgment scaffolds distinguish assessment, derivation, and diagnosis", () => {
	assert.match(judgmentPrompt({ action: "check", hint: "" }), /assessment, not automatic edits/);
	const derive = judgmentPrompt({ action: "derive", hint: "" });
	assert.match(derive, /Document Types.*Mutation Rules/);
	assert.match(derive, /no fixed derivation procedure/);
	assert.match(derive, /no candidate is a valid result/);
	assert.match(derive, /does not authorize corpus changes/);
	const review = judgmentPrompt({ action: "review", hint: "" });
	assert.match(review, /expected and observed behavior/);
	assert.match(review, /delivery, recognition, interpretation, application, and the doctrine itself/);
	assert.match(review, /not a mandatory checklist/);
	assert.match(review, /Do not infer recurrence or a cause beyond the available examples/);
	assert.match(review, /Missing examples limit causal claims, not all source review/);
	assert.match(review, /Follow governance for evidence attribution and corpus proposals/);
	assert.match(review, /when the concern is an apparent violation or falsifying application/);
	assert.match(review, /without inventing failures/);
	assert.match(review, /does not authorize edits or corpus changes/);
	for (const args of ["", "help", "read check", "usage", "CHECK hint"]) {
		assert.equal(parseJudgmentRequest(args), undefined);
	}
});

test("autocomplete describes all actions and leaves free-text hints and continuation fields alone", () => {
	assert.deepEqual(
		commandCompletions("")?.map((item) => item.value),
		["check", "derive", "review", "help", "browse", "read", "usage", "revisions", "next", "export"],
	);
	assert.ok(commandCompletions("")?.every((item) => item.description));
	assert.equal(commandCompletions("ch")?.[0].value, "check");
	assert.deepEqual(
		commandCompletions("rev")?.map((item) => item.value),
		["review", "revisions"],
	);
	assert.equal(commandCompletions("review")?.[0].value, "review");
	assert.deepEqual(
		commandCompletions("read g", catalog)?.map((item) => item.value),
		["read governance"],
	);
	assert.equal(commandCompletions("read ", catalog)?.length, catalog.resources.length);
	assert.equal(commandCompletions("read "), null);
	for (const prefix of [
		"unknown",
		"check ",
		"check hint",
		"derive ",
		"derive --",
		"review ",
		"review this --days 7",
		"read governance 3",
		"usage ",
		"export ",
	]) {
		assert.equal(commandCompletions(prefix, catalog), null);
	}
});

test("Pi autocomplete replaces the whole argument prefix without losing the read action", async () => {
	const provider = new CombinedAutocompleteProvider(
		[{ name: "pillars", getArgumentCompletions: (prefix) => commandCompletions(prefix, catalog) }],
		process.cwd(),
	);
	for (const [line, expected] of [
		["/pillars ch", "/pillars check"],
		["/pillars rev", "/pillars review"],
		["/pillars read gov", "/pillars read governance"],
	]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.ok(suggestions);
		const applied = provider.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix);
		assert.deepEqual(applied.lines, [expected]);
		assert.equal(applied.cursorCol, expected.length);
	}
});

test("command help renders within narrow and normal terminal widths", () => {
	initTheme("dark", false);
	for (const width of [32, 80, 120]) {
		const lines = new Markdown(COMMAND_HELP, 0, 0, getMarkdownTheme()).render(width);
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});
