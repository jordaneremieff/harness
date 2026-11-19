import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const reader = {} as ReaderCoreAPI;
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./highlight.ts", import.meta.url), "utf8")), { reader });
const syntax = reader.syntax;
// Values from the highlighter's own realm are copied into this one before strict comparison.
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const kinds = (text: string, language: string) =>
	plain(
		syntax
			.tokens(text, language)
			.filter((token) => token.kind)
			.map((token) => `${token.kind}:${token.text}`),
	);
const has = (text: string, language: string, expected: string[]) => {
	const found = kinds(text, language);
	for (const item of expected) assert.ok(found.includes(item), `${language}: ${item} in ${found.join(" ")}`);
};
// A literal dollar and brace, as code contains them.
const at = (name: string) => `$${"{"}${name}}`;

const samples: [string, string][] = [
	[
		"ts",
		`export async function show(id: string): Promise<Pane> {\n\t// open it\n\treturn open(\`pane ${at("id")}\`, 42, true);\n}\n`,
	],
	[
		"swift",
		'let paper = NSColor(srgbRed: 36 / 255, green: 0x27, blue: 0.5, alpha: 1) // base\nguard let x else { return nil }\n"""\nmulti \\(x)\n"""',
	],
	["json", '{ "kind": "published", "revision": 2, "open": null, "items": ["a\\"b"] }'],
	["bash", `export PI_MARKDOWN_APP="$HOME/app" # build\nif [ -n "${at("X")}" ]; then node build.mts --verify; fi`],
	["python", 'def run(self, path: str) -> None:\n    """Doc."""\n    return f"{path}" if True else None  # done'],
	["diff", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same"],
	["html", "<a href=\"https://x.test\" class='y'>link &amp; more</a><!-- note -->"],
	["yaml", "title: Reader\ncount: 3\nok: true\n- name: x # c"],
	["css", "@media (width < 860px) { .outline { margin-top: var(--bar-h); color: #24273a; } }"],
	["sql", "SELECT name FROM docs WHERE id = 'a''b' -- one\n"],
	["md", "# Title\n\n- See `code` and [a link](https://x.test)."],
	[
		"js",
		"const re = /a\\/b+/gi; const half = a / b;\nitems.map((x, i) => x * 2).filter(y => y);\nthis.root = console.log;",
	],
	["rust", 'fn main() { println!("{}", self.len()); }'],
	["unknown", "nothing to colour 42"],
];

test("tokens join to the exact code text for every language", () => {
	for (const [language, text] of samples)
		assert.equal(
			syntax
				.tokens(text, language)
				.map((token) => token.text)
				.join(""),
			text,
			language,
		);
});

test("definitions, parameters, members and builtins take their own colours", () => {
	has(samples[0][1], "typescript", [
		"k:export",
		"k:async",
		"k:function",
		"f:show",
		"r:id",
		"t:string",
		"t:Promise",
		"t:Pane",
		"c:// open it",
		"k:return",
		"f:open",
		"n:42",
		"n:true",
		"d:(",
		"o::",
	]);
	has(samples[4][1], "py", ["k:def", "f:run", "b:self", "r:path", "t:str", "o:->", "n:None", "n:True", "c:# done"]);
	has(samples[11][1], "javascript", [
		"e:/a\\/b+/gi",
		"o:/",
		"f:map",
		"r:x",
		"r:i",
		"f:filter",
		"r:y",
		"b:this",
		"m:root",
		"b:console",
		"m:log",
	]);
	has(samples[1][1], "swift", ["t:NSColor", "n:0x27", "n:0.5", "c:// base", "k:guard", "n:nil"]);
	has("split(direction: .horizontal, view.frame)", "swift", ["ev:horizontal", "m:frame"]);
	has(samples[12][1], "rs", ["k:fn", "f:main", "x:println", "b:self", "f:len"]);
});

test("strings show escapes and interpolated code", () => {
	has(samples[0][1], "ts", ["s:`pane ", `e:${"$"}{`, "e:}", "s:`"]);
	has(samples[4][1], "python", ['s:f"', "e:{", "e:}"]);
	has(samples[1][1], "swift", ["e:\\(", "e:)"]);
	has(samples[2][1], "json", ['p:"kind"', 's:"published"', "n:2", "n:null", 's:"a', 'e:\\"', 's:b"']);
	has(samples[3][1], "sh", [
		"k:export",
		"v:PI_MARKDOWN_APP",
		"v:$HOME",
		"c:# build",
		"k:if",
		"r:-n",
		`v:${at("X")}`,
		"k:then",
		"f:node",
		"r:--verify",
		"k:fi",
	]);
});

test("markup, data and diff languages use their own scanners", () => {
	assert.deepEqual(kinds(samples[5][1], "patch"), [
		"meta:diff --git a/x b/x",
		"meta:--- a/x",
		"meta:+++ b/x",
		"meta:@@ -1 +1 @@",
		"del:-old",
		"ins:+new",
	]);
	assert.deepEqual(kinds(samples[6][1], "html"), [
		"d:<",
		"f:a",
		"t:href",
		"o:=",
		's:"https://x.test"',
		"t:class",
		"o:=",
		"s:'y'",
		"d:>",
		"e:&amp;",
		"d:</",
		"f:a",
		"d:>",
		"c:<!-- note -->",
	]);
	assert.deepEqual(kinds(samples[7][1], "yml"), [
		"p:title",
		"s:Reader",
		"p:count",
		"n:3",
		"p:ok",
		"n:true",
		"d:-",
		"p:name",
		"s:x",
		"c:# c",
	]);
	has(samples[8][1], "css", [
		"k:@media",
		"n:860px",
		"t:.outline",
		"p:margin-top",
		"f:var",
		"v:--bar-h",
		"p:color",
		"n:#24273a",
	]);
	has(samples[9][1], "sql", ["k:SELECT", "k:FROM", "k:WHERE", "s:'a''b'", "c:-- one"]);
	assert.deepEqual(kinds(samples[10][1], "markdown"), ["k:# Title", "d:- ", "s:`code`", "f:[a link](https://x.test)"]);
	assert.deepEqual(
		plain(syntax.tokens(samples[13][1], "unknown")),
		[{ text: samples[13][1] }],
		"an unknown language stays plain",
	);
	assert.equal(syntax.supports("Front matter"), true);
	assert.equal(syntax.supports("code"), false);
	assert.equal(syntax.detect('{ "a": [1, 2] }'), "json");
	assert.equal(syntax.detect("$ ls -la\ntotal 0"), "shell");
	assert.equal(syntax.detect("Plain words."), "");
});

test("each language label has one canonical syntax, and every choice colours as its labels do", () => {
	const expected: [string, string][] = [
		["ts", "js"],
		["tsx", "js"],
		["javascript", "js"],
		["md", "markdown"],
		["Markdown", "markdown"],
		["html", "markup"],
		["svg", "markup"],
		["yml", "yaml"],
		["toml", "yaml"],
		["front matter", "yaml"],
		["sh", "shell"],
		["console", "shell"],
		["py", "python"],
		["rs", "rust"],
		["cpp", "clike"],
		["java", "clike"],
		["jsonc", "json"],
		["patch", "diff"],
		["scss", "css"],
		["golang", "go"],
		["markup", "markup"],
		["text", ""],
		["code", ""],
		["constructor", ""],
		["__proto__", ""],
		["toString", ""],
	];
	for (const [label, key] of expected) assert.equal(syntax.canonical(label), key, label);
	const ids = plain(syntax.choices.map((choice) => choice.id));
	assert.equal(new Set(ids).size, ids.length, "one choice for each syntax");
	for (const id of ids) assert.equal(syntax.canonical(id), id, `${id} is its own canonical key`);
	const labels = plain(syntax.choices.map((choice) => choice.label));
	assert.deepEqual(
		labels,
		[...labels].sort((a, b) => a.localeCompare(b)),
		"choices in alphabetical order",
	);
	for (const [language, text] of samples.slice(0, 13))
		assert.deepEqual(kinds(text, syntax.canonical(language)), kinds(text, language), language);
	assert.equal(syntax.supports("constructor"), false);
});
