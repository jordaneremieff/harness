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

// A literal dollar and brace, as code contains them.
const at = (name: string) => `$${"{"}${name}}`;
const samples: [string, string][] = [
	["ts", `export async function show(id: string): Promise<Pane> {\n\t// open it\n\treturn open(\`pane ${at("id")}\`, 42, true);\n}\n`],
	["swift", 'let paper = NSColor(srgbRed: 36 / 255, green: 0x27, blue: 0.5, alpha: 1) // base\nguard let x else { return nil }\n"""\nmulti\n"""'],
	["json", '{ "kind": "published", "revision": 2, "open": null, "items": ["a\\"b"] }'],
	["bash", `export PI_MARKDOWN_APP="$HOME/app" # build\nif [ -n "${at("X")}" ]; then node build.mts --verify; fi`],
	["python", 'def run(self, path: str) -> None:\n    """Doc."""\n    return f"{path}" if True else None  # done'],
	["diff", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same"],
	["html", '<a href="https://x.test" class=\'y\'>link</a><!-- note -->'],
	["yaml", "title: Reader\ncount: 3\nok: true\n- name: x # c"],
	["css", "@media (width < 860px) { .outline { margin-top: var(--bar-h); } }"],
	["sql", "SELECT name FROM docs WHERE id = 'a''b' -- one\n"],
	["md", "# Title\n\nSee `code` and [a link](https://x.test)."],
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

test("tokens follow the style guide's roles", () => {
	const ts = kinds(samples[0][1], "typescript");
	for (const expected of ["k:export", "k:async", "k:function", "f:show", "t:Promise", "t:Pane", "c:// open it", `s:\`pane ${at("id")}\``, "n:42", "n:true"])
		assert.ok(ts.includes(expected), `${expected} in ${ts.join(" ")}`);
	assert.ok(kinds(samples[2][1], "json").includes('p:"kind"'), "a JSON key is a property");
	assert.ok(kinds(samples[2][1], "json").includes('s:"published"'), "a JSON value is a string");
	const shell = kinds(samples[3][1], "sh");
	for (const expected of ["k:export", "s:\"$HOME/app\"", "c:# build", "k:if", "k:then", "k:fi"]) assert.ok(shell.includes(expected), `${expected} in ${shell.join(" ")}`);
	assert.deepEqual(kinds(samples[5][1], "patch"), ["meta:diff --git a/x b/x", "meta:--- a/x", "meta:+++ b/x", "meta:@@ -1 +1 @@", "del:-old", "ins:+new"]);
	assert.deepEqual(kinds(samples[6][1], "html"), ["k:a", "a:href", 's:"https://x.test"', "a:class", "s:'y'", "k:a", "c:<!-- note -->"]);
	assert.ok(kinds(samples[7][1], "yml").includes("p:title") && kinds(samples[7][1], "yml").includes("n:true"));
	assert.ok(kinds(samples[8][1], "css").includes("p:margin-top") || kinds(samples[8][1], "css").includes("p:top"));
	assert.ok(kinds(samples[9][1], "sql").includes("k:SELECT") && kinds(samples[9][1], "sql").includes("s:'a''b'"));
	assert.deepEqual(kinds(samples[10][1], "markdown"), ["k:# Title", "s:`code`", "f:[a link](https://x.test)"]);
	assert.deepEqual(plain(syntax.tokens(samples[11][1], "unknown")), [{ text: samples[11][1] }], "an unknown language stays plain");
	assert.equal(syntax.supports("Front matter"), true);
	assert.equal(syntax.supports("code"), false);
});
