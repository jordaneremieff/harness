import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NOTE_OPEN_FLAGS, addressableSlug, extractCue, openRegular, sliceByCodePoints, trimUtf8 } from "./lookup.mts";

type Json = Record<string, unknown>;

const script = fileURLToPath(new URL("./lookup.mts", import.meta.url));
const cleanupRoots: string[] = [];

after(() => {
	for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

function asObject(value: unknown): Json {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
	return value as Json;
}

function asArray(value: unknown): unknown[] {
	assert.ok(Array.isArray(value), "expected a JSON array");
	return value as unknown[];
}

function asString(value: unknown): string {
	assert.equal(typeof value, "string");
	return value as string;
}

function asNumber(value: unknown): number {
	assert.equal(typeof value, "number");
	return value as number;
}

function asBoolean(value: unknown): boolean {
	assert.equal(typeof value, "boolean");
	return value as boolean;
}

function notesOf(json: Json): Json[] {
	return asArray(json.notes).map(asObject);
}

function cuesOf(note: Json): Json {
	return asObject(note.cues);
}

function issueCodes(json: Json): string[] {
	return asArray(asObject(json.scan).issues).map((issue) => asString(asObject(issue).code));
}

function makeCorpus(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "memory-lookup-"));
	cleanupRoots.push(root);
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function run(args: string[], memoryDir: string | null): SpawnSyncReturns<string> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (memoryDir === null) delete env.PI_MEMORY_DIR;
	else env.PI_MEMORY_DIR = memoryDir;
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

function runJsonOk(args: string[], memoryDir: string | null): Json {
	const result = run(args, memoryDir);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(Buffer.byteLength(result.stdout) < 50 * 1024, "successful output must stay below 50 KiB");
	return asObject(JSON.parse(result.stdout));
}

function runError(args: string[], memoryDir: string | null): { status: number | null; stderr: string } {
	const result = run(args, memoryDir);
	return { status: result.status, stderr: result.stderr };
}

function drainIndex(root: string, extra: string[] = []): Json[] {
	const pages: Json[] = [];
	let index = 0;
	for (let guard = 0; guard < 200; guard += 1) {
		const json = runJsonOk(["--index", String(index), ...extra], root);
		pages.push(json);
		if (asBoolean(json.hasMore) !== true) return pages;
		const nextIndex = asNumber(json.nextIndex);
		assert.ok(nextIndex > index, "index continuation must make progress");
		index = nextIndex;
	}
	throw new Error("index walk exceeded its guard");
}

const README = "# Memory corpus contract\n\nThis directory holds durable notes.\n";

const ACTIVE_NOTE = `---
title: Prefer dark theme
tags: [preference, ui]
status: active
created: 2025-01-02
updated: 2025-01-03
verified: true
verified_date: 2025-01-03
supersedes: []
superseded_by: null
---

# Prefer dark theme

## Summary

Use the dark theme.
`;

const OLD_NOTE = `---
title: Old edge setting
tags: [browser]
status: superseded
supersedes: []
superseded_by: prefer-dark-theme
---

# Old edge setting

The body mentions zebra-feature.
`;

const HEADING_NOTE = "# Heading only note\n\nNo frontmatter here.\n";

function maximalNote(index: number): string {
	const tags = Array.from({ length: 40 }, (_, key) => `tag-${index}-${key}`.padEnd(80, "x")).join(", ");
	const supersedes = Array.from({ length: 40 }, (_, key) => `slug-${index}-${key}`.padEnd(160, "y")).join(", ");
	return `---\ntitle: ${"T".repeat(300)}\ntags: [${tags}]\nstatus: ${"s".repeat(80)}\nsupersedes: [${supersedes}]\nsuperseded_by: ${"z".repeat(160)}\n---\n\n# Heading ${index}\n`;
}

test("indexes verbatim cue lines with heading and filename fallback", () => {
	const root = makeCorpus({
		"README.md": README,
		"prefer-dark-theme.md": ACTIVE_NOTE,
		"old-edge-setting.md": OLD_NOTE,
		"heading-only.md": HEADING_NOTE,
	});
	const json = runJsonOk([], root);
	assert.equal(asNumber(json.totalNotes), 3);
	const bySlug = new Map(notesOf(json).map((note) => [asString(note.slug), note]));
	assert.equal(bySlug.has("README"), false);
	const theme = bySlug.get("prefer-dark-theme");
	assert.ok(theme);
	assert.equal(asString(theme.title), "Prefer dark theme");
	assert.equal(asString(theme.titleSource), "frontmatter");
	assert.equal(asString(cuesOf(theme).title), "title: Prefer dark theme");
	assert.equal(asString(cuesOf(theme).tags), "tags: [preference, ui]");
	assert.equal(asString(cuesOf(theme).status), "status: active");
	assert.equal(asString(cuesOf(theme).supersedes), "supersedes: []");
	assert.equal(asString(cuesOf(theme).superseded_by), "superseded_by: null");
	assert.equal(asString(theme.metadata), "ok");
	assert.equal(asBoolean(theme.cuesClipped), false);
	const heading = bySlug.get("heading-only");
	assert.ok(heading);
	assert.equal(asString(heading.title), "Heading only note");
	assert.equal(asString(heading.titleSource), "heading");
	assert.equal(asString(heading.metadata), "absent");
});

test("queries raw source and title/tag cues plus filename/slug", () => {
	const root = makeCorpus({
		"README.md": README,
		"prefer-dark-theme.md": ACTIVE_NOTE,
		"old-edge-setting.md": OLD_NOTE,
	});
	assert.equal(asNumber(runJsonOk(["--query", "UI"], root).totalMatches), 1);
	assert.equal(asNumber(runJsonOk(["--query", "old-edge"], root).totalMatches), 1);
	const body = runJsonOk(["--query", "zebra-feature"], root);
	assert.equal(asNumber(body.totalMatches), 1);
	assert.equal(asBoolean(notesOf(body)[0].cueMatch), false);
	assert.equal(asString(cuesOf(notesOf(body)[0]).status), "status: superseded");
	assert.equal(asNumber(runJsonOk(["--query", "dark interface"], root).totalMatches), 0);
	assert.equal(asNumber(runJsonOk(["--query", "UI.*"], root).totalMatches), 0);
	const slug = notesOf(runJsonOk(["--query", "old-edge"], root))[0];
	assert.equal(asBoolean(slug.cueMatch), true);
	assert.equal(slug.sourceMatch, null);
	assert.match(asString(slug.digest), /^[a-f0-9]{64}$/);
});

test("does not split comma-bearing tag values", () => {
	const root = makeCorpus({
		"README.md": README,
		"comma-tag.md": '---\ntitle: Comma tag\ntags: ["a,b", c]\n---\n\n# Comma tag\n',
	});
	const json = runJsonOk(["--query", "a,b"], root);
	assert.equal(asNumber(json.totalMatches), 1);
	assert.equal(asString(notesOf(json)[0].slug), "comma-tag");
	assert.equal(asString(cuesOf(notesOf(json)[0]).tags), 'tags: ["a,b", c]');
});

test("reaches every indexed record under maximal cue metadata", () => {
	const files: Record<string, string> = { "README.md": README };
	for (let index = 0; index < 30; index += 1) {
		files[`max-${String(index).padStart(2, "0")}.md`] = maximalNote(index);
	}
	const root = makeCorpus(files);
	const seen = new Set<string>();
	for (const page of drainIndex(root)) {
		for (const note of notesOf(page)) {
			const slug = asString(note.slug);
			assert.ok(!seen.has(slug), `duplicate record ${slug}`);
			seen.add(slug);
			assert.equal(typeof note.title, "string");
		}
	}
	assert.equal(seen.size, 30);
});

test("distinguishes a clean empty corpus, a query miss, and uncertain emptiness", () => {
	const empty = makeCorpus({ "README.md": README });
	assert.equal(asBoolean(runJsonOk([], empty).corpusEmpty), true);
	const miss = runJsonOk(["--query", "nothing-matches"], empty);
	assert.equal(asNumber(miss.totalMatches), 0);
	assert.equal(asBoolean(miss.corpusEmpty), true);

	const nonEmpty = makeCorpus({ "README.md": README, "good.md": ACTIVE_NOTE });
	assert.equal(asBoolean(runJsonOk([], nonEmpty).corpusEmpty), false);

	const hidden = makeCorpus({ "README.md": README });
	mkdirSync(join(hidden, "bad.md"));
	const uncertain = runJsonOk([], hidden);
	assert.equal(uncertain.corpusEmpty, null);
	assert.equal(asNumber(uncertain.totalNotes), 0);
});

test("requires an absolute existing PI_MEMORY_DIR with a readable README and never creates it", () => {
	const missing = runError([], null);
	assert.equal(missing.status, 3);
	assert.match(missing.stderr, /Memory unavailable/);
	const relative = runError([], "relative/corpus");
	assert.equal(relative.status, 3);
	assert.match(relative.stderr, /absolute/);
	const absentRoot = join(tmpdir(), `memory-lookup-absent-${process.pid}-${Date.now()}`);
	const absent = runError([], absentRoot);
	assert.equal(absent.status, 3);
	assert.equal(existsSync(absentRoot), false);
	const noReadme = makeCorpus({ "only-note.md": ACTIVE_NOTE });
	const result = runError([], noReadme);
	assert.equal(result.status, 3);
	assert.match(result.stderr, /README\.md/);
});

test("preserves a leading UTF-8 byte order mark in source pages", () => {
	const source = `\uFEFF${ACTIVE_NOTE}`;
	const root = makeCorpus({ "README.md": README, "marked-note.md": source });
	const note = runJsonOk(["--note", "marked-note"], root);
	assert.equal(asString(note.content), source);
});

test("reads a note source and the README contract", () => {
	const root = makeCorpus({ "README.md": README, "prefer-dark-theme.md": ACTIVE_NOTE });
	const note = runJsonOk(["--note", "prefer-dark-theme"], root);
	assert.equal(asString(note.source), "note");
	assert.equal(asString(note.file), "prefer-dark-theme.md");
	assert.equal(asNumber(note.offset), 0);
	assert.equal(asString(note.content), ACTIVE_NOTE);
	assert.match(asString(note.digest), /^[a-f0-9]{64}$/);
	const contract = runJsonOk(["--note", "README"], root);
	assert.equal(asString(contract.source), "contract");
	assert.equal(asString(contract.file), "README.md");
	assert.equal(asString(contract.content), README);
});

function collectPages(root: string, slug: string): { text: string; pages: Json[] } {
	let offset = 0;
	let digest: string | null = null;
	let text = "";
	const pages: Json[] = [];
	for (let guard = 0; guard < 64; guard += 1) {
		const args = ["--note", slug, "--offset", String(offset)];
		if (digest !== null) args.push("--digest", digest);
		const page = runJsonOk(args, root);
		const content = asString(page.content);
		assert.equal(Buffer.from(content, "utf8").toString("utf8"), content, "page content must survive UTF-8 round trip");
		text += content;
		pages.push(page);
		if (asBoolean(page.hasMore) !== true) return { text, pages };
		offset = asNumber(page.nextOffset);
		digest = asString(page.digest);
	}
	throw new Error("page walk exceeded its guard");
}

test("continues a Unicode source across code-point pages without loss", () => {
	const unit = "é😀中abc";
	const body = unit.repeat(1500);
	const source = `---\ntitle: Unicode\n---\n\n# Unicode\n\n${body}`;
	const root = makeCorpus({ "README.md": README, "unicode-note.md": source });
	const { text, pages } = collectPages(root, "unicode-note");
	assert.ok(pages.length >= 2, "expected more than one page");
	assert.equal(text, source);
	assert.ok(!text.includes("\uFFFD"));
});

test("rejects a changed source for a supplied digest", () => {
	const root = makeCorpus({ "README.md": README, "prefer-dark-theme.md": ACTIVE_NOTE });
	const first = runJsonOk(["--note", "prefer-dark-theme"], root);
	const offset = asNumber(first.nextOffset);
	const digest = asString(first.digest);
	writeFileSync(join(root, "prefer-dark-theme.md"), `${ACTIVE_NOTE}\nextra line\n`);
	const changed = runError(["--note", "prefer-dark-theme", "--offset", String(offset), "--digest", digest], root);
	assert.equal(changed.status, 4);
	assert.match(changed.stderr, /changed/);
});

test("accepts exactly 64 KiB and refuses a larger or invalid UTF-8 source", () => {
	const exact = "x".repeat(64 * 1024);
	const root = makeCorpus({ "README.md": README, "exact.md": exact, "over.md": `${exact}x` });
	const accepted = runJsonOk(["--note", "exact"], root);
	assert.equal(asNumber(accepted.sourceBytes), 64 * 1024);
	const refused = runError(["--note", "over"], root);
	assert.equal(refused.status, 3);
	assert.match(refused.stderr, /65536-byte source limit/);
	assert.ok(issueCodes(runJsonOk([], root)).includes("note.oversized"));

	writeFileSync(join(root, "bad-utf8.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
	const badIndex = runJsonOk([], root);
	assert.ok(issueCodes(badIndex).includes("note.unreadable"));
	const badNote = runError(["--note", "bad-utf8"], root);
	assert.equal(badNote.status, 3);
	assert.match(badNote.stderr, /valid UTF-8/);
});

test("opens with O_NOFOLLOW and O_NONBLOCK, and refuses ELOOP and nonregular notes", () => {
	assert.ok((NOTE_OPEN_FLAGS & constants.O_NOFOLLOW) !== 0, "note opens must request O_NOFOLLOW");
	assert.ok((NOTE_OPEN_FLAGS & constants.O_NONBLOCK) !== 0, "note opens must request O_NONBLOCK");
	const root = makeCorpus({ "README.md": README, "prefer-dark-theme.md": ACTIVE_NOTE });
	const loopError = new Error("too many levels of symbolic links") as NodeJS.ErrnoException;
	loopError.code = "ELOOP";
	const loop = openRegular(join(root, "prefer-dark-theme.md"), () => {
		throw loopError;
	});
	assert.equal(loop.ok, false);
	if (!loop.ok) assert.match(loop.reason, /symbolic link/);

	mkdirSync(join(root, "directory.md"));
	const nonregular = runError(["--note", "directory"], root);
	assert.equal(nonregular.status, 3);
	assert.match(nonregular.stderr, /nonregular/);
});

test("caps the directory scan and reports null emptiness when notes may be hidden", () => {
	const files: Record<string, string> = { "README.md": README };
	for (let index = 0; index < 520; index += 1) files[`entry-${index}.txt`] = "not a note";
	const root = makeCorpus(files);
	const json = runJsonOk([], root);
	const scan = asObject(json.scan);
	assert.equal(asBoolean(scan.complete), false);
	assert.equal(asNumber(scan.visited), 513);
	assert.ok(issueCodes(json).includes("scan.limit"));
	assert.equal(json.corpusEmpty, null);
});

test("only includes names --note reproduces, excluding foo.MD and foo.md.md", () => {
	assert.equal(addressableSlug("foo.md"), "foo");
	assert.equal(addressableSlug("FOO.md"), "FOO");
	assert.equal(addressableSlug("foo.MD"), undefined);
	assert.equal(addressableSlug("foo.md.md"), undefined);
	assert.equal(addressableSlug("bad name.md"), undefined);
	assert.equal(addressableSlug("README.md"), undefined);
	assert.equal(addressableSlug("foo.txt"), undefined);

	const root = makeCorpus({
		"README.md": README,
		"good.md": ACTIVE_NOTE,
		"UPPER.MD": "# Upper\n",
		"double.md.md": "# Double\n",
		"bad name.md": "# Bad name\n",
	});
	const json = runJsonOk([], root);
	assert.deepEqual(
		notesOf(json).map((note) => asString(note.slug)),
		["good"],
	);
	assert.ok(issueCodes(json).includes("note.unaddressable"));
	for (const note of notesOf(json)) {
		const page = runJsonOk(["--note", asString(note.slug)], root);
		assert.equal(asString(page.file), asString(note.file));
	}
});

test("flags duplicate, multiline, and clipped cues and unclosed frontmatter", () => {
	const root = makeCorpus({
		"README.md": README,
		"duplicate.md": "---\ntitle: A\ntitle: B\n---\n\n# H\n",
		"multiline.md": "---\ntags:\n  - a\n  - b\nstatus: active\n---\n\n# H\n",
		"clipped.md": `---\ntitle: ${"x".repeat(300)}\n---\n\n# H\n`,
		"unclosed.md": "---\ntitle: A\n",
		"huge.md": `---\ntitle: Huge\nblob: ${"y".repeat(9000)}\n---\n\n# Huge\n`,
	});
	const json = runJsonOk([], root);
	const bySlug = new Map(notesOf(json).map((note) => [asString(note.slug), note]));
	const duplicate = bySlug.get("duplicate");
	assert.ok(duplicate);
	assert.equal(asBoolean(duplicate.cuesDuplicate), true);
	assert.equal(asString(cuesOf(duplicate).title), "title: A");
	assert.match(asString(duplicate.metadataIssue), /duplicate/);
	const multiline = bySlug.get("multiline");
	assert.ok(multiline);
	assert.equal(asBoolean(multiline.cuesMultiline), true);
	assert.match(asString(multiline.metadataIssue), /multiline/);
	const clipped = bySlug.get("clipped");
	assert.ok(clipped);
	assert.equal(asBoolean(clipped.cuesClipped), true);
	assert.ok(asString(cuesOf(clipped).title).length <= 240);
	const unclosed = bySlug.get("unclosed");
	assert.ok(unclosed);
	assert.equal(asString(unclosed.metadata), "malformed");
	const huge = bySlug.get("huge");
	assert.ok(huge);
	assert.equal(asString(huge.metadata), "partial");
	assert.ok(issueCodes(json).includes("note.metadata"));
});

test("validates CLI options and boundaries", () => {
	const root = makeCorpus({ "README.md": README, "good.md": ACTIVE_NOTE });
	const cases: Array<[string[], RegExp]> = [
		[["--bogus"], /unknown option/],
		[["--query", "a", "--query", "b"], /duplicate option/],
		[["--note", "good.md"], /without the \.md extension/],
		[["--note", "good", "--query", "a"], /cannot be combined/],
		[["--note", "good", "--index", "2"], /cannot be combined/],
		[["--index", "-1"], /non-negative integer/],
		[["--offset", "5"], /requires --note/],
		[["--note", "good", "--offset", "5"], /requires --digest/],
		[["--note", "good", "--digest", "nope"], /64-character/],
		[["--query", "x".repeat(201)], /maximum is 200/],
	];
	for (const [args, pattern] of cases) {
		const result = runError(args, root);
		assert.equal(result.status, 2, `expected usage error for ${args.join(" ")}: ${result.stderr}`);
		assert.match(result.stderr, pattern);
	}
	const help = run(["--help"], root);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /--query/);
	assert.match(help.stdout, /PI_MEMORY_DIR/);
	assert.match(help.stdout, /Exit codes/);
});

test("stays read-only for the index, note reads, and missing roots", () => {
	const root = makeCorpus({ "README.md": README, "good.md": ACTIVE_NOTE });
	const before = readdirSync(root).sort();
	runJsonOk([], root);
	runJsonOk(["--query", "theme"], root);
	runJsonOk(["--query", "absent knowledge"], root);
	runJsonOk(["--note", "good"], root);
	runJsonOk(["--note", "README"], root);
	runError(["--note", "absent-note"], root);
	const after = readdirSync(root).sort();
	assert.deepEqual(after, before);
	assert.equal(readFileSync(join(root, "good.md"), "utf8"), ACTIVE_NOTE);
});

test("bounds serialized output for escaping content and a long root", () => {
	const root = mkdtempSync(join(tmpdir(), "memory-lookup-deep-"));
	cleanupRoots.push(root);
	let deep = root;
	while (deep.length < 600) {
		deep = join(deep, "segment-name-".padEnd(60, "x"));
		mkdirSync(deep);
	}
	writeFileSync(join(deep, "README.md"), README);
	writeFileSync(join(deep, "control.md"), `# Control\n\n${"\u0001".repeat(20 * 1024)}`);
	const json = runJsonOk(["--note", "control"], deep);
	assert.ok(asNumber(json.sourceBytes) > 4000);
	assert.ok(Buffer.byteLength(JSON.stringify(json)) < 50 * 1024);
});

test("extracts verbatim cue lines without YAML interpretation", () => {
	const absent = extractCue("# Title\n", false);
	assert.equal(absent.metadata, "absent");
	const ok = extractCue(
		'---\ntitle: "A: B"\ntags: [x, y]\nstatus: active\nsuperseded_by: null\ncreated: 2025-01-01\n---\n\n# A\n',
		false,
	);
	assert.equal(ok.metadata, "ok");
	assert.equal(ok.lines.get("title"), 'title: "A: B"');
	assert.equal(ok.lines.get("tags"), "tags: [x, y]");
	assert.equal(ok.lines.get("superseded_by"), "superseded_by: null");
	const duplicate = extractCue("---\ntitle: A\ntitle: B\n---\n\n# A\n", false);
	assert.equal(duplicate.duplicate, true);
	assert.match(duplicate.issue ?? "", /duplicate/);
	const multiline = extractCue("---\ntags:\n  - a\n---\n\n# A\n", false);
	assert.equal(multiline.multiline, true);
	assert.match(multiline.issue ?? "", /multiline/);
	const malformed = extractCue("---\ntitle: A\n", false);
	assert.equal(malformed.metadata, "malformed");
	const partial = extractCue(`---\ntitle: A\n${"y".repeat(9000)}`, true);
	assert.equal(partial.metadata, "partial");
	assert.equal(partial.issue, "frontmatter not closed within the read window");
});

function assertSourceLocation(note: Json, source: string, expectedText: string): Json {
	const match = asObject(note.sourceMatch);
	const points = Array.from(source);
	const offset = asNumber(match.offset);
	const endOffset = asNumber(match.endOffset);
	assert.equal(points.slice(offset, endOffset).join(""), expectedText);
	assert.equal(offset, Array.from(source.slice(0, source.indexOf(expectedText))).length);
	const excerptOffset = asNumber(match.excerptOffset);
	const excerptEnd = asNumber(match.excerptEndOffset);
	assert.equal(asString(match.excerpt), points.slice(excerptOffset, excerptEnd).join(""));
	assert.ok(excerptOffset <= offset && excerptEnd >= endOffset);
	assert.ok(excerptEnd - excerptOffset <= 480);
	assert.equal(asString(note.digest), createHash("sha256").update(source).digest("hex"));
	return match;
}

test("keeps unfiltered browsing cue-only, including blank queries", () => {
	const root = makeCorpus({ "README.md": README, "good.md": ACTIVE_NOTE });
	for (const args of [[], ["--query", "  "]]) {
		const index = runJsonOk(args, root);
		assert.equal(index.search, undefined);
		assert.equal(notesOf(index)[0].digest, undefined);
		assert.equal(notesOf(index)[0].sourceMatch, undefined);
		assert.equal(asString(cuesOf(notesOf(index)[0]).title), "title: Prefer dark theme");
	}
});

test("returns original locations through lowercase expansion, contextual casing, and multibyte text", () => {
	const cases: Array<[string, string, string]> = [
		["\uFEFF😀İ prefix\r\nA NEEDLE after é中.", "needle", "NEEDLE"],
		["😀İ😀İ😀 NEEDLE", "needle", "NEEDLE"],
		["😀İstanbul", "i", "İ"],
		["😀İstanbul", "\u0307", "İ"],
		["😀İstanbul", "i\u0307s", "İs"],
		["😀 ΟΔΟΣ after", "οδος", "ΟΔΟΣ"],
		["😀 Σ before ΟΣ after", "ΟΣ", "ΟΣ"],
		["😀 e\u0301 中 𐐀", "𐐨", "𐐀"],
		["before a.b+[x] after", "a.b+[x]", "a.b+[x]"],
	];
	for (const [source, query, expected] of cases) {
		const root = makeCorpus({ "README.md": README, "note.md": source });
		const index = runJsonOk(["--query", query], root);
		assert.equal(asNumber(index.totalMatches), 1, JSON.stringify({ source, query }));
		const note = notesOf(index)[0];
		const match = assertSourceLocation(note, source, expected);
		const page = runJsonOk(
			["--note", "note", "--offset", String(match.excerptOffset), "--digest", asString(note.digest)],
			root,
		);
		assert.equal(asString(page.content), Array.from(source).slice(asNumber(match.excerptOffset)).join(""));
	}
	const decomposed = makeCorpus({ "README.md": README, "note.md": "e\u0301" });
	assert.equal(asNumber(runJsonOk(["--query", "é"], decomposed).totalMatches), 0);
});

test("keeps the complete source match within an excerpt when lowercase expands the query", () => {
	const query = "\u0130".repeat(200);
	const matched = "i\u0307".repeat(200);
	const source = `${"p".repeat(120)}${matched} tail`;
	const root = makeCorpus({ "README.md": README, "note.md": source });
	const index = runJsonOk(["--query", query], root);
	assert.equal(asNumber(index.totalMatches), 1);
	const match = assertSourceLocation(notesOf(index)[0], source, matched);
	assert.equal(asNumber(match.offset), 120);
	assert.equal(asNumber(match.endOffset), 520);
	assert.equal(asNumber(match.excerptOffset), 40);
	assert.equal(asNumber(match.excerptEndOffset), 520);
});

test("searches introductory prose, fenced content, and source tails without section parsing", () => {
	const intro =
		"---\ntitle: Display\nstatus: active\n---\n\nDisable animated transitions.\n\n# Display\n\nDo not apply this to video playback.\n";
	const fenced =
		"---\ntitle: Preview\n---\n\n# Preview\n\nUse vector output. The following example is retired.\n\n```text\n# Raster example\nrender_mode = raster\n```\n\nKeep vector output.\n";
	const tail = `${ACTIVE_NOTE}\n${"😀 filler line\n".repeat(1500)}\nOnly choose a quiet room when there is no fee.\n`;
	const root = makeCorpus({ "README.md": README, "intro.md": intro, "fenced.md": fenced, "tail.md": tail });
	for (const [slug, source, query] of [
		["intro", intro, "animated transitions"],
		["fenced", fenced, "render_mode"],
		["tail", tail, "quiet room"],
	]) {
		const index = runJsonOk(["--query", query], root);
		assert.equal(asNumber(index.totalMatches), 1);
		const note = notesOf(index)[0];
		assert.equal(asString(note.slug), slug);
		assertSourceLocation(note, source, query);
		assert.equal(asBoolean(note.cueMatch), false);
		assert.equal(asBoolean(asObject(index.search).complete), true);
	}
	const note = notesOf(runJsonOk(["--query", "quiet room"], root))[0];
	const match = asObject(note.sourceMatch);
	assert.ok(asNumber(match.offset) > 8192);
	const page = runJsonOk(
		["--note", "tail", "--offset", String(match.excerptOffset), "--digest", asString(note.digest)],
		root,
	);
	assert.match(asString(page.content), /no fee/);
});

test("exposes only the first occurrence as an excerpt without hiding later source pages", () => {
	const source = `${ACTIVE_NOTE}\nneedle before a qualification\n${"x".repeat(6000)}\nneedle with a later qualification\n`;
	const root = makeCorpus({ "README.md": README, "note.md": source });
	const index = runJsonOk(["--query", "needle"], root);
	assert.equal(asBoolean(asObject(index.search).firstMatchOnly), true);
	const match = assertSourceLocation(notesOf(index)[0], source, "needle");
	assert.ok(asNumber(match.excerptEndOffset) < Array.from(source).length);
	const full = collectPages(root, "note");
	assert.equal(full.text, source);
	assert.match(full.text, /later qualification/);
});

test("binds a query match to the first source read and observes edits and deletions on the next query", () => {
	const source = `${ACTIVE_NOTE}\nbody phrase\n`;
	const root = makeCorpus({ "README.md": README, "good.md": source });
	const first = notesOf(runJsonOk(["--query", "body phrase"], root))[0];
	const digest = asString(first.digest);
	assert.equal(asString(runJsonOk(["--note", "good", "--digest", digest], root).content), source);
	writeFileSync(join(root, "good.md"), `${ACTIVE_NOTE}\nreplacement phrase\n`);
	const changed = runError(["--note", "good", "--digest", digest], root);
	assert.equal(changed.status, 4);
	assert.match(changed.stderr, /changed/);
	assert.equal(asNumber(runJsonOk(["--query", "body phrase"], root).totalMatches), 0);
	assert.equal(asNumber(runJsonOk(["--query", "replacement phrase"], root).totalMatches), 1);
	rmSync(join(root, "good.md"));
	const removed = runJsonOk(["--query", "replacement phrase"], root);
	assert.equal(asNumber(removed.totalMatches), 0);
	assert.equal(asBoolean(asObject(removed.search).complete), true);
});

test("separates source coverage gaps from query misses and raw metadata warnings", () => {
	const root = makeCorpus({
		"README.md": README,
		"good.md": "---\ntitle: First\ntitle: Duplicate\n---\n\nneedle\n",
		"large.md": `# Large\n${"x".repeat(65536)}needle`,
		"bad name.md": "needle",
	});
	mkdirSync(join(root, "directory.md"));
	writeFileSync(join(root, "invalid.md"), Buffer.concat([Buffer.from("x".repeat(9000)), Buffer.from([0xff])]));
	const index = runJsonOk(["--query", "needle"], root);
	const search = asObject(index.search);
	assert.equal(asBoolean(asObject(index.scan).complete), true);
	assert.equal(asBoolean(search.complete), false);
	assert.equal(asNumber(search.notesSearched), 1);
	assert.equal(asNumber(search.unavailableNotes), 4);
	assert.equal(asNumber(index.totalMatches), 1);
	assert.deepEqual(
		issueCodes(index).sort(),
		["note.metadata", "note.nonregular", "note.oversized", "note.unaddressable", "note.unreadable"].sort(),
	);
	const missing = runJsonOk(["--query", "nothing"], root);
	assert.equal(asNumber(missing.totalMatches), 0);
	assert.equal(asBoolean(asObject(missing.search).complete), false);
	assert.equal(asNumber(runJsonOk(["--query", "large"], root).totalMatches), 0);
	assert.ok(notesOf(runJsonOk([], root)).some((note) => note.slug === "large"));

	const metadataOnly = makeCorpus({ "README.md": README, "note.md": "---\ntitle: Unclosed\n\nneedle" });
	const complete = runJsonOk(["--query", "needle"], metadataOnly);
	assert.equal(asBoolean(asObject(complete.search).complete), true);
	assert.equal(asString(notesOf(complete)[0].metadata), "malformed");
	assert.equal(asNumber(asObject(complete.search).unavailableNotes), 0);
});

test("queries a source exactly at the byte bound and excludes hidden and contract contents", () => {
	const prefix = "😀".repeat(16_382);
	const source = `${prefix}sentinel`;
	assert.equal(Buffer.byteLength(source), 65536);
	const root = makeCorpus({ "README.md": `${README}\ncontract-only`, "exact.md": source, ".hidden.md": "hidden-only" });
	const index = runJsonOk(["--query", "sentinel"], root);
	assertSourceLocation(notesOf(index)[0], source, "sentinel");
	assert.equal(asBoolean(asObject(index.search).complete), true);
	assert.equal(asNumber(runJsonOk(["--query", "contract-only"], root).totalMatches), 0);
	assert.equal(asNumber(runJsonOk(["--query", "hidden-only"], root).totalMatches), 0);
	const noReadme = makeCorpus({ "good.md": "sentinel" });
	assert.equal(runError(["--query", "sentinel"], noReadme).status, 3);
	assert.equal(runError(["--query", "sentinel"], null).status, 3);
});

test("reports directory limits and counts unavailable notes beyond retained issue detail", () => {
	const files: Record<string, string> = { "README.md": README };
	for (let index = 0; index < 30; index += 1) files[`bad ${index}.md`] = "needle";
	const root = makeCorpus(files);
	const index = runJsonOk(["--query", "needle"], root);
	assert.equal(asNumber(asObject(index.search).unavailableNotes), 30);
	assert.equal(asNumber(asObject(index.scan).issueCount), 30);
	assert.equal(asNumber(asObject(index.scan).issuesShown), 20);
	assert.equal(index.corpusEmpty, null);
	const many: Record<string, string> = { "README.md": README };
	for (let count = 0; count < 520; count += 1) many[`entry-${count}.txt`] = "not a note";
	const limited = runJsonOk(["--query", "needle"], makeCorpus(many));
	assert.equal(asBoolean(asObject(limited.search).complete), false);
	assert.equal(asNumber(asObject(limited.scan).visited), 513);
	assert.ok(issueCodes(limited).includes("scan.limit"));
});

test("paginates escaped source matches without skipping records or treating metadata warnings as unread source", () => {
	const files: Record<string, string> = { "README.md": README };
	for (let index = 0; index < 30; index += 1) {
		files[`note-${String(index).padStart(2, "0")}.md`] =
			`${maximalNote(index)}\n${"\u0001".repeat(600)}needle${"\u0001".repeat(600)}`;
	}
	const root = makeCorpus(files);
	const pages = drainIndex(root, ["--query", "needle"]);
	assert.ok(asNumber(pages[0].returned) < 25, "serialized byte bound must shrink this page");
	const seen: string[] = [];
	for (const page of pages) {
		assert.equal(asBoolean(asObject(page.search).complete), true);
		assert.equal(asNumber(asObject(page.search).notesSearched), 30);
		for (const note of notesOf(page)) {
			const slug = asString(note.slug);
			assert.ok(!seen.includes(slug));
			seen.push(slug);
			assertSourceLocation(note, files[`${slug}.md`], "needle");
		}
	}
	assert.equal(seen.length, 30);
	assert.deepEqual(seen, [...seen].sort());
});

test("returns lifecycle cues verbatim and does not suppress conflicting or superseded source hits", () => {
	const root = makeCorpus({
		"README.md": README,
		"active.md": "---\ntitle: Current\nstatus: active\nsupersedes: [old]\n---\n\nUse bullets for a weekly report.\n",
		"old.md":
			"---\ntitle: Previous\nstatus: superseded\nsuperseded_by: active\n---\n\nUse prose for a weekly report.\n",
		"conflict.md": "---\ntitle: Other\nstatus: active\n---\n\nUse a table for a weekly report.\n",
	});
	const index = runJsonOk(["--query", "weekly report"], root);
	assert.equal(asNumber(index.totalMatches), 3);
	assert.deepEqual(
		notesOf(index).map((note) => asString(note.slug)),
		["active", "conflict", "old"],
	);
	assert.equal(asString(cuesOf(notesOf(index)[2]).status), "status: superseded");
	assert.equal(asString(cuesOf(notesOf(index)[0]).supersedes), "supersedes: [old]");
});

test("slices by code point and trims incomplete UTF-8 windows", () => {
	const sliced = sliceByCodePoints("😀ab", 0, 1);
	assert.equal(sliced.content, "😀");
	assert.equal(sliced.nextOffset, 1);
	assert.equal(sliced.hasMore, true);
	assert.equal(sliceByCodePoints("😀ab", 1, 1).content, "a");
	const complete = Buffer.from([0x61, 0xc3, 0xa9]);
	assert.equal(trimUtf8(complete, true).toString("utf8"), "aé");
	const split = Buffer.from([0x61, 0xc3]);
	assert.equal(trimUtf8(split, true).toString("utf8"), "a");
});
