import assert from "node:assert/strict";
import test from "node:test";
import { acceptPatch, acceptRefresh, capturePatch, makeDraft, refreshStamp } from "./web/draft.ts";
import { lexerFor } from "./web/syntax.ts";

const record = { doc: "example.ts", title: "example.ts", text: "a😀z", rev: 1, dirty: false };

test("a patch replaces a whole UTF-16 pair and its receipt preserves subsequent keystrokes", () => {
	const draft = makeDraft(record);
	draft.text = "a😁z";
	const patch = capturePatch(draft);
	assert.ok(patch);
	assert.deepEqual(patch.input, { op: "patch", doc: record.doc, rev: 1, start: 1, end: 3, text: "😁" });
	draft.text += "!";
	acceptPatch(draft, patch, { rev: 2, dirty: true });
	assert.equal(draft.text, "a😁z!");
	assert.deepEqual(capturePatch(draft)?.input, { op: "patch", doc: record.doc, rev: 2, start: 4, end: 4, text: "!" });
});

test("a refresh remaps a clean selection but does not take over a local conflict", () => {
	const draft = makeDraft(record);
	draft.start = 1;
	draft.end = 3;
	draft.direction = "backward";
	assert.equal(acceptRefresh(draft, refreshStamp(draft), { ...record, rev: 2, text: `xy${draft.text}` }), true);
	assert.deepEqual([draft.start, draft.end, draft.direction], [3, 5, "backward"]);
	assert.equal(draft.text.slice(draft.start, draft.end), "😀");
	const stamp = refreshStamp(draft);
	draft.text += "!";
	draft.blocked = { kind: "conflict", message: "Shared revision changed." };
	assert.equal(acceptRefresh(draft, stamp, { ...record, rev: 3 }), false);
	assert.equal(draft.text, "xya😀z!");
	assert.equal(draft.rev, 2);
});

test("skipped and chunked lines retain the state used to colour the next visible line", () => {
	const lex = lexerFor("TypeScript");
	const long = `${"const n = 1;".repeat(4000)}/*`;
	const scanner = lex.scan(long, null, false);
	let result = scanner.advance(1024);
	assert.equal(result, undefined);
	for (let slice = 0; slice < 100 && !result; slice++) result = scanner.advance(1024);
	assert.ok(result);
	assert.deepEqual(result, lex(long, null, false));
	const [, state] = result;
	const line = "comment */ const word = `hello";
	const [tokens, continued] = lex(line, state);
	assert.deepEqual(
		tokens.map(([start, end, kind]) => [line.slice(start, end), kind]),
		[
			["comment */", "comment"],
			["const", "keyword"],
			["=", "operator"],
			["`hello", "string"],
		],
	);
	assert.deepEqual(continued, { kind: "string", delimiter: "`" });
});
