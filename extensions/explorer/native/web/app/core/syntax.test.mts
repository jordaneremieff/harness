import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const window = {
	explorer: {} as Pick<ExplorerApp, "syntax"> & {
		syntaxFile(lines: string[], id: string): (index: number) => ExplorerSpan[];
	},
};
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./syntax.ts", import.meta.url), "utf8")), { window });
const { syntaxFile, syntax } = window.explorer;

function tokens(line: string, spans: ExplorerSpan[]) {
	let end = 0;
	return Array.from(spans, (span) => {
		assert.ok(end <= span.start && span.start < span.end && span.end <= line.length);
		end = span.end;
		return [line.slice(span.start, span.end), span.role];
	});
}

for (const [id, lines, role, close, keyword] of [
	["typescript", ["const a=/** doc", "const notCode = 2;", "*/null;"], "com", "*/", "null"],
	["javascript", ["/* comment", "let notCode = 2;", "*/ return true;"], "com", "*/", "return"],
	["typescript", ["const a=`hello \\`", "const notCode = value;", "`; const b = 0;"], "str", "`", "const"],
	["javascript", ["const a = `hello", "function notCode() {}", "`; let b = 0;"], "str", "`", "let"],
	["swift", ['let a = """', "let notCode = 2;", '"""; let b = 0;'], "str", '"""', "let"],
	["swift", ['let a = ##"""', 'let notCode = """#', '"""##; let b = 0;'], "str", '"""##', "let"],
	["python", ['a = r"""hello', "def not_code():", '"""; return 0'], "str", '"""', "return"],
	["python", ["a = f'''hello", "def not_code():", "'''; return 0"], "str", "'''", "return"],
	["rust", ['let a = br##"hello', 'let not_code = "#;', '"##; let b = 0;'], "str", '"##', "let"],
	["rust", ['let a = r"hello', "let not_code = 2;", '"; let b = 0;'], "str", '"', "let"],
	["go", ["var a = `hello", "func notCode() {}\\", "`; var b = 0"], "str", "`", "var"],
] as const) {
	test(`${id} carries ${lines[0]} across lines and resumes code`, () => {
		const highlight = syntaxFile([...lines], id);
		const closing = tokens(lines[2], highlight(2));
		assert.deepEqual(closing[0], [close, role]);
		assert.ok(closing.some(([text, name]) => text === keyword && name === (keyword === "null" ? "num" : "key")));
		assert.deepEqual(tokens(lines[1], highlight(1)), [[lines[1], role]]);
	});
}

test("keeps nested template expressions in the outer string", () => {
	const lines = [
		"const a = `outer ${ { b: `inner",
		"still inner",
		'`, c: "`", d: /* `',
		"*/ 1 }.b } end`; const b = 1;",
	];
	const highlight = syntaxFile(lines, "typescript");
	assert.deepEqual(tokens(lines[3], highlight(3)).slice(0, 3), [
		["*/ 1 }.b } end`", "str"],
		[";", "punct"],
		["const", "key"],
	]);
	assert.deepEqual(tokens(lines[1], highlight(1)), [[lines[1], "str"]]);
});

test("ignores openers inside ordinary strings and line comments", () => {
	const lines = ['const a = "/* `"; // ignored ` /*', "const b = 2;"];
	assert.deepEqual(tokens(lines[1], syntaxFile(lines, "typescript")(1))[0], ["const", "key"]);
});

test("tracks nested Swift and Rust comments", () => {
	const lines = ["/* outer /* inner", "*/ still a comment", "", "*/ let x = 0"];
	for (const id of ["swift", "rust"]) {
		const highlight = syntaxFile(lines, id);
		assert.deepEqual(tokens(lines[3], highlight(3)).slice(0, 2), [
			["*/", "com"],
			["let", "key"],
		]);
		assert.deepEqual(tokens(lines[1], highlight(1)), [[lines[1], "com"]]);
		assert.equal(highlight(2).length, 0);
	}
});

test("colours fenced code aliases and resets state at matching Markdown fences", () => {
	const lines = [
		"````TS title",
		"const x = `start",
		"~~~",
		"still a template",
		"`````",
		"# Heading",
		"~~~py",
		"def run():",
		"~~~",
		"~~~unknown",
		"def plain():",
		"~~~",
	];
	const highlight = syntaxFile(lines, "markdown");
	assert.deepEqual(tokens(lines[7], highlight(7))[0], ["def", "key"]);
	for (const i of [0, 4, 5, 6, 8, 9, 11]) assert.deepEqual(tokens(lines[i], highlight(i)), [[lines[i], "meta"]]);
	for (const i of [2, 3]) assert.deepEqual(tokens(lines[i], highlight(i)), [[lines[i], "str"]]);
	assert.deepEqual(tokens(lines[10], highlight(10)), []);
});

