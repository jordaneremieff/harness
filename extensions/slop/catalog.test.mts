import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Detector, fenced, parseDetectors, parseEntry, type Scope } from "./catalog.ts";
import { checkLines, exampleFailures, segment } from "./detect.ts";
import { loadEntries, shippedCatalog } from "./store.ts";

const entrySource = `---
id: release-diary
title: Release diary
domain: "code"
applies: ["comment", "reply", "document"]
---

# Release diary

## Recognition

A diary label appears in place of the comment's purpose.

## Cost

The comment does not explain what the code requires.

## Repair

Name the rule that the code preserves. Remove the comment if there is no rule.
`;
function fixture(detector?: Detector) {
	return parseEntry(
		`${entrySource}${detector ? `\n## Detectors\n\n${fenced("json", JSON.stringify([detector]))}` : ""}`,
		"release-diary",
		"shipped",
	);
}
const scope: Scope[] = ["reply", "comment", "document"];
const detector: Detector = { id: "marker", in: scope, phrases: ["release diary"] };

// This loop also checks new entries when a checkout contains no earlier catalog files.
test("every shipped entry parses and its marked examples agree with its detectors", () => {
	for (const entry of loadEntries(shippedCatalog, "shipped")) assert.deepEqual(exampleFailures(entry), [], entry.id);
});

test("frontmatter and sections require a matching id and title", () => {
	assert.equal(fixture().prompt, false);
	assert.equal(parseEntry(entrySource, "release-diary", "local").prompt, true);
	assert.throws(() => parseEntry(entrySource, "another", "shipped"), /id must equal/);
	assert.throws(
		() => parseEntry(entrySource.replace("# Release diary", "# Different"), "release-diary", "shipped"),
		/heading/,
	);
	assert.throws(() => parseEntry(entrySource.replace("## Cost", "## Notes"), "release-diary", "shipped"), /Cost/);
	assert.throws(
		() => parseEntry(entrySource.replace('domain: "code"', 'domain: "other"'), "release-diary", "shipped"),
		/domain/,
	);
	assert.throws(() => parseEntry(`${entrySource}\n## Repair\n\na`, "release-diary", "shipped"), /Duplicate section/);
});

test("detector validation rejects invalid and contradictory fields", () => {
	assert.throws(() => parseDetectors([{ ...detector, match: "other" }], scope), /unknown field match/);
	assert.throws(() => parseDetectors([{ ...detector, in: ["commit"] }], scope), /scopes from applies/);
	assert.throws(() => parseDetectors([{ ...detector, pattern: "x" }], scope), /exactly one/);
	assert.throws(() => parseDetectors([{ id: "regex", in: scope, pattern: "(" }], scope), /invalid regular expression/);
	assert.throws(() => parseDetectors([{ ...detector, per: 12 }], scope), /per requires limit/);
	assert.throws(() => parseDetectors([detector, detector], scope), /unique/);
});

test("detector validation refuses repetitions whose matching time grows faster than the line", () => {
	for (const pattern of ["(a+)+", "(?:\\w+\\s?)+:", "(?<name>a*)*", "(?<=\\S+):", "(?<![a-z]{2,}):"])
		assert.throws(() => parseDetectors([{ id: "risky", in: scope, pattern }], scope), /Bound the repetition/, pattern);
	for (const pattern of [
		"\\p{L}+(?:-\\p{L}+){1,12}",
		"(?<=\\S{1,40}[ \\t]{1,8}):",
		"[(+)]+x",
		"\\(a+\\)+",
		"(?:ab){2,}",
		"(?<!-\\p{L})x+",
	])
		assert.doesNotThrow(() => parseDetectors([{ id: "bounded", in: scope, pattern }], scope), pattern);
});

test("examples use file segmentation and count matches before the allowance", () => {
	const entry = fixture({ ...detector, limit: 100, paths: ["src/**/*.ts"] });
	entry.examples = [
		{ kind: "ts", verdict: "slop", text: "// release diary" },
		{ kind: "ts", verdict: "better", text: 'const s = "// release diary";' },
		{ kind: "ts", verdict: "better", text: "// release diary" },
		{ kind: "ts", verdict: "slop", text: 'const s = "// release diary";' },
	];
	assert.deepEqual(exampleFailures(entry), [
		"Example 3 (better, ts): matched marker.",
		"Example 4 (slop, ts): no match from marker.",
	]);
});

