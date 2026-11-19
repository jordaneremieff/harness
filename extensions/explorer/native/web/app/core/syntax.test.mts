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