test("scans skipped lines once, only reads the requested prefix, and preserves the line API cap", () => {
	const reads: number[] = [];
	const lines = new Proxy(["/*", "x".repeat(20_000), "*/", "const after = 1;"], {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) reads.push(Number(key));
			return Reflect.get(target, key, receiver);
		},
	});
	const highlight = syntaxFile(lines, "javascript");
	assert.deepEqual(reads, []);
	assert.deepEqual(tokens(lines[1], highlight(1)), [["x".repeat(8192), "com"]]);
	highlight(3);
	highlight(3);
	assert.deepEqual(reads, [1, 0, 1, 2, 3, 3]);
	for (const index of [-1, 4, 0.5, Number.NaN]) assert.equal(highlight(index).length, 0);
	assert.deepEqual(tokens("const a = 1;", syntax("const a = 1;", "typescript")), [
		["const", "key"],
		["=", "op"],
		["1", "num"],
		[";", "punct"],
	]);
	assert.equal(syntax(`/*${"x".repeat(20_000)}`, "javascript")[0].end, 8192);
});

test("a backtick in a regular expression does not start a template across lines", () => {
	const lines = ["const fence = /`{3,}/;", "const next = value;"];
	const source = syntaxFile(lines, "typescript");
	assert.deepEqual(tokens(lines[1], source(1))[0], ["const", "key"]);
});

