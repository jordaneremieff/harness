import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { changedPaths, selectTests } from "./select-tests.mts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "select-tests-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tree: Record<string, string> = {
		"extensions/example/source.ts": "export const value = 1;",
		"extensions/example/source.test.mts": "// Behaviour observed without a module import.",
		"extensions/example/loader.test.mts": 'new URL("./source.ts", import.meta.url);',
		"extensions/example/nested/unrelated.test.mts": "",
		"prompts/direct.test.mts": 'import { value } from "../extensions/example/source.ts";',
		"extensions/example/index.ts": 'import { value } from "./source.ts"; export default value;',
		"prompts/entry.test.mts": 'import value from "../extensions/example/index.ts";',
		"extensions/example/barrel.ts": 'export { value } from "./source.ts";',
		"prompts/barrel.test.mts": 'import { value } from "../extensions/example/barrel.ts";',
		"other/second.ts": 'export { value } from "../extensions/example/barrel.ts";',
		"prompts/deep.test.mts": 'import { value } from "../other/second.ts";',
		"prompts/computed.test.mts": 'const path = "../extensions/example/source.ts"; import(path);',
		"prompts/text.test.mts": 'const path = "../extensions/example/source.ts";',
		"prompts/unrelated.test.mts": "",
		"empty/source.ts": "export const other = 2;",
	};
	for (const [path, source] of Object.entries(tree)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), source);
	}
	const files = Object.keys(tree);
	return { root, files, select: (changed: string[]) => selectTests(root, files, changed) };
}

const expected = [
	"extensions/example/loader.test.mts",
	"extensions/example/source.test.mts",
	"prompts/barrel.test.mts",
	"prompts/direct.test.mts",
	"prompts/entry.test.mts",
];

test("selects same-directory tests and external consumers through an import or re-export", (t) => {
	assert.deepEqual(fixture(t).select(["extensions/example/source.ts"]), expected);
});

test("keeps changed tests and their neighbours without duplicates", (t) => {
	const { select } = fixture(t);
	assert.deepEqual(select(["extensions/example/source.test.mts", "extensions/example/source.test.mts"]), [
		"extensions/example/loader.test.mts",
		"extensions/example/source.test.mts",
	]);
});

test("prints no selection for a path without tests", (t) => {
	assert.deepEqual(fixture(t).select(["empty/source.ts"]), []);
});

test("revision ranges use the injected changed-file list", (t) => {
	const paths = changedPaths(["--range", "base..tip"], (range) => {
		assert.equal(range, "base..tip");
		return ["extensions/example/source.ts", "empty/source.ts"];
	});
	assert.deepEqual(fixture(t).select(paths), expected);
});

test("explicit paths do not request a revision list", () => {
	assert.deepEqual(
		changedPaths(["empty/source.ts"], () => assert.fail("unexpected revision request")),
		["empty/source.ts"],
	);
	assert.throws(() => changedPaths([], () => []), /Usage/);
	assert.throws(() => changedPaths(["--range"], () => []), /Usage/);
});

test("deleted modules still match literal consumers in the current tree", (t) => {
	const { root, files } = fixture(t);
	rmSync(join(root, "extensions/example/source.ts"));
	assert.deepEqual(
		selectTests(root, files.filter((path) => path !== "extensions/example/source.ts"), ["extensions/example/source.ts"]),
		expected,
	);
});

test("does not infer deeper chains, computed imports, text paths or nested neighbours", (t) => {
	const selected = fixture(t).select(["extensions/example/source.ts"]);
	for (const path of [
		"prompts/deep.test.mts",
		"prompts/computed.test.mts",
		"prompts/text.test.mts",
		"extensions/example/nested/unrelated.test.mts",
	]) {
		assert.ok(!selected.includes(path), path);
	}
});
