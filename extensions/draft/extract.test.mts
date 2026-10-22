// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { columnOf, extract, kindForPath, lineOf, normalizeText } from "./scripts/extract.mts";

const prose = (text: string, kind: "md" | "html" | "text" | "ts" | "js" | "commit" = "md"): string => extract(text, kind).prose;

test("fenced code is blank in every view and counted", () => {
	const ex = extract("Before.\n\n```js\nconst a = 1;\n```\n\nAfter.\n", "md");
	assert.ok(!ex.prose.includes("const"));
	assert.ok(!ex.raw.includes("const"));
	assert.equal(ex.fenceCount, 1);
	assert.equal(ex.lines[3]?.kind, "code");
});

test("tilde fences and longer fences follow the closing-length rule", () => {
	const ex = extract("````\n```\ninside\n````\nout\n", "md");
	assert.ok(!ex.prose.includes("inside"));
	assert.ok(ex.prose.includes("out"));
	const tilde = extract("~~~\nhidden\n~~~\nshown\n", "md");
	assert.ok(!tilde.prose.includes("hidden"));
	assert.ok(tilde.prose.includes("shown"));
});

test("an unclosed fence runs to the end of the text", () => {
	const ex = extract("Intro text.\n\n```\nnever closed\nstill code\n", "md");
	assert.ok(!ex.prose.includes("never closed"));
	assert.ok(!ex.prose.includes("still code"));
	assert.ok(ex.prose.includes("Intro"));
});

test("indented code is blank, list continuation is not", () => {
	const ex = extract("Para.\n\n    code line\n\n- item\n\n    continued item text\n", "md");
	assert.ok(!ex.prose.includes("code line"));
	assert.ok(ex.prose.includes("continued item text"));
});

test("front matter and html comments are skipped", () => {
	const ex = extract("---\ntitle: x\n---\nBody text.\n<!-- hidden\nmore -->\nTail.\n", "md");
	assert.ok(!ex.prose.includes("title"));
	assert.ok(!ex.prose.includes("hidden"));
	assert.ok(ex.prose.includes("Body text."));
	assert.ok(ex.prose.includes("Tail."));
});

test("inline code is blank in prose and kept in literal", () => {
	const ex = extract("Run `npm test` now.", "md");
	assert.ok(!ex.prose.includes("npm"));
	assert.ok(ex.literal.includes("npm test"));
	assert.equal(ex.inlineCodeCount, 1);
});

test("link targets are removed and anchors stay", () => {
	const ex = extract("See [the guide](https://example.org/a/b?c=d (x)) now, and ![alt text](img.png).", "md");
	assert.ok(ex.prose.includes("the guide"));
	assert.ok(ex.prose.includes("alt text"));
	assert.ok(!ex.prose.includes("example.org"));
	assert.ok(!ex.prose.includes("img.png"));
	assert.equal(ex.links.length, 0);
});

test("reference links keep their text and drop the reference", () => {
	const ex = extract("A [named link][ref] here.\n\n[ref]: https://example.org/x\n", "md");
	assert.ok(ex.prose.includes("named link"));
	assert.ok(!ex.prose.includes("ref]"));
	assert.equal(ex.links.length, 0);
});

test("autolinks, bare urls and url anchors are recorded and blanked", () => {
	const ex = extract("<https://a.example/x> and https://b.example/y. [https://c.example](https://c.example)", "md");
	assert.deepEqual(
		ex.links.map((link) => link.kind),
		["autolink", "bare", "url-anchor"],
	);
	assert.ok(!ex.prose.includes("example"));
});

test("a bare url drops trailing punctuation and unmatched brackets", () => {
	const ex = extract("(see https://example.org/page).", "md");
	assert.equal(ex.links[0]?.text, "https://example.org/page");
});

test("entities and tags do not reach prose", () => {
	const ex = extract("A &amp; B <em>x</em> done&nbsp;now.", "md");
	assert.ok(!ex.prose.includes("&amp;"));
	assert.ok(!ex.prose.includes("<em>"));
});