const samples: [string, string, [string, string][]][] = [
	[
		"toml",
		"[package] # settings",
		[
			["[package]", "type"],
			["# settings", "com"],
		],
	],
	[
		"ini",
		"[Service] ; launch settings",
		[
			["[Service]", "type"],
			["; launch settings", "com"],
		],
	],
	["c", '#include "stdio.h"', [['#include "stdio.h"', "macro"]]],
	[
		"ruby",
		'def greet(name = "Explorer")',
		[
			["def", "key"],
			["greet", "fn"],
			['"Explorer"', "str"],
		],
	],
	[
		"php",
		'<?php echo $name ?? "world";',
		[
			["<?php", "meta"],
			["echo", "key"],
			["$name", "variant"],
			['"world"', "str"],
		],
	],
	[
		"lua",
		'local message = "hello" -- greeting',
		[
			["local", "key"],
			['"hello"', "str"],
			["-- greeting", "com"],
		],
	],
	[
		"makefile",
		"deploy: $(TARGETS) # targets",
		[
			["deploy", "fn"],
			["$(TARGETS)", "member"],
			["# targets", "com"],
		],
	],
	["makefile", '\tprintf "%s" "$@"', [["$@", "variant"]]],
	[
		"gomod",
		'replace example.org/v2 => "../local" // override',
		[
			["replace", "key"],
			["=>", "op"],
			['"../local"', "str"],
			["// override", "com"],
		],
	],
	[
		"hcl",
		'resource "local_file" "setup" {',
		[
			["resource", "key"],
			['"local_file"', "str"],
		],
	],
	[
		"hcl",
		"name = upper(var.text) # computed",
		[
			["name", "member"],
			["upper", "fn"],
			["# computed", "com"],
		],
	],
	[
		"hcl",
		"values = [for v in var.items : v if true] // list",
		[
			["for", "key"],
			["in", "key"],
			["if", "key"],
			["true", "num"],
			["// list", "com"],
		],
	],
	[
		"graphql",
		"query Search($term: String) @cached { # lookup",
		[
			["query", "key"],
			["$term", "variant"],
			["@cached", "macro"],
			["# lookup", "com"],
		],
	],
	[
		"protobuf",
		"optional string name = 1; // label",
		[
			["optional", "key"],
			["string", "builtin"],
			["1", "num"],
			["// label", "com"],
		],
	],
	[
		"dbml",
		"TaBLe people [NoTe: `lower(name)`, PrImArY KeY]",
		[
			["TaBLe", "key"],
			["NoTe", "key"],
			["`lower(name)`", "str"],
			["PrImArY", "key"],
			["KeY", "key"],
		],
	],
	["gettext", "#, fuzzy, c-format", [["#, fuzzy, c-format", "meta"]]],
	[
		"gettext",
		'msgstr[0] "1 item"',
		[
			["msgstr", "key"],
			["0", "num"],
			['"1 item"', "str"],
		],
	],
	[
		"plantuml",
		`actor "Sam's team" as Sam ' account`,
		[
			["actor", "key"],
			[`"Sam's team"`, "str"],
			["as", "key"],
			["' account", "com"],
		],
	],
	["plantuml", "Sam-->App", [["-->", "op"]]],
	["plantuml", "@startuml example", [["@startuml example", "meta"]]],
	["rst", "========", [["========", "meta"]]],
	["rst", ".. note:: plain body", [[".. note::", "key"]]],
	["rst", ".. comment", [[".. comment", "com"]]],
	[
		"rst",
		":Author: :ref:`guide`",
		[
			[":Author:", "member"],
			[":ref:`guide`", "fn"],
		],
	],
	[
		"rst",
		"(1) ``install`` or see `here <guide.html>`_",
		[
			["(1)", "key"],
			["``install``", "str"],
			["`here <guide.html>`_", "fn"],
		],
	],
	[
		"erb",
		'<p><%= "x%>y" %></p>',
		[
			["<p", "fn"],
			["<%=", "meta"],
			['"x%>y"', "str"],
			["%>", "meta"],
			["</p", "fn"],
		],
	],
	[
		"erb",
		"<%- if ready -%>",
		[
			["<%-", "meta"],
			["if", "key"],
			["-%>", "meta"],
		],
	],
	[
		"erb",
		"<%# internal note %>",
		[
			["<%#", "meta"],
			[" internal note ", "com"],
			["%>", "meta"],
		],
	],
	[
		"handlebars",
		"{{#if user.active}}{{{user.html}}}{{else}}{{> row}}{{/if}}",
		[
			["if", "key"],
			["user.active", "member"],
			["{{{", "meta"],
			["user.html", "member"],
			["}}}", "meta"],
			["else", "key"],
			["row", "key"],
		],
	],
	[
		"gotemplate",
		'{{- if .Values.ready }}{{ $job | default "backup" }}{{ end -}}',
		[
			["if", "key"],
			[".Values.ready", "member"],
			["$job", "variant"],
			["|", "op"],
			["default", "fn"],
			['"backup"', "str"],
			["-}}", "meta"],
		],
	],
	[
		"svelte",
		"{#each entries as item}<p>{item.name}</p>{:else}{@html fallback}{/each}",
		[
			["{#", "meta"],
			["each", "key"],
			["as", "key"],
			["<p", "fn"],
			["name", "member"],
			["else", "key"],
			["html", "key"],
		],
	],
	[
		"astro",
		'<h1>{makeTitle({ fallback: "}" })}</h1>',
		[
			["<h1", "fn"],
			["{", "meta"],
			["makeTitle", "fn"],
			['"}"', "str"],
			["}", "meta"],
			["</h1", "fn"],
		],
	],
];

function includes(spans: string[][], expected: [string, string][]) {
	for (const [text, role] of expected) {
		assert.ok(
			spans.some((pair) => pair[0] === text && pair[1] === role),
			`${text} (${role}) in ${JSON.stringify(spans)}`,
		);
	}
}

for (const [id, line, expected] of samples) {
	test(`${id} roles: ${line}`, () => {
		includes(tokens(line, syntaxFile([line], id)(0)), expected);
		includes(tokens(line, syntax(line, id)), expected);
	});
}

test("only an assignment outranks keyword and type roles in config files", () => {
	for (const id of ["toml", "ini", "hcl"]) {
		const lines = ["API_KEY=1", "default = 1", "API_KEY == 1", "default == 1", `for${" ".repeat(48)}=1`];
		const highlight = syntaxFile(lines, id);
		for (const i of [0, 1, 4]) assert.equal(tokens(lines[i], highlight(i))[0][1], "member");
		for (const i of [2, 3]) assert.ok(!highlight(i).some(({ role }) => role === "member"));
	}
	for (const id of [
		"toml",
		"ini",
		"hcl",
		"gomod",
		"graphql",
		"protobuf",
		"dbml",
		"gettext",
		"plantuml",
		"handlebars",
	]) {
		const line = id === "handlebars" ? "{{const break}}" : "const break";
		assert.ok(!syntax(line, id).some(({ role }) => role === "key"));
	}
});

