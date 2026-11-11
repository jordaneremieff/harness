import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { changedPaths, selectTests } from "./select-tests.mts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "select-tests-")));
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

function cliFixture(t: TestContext) {
	const { root } = fixture(t);
	const scripts = join(root, "scripts");
	mkdirSync(scripts);
	copyFileSync(fileURLToPath(new URL("./select-tests.mts", import.meta.url)), join(scripts, "select-tests.mts"));
	// Fixture roots use the compiler installed for this test.
	writeFileSync(
		join(scripts, "check-slices.mts"),
		readFileSync(new URL("./check-slices.mts", import.meta.url), "utf8").replace(
			'"typescript"',
			JSON.stringify(import.meta.resolve("typescript")),
		),
	);
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: root,
			env,
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 128_000,
		});
	git("init", "-q", "-b", "main");
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [join(scripts, "select-tests.mts"), ...args], {
			cwd: scripts,
			env,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 128_000,
		});
	return { root, git, run };
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

test("option-shaped revision ranges are refused before the revision reader", () => {
	for (const range of ["--output=probe-out.txt", "-R"]) {
		assert.throws(
			() => changedPaths(["--range", range], () => assert.fail("unexpected revision request")),
			/Revision range must not start with '-'/,
		);
	}
});

test("explicit paths do not request a revision list", () => {
	assert.deepEqual(
		changedPaths(["empty/source.ts"], () => assert.fail("unexpected revision request")),
		["empty/source.ts"],
	);
	assert.throws(() => changedPaths([], () => []), /Usage/);
	assert.throws(() => changedPaths(["--range"], () => []), /Usage/);
});

test("the command prints sorted tracked and untracked tests but excludes ignored and non-source entries", (t) => {
	const { root, git, run } = cliFixture(t);
	const consumer = 'import "../extensions/example/source.ts";';
	for (const path of [".hidden", "node_modules", "dist", "build"]) {
		mkdirSync(join(root, path));
		writeFileSync(join(root, path, "consumer.test.mts"), consumer);
	}
	writeFileSync(join(root, "extensions/example/notes.test.txt"), "");
	writeFileSync(join(root, "extensions/example/deleted.test.mts"), "");
	writeFileSync(join(root, "extensions/example/directory.test.mts"), "");
	writeFileSync(join(root, ".gitignore"), "extensions/example/ignored.test.mts\n");
	git("add", ".");
	writeFileSync(join(root, "extensions/example/ignored.test.mts"), "");
	writeFileSync(join(root, "extensions/example/untracked.test.mts"), "");
	rmSync(join(root, "extensions/example/deleted.test.mts"));
	rmSync(join(root, "extensions/example/directory.test.mts"));
	mkdirSync(join(root, "extensions/example/directory.test.mts"));
	const result = run("extensions/example/source.ts");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout, `${[...expected, "extensions/example/untracked.test.mts"].sort().join("\n")}\n`);
});

test("the command selects revision changes and reads consumers from the current source", (t) => {
	const { root, git, run } = cliFixture(t);
	git("add", ".");
	git("commit", "-qm", "Initial");
	writeFileSync(join(root, "extensions/example/source.ts"), "export const value = 2;");
	git("add", ".");
	git("commit", "-qm", "Change source");
	writeFileSync(join(root, "prompts/current.test.mts"), 'import "../extensions/example/source.ts";');
	const result = run("--range", "HEAD~1..HEAD");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout, `${[...expected, "prompts/current.test.mts"].sort().join("\n")}\n`);
	const empty = run("empty/source.ts");
	assert.equal(empty.status, 0, empty.stderr);
	assert.equal(empty.stdout, "");
	assert.equal(empty.stderr, "");
});

test("the command refuses option-shaped revision ranges without an output file", (t) => {
	const { root, run } = cliFixture(t);
	const result = run("--range", "--output=probe-out.txt");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /Revision range must not start with '-'/);
	assert.equal(existsSync(join(root, "probe-out.txt")), false);
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
