import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { diffInput } from "./input.ts";
import { catalogSection, check, inspectCatalog, record } from "./operations.ts";
import { readSettings } from "./settings.ts";
import {
	compareStarter,
	importEntries,
	promptSection,
	type SaveFields,
	readCatalog,
	removeEntry,
	saveEntry,
	setDisabled,
	starterDir,
} from "./store.ts";

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
	const identity = { session: "s1", model: "p/m" };
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

test("save validates merged examples and appends unmatched variants once", (t) => {
	const { dir, identity, options } = fixture(t);
	assert.throws(
		() => record(options, { action: "save", id: entry.id, operator: "note" }, identity),
		/new entry requires title/,
	);
	assert.throws(() => record(options, { action: "save", id: entry.id }, identity), /requires operator/);
	assert.deepEqual(readdirSync(dir), [], "a refused save does not seed the store");
	const { entry: saved } = saveEntry(
		dir,
		{ ...entry, prompt: false, excerpt: "```\n## Repair\n### Save\n```" },
		identity,
	);
	assert.match(saved.raw, /## Record\n\nCreated:/);
	assert.match(saved.raw, /Session: "s1"/);
	const variant = { kind: "ts", verdict: "slop" as const, text: "// A human reader spots this without a detector." };
	const update = { action: "save" as const, id: entry.id, operator: "Retain another variant.", examples: [variant] };
	const changed = record(options, update, identity);
	assert.match(changed.content[0].text, /No detector matched: Example 3 \(slop, ts\)\./);
	assert.equal(readCatalog(dir).find((item) => item.id === entry.id)?.prompt, false);
	record(options, { ...update, operator: "Keep the cue in prompts.", prompt: true }, identity);
	const merged = readCatalog(dir).find((item) => item.id === entry.id);
	assert.ok(merged);
	assert.equal(merged.origin, "recorded");
	assert.equal(merged.record?.created, saved.record?.created);
	assert.equal(merged.record?.items.length, 3);
	assert.match(merged.record?.items[0] ?? "", /### Save/);
	assert.match(merged.record?.items[1] ?? "", /Retain another variant/);
	assert.match(merged.record?.items[2] ?? "", /Keep the cue in prompts/);
	assert.deepEqual(merged.examples, [...saved.examples, variant]);
	assert.deepEqual(merged.detectors, saved.detectors);
	assert.equal(merged.recognition, saved.recognition);
	assert.equal(merged.prompt, true);
	const file = join(dir, "catalog", `${entry.id}.md`);
	assert.throws(
		() =>
			record(options, { ...update, examples: [{ ...variant, verdict: "better", text: "// release diary" }] }, identity),
		/Better|matched phrase/,
	);
	assert.throws(
		() =>
			saveEntry(
				dir,
				{
					id: entry.id,
					operator: "A dead detector",
					detectors: [{ id: "dead", in: ["comment"], phrases: ["absent"] }],
				},
				identity,
			),
		/Detector dead: no matching Slop example/,
	);
	assert.equal(readFileSync(file, "utf8"), merged.raw);
	assert.deepEqual(
		saveEntry(dir, { id: entry.id, operator: "Clear detectors.", detectors: [] }, identity).entry.detectors,
		[],
	);
});

test("save drops the oldest history items when the entry reaches its byte limit", (t) => {
	const { dir, identity } = fixture(t);
	const large = "é".repeat(29_000);
	const first = saveEntry(dir, { ...entry, note: `First ${large}` }, identity).entry;
	saveEntry(dir, { id: entry.id, operator: "Second", note: large }, identity);
	const latest = saveEntry(dir, { id: entry.id, operator: "Third", note: large }, identity).entry;
	assert.equal(latest.record?.created, first.record?.created);
	assert.equal(latest.record?.items.length, 2);
	assert.ok(latest.record?.items[0].includes("Second"));
	assert.ok(latest.record?.items[1].includes("Third"));
});

test("catalog filtering, disabled state and prompt follow the machine catalog", async (t) => {
	const { dir, options, cwd, identity } = fixture(t);
	saveEntry(dir, entry, identity);
	assert.match(
		inspectCatalog(options, { query: "RELEASE DIARY", scope: "comment" }).content[0].text,
		/recorded · active · prompt · 1 detector/,
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
	assert.match(inspectCatalog(options, { entry: entry.id }).content[0].text, /recorded · off/);
	const state = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
	assert.equal(state.disabled[entry.id].reason, "Fixture");
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

test("the first read copies every starter byte and records each digest; an empty catalog never reseeds", (t) => {
	const { dir } = fixture(t);
	const files = readdirSync(starterDir).filter((file) => file !== "README.md" && file.endsWith(".md"));
	assert.ok(files.length);
	assert.equal(readCatalog(dir).length, files.length);
	const catalog = join(dir, "catalog");
	assert.deepEqual(readdirSync(catalog).sort(), files.sort());
	const imported = Object.fromEntries(
		files.map((file) => {
			const bytes = readFileSync(join(starterDir, file));
			assert.ok(readFileSync(join(catalog, file)).equals(bytes), file);
			rmSync(join(catalog, file));
			return [file.slice(0, -3), createHash("sha256").update(bytes).digest("hex")];
		}),
	);
	const state = join(dir, "catalog.json");
	const expected = { imported, disabled: {}, removed: {} };
	assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), expected);
	assert.deepEqual(readCatalog(dir), []);
	assert.deepEqual(readdirSync(catalog), []);
	assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), expected);
});

test("starter comparison tracks the ancestor, and only explicit import restores a removed entry", (t) => {
	const { root, dir, identity } = fixture(t);
	const starter = join(root, "starter");
	mkdirSync(starter);
	const writeStarter = (id: string, tail = "") => {
		const content =
			readFileSync(join(starterDir, "context-free-decisions.md"), "utf8").replace(
				"id: context-free-decisions",
				`id: ${id}`,
			) + tail;
		writeFileSync(join(starter, `${id}.md`), content);
		return content;
	};
	for (const id of ["same", "changed", "deleted"]) writeStarter(id);
	const list = () => readCatalog(dir, starter);
	assert.throws(() => importEntries(dir, ["same", "absent"], starter), /No starter entry named absent/);
	assert.throws(() => readdirSync(dir), { code: "ENOENT" });
	assert.equal(list().length, 3);
	const edited = saveEntry(
		dir,
		{ id: "same", operator: "Clarify the title.", title: "A different title" },
		identity,
		undefined,
		starter,
	).entry;
	assert.equal(edited.prompt, false);
	assert.equal(edited.origin, "recorded");
	assert.equal(edited.record?.items.length, 1);
	const updated = writeStarter("changed", "\n## Notes\n\nMore detail.\n");
	writeStarter("fresh");
	assert.deepEqual(importEntries(dir, [], starter), []);
	assert.ok(!list().some(({ id }) => id === "fresh"));
	saveEntry(dir, { ...entry, id: "replaced" }, identity, undefined, starter);
	writeStarter("replaced");
	setDisabled(dir, "deleted", true, identity, "Paused.", starter);
	removeEntry(dir, "deleted", identity, "No longer useful.", starter);
	assert.deepEqual(
		Object.fromEntries(compareStarter(dir, list(), starter).map(({ entry, status }) => [entry.id, status])),
		{
			changed: "updated",
			deleted: "removed",
			fresh: "new",
			replaced: "replaced",
			same: "current",
		},
	);
	assert.throws(() => importEntries(dir, ["fresh", "absent"], starter), /No starter entry named absent/);
	assert.ok(!list().some(({ id }) => id === "fresh"));
	assert.deepEqual(importEntries(dir, undefined, starter), ["fresh"]);
	assert.ok(!list().some(({ id }) => id === "deleted"));
	assert.deepEqual(importEntries(dir, ["deleted", "changed", "same"], starter), ["deleted", "changed", "same"]);
	assert.equal(list().find(({ id }) => id === "deleted")?.disabled, false);
	assert.equal(list().find(({ id }) => id === "changed")?.raw, updated);
	assert.equal(list().find(({ id }) => id === "same")?.origin, "starter");
});

test("catalog and record tools keep starter reads and action fields distinct", (t) => {
	const { dir, identity, options } = fixture(t);
	mkdirSync(join(dir, "catalog"), { recursive: true });
	assert.match(inspectCatalog(options, {}).content[0].text, /^Starter set: \d+ new, 0 updated/);
	assert.match(
		inspectCatalog(options, { starter: true }).content[0].text,
		/context-free-decisions · new ·.*\n[\s\S]*slop_record/,
	);
	assert.match(
		inspectCatalog(options, { starter: true, entry: "context-free-decisions" }).content[0].text,
		/^context-free-decisions · new\n\n---/,
	);
	assert.throws(() => inspectCatalog(options, { starter: true, scope: "reply" }), /only to filter/);
	assert.throws(() => record(options, { action: "import", id: entry.id }, identity), /import accepts.*ids/);
	assert.throws(
		() => record(options, { action: "remove", id: entry.id, title: "Title" }, identity),
		/remove accepts.*id, reason/,
	);
	assert.throws(() => record(options, { action: "disable" }, identity), /disable requires id/);
	assert.match(
		record(options, { action: "import", ids: ["context-free-decisions"] }, identity).content[0].text,
		/Imported starter entries: context-free-decisions/,
	);
	assert.match(inspectCatalog(options, { entry: "context-free-decisions" }).content[0].text, /starter · active/);
	assert.match(
		record(options, { action: "remove", id: "context-free-decisions" }, identity).content[0].text,
		/Removed context-free-decisions/,
	);
	assert.match(
		inspectCatalog(options, { starter: true, entry: "context-free-decisions" }).content[0].text,
		/^context-free-decisions · removed/,
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
	assert.equal(saveEntry(dir, entry, identity).entry.id, entry.id);
	assert.throws(() => readdirSync(lock), { code: "ENOENT" });
});

test("prompt puts recent records before starter entries in id order and stays within its limit", (t) => {
	const { dir, identity } = fixture(t);
	const { entry: saved } = saveEntry(dir, entry, identity);
	const scoped = [
		...Array.from({ length: 30 }, (_, i) => ({
			...saved,
			id: `habit-${String(i + 1).padStart(2, "0")}`,
			title: `Habit ${i + 1}`,
			repair: "Explain the rule that the code preserves in the place where that rule applies.",
			origin: "starter" as const,
			record: undefined,
		})).reverse(),
		{ ...saved, id: "older", title: "Older save", record: { items: [], updated: "2000-01-01T00:00:00.000Z" } },
		saved,
	];
	const prompt = promptSection(scoped);
	assert.ok(prompt);
	assert.ok(prompt.length <= 1500);
	assert.match(prompt, /^Each line names a habit to avoid and its repair\.\nRelease diary:.*\nOlder save:.*\nHabit 1:/);
	assert.doesNotMatch(prompt, /Habit 30/);
});