test("leaves ignore patterns plain and applies Dockerfile instructions only at the start", () => {
	assert.deepEqual(tokens("# comment", syntax("# comment", "ignore")), [["# comment", "com"]]);
	assert.deepEqual(tokens("  #not-a-comment", syntax("  #not-a-comment", "ignore")), []);
	assert.deepEqual(tokens("!node_modules/**", syntax("!node_modules/**", "ignore")), []);
	const lines = ["rUn npm run build \\", "# explanatory note", 'COPY "$target" .', 'FrOm "node:22"'];
	const at = syntaxFile(lines, "dockerfile");
	assert.deepEqual(tokens(lines[0], at(0)), [["rUn", "key"]]);
	assert.deepEqual(tokens(lines[1], at(1)), [[lines[1], "com"]]);
	assert.ok(!at(2).some(({ role }) => role === "key"));
	includes(tokens(lines[2], at(2)), [['"$target"', "str"]]);
	assert.deepEqual(tokens(lines[3], at(3)), [
		["FrOm", "key"],
		['"node:22"', "str"],
	]);
});

test("CSV and TSV keep columns stable, including empty fields and quoted separators", () => {
	for (const [id, separator] of [
		["csv", ","],
		["tsv", "\t"],
	]) {
		const lines = [`a${separator}"b${separator}c""d"${separator}e`, `${separator}f${separator}g`];
		const at = syntaxFile(lines, id);
		assert.deepEqual(tokens(lines[0], at(0)), [
			["a", "member"],
			[separator, "punct"],
			[`"b${separator}c""d"`, "str"],
			[separator, "punct"],
			["e", "num"],
		]);
		assert.deepEqual(tokens(lines[1], at(1)), [
			[separator, "punct"],
			["f", "str"],
			[separator, "punct"],
			["g", "num"],
		]);
	}
});

const multiline: [string, string, string, string, string, string?, [string, string][]?][] = [
	["toml", 'brief = """first', "line = 1", '""" # done', "str", '"""', [["# done", "com"]]],
	["toml", "brief = '''first", "line = 1", "''' # done", "str", "'''", [["# done", "com"]]],
	["lua", "local value = [[hi", "local not_code = 1", "]] local x = 1", "str", "]]", [["local", "key"]]],
	["lua", "local value = [==[hi", "]] ]=] local not_code = 1", "]==] local x = 1", "str", "]==]", [["local", "key"]]],
	["lua", "--[[start", "local not_code = 1", "]] local x = 1", "com", "]]", [["local", "key"]]],
	["c", "/* start", "int not_code = 1;", "*/ int x = 1;", "com", "*/", [["int", "key"]]],
	["php", "/* start", "echo not_code;", "*/ echo $x;", "com", "*/", [["echo", "key"]]],
	["ruby", "=begin", "keep =end here", "=end", "com"],
	["hcl", "value = <<EOF", "not EOF", "EOF", "str"],
	["hcl", "value = <<-EOF", "EOF x", "  EOF", "str"],
	["hcl", "/* start", 'name = "comment"', '*/ name = "live"', "com", "*/", [["name", "member"]]],
	[
		"graphql",
		'"""A description',
		'not the escaped delimiter \\"""',
		'""" type Book {',
		"str",
		'"""',
		[["type", "key"]],
	],
	["protobuf", "/* start", "string unused = 2;", "*/ message Book {", "com", "*/", [["message", "key"]]],
	["dbml", "Note: '''A description", "Table unused {", "''' Table books {", "str", "'''", [["Table", "key"]]],
	["dbml", "/* start", "Table unused {", "*/ Table books {", "com", "*/", [["Table", "key"]]],
	["plantuml", "/' start", "participant NotCode", "'/ actor User", "com", "'/", [["actor", "key"]]],
	[
		"handlebars",
		"{{!-- start",
		"{{inside.comment}}",
		"--}}<em>{{user.name}}</em>",
		"com",
		"--}}",
		[
			["--}}", "meta"],
			["user.name", "member"],
		],
	],
	[
		"gotemplate",
		"{{/* start",
		"{{inside.comment}}",
		"*/}} {{ .User.Name }}",
		"com",
		"*/",
		[
			["}}", "meta"],
			[".User.Name", "member"],
		],
	],
];

for (const [id, first, middle, last, bodyRole, close = last, rest = []] of multiline) {
	test(`${id} carries ${first} and resumes after ${close}`, () => {
		const tail = id === "ruby" ? "def live" : "after = 1";
		const at = syntaxFile([first, middle, last, tail], id);
		const closing = tokens(last, at(2));
		assert.equal(closing[0][0], close);
		includes(closing, rest);
		assert.deepEqual(tokens(middle, at(1)), [[middle, bodyRole]]);
		if (id === "ruby" || id === "hcl") assert.equal(at(3)[0].role, id === "ruby" ? "key" : "member");
	});
}