test("heading, list and table markers are blank and each starts a unit", () => {
	const ex = extract("# Heading\n\n- one\n- two\n\n| a | b |\n|---|---|\n| c | d |\n", "md");
	const kinds = ex.units.map((unit) => unit.kind);
	assert.deepEqual(kinds, ["heading", "list", "list", "table", "table"]);
	assert.ok(!ex.prose.includes("#"));
	assert.ok(!ex.prose.includes("---"));
});

test("soft-wrapped paragraph lines join into one unit", () => {
	const ex = extract("first line\nsecond line\n\nnew paragraph\n", "md");
	assert.equal(ex.units.length, 2);
	assert.equal(ex.units[0]?.text, "first line second line");
});

test("offsets stay aligned with the source", () => {
	const source = "Intro.\n\n- **Label:** text with `code` and [anchor](http://x.example/y) end.\n";
	const ex = extract(source, "md");
	assert.equal(ex.prose.length, source.length);
	assert.equal(ex.literal.length, source.length);
	const at = source.indexOf("anchor");
	assert.equal(ex.prose.slice(at, at + 6), "anchor");
	assert.equal(lineOf(ex.lineStarts, at), 3);
	assert.equal(columnOf(ex.lineStarts, at), source.split("\n")[2]?.indexOf("anchor") === undefined ? 0 : (source.split("\n")[2] ?? "").indexOf("anchor") + 1);
});

test("html input drops tags, scripts, styles and comments", () => {
	const html = "<html><style>p{color:red}</style><body><!-- note --><p>First para.</p><p>Second para &amp; more.</p><script>var a = 1;</script></body></html>";
	const ex = extract(html, "html");
	assert.ok(ex.prose.includes("First para."));
	assert.ok(!ex.prose.includes("color"));
	assert.ok(!ex.prose.includes("var a"));
	assert.ok(!ex.prose.includes("note"));
	assert.ok(ex.units.length >= 2);
	assert.ok(ex.raw.includes("<p>"));
});

test("plain text kind keeps markdown-looking characters", () => {
	const ex = extract("# not a heading\n\nplain `tick` text", "text");
	assert.ok(ex.prose.includes("# not a heading"));
	assert.ok(!ex.prose.includes("tick"));
});

test("a source file with code but no comments yields no prose", () => {
	const ex = extract("const label = '# not prose';\nconst n = 1;\n", "ts");
	assert.equal(ex.units.length, 0);
});

test("pragma and shebang comments are skipped", () => {
	const ex = extract("#!/usr/bin/env node\n// biome-ignore lint: reason\n// real comment\n", "ts");
	assert.ok(!ex.prose.includes("biome"));
	assert.ok(ex.prose.includes("real comment"));
});

test("jsdoc tags and example blocks are not prose", () => {
	const ex = extract("/**\n * Adds numbers.\n * @param {number} a the first value\n * @example\n * add(1, 2);\n */\n", "ts");
	assert.ok(ex.prose.includes("Adds numbers."));
	assert.ok(ex.prose.includes("the first value"));
	assert.ok(!ex.prose.includes("add(1"));
	assert.ok(!ex.prose.includes("@param"));
});

test("normalizeText strips the byte order mark and unifies line endings", () => {
	assert.equal(normalizeText("\uFEFFa\r\nb\rc"), "a\nb\nc");
});

test("kindForPath maps extensions and skips unknown files", () => {
	assert.equal(kindForPath("docs/readme.md"), "md");
	assert.equal(kindForPath("a/b/page.HTML"), "html");
	assert.equal(kindForPath("src/index.mts"), "ts");
	assert.equal(kindForPath("src/main.js"), "js");
	assert.equal(kindForPath("data.json"), null);
	assert.equal(kindForPath(".git/COMMIT_EDITMSG"), "commit");
});

test("prose helper keeps newlines", () => {
	assert.equal(prose("a\nb").split("\n").length, 2);
});
