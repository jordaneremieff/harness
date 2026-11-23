import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { diffInput } from "./input.ts";
import { catalogSection, check, inspectCatalog, record } from "./operations.ts";
import { readSettings } from "./settings.ts";
import { promptSection, type SaveFields, readCatalog, saveEntry, saveFlag } from "./store.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const entry: SaveFields = {
	id: "release-diary",
	title: "Release diary",
	domain: "code",
	applies: ["comment", "commit", "document"],
	recognition: "A comment claims this is a release diary.",
	cost: "The label does not describe the code.",
	repair: "Describe the constraint that the code preserves.",
	operator: "Please record release diary labels.",
	detectors: [{ id: "phrase", in: ["comment", "commit", "document"], phrases: ["release diary"] }],
	examples: [
		{ kind: "ts", verdict: "slop", text: "// release diary" },
		{ kind: "ts", verdict: "better", text: "// Host permits one retry." },
	],
};

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "slop-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	const options = { agentDir: root, env: {} };
	const dir = join(root, "slop");
	const identity = { session: "s1", model: "p/m", cwd };
	return { root, cwd, dir, options, identity };
}

function git(cwd: string, ...args: string[]) {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			...args,
		],
		{ cwd, encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

test("save validates examples before writes and preserves creation time on replacement", (t) => {
	const { dir, identity } = fixture(t);
	assert.throws(
		() =>
			saveEntry(dir, { ...entry, examples: [{ kind: "ts", verdict: "better", text: "// release diary" }] }, identity),
		/Example 1.*matched phrase/,
	);
	assert.throws(() => readdirSync(dir), { code: "ENOENT" });
	const saved = saveEntry(dir, { ...entry, excerpt: "```\n## Repair\n```" }, identity);
	assert.match(saved.raw, /## Record\n\nCreated:/);
	assert.match(saved.raw, /Session: "s1"/);
	assert.equal(saved.prompt, true);
	const replaced = saveEntry(dir, { ...entry, title: "Release log" }, identity);
	assert.equal(replaced.created, saved.created);
	assert.equal(readCatalog(dir)[0].title, "Release log");
});

test("catalog filtering, disabled state and prompt follow the effective local catalog", async (t) => {
	const { dir, options, cwd, identity } = fixture(t);
	saveEntry(dir, entry, identity);
	assert.match(
		inspectCatalog(options, { query: "RELEASE DIARY", scope: "comment" }).content[0].text,
		/local · active · 1 detector/,
	);
	assert.doesNotMatch(inspectCatalog(options, { scope: "code" }).content[0].text, /release-diary/);
	assert.match(
		catalogSection(options) ?? "",
		/^Each line names a habit to avoid and its repair\.\nRelease diary: Describe the constraint/,
	);
	assert.equal(catalogSection({ ...options, env: { PI_SLOP_PROMPT: "off" } }), undefined);
	const arg = { text: "release diary", kind: "document" as const, entries: [entry.id] };
	assert.equal((await check(options, cwd, arg)).details.ok, false);
	record(options, { action: "disable", id: entry.id, reason: "Fixture" }, identity);
	assert.equal((await check(options, cwd, arg)).details.ok, true);
	assert.doesNotMatch(catalogSection(options) ?? "", /Release diary:/);
	assert.match(inspectCatalog(options, { entry: entry.id }).content[0].text, /disabled/);
	const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
	assert.equal(state[entry.id].reason, "Fixture");
	record(options, { action: "enable", id: entry.id }, identity);
	assert.equal((await check(options, cwd, arg)).details.ok, false);
	await assert.rejects(check(options, cwd, { text: "x", diff: {} }), /exactly one/);
});

test("a line too long to check in bounded time is skipped and reported", async (t) => {
	const { dir, options, cwd, identity } = fixture(t);
	saveEntry(dir, entry, identity);
	const text = `release diary\n${"release diary ".repeat(2000)}`;
	const result = await check(options, cwd, { text, kind: "document", entries: [entry.id] });
	assert.equal(result.details.skippedCount, 1);
	assert.match(result.content[0].text, /text:2: line longer than 20000 characters/);
	assert.match(result.content[0].text, /phrase: 1 match, allowance 0/);
});

test("settings keep a rejected environment value above the file and resolve relative paths", (t) => {
	const { options, root } = fixture(t);
	writeFileSync(
		join(root, "custom.json"),
		JSON.stringify({ version: 1, slop: { dir: "custom", prompt: "off", lexicon: "terms.txt", other: 1 } }),
	);
	const read = readSettings({ ...options, env: { PI_HARNESS_FILE: "custom.json", PI_SLOP_DIR: "" } });
	assert.deepEqual(read.values, { dir: join(root, "slop"), prompt: "off", lexicon: join(root, "terms.txt") });
	assert.equal(read.source.status, "loaded");
	assert.deepEqual(
		read.diagnostics.map(({ field, source, code }) => [field, source, code]),
		[
			["slop.other", "file", "unknown"],
			["slop.dir", "env", "invalid"],
		],
	);
});

test("flags retain exact reply and note in a private file", (t) => {
	const { dir, identity } = fixture(t);
	const id = saveFlag(dir, "reply\n\n body\n", "note", identity);
	const flag = JSON.parse(readFileSync(join(dir, "flags", `${id}.json`), "utf8"));
	assert.deepEqual(
		{ ...flag, time: undefined },
		{ id, time: undefined, ...identity, reply: "reply\n\n body\n", note: "note" },
	);
});

test("real Git checks only added lines of the selected version and includes commit messages for a range", async (t) => {
	const { cwd, dir, options, identity } = fixture(t);
	saveEntry(dir, entry, identity);
	git(cwd, "init", "-q");
	const path = 'a name "λ".ts';
	writeFileSync(join(cwd, path), "/**\n * existing release diary\n * description\n */\n");
	git(cwd, "add", "--", path);
	git(cwd, "commit", "-qm", "Baseline");
	const base = git(cwd, "rev-parse", "HEAD");
	writeFileSync(join(cwd, path), "/**\n * existing release diary\n * new release diary\n */\n");
	git(cwd, "add", "--", path);
	writeFileSync(join(cwd, path), "/**\n * existing release diary\n * working text\n */\n");
	writeFileSync(join(cwd, "image.ts"), Buffer.from([0, 47, 0]));
	git(cwd, "add", "image.ts");
	const staged = await diffInput(cwd, { staged: true });
	assert.deepEqual(staged.lines, [{ scope: "comment", line: 3, text: " new release diary", path }]);
	assert.equal(staged.skipped[0], "image.ts: binary file");
	assert.equal((await check(options, cwd, { diff: { paths: [path] }, entries: [entry.id] })).details.ok, true);
	git(cwd, "commit", "-qm", "A release diary subject", "-m", "Normal body.");
	const found = await check(options, cwd, { diff: { range: `${base}..HEAD`, paths: [path] }, entries: [entry.id] });
	assert.equal(found.details.ok, false);
	assert.match(found.content[0].text, /2 matches, allowance 0/);
	assert.match(found.content[0].text, /commit [0-9a-f]{12}/);
});

test("staged CLI signals findings in a repository without HEAD, and distinguishes clean checks and errors", (t) => {
	const { cwd, dir, root, identity } = fixture(t);
	saveEntry(dir, entry, identity);
	git(cwd, "init", "-q");
	writeFileSync(join(cwd, "file.ts"), "// release diary\n");
	git(cwd, "add", "file.ts");
	const run = (...args: string[]) =>
		execFileSync(process.execPath, [cli, "check", ...args], {
			cwd,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: root,
				PI_SLOP_DIR: dir,
				PI_HARNESS_FILE: join(root, "harness.json"),
				PI_SLOP_LEXICON: "",
			},
			encoding: "utf8",
			timeout: 6000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	assert.throws(() => run("--staged"), { status: 1, stdout: /file\.ts.*release diary/ });
	writeFileSync(join(cwd, "msg"), "Describe the constraint\n");
	assert.match(run("--commit-file", "msg"), /No slop findings/);
	assert.throws(() => run("--staged", "--commit-file", "msg"), { status: 2 });
});

test("Git skips oversize patches and content, ignores data, and still checks other files", async (t) => {
	const { cwd, options } = fixture(t);
	git(cwd, "init", "-q");
	writeFileSync(join(cwd, "large.ts"), Buffer.alloc(17 * 1024 * 1024, 65));
	writeFileSync(join(cwd, "medium.ts"), Buffer.alloc(9 * 1024 * 1024, 65));
	writeFileSync(join(cwd, "doc.txt"), "Reader text.\n");
	writeFileSync(join(cwd, "package.json"), '{"command":"npm test -- --flag"}\n');
	writeFileSync(join(cwd, "Package.resolved"), "a27ca48ec\n");
	git(cwd, "add", ".");
	const changed = await diffInput(cwd, { staged: true });
	assert.deepEqual(changed.lines, [{ scope: "document", path: "doc.txt", line: 1, text: "Reader text." }]);
	assert.deepEqual(changed.skipped, [
		"large.ts: git diff: output exceeds 16 MiB",
		"medium.ts: new content exceeds 8 MiB",
	]);
	const explicit = await check(options, cwd, { path: "package.json" });
	assert.equal(explicit.details.skippedCount, 1);
	assert.match(explicit.content[0].text, /package\.json: unsupported file kind/);
});

test("a write recovers an expired lock but does not bypass a held lock", (t) => {
	const { dir, identity } = fixture(t);
	const lock = join(dir, ".write-lock");
	mkdirSync(lock, { recursive: true });
	assert.throws(() => saveEntry(dir, entry, identity), { code: "ELOCKED" });
	const expired = new Date(0);
	utimesSync(lock, expired, expired);
	assert.equal(saveEntry(dir, entry, identity).id, entry.id);
	assert.throws(() => readdirSync(lock), { code: "ENOENT" });
});

test("prompt includes its introduction within the size limit and keeps the input order", (t) => {
	const { dir, identity } = fixture(t);
	const local = saveEntry(dir, entry, identity);
	const scoped = [
		local,
		...Array.from({ length: 30 }, (_, i) => ({
			...local,
			title: `Habit ${i + 1}`,
			repair: "Explain the rule that the code preserves in the place where that rule applies.",
			source: "shipped" as const,
		})),
	];
	const prompt = promptSection(scoped);
	assert.ok(prompt);
	assert.ok(prompt.length <= 1500);
	assert.match(prompt, /^Each line names a habit to avoid and its repair\.\nRelease diary:.*\nHabit 1:/);
	assert.doesNotMatch(prompt, /Habit 30/);
});