test("Markdown skips non-prose without altering original line numbers", () => {
	const text = [
		"---",
		"title: release diary",
		"---",
		"> release diary",
		"```text",
		"release diary",
		"```",
		"`release diary` [visible](release diary) https://example.test/release-diary",
		"<!-- start",
		"release diary --> **RELEASE  diary**",
		"release `unrelated` diary",
		"### release diary",
		"A pre-release diary is still a phrase.",
		"norelease diaryword",
	].join("\n");
	const [found] = checkLines([fixture(detector)], segment({ kind: "reply", text }), new Set());
	assert.equal(found.count, 3);
	assert.deepEqual(
		found.locations.map((location) => location.line),
		[10, 12, 13],
	);
});

test("comment families keep strings out of comment scope", () => {
	const input = [
		{
			path: "doc.ts",
			text: 'const q = "// release diary"; /* release diary */ const r = `hi\n// release diary`; // release diary\n/**\n * release diary\n */',
			expected: [1, 2, 4],
		},
		{
			path: "doc.py",
			text: '#!/bin/release diary\ns = "# release diary"\ns = """\n# release diary\n"""\nvalue = 1 # release diary',
			expected: [6],
		},
		{
			path: "doc.html",
			text: '<a title="<!-- release diary -->">someone\'s text</a>\n<!-- release diary -->',
			expected: [2],
		},
	];
	for (const { path, text, expected } of input) {
		const [found] = checkLines([fixture(detector)], segment({ kind: "file", path, text }), new Set());
		assert.deepEqual(
			found.locations.map((location) => location.line),
			expected,
			path,
		);
	}
});

test("allowance, distinct, allow and lexicon apply only to the chosen scope and path", () => {
	const entry = fixture({
		id: "density",
		in: ["reply"],
		pattern: "hint[0-9]",
		limit: 2,
		per: 6,
		allow: ["Hint1"],
		lexicon: true,
		distinct: true,
	});
	const text = "hint1 hint2 hint3 HINT3 hint4 hint5 hint6 one two three four five";
	const [found] = checkLines([entry], segment({ kind: "reply", text }), new Set(["hint2"]));
	assert.equal(found?.count, undefined); // Four distinct matches fit the allowance for twelve words.
	const [next] = checkLines([entry], segment({ kind: "reply", text }), new Set());
	assert.equal(next.count, 5);
	assert.equal(next.allowance, 4);
	const constrained = fixture({ ...detector, paths: ["src/**/*.ts"] });
	for (const path of ["src/file.ts", "src/nested/file.ts"])
		assert.equal(
			checkLines([constrained], segment({ kind: "file", path, text: "// release diary" }), new Set()).length,
			1,
		);
	assert.equal(
		checkLines([constrained], segment({ kind: "file", path: "docs/file.ts", text: "// release diary" }), new Set())
			.length,
		0,
	);
	assert.equal(checkLines([constrained], segment({ kind: "reply", text: "release diary" }), new Set()).length, 0);
});

test("the catalog overview's Entries section lists exactly the shipped ids", () => {
	const ids = loadEntries(shippedCatalog, "shipped")
		.map((entry) => entry.id)
		.sort();
	const path = join(shippedCatalog, "README.md");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (!ids.length && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const body = /^## Entries\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1];
	assert.ok(body, "catalog overview must contain the Entries section");
	const listed = [...body.matchAll(/^- `([a-z0-9-]+)`:/gm)].map((match) => match[1]).sort();
	assert.deepEqual(listed, ids);
});

test("caseSensitive keeps letter case and modifier groups fail validation", () => {
	const entry = fixture({ id: "caseful", in: ["reply"], pattern: "\\p{Lu}atch", caseSensitive: true });
	const [finding] = checkLines([entry], segment({ kind: "reply", text: "Match match" }), new Set());
	assert.equal(finding.count, 1);
	assert.equal(finding.locations[0].match, "Match");
	for (const pattern of ["(?-i:a)", "x(?i-ms:y)"])
		assert.throws(() => parseDetectors([{ id: "modifiers", in: scope, pattern }], scope), /caseSensitive/);
	assert.doesNotThrow(() => parseDetectors([{ id: "literal", in: scope, pattern: "\\(\\?-i:literal\\)" }], scope));
});

test("the shipped compatibility detector recognises affixes in identifier case conventions", () => {
	const entry = loadEntries(shippedCatalog, "shipped").find((item) => item.id === "compatibility-shims");
	if (!entry) return;
	const identifiers = ["legacyFoo", "LegacyFoo", "LEGACY_FOO", "fooLegacy"];
	const [found] = checkLines(
		[entry],
		segment({ kind: "file", path: "file.ts", text: identifiers.join("\n") }),
		new Set(),
	);
	assert.deepEqual(
		found.locations.map((location) => location.match),
		identifiers,
	);
});