test("tracks DBML settings across rows without interpreting brackets in strings", () => {
	const lines = ["  id integer [", '    note: "text ]",', "    not null]", "  Primary integer"];
	const at = syntaxFile(lines, "dbml");
	includes(tokens(lines[2], at(2)), [
		["not", "key"],
		["null", "key"],
	]);
	assert.deepEqual(tokens(lines[3], at(3)), []);
});

test("ERB carries Ruby and resumes HTML after an unquoted closer", () => {
	const lines = ["<div><%=", '  if x == "%>"', '    "hello"', "end %><strong>world</strong></div>"];
	const at = syntaxFile(lines, "erb");
	includes(tokens(lines[3], at(3)), [
		["end", "key"],
		["%>", "meta"],
		["<strong", "fn"],
	]);
	includes(tokens(lines[1], at(1)), [
		["if", "key"],
		['"%>"', "str"],
	]);
});

for (const id of ["svelte", "astro"]) {
	test(`${id} carries script, style and brace expressions across lines`, () => {
		const lines = [
			'<script lang="ts">',
			"const message = `Hello",
			"world`;",
			"</script><style>",
			"/* a note",
			"message { color: green; }",
			"*/ .button { color: red; }",
			"</style>",
			"<p>{call({",
			'  text: "}"',
			"})}</p>",
		];
		const at = syntaxFile(lines, id);
		includes(tokens(lines[10], at(10)), [
			["}", "meta"],
			["</p", "fn"],
		]);
		includes(tokens(lines[0], at(0)), [
			["<script", "fn"],
			["lang", "member"],
			['"ts"', "str"],
		]);
		includes(tokens(lines[1], at(1)), [
			["const", "key"],
			["`Hello", "str"],
		]);
		includes(tokens(lines[2], at(2)), [["world`", "str"]]);
		assert.deepEqual(tokens(lines[5], at(5)), [[lines[5], "com"]]);
		includes(tokens(lines[6], at(6)), [
			["*/", "com"],
			["color", "member"],
		]);
		includes(tokens(lines[9], at(9)), [['"}"', "str"]]);
	});
}

test("Astro frontmatter applies only at the start, then HTML and expressions resume", () => {
	const lines = ["---", 'import Card from "./Card.astro";', "const max = 5;", "---", "<Card>{max}</Card>", "---"];
	const at = syntaxFile(lines, "astro");
	assert.deepEqual(tokens(lines[5], at(5)), []);
	for (const i of [0, 3]) assert.deepEqual(tokens(lines[i], at(i)), [["---", "meta"]]);
	includes(tokens(lines[2], at(2)), [
		["const", "key"],
		["5", "num"],
	]);
	includes(tokens(lines[4], at(4)), [
		["<Card", "fn"],
		["{", "meta"],
		["</Card", "fn"],
	]);
});

test("applies new fence aliases with fresh template state per block", () => {
	const lines = [
		"```go-template",
		"{{/* start",
		"```",
		"```go-template",
		"{{if .Ready}}",
		"```",
		"```terraform",
		"a = true",
		"```",
	];
	const at = syntaxFile(lines, "markdown");
	includes(tokens(lines[7], at(7)), [
		["a", "member"],
		["true", "num"],
	]);
	includes(tokens(lines[4], at(4)), [
		["if", "key"],
		[".Ready", "member"],
	]);
});

test("preserves HTML attribute roles on both sides of a template expression", () => {
	const line = '<button onclick={increment} class="counter">Go</button>';
	const painted = tokens(line, syntaxFile([line], "svelte")(0));
	includes(painted, [
		["onclick", "member"],
		["{", "meta"],
		["}", "meta"],
		["class", "member"],
		['"counter"', "str"],
	]);
});

test("ignores braces in embedded TypeScript regex literals and does not treat division as a literal", () => {
	const value = `\`value: \${3}\``;
	const line = `<div>{1 / 2} {match(/[}]/)} {format(${value})}</div>`;
	const painted = tokens(line, syntaxFile([line], "astro")(0));
	assert.equal(painted.filter(([text, role]) => text === "}" && role === "meta").length, 3);
	includes(painted, [
		["match", "fn"],
		[value, "str"],
		["</div", "fn"],
	]);
});
