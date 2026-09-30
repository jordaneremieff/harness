import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { Value } from "typebox/value";
import { memorySearchOutputSchema } from "./search-output.ts";
import {
	MemoryRetrievalError,
	memoryIndex,
	NOTE_OPEN_FLAGS,
	type ReadOptions,
	type SearchOptions,
	addressableSlug,
	extractCue,
	openRegular,
	readMemory,
	searchMemory,
	sliceByCodePoints,
	trimUtf8,
} from "./retrieval.ts";

test("cue title fallback ignores fenced examples and preserves heading levels one through six", async () => {
	for (let level = 1; level <= 6; level++) {
		const root = corpus({
			"README.md": "Contract",
			"subject.md": `---\nstatus: active\n---\nIntro\n\n\`\`\`md\n# comment\n\`\`\`\n\n~~~~\n## another comment\n~~~\n# still fenced\n~~~~\n\n${"#".repeat(level)} Real subject ###\nBody`,
		});
		assert.equal(notes(await search(root))[0].title, "Real subject");
	}
	const root = corpus({ "README.md": "Contract", "subject.md": "~~~\n# Only a fenced example" });
	assert.equal(notes(await search(root))[0].title, "subject");
});

type Json = Record<string, unknown>;
const cleanupRoots: string[] = [];
after(() => {
	for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});
function object(value: unknown): Json {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as Json;
}
function array(value: unknown): unknown[] {
	assert.ok(Array.isArray(value));
	return value;
}
function string(value: unknown): string {
	assert.equal(typeof value, "string");
	return value as string;
}
function number(value: unknown): number {
	assert.equal(typeof value, "number");
	return value as number;
}
function notes(result: Json): Json[] {
	return array(result.notes).map(object);
}
function issues(result: Json): string[] {
	return array(object(result.scan).issues).map((issue) => string(object(issue).code));
}
function corpus(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "memory-retrieval-"));
	cleanupRoots.push(root);
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}
function boundedJson(value: Json): Json {
	assert.ok(Buffer.byteLength(JSON.stringify(value)) + 1 <= 48 * 1024);
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "result must contain only JSON-compatible data");
	return value;
}
async function search(root: string, options: SearchOptions = {}): Promise<Json> {
	const result = boundedJson(await searchMemory(root, options));
	Value.Assert(memorySearchOutputSchema, result);
	return result;
}
async function read(root: string, options: ReadOptions): Promise<Json> {
	return boundedJson(await readMemory(root, options));
}
async function rejects(
	operation: Promise<unknown>,
	code: MemoryRetrievalError["code"],
	pattern?: RegExp,
): Promise<void> {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof MemoryRetrievalError);
		assert.equal(error.code, code);
		assert.ok(error.message.length <= 500);
		assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/);
		if (pattern) assert.match(error.message, pattern);
		return true;
	});
}
async function drain(root: string, options: SearchOptions = {}): Promise<Json[]> {
	const pages: Json[] = [];
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let guard = 0; guard < 200; guard += 1) {
		const page = await search(root, { ...options, cursor });
		pages.push(page);
		if (!page.hasMore) return pages;
		cursor = string(page.nextCursor);
		assert.equal(seen.has(cursor), false);
		seen.add(cursor);
	}
	throw new Error("cursor walk exceeded guard");
}
async function collect(root: string, slug: string): Promise<{ text: string; pages: Json[] }> {
	let offset = 0;
	let digest: string | undefined;
	let text = "";
	const pages: Json[] = [];
	for (let guard = 0; guard < 64; guard += 1) {
		const page = await read(root, { slug, offset, digest });
		const content = string(page.content);
		assert.equal(Buffer.from(content, "utf8").toString("utf8"), content);
		text += content;
		pages.push(page);
		if (!page.hasMore) return { text, pages };
		offset = number(page.nextOffset);
		digest = string(page.digest);
	}
	throw new Error("source walk exceeded guard");
}
function sourceLocation(note: Json, source: string, expected: string): Json {
	const match = object(note.sourceMatch);
	const points = Array.from(source);
	const offset = number(match.offset);
	const end = number(match.endOffset);
	assert.equal(points.slice(offset, end).join(""), expected);
	assert.equal(offset, Array.from(source.slice(0, source.indexOf(expected))).length);
	const excerptOffset = number(match.excerptOffset);
	const excerptEnd = number(match.excerptEndOffset);
	assert.equal(match.excerpt, points.slice(excerptOffset, excerptEnd).join(""));
	assert.ok(excerptOffset <= offset && excerptEnd >= end);
	assert.ok(excerptEnd - excerptOffset <= 480);
	assert.equal(note.digest, createHash("sha256").update(source).digest("hex"));
	return match;
}
const README = "# Memory corpus contract\n\nThis directory holds durable notes.\n";
const ACTIVE =
	"---\ntitle: Prefer dark theme\ntags: [preference, ui]\nstatus: active\ncreated: 2025-01-02\nupdated: 2025-01-03\nverified: true\nverified_date: 2025-01-03\nsupersedes: []\nsuperseded_by: null\n---\n\n# Prefer dark theme\n\n## Summary\n\nUse the dark theme.\n";
const OLD =
	"---\ntitle: Old edge setting\ntags: [browser]\nstatus: superseded\nsupersedes: []\nsuperseded_by: prefer-dark-theme\n---\n\n# Old edge setting\n\nThe body mentions zebra-feature.\n";
function maximalNote(index: number): string {
	const tags = Array.from({ length: 40 }, (_, key) => `tag-${index}-${key}`.padEnd(80, "x")).join(", ");
	const supersedes = Array.from({ length: 40 }, (_, key) => `slug-${index}-${key}`.padEnd(160, "y")).join(", ");
	return `---\ntitle: ${"T".repeat(300)}\ntags: [${tags}]\nstatus: ${"s".repeat(80)}\nsupersedes: [${supersedes}]\nsuperseded_by: ${"z".repeat(160)}\n---\n\n# Heading ${index}\n`;
}

test("lifecycle selection excludes retired notes without changing lexical ranking among selected notes", async () => {
	const retired = ACTIVE.replace("status: active", "status: retired");
	const files = {
		"README.md": README,
		"active.md": ACTIVE,
		"superseded.md": OLD,
		"unknown.md": "# Unknown\nUse the dark theme.",
	};
	const root = corpus({
		...files,
		"retired.md": retired,
		"retired-invalid.md": retired.replace("superseded_by: null", "superseded_by: [replacement]"),
	});
	const selectedRoot = corpus(files);
	for (const query of [undefined, "dark theme", ["dark theme", "zebra-feature"]]) {
		const page = await search(root, { query });
		const baseline = await search(selectedRoot, { query });
		assert.deepEqual(page.notes, baseline.notes);
		assert.equal(page.includeRetired, false);
		assert.equal(page.excludedRetired, 2);
		assert.equal(page.totalNotes, 3);
		assert.equal(object(page.scan).retiredNotes, 2);
		assert.equal(object(page.scan).excludedRetired, 2);
		if (query) {
			assert.equal(object(page.search).notesSearched, 3);
			assert.equal(object(page.search).excludedRetired, 2);
			assert.deepEqual(object(page.search).terms, object(baseline.search).terms);
		}
		const included = await search(root, { query, includeRetired: true });
		assert.equal(included.includeRetired, true);
		assert.equal(included.excludedRetired, 0);
		assert.equal(included.totalNotes, 5);
		assert.equal(object(included.scan).retiredNotes, 2);
		assert.equal(object(included.scan).excludedRetired, 0);
		const inactive = notes(included).find((item) => item.slug === "retired-invalid");
		assert.ok(inactive);
		assert.equal(object(inactive.lifecycle).status, "retired");
		assert.match(string(object(inactive.lifecycle).problem), /Retired status requires/);
	}
	const first = await search(root, { limit: 1 });
	await rejects(
		searchMemory(root, { includeRetired: true, cursor: string(first.nextCursor) }),
		"changed",
		/request changed/,
	);
	assert.equal((await search(root, { includeRetired: false, cursor: string(first.nextCursor) })).includeRetired, false);
	const explicit = await search(root, { includeRetired: true, limit: 1 });
	await rejects(searchMemory(root, { cursor: string(explicit.nextCursor) }), "changed", /request changed/);
});

test("retired-only source windows preserve exact exclusions and continuation", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let index = 0; index < 4096; index++)
		files[`retired-${String(index).padStart(4, "0")}.md`] = "---\nstatus: retired\nsuperseded_by: null\n---\nneedle";
	files["z-subject.md"] = "needle";
	const root = corpus(files);
	for (const query of [undefined, "needle"]) {
		const first = await search(root, { query });
		assert.deepEqual(first.notes, []);
		assert.equal(first.totalNotes, 0);
		assert.equal(first.excludedRetired, 4096);
		assert.equal(first.corpusEmpty, false);
		assert.equal(first.countScope, "source-window");
		assert.equal(object(first.scan).windowNotes, 4096);
		assert.equal(object(first.scan).unavailableNotes, 0);
		const last = await search(root, { query, cursor: string(first.nextCursor) });
		assert.deepEqual(
			notes(last).map((item) => item.slug),
			["z-subject"],
		);
		assert.equal(last.excludedRetired, 0);
		assert.equal(last.totalNotes, 1);
		assert.equal(last.nextCursor, null);
	}
});

test("search and every note page expose source-specific freshness without renewing it", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-29T23:59:59.999Z") });
	const concern = { date: "2026-09-28", reason: "One claim is disputed.", sources: "Conflicting synthetic source." };
	const lastReview = { date: "2026-09-27", digest: "a".repeat(64), sources: "Synthetic prior source." };
	const source =
		ACTIVE.replace(
			"---\n\n#",
			`review_policy: before-use\nreview_after: 2026-09-30\nreview_flag: ${JSON.stringify(concern)}\nlast_review: ${JSON.stringify(lastReview)}\n---\n\n#`,
		) + "qualified body\n".repeat(2000);
	const root = corpus({ "README.md": README, "subject.md": source });
	const before = readFileSync(join(root, "subject.md"));
	const { text, pages } = await collect(root, "subject");
	assert.equal(text, source);
	assert.ok(pages.length > 1);
	const expected = {
		evaluatedOn: "2026-09-29",
		verified: true,
		verifiedDate: "2025-01-03",
		policy: "before-use",
		reviewAfter: "2026-09-30",
		deadline: "not-due",
		concern,
		lastReview,
		retirement: null,
		problems: [],
	};
	for (const page of pages) assert.deepEqual(page.freshness, expected);
	for (const query of [undefined, "theme", ["theme", "qualified"]]) {
		const item = notes(await search(root, { query }))[0];
		assert.deepEqual(item.freshness, expected);
		assert.deepEqual(item.lifecycle, { status: "active", supersededBy: null });
		assert.equal(item.review_policy, undefined);
		assert.equal(item.review_flag, undefined);
	}
	t.mock.timers.tick(1);
	const next = await read(root, { slug: "subject" });
	assert.equal(object(next.freshness).evaluatedOn, "2026-09-30");
	assert.equal(object(next.freshness).deadline, "due");
	assert.equal(object(next.freshness).verifiedDate, "2025-01-03");
	assert.deepEqual(readFileSync(join(root, "subject.md")), before);
});

test("freshness preserves declarations and qualifies absent or malformed current metadata", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-29T00:00:00.000Z") });
	const cases: Array<[string, string, string, RegExp | null]> = [
		["", "unclassified", "unscheduled", null],
		["review_policy: on-change\nreview_after: null\n", "on-change", "unscheduled", null],
		["review_policy: before-use\nreview_after: 2026-09-29\n", "before-use", "due", null],
		[
			"review_policy: other\nreview_after: 2026-02-30\n",
			"unknown",
			"unknown",
			/Invalid review_policy|Invalid review_after/,
		],
		["review_policy: null\n", "unknown", "unscheduled", /Invalid review_policy/],
		["policy: &policy on-change\nreview_policy: *policy\n", "unknown", "unscheduled", /Ambiguous review_policy/],
		["review_flag: {date: 2026-09-29, reason: concern}\n", "unclassified", "unscheduled", /Invalid review_flag/],
	];
	for (const [fields, policy, deadline, problem] of cases) {
		const source = ACTIVE.replace("---\n\n#", `${fields}---\n\n#`);
		const root = corpus({ "README.md": README, "subject.md": source });
		const freshness = object((await read(root, { slug: "subject" })).freshness);
		assert.equal(freshness.policy, policy, fields);
		assert.equal(freshness.deadline, deadline, fields);
		if (problem) assert.match(array(freshness.problems).join("; "), problem);
		else assert.deepEqual(freshness.problems, []);
	}
	const future = corpus({
		"README.md": README,
		"subject.md": ACTIVE.replace("verified_date: 2025-01-03", "verified_date: 2027-01-01"),
	});
	const freshness = object((await read(future, { slug: "subject" })).freshness);
	assert.equal(freshness.verifiedDate, "2027-01-01");
	assert.match(array(freshness.problems).join("; "), /in the future/);
});

test("freshness enforces the original header byte bound with BOM and CRLF intact", async () => {
	const prefix =
		"\uFEFF---\r\nstatus: active\r\nsuperseded_by: null\r\nverified: true\r\nverified_date: 2025-01-03\r\nreview_policy: on-change\r\ncustom: ";
	const suffix = "\r\n---\r\n";
	for (const size of [8192, 8193]) {
		const header = `${prefix}${"x".repeat(size - Buffer.byteLength(prefix + suffix))}${suffix}`;
		assert.equal(Buffer.byteLength(header), size);
		const root = corpus({ "README.md": README, "subject.md": `${header}# Body\nneedle` });
		const page = await read(root, { slug: "subject" });
		const freshness = object(page.freshness);
		assert.equal(freshness.policy, size === 8192 ? "on-change" : "unknown");
		if (size > 8192) assert.match(array(freshness.problems).join("; "), /within 8 KiB/);
	}
});

test("source byte windows advance through empty pages without claiming a frozen corpus snapshot", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let index = 0; index < 520; index++) files[`a-${String(index).padStart(3, "0")}.md`] = "x".repeat(65536);
	files["zz-target.md"] = "latewindowtoken";
	const root = corpus(files);
	const first = await search(root, { query: "latewindowtoken", limit: 1 });
	assert.deepEqual(first.notes, []);
	assert.equal(first.hasMore, true);
	assert.ok(number(object(first.scan).sourceBytes) <= 32 * 1024 * 1024);
	assert.ok(number(object(first.scan).windowEnd) < 520);
	assert.equal(object(first.coverage).frozenSnapshot, false);
	const next = await search(root, { query: "latewindowtoken", cursor: string(first.nextCursor), limit: 1 });
	assert.deepEqual(
		notes(next).map((note) => note.slug),
		["zz-target"],
	);
	assert.equal(next.nextCursor, null);
	assert.equal(object(next.coverage).traversalComplete, true);
	assert.equal(object(next.search).complete, false);
});

test("browse orders a slug before its extensions across result and source windows", async () => {
	const files: Record<string, string> = { "README.md": README, "a.md": "# First subject" };
	for (let index = 0; index < 4096; index++) files[`a-${String(index).padStart(4, "0")}.md`] = "# Related subject";
	const root = corpus(files);
	const pages = await drain(root, { limit: 512 });
	const found = pages.flatMap(notes).map((note) => note.slug);
	assert.deepEqual(found, ["a", ...Array.from({ length: 4096 }, (_, index) => `a-${String(index).padStart(4, "0")}`)]);
	assert.equal(new Set(found).size, 4097);
	assert.equal(object(pages.at(-1)?.scan).windowStart, 4096);
});

test("browse cursor binds query, complete inventory and source evidence beyond cue bytes", async () => {
	const root = corpus({ "README.md": README, "a.md": `${ACTIVE}${"x".repeat(9000)}`, "b.md": ACTIVE });
	const first = await search(root, { limit: 1 });
	const cursor = string(first.nextCursor);
	await rejects(searchMemory(root, { query: "dark", cursor }), "changed", /request changed/);
	writeFileSync(join(root, "a.md"), `${ACTIVE}${"x".repeat(8999)}y`);
	await rejects(searchMemory(root, { cursor }), "changed", /window changed/);
	const fresh = await search(root, { limit: 1 });
	writeFileSync(join(root, "new.txt"), "inventory only");
	await rejects(searchMemory(root, { cursor: string(fresh.nextCursor) }), "changed", /inventory changed/);
});

test("hard inventory overflow bounds traversal before source work and qualifies the prompt", async (t) => {
	const root = corpus({ "README.md": README });
	let visits = 0;
	t.mock.method(fs, "opendirSync", () => ({
		readSync() {
			visits++;
			return { name: `entry-${visits}`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
		},
		closeSync() {},
	}));
	syncBuiltinESMExports();
	try {
		await rejects(searchMemory(root), "corpus", /16384 entries; 16385 visited/);
		assert.equal(visits, 16385);
		visits = 0;
		assert.match((await memoryIndex(root)) ?? "", /16384 entries; 16385 visited/);
		assert.equal(visits, 16385);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("returns compact literal cues with heading and filename fallback", async () => {
	const root = corpus({
		"README.md": README,
		"prefer-dark-theme.md": ACTIVE,
		"old-edge-setting.md": OLD,
		"heading.md": "# Heading only\n",
		"plain.md": "Body only",
	});
	const result = await search(root);
	assert.equal(result.totalNotes, 4);
	const bySlug = new Map(notes(result).map((note) => [note.slug, note]));
	assert.equal(bySlug.has("README"), false);
	const { lifecycle, freshness, ...activeCues } = object(bySlug.get("prefer-dark-theme"));
	assert.deepEqual(lifecycle, { status: "active", supersededBy: null });
	assert.equal(object(freshness).verified, true);
	assert.equal(object(freshness).verifiedDate, "2025-01-03");
	assert.equal(object(freshness).policy, "unclassified");
	assert.deepEqual(activeCues, {
		slug: "prefer-dark-theme",
		title: "Prefer dark theme",
		tags: "[preference, ui]",
		status: "active",
		supersedes: "[]",
		superseded_by: "null",
	});
	for (const [slug, title] of [
		["heading", "Heading only"],
		["plain", "plain"],
	]) {
		const { lifecycle, freshness, ...cues } = object(bySlug.get(slug));
		assert.deepEqual(cues, { slug, title });
		assert.equal(object(lifecycle).status, "unknown");
		assert.equal(object(freshness).policy, "unknown");
	}
	for (const query of [undefined]) {
		const browse = await search(root, { query });
		assert.equal(browse.search, undefined);
		for (const note of notes(browse)) {
			assert.equal(note.digest, undefined);
			assert.equal(note.sourceMatch, undefined);
		}
	}
});

test("searches full source, cues, and slugs while retaining superseded notes", async () => {
	const root = corpus({ "README.md": README, "prefer-dark-theme.md": ACTIVE, "old-edge-setting.md": OLD });
	for (const query of ["UI", "old-edge", "zebra-feature"])
		assert.equal((await search(root, { query })).totalMatches, 1);
	const body = notes(await search(root, { query: "zebra-feature" }))[0];
	assert.deepEqual(object(array(body.matched)[0]).fields, ["body"]);
	assert.equal(body.status, "superseded");
	const partial = notes(await search(root, { query: "dark interface" }));
	assert.equal(partial.length, 2);
	assert.equal(partial[0].slug, "prefer-dark-theme");
	assert.deepEqual(partial[0].missing, ["interface"]);
	assert.deepEqual(object(array(partial[1].matched)[0]).fields, ["frontmatter"]);
	assert.equal((await search(root, { query: '"UI.*"' })).totalMatches, 0);
	const slug = notes(await search(root, { query: '"old-edge"' }))[0];
	assert.deepEqual(object(array(slug.matched)[0]).fields, ["slug"]);
	assert.equal(slug.sourceMatch, null);
	assert.match(string(slug.digest), /^[a-f0-9]{64}$/);
});

test("fenced comments retain body evidence and Unicode source positions without title rank inflation", async () => {
	for (const [open, close, newline = "\r\n"] of [
		["```sh", "```"],
		["~~~~sh", "~~~~"],
		["   ````sh", "   ````"],
		["```sh", "```", "\r"],
	]) {
		const phrase = "rotate the credential cache";
		const fenced = `Intro 😀${newline}${open}${newline}# ${phrase}${newline}${close}${newline}`;
		const prose = `Intro 😀${newline}${phrase}${newline}`;
		const root = corpus({ "README.md": README, "fenced.md": fenced, "prose.md": prose });
		const found = notes(await search(root, { query: "rotate cache" }));
		assert.deepEqual(
			found.map((note) => note.slug),
			["prose", "fenced"],
		);
		for (const note of found) {
			for (const match of array(note.matched)) assert.deepEqual(object(match).fields, ["body"]);
			sourceLocation(note, note.slug === "fenced" ? fenced : prose, phrase);
		}
		const heading = `${fenced}${newline}## ${phrase}${newline}`;
		writeFileSync(join(root, "heading.md"), heading);
		const result = notes(await search(root, { query: "rotate cache" })).find((note) => note.slug === "heading");
		assert.ok(result);
		for (const match of array(result.matched)) assert.deepEqual(object(match).fields, ["body", "title"]);
		const match = object(result.sourceMatch);
		assert.equal(
			string(match.excerpt),
			Array.from(heading).slice(number(match.excerptOffset), number(match.excerptEndOffset)).join(""),
		);
	}
});

test("string and single-formulation array queries return the same body-first source passage", async () => {
	const source =
		"---\r\ntitle: Compaction settings\r\nstatus: active\r\n---\r\n\r\nIntro 😀\r\ncompaction settings control the boundary.\r\n";
	const root = corpus({ "README.md": README, "subject.md": source });
	const plain = notes(await search(root, { query: "compaction settings" }))[0];
	const arrayForm = notes(await search(root, { query: ["compaction settings"] }))[0];
	assert.deepEqual(plain.sourceMatch, arrayForm.sourceMatch);
	sourceLocation(plain, source, "compaction settings");
	assert.doesNotMatch(string(object(plain.sourceMatch).excerpt), /title:|status:/);
});

test("malformed headers expose qualified raw cues without metadata title weights or active pointers", async () => {
	for (const suffix of ["other: [unclosed\n", "---suffix\ntitle: hidden-title\n"]) {
		const source = `---\nstatus: active\n${suffix}---\nBody sentinel\n`;
		const root = corpus({ "README.md": README, "subject.md": source });
		const cue = notes(await search(root))[0];
		assert.equal(cue.status, "active");
		assert.match(string(cue.cueProblem), /invalid or ambiguous frontmatter/);
		const found = notes(await search(root, { query: suffix.startsWith("---") ? "hidden-title" : "active" }))[0];
		assert.match(string(found.cueProblem), /invalid or ambiguous frontmatter/);
		for (const match of array(found.matched)) assert.deepEqual(object(match).fields, ["body"]);
		const index = await memoryIndex(root);
		assert.match(index ?? "", /Unknown status: 1/);
		assert.doesNotMatch(index ?? "", /^subject:/m);
		assert.equal((await read(root, { slug: "subject" })).content, source);
	}
});

test("Unicode separators never create physical frontmatter delimiters", async () => {
	for (const separator of ["\u2028", "\u2029"]) {
		const source = `---\nstatus: active\ncustom: word${separator}---${separator}tail\ntitle: Physical title\n---\nBody sentinel\n`;
		const root = corpus({ "README.md": README, "subject.md": source });
		const cue = notes(await search(root))[0];
		assert.equal(cue.title, "Physical title");
		assert.equal((await read(root, { slug: "subject" })).content, source);
		const found = notes(await search(root, { query: "Physical" }))[0];
		sourceLocation(found, source, "Physical");
		assert.ok(object(found.sourceMatch).excerptEndOffset);
	}
});

test("preserves comma-bearing tag values", async () => {
	const root = corpus({ "README.md": README, "comma.md": '---\ntitle: Comma tag\ntags: ["a,b", c]\n---\n# Comma\n' });
	const result = await search(root, { query: "a,b" });
	assert.equal(result.totalMatches, 1);
	assert.equal(notes(result)[0].tags, '["a,b", c]');
});

test("distinguishes clean emptiness, query misses, and uncertain emptiness", async () => {
	const empty = corpus({ "README.md": README });
	assert.equal((await search(empty)).corpusEmpty, true);
	const miss = await search(empty, { query: "nothing-matches" });
	assert.equal(miss.totalMatches, 0);
	assert.equal(miss.corpusEmpty, true);
	const nonempty = corpus({ "README.md": README, "good.md": ACTIVE });
	assert.equal((await search(nonempty, { query: "unavailable" })).corpusEmpty, false);
	mkdirSync(join(empty, "bad.md"));
	const uncertain = await search(empty);
	assert.equal(uncertain.corpusEmpty, null);
	assert.equal(uncertain.totalNotes, 0);
});

test("requires an explicit absolute existing root and readable README without writes", async () => {
	for (const root of [undefined, null, 3, "", "relative/corpus"] as unknown as string[]) {
		await rejects(searchMemory(root, {}), "corpus", /absolute/);
	}
	const root = corpus({ "only-note.md": ACTIVE });
	await rejects(searchMemory(root, {}), "corpus", /README\.md/);
	await rejects(readMemory(root, { slug: "only-note" }), "corpus", /README\.md/);
	const absent = join(root, "absent");
	await rejects(searchMemory(absent, {}), "corpus");
	assert.equal(existsSync(absent), false);
	await rejects(searchMemory(join(root, "only-note.md"), {}), "corpus", /directory/);
	await rejects(searchMemory(`/${"x".repeat(1025)}`, {}), "corpus", /1024/);
	await rejects(searchMemory(`${root}\0`, {}), "corpus");
	mkdirSync(join(root, "README.md"));
	await rejects(searchMemory(root, {}), "corpus", /nonregular/);
});

test("reads original note and README source, preserving BOM and code-point pages", async () => {
	const source = `\uFEFF${ACTIVE}${"é😀中abc".repeat(2500)}`;
	const root = corpus({ "README.md": README, "unicode.md": source });
	const { text, pages } = await collect(root, "unicode");
	assert.equal(text, source);
	assert.ok(pages.length > 1);
	assert.equal(pages[0].source, "note");
	assert.equal(pages[0].file, "unicode.md");
	assert.equal(pages[0].offset, 0);
	assert.equal(pages[0].contentCodePoints, 12000);
	assert.equal(pages[0].totalCodePoints, Array.from(source).length);
	const contract = await read(root, { slug: "README" });
	assert.equal(contract.source, "contract");
	assert.equal(contract.file, "README.md");
	assert.equal(contract.content, README);
	assert.equal(contract.lifecycle, null);
	assert.equal(contract.freshness, null);
	const end = await read(root, { slug: "unicode", offset: Array.from(source).length, digest: string(pages[0].digest) });
	assert.equal(end.content, "");
	assert.equal(end.hasMore, false);
	await rejects(
		readMemory(root, { slug: "unicode", offset: Array.from(source).length + 1, digest: string(pages[0].digest) }),
		"input",
		/beyond/,
	);
});

test("binds search evidence and every continuation to the source digest", async () => {
	const source = `${ACTIVE}\nbody phrase\n`;
	const root = corpus({ "README.md": README, "good.md": source });
	const found = notes(await search(root, { query: "body phrase" }))[0];
	const digest = string(found.digest);
	await rejects(readMemory(root, { slug: "good", digest: digest.toUpperCase() }), "input", /lowercase/);
	const page = await read(root, { slug: "good", digest });
	assert.equal(page.content, source);
	writeFileSync(join(root, "good.md"), `${ACTIVE}\nreplacement phrase\n`);
	await rejects(readMemory(root, { slug: "good", digest }), "changed", /Search again.*restart memory_read at offset 0/);
	await rejects(readMemory(root, { slug: "good", offset: number(page.nextOffset), digest }), "changed", /changed/);
	assert.equal((await search(root, { query: '"body phrase"' })).totalMatches, 0);
	assert.equal((await search(root, { query: "replacement phrase" })).totalMatches, 1);
	rmSync(join(root, "good.md"));
	const removed = await search(root, { query: "replacement phrase" });
	assert.equal(removed.totalMatches, 0);
	assert.equal(object(removed.search).complete, true);
	await rejects(readMemory(root, { slug: "good" }), "corpus", /not found.*memory_search.*offset 0.*current digest/);
});

test("a changed contract restarts from zero without an old digest", async () => {
	const root = corpus({ "README.md": README });
	const first = await read(root, { slug: "README" });
	writeFileSync(join(root, "README.md"), `${README}\nChanged contract.`);
	await rejects(
		readMemory(root, { slug: "README", digest: string(first.digest), offset: 1 }),
		"changed",
		/offset 0 without the old digest/,
	);
	const changed = await read(root, { slug: "README", offset: 0 });
	assert.notEqual(changed.digest, first.digest);
	assert.match(string(changed.content), /Changed contract/);
});

test("every note page exposes conservative lifecycle evidence without altering its source", async () => {
	const cases: Array<[string, string, string | null, RegExp | null]> = [
		['status: "active"\nsuperseded_by: null', "active", null, null],
		['status: "superseded"\nsuperseded_by: "new-subject"', "superseded", "new-subject", null],
		['status: "retired"\nsuperseded_by: null', "retired", null, null],
		["status: retired\nsuperseded_by: new-subject", "retired", null, /Retired status requires/],
		["status: retired\nsuperseded_by: [new-subject]", "retired", null, /Retired status requires/],
		["status: retired\nsuperseded_by:\n  - new-subject", "retired", null, /Retired status requires/],
		["status: retired", "retired", null, /Retired status requires/],
		["replacement: &next new-subject\nstatus: superseded\nsuperseded_by: *next", "superseded", "new-subject", null],
		["status: active\nsuperseded_by: new-subject", "unknown", null, /Active status requires/],
		["status: superseded\nsuperseded_by: null", "superseded", null, /different lowercase subject slug/],
		["status: superseded\nsuperseded_by: subject", "superseded", null, /different lowercase subject slug/],
		["status: superseded\nsuperseded_by: Upper", "superseded", null, /different lowercase subject slug/],
		["status: superseded\nsuperseded_by: readme", "superseded", null, /different lowercase subject slug/],
		["status: active", "unknown", null, /Active status requires/],
		["title: Without status", "unknown", null, /plain status key/],
		["status: unusual\nsuperseded_by: null", "unknown", null, /active or superseded/],
		["status: [active]\nsuperseded_by: null", "unknown", null, /active or superseded/],
		["status: active\nstatus: superseded\nsuperseded_by: new-subject", "unknown", null, /frontmatter|duplicate/],
		["status: |\n  active\nsuperseded_by: null", "unknown", null, /plain status key/],
		["status: active\nother: [unclosed\nsuperseded_by: null", "unknown", null, /invalid or ambiguous/],
		["status: active\n---suffix\nsuperseded_by: null", "unknown", null, /invalid or ambiguous/],
	];
	for (const [header, status, replacement, problem] of cases) {
		const source = `---\n${header}\n---\n# Subject\n${"body qualification 😀\n".repeat(750)}`;
		const root = corpus({ "README.md": README, "subject.md": source });
		const { text, pages } = await collect(root, "subject");
		assert.equal(text, source);
		assert.ok(pages.length > 1);
		for (const page of pages) {
			const lifecycle = object(page.lifecycle);
			assert.equal(lifecycle.status, status, header);
			assert.equal(lifecycle.supersededBy, replacement, header);
			if (problem) assert.match(string(lifecycle.problem), problem);
			else assert.equal(lifecycle.problem, undefined);
			assert.deepEqual(lifecycle, pages[0].lifecycle);
		}
		const index = await memoryIndex(root);
		assert.equal(/^subject:/m.test(index ?? ""), status === "active", header);
		if (status === "unknown") assert.match(index ?? "", /Unknown status: 1/);
		assert.equal(readFileSync(join(root, "subject.md"), "utf8"), source);
	}
	const root = corpus({ "README.md": README, "plain.md": "# No metadata\nText" });
	assert.equal(object((await read(root, { slug: "plain" })).lifecycle).status, "unknown");
});

test("accepts exactly 64 KiB and refuses larger or invalid UTF-8 sources", async () => {
	const source = `${"😀".repeat(16_382)}sentinel`;
	assert.equal(Buffer.byteLength(source), 65536);
	const root = corpus({
		"README.md": `${README}\ncontract-only`,
		"exact.md": source,
		"over.md": `${source}x`,
		".hidden.md": "hidden-only",
	});
	assert.equal((await read(root, { slug: "exact" })).sourceBytes, 65536);
	await rejects(readMemory(root, { slug: "over" }), "corpus", /65536-byte/);
	assert.ok(issues(await search(root)).includes("note.oversized"));
	const found = await search(root, { query: "sentinel" });
	sourceLocation(notes(found)[0], source, "sentinel");
	assert.equal(object(found.search).complete, false);
	assert.equal((await search(root, { query: "contract-only" })).totalMatches, 0);
	assert.equal((await search(root, { query: "hidden-only" })).totalMatches, 0);
	writeFileSync(join(root, "bad-utf8.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
	assert.ok(issues(await search(root)).includes("note.unreadable"));
	await rejects(readMemory(root, { slug: "bad-utf8" }), "corpus", /valid UTF-8/);
});

test("requests no-follow and nonblocking opens and rejects symlink errors and nonregular files", async () => {
	assert.ok((NOTE_OPEN_FLAGS & constants.O_NOFOLLOW) !== 0);
	assert.ok((NOTE_OPEN_FLAGS & constants.O_NONBLOCK) !== 0);
	const root = corpus({ "README.md": README, "good.md": ACTIVE });
	const error = Object.assign(new Error("symbolic link"), { code: "ELOOP" });
	const loop = openRegular(join(root, "good.md"), () => {
		throw error;
	});
	assert.equal(loop.ok, false);
	if (!loop.ok) assert.match(loop.reason, /symbolic link/);
	mkdirSync(join(root, "directory.md"));
	await rejects(readMemory(root, { slug: "directory" }), "corpus", /nonregular/);
});

test("reports directory limits and counts unavailable notes beyond retained detail", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 30; i += 1) files[`bad ${i}.md`] = "needle";
	const result = await search(corpus(files), { query: "needle" });
	assert.equal(object(result.search).unavailableNotes, 30);
	assert.equal(object(result.scan).issueCount, 30);
	assert.equal(object(result.scan).issuesShown, 20);
	assert.equal(result.corpusEmpty, null);
	const many: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 520; i += 1) many[`entry-${i}.txt`] = "not a note";
	const root = corpus(many);
	for (const options of [{}, { query: "needle" }]) {
		const limited = await search(root, options);
		assert.equal(object(limited.scan).complete, true);
		assert.equal(object(limited.scan).visited, 521);
		assert.equal(object(limited.scan).inventoryComplete, true);
		assert.equal(limited.corpusEmpty, true);
		if (limited.search) assert.equal(object(limited.search).complete, true);
	}
});

test("includes only filenames that source reads reproduce exactly", async () => {
	for (const [file, expected] of [
		["foo.md", "foo"],
		["FOO.md", "FOO"],
		["foo.MD", undefined],
		["foo.md.md", undefined],
		["bad name.md", undefined],
		["README.md", undefined],
		["foo.txt", undefined],
	])
		assert.equal(addressableSlug(string(file)), expected);
	const root = corpus({
		"README.md": README,
		"good.md": ACTIVE,
		"UPPER.MD": "# Upper",
		"double.md.md": "# Double",
		"bad name.md": "# Bad",
	});
	const result = await search(root);
	assert.deepEqual(
		notes(result).map((note) => note.slug),
		["good"],
	);
	assert.ok(issues(result).includes("note.unaddressable"));
	assert.equal((await read(root, { slug: "good" })).file, "good.md");
});

test("reports duplicate, multiline, empty, clipped, and unclosed cue fields", async () => {
	const root = corpus({
		"README.md": README,
		"duplicate.md": "---\ntitle: A\ntitle: B\n---\n# H\n",
		"multiline.md": "---\ntags:\n  - a\n  - b\nstatus: active\n---\n# H\n",
		"clipped.md": `---\ntitle: ${"x".repeat(300)}\n---\n# H\n`,
		"unclosed.md": "---\ntitle: A\n",
		"huge.md": `---\ntitle: Huge\nblob: ${"y".repeat(9000)}\n---\n# Huge\n`,
		"empty.md": "---\ntitle:\nstatus:\n---\n# Heading\n",
	});
	const result = await search(root);
	const bySlug = new Map(notes(result).map((note) => [note.slug, note]));
	assert.equal(bySlug.get("duplicate")?.title, "A");
	for (const [slug, pattern] of [
		["duplicate", /duplicate/],
		["multiline", /multiline/],
		["clipped", /clipped/],
		["unclosed", /no closing delimiter/],
		["huge", /read window/],
		["empty", /empty/],
	] as const)
		assert.match(string(bySlug.get(slug)?.cueProblem), pattern);
	assert.ok(string(bySlug.get("clipped")?.title).length <= 160);
	assert.equal(bySlug.get("empty")?.status, "");
	assert.equal(bySlug.get("empty")?.title, "Heading");
	assert.ok(issues(result).includes("note.metadata"));
});

test("validates scalar inputs, integer bounds, query grammar, and safe continuation", async () => {
	const root = corpus({ "README.md": README, "good.md": ACTIVE });
	for (const options of [
		null,
		[],
		{ bogus: true },
		{ query: ["a", "b"] },
		{ query: null },
		{ query: 2 },
		{ includeRetired: 1 },
		{ includeRetired: null },
		{ includeRetired: "true" },
		{ query: "x".repeat(201) },
		{ index: 0 },
		{ cursor: -1 },
		{ cursor: "invalid" },
		{ cursor: "x".repeat(1025) },
		{ cursor: null },
		{ limit: 0 },
		{ limit: 513 },
		{ query: "needle", limit: 26 },
		{ limit: 1.5 },
		{ limit: "2" },
		{ limit: null },
		{ limit: Infinity },
	])
		await rejects(searchMemory(root, options as SearchOptions), "input");
	for (const options of [
		null,
		[],
		{},
		{ slug: [] },
		{ slug: "good.md" },
		{ slug: "../good" },
		{ slug: "x".repeat(121) },
		{ slug: "good", offset: 5 },
		{ slug: "good", offset: -1 },
		{ slug: "good", offset: 1_000_000_001 },
		{ slug: "good", offset: "0" },
		{ slug: "good", digest: "nope" },
		{ slug: "good", digest: 2 },
		{ slug: "good", query: "a" },
	])
		await rejects(readMemory(root, options as ReadOptions), "input");
	for (const query of ["the and", "!!!", '""', '"unclosed', Array.from({ length: 17 }, (_, i) => `w${i}`).join(" ")])
		await rejects(searchMemory(root, { query }), "input");
	await rejects(readMemory(root, { slug: "bad\n\u001bname" }), "input", /invalid note slug/);
});

test("blank scalar and array queries require omission for browse", async () => {
	const root = corpus({ "README.md": README });
	for (const query of ["", " \t\n", [""], ["  "]])
		await rejects(searchMemory(root, { query }), "input", /omit query to browse/);
	assert.equal((await search(root)).query, null);
});

test("source reads refuse offsets beyond the note's code-point end", async () => {
	const root = corpus({ "README.md": README, "note.md": "😀abc" });
	const first = await read(root, { slug: "note" });
	await rejects(readMemory(root, { slug: "note", digest: string(first.digest), offset: 5 }), "input", /beyond the end/);
	assert.equal((await read(root, { slug: "note", digest: string(first.digest), offset: 4 })).content, "");
});

test("real symbolic links remain excluded from browse and search", async () => {
	const root = corpus({ "README.md": README, "target.md": "needle" });
	symlinkSync(join(root, "target.md"), join(root, "linked.md"));
	for (const query of [undefined, "needle", ["needle", "target"]]) {
		const result = await search(root, { query });
		assert.deepEqual(
			notes(result).map((note) => note.slug),
			["target"],
		);
		assert.ok(issues(result).includes("note.symlink"));
		assert.equal(object(result.scan).complete, true);
		assert.equal(object(result.scan).unavailableNotes, 1);
		if (query) assert.equal(object(result.search).complete, false);
	}
});

test("query limits explain how to shorten full questions", async () => {
	const root = corpus({ "README.md": README });
	await rejects(searchMemory(root, { query: "word ".repeat(50) }), "input", /Shorten to a keyword formulation/);
	await rejects(
		searchMemory(root, { query: Array.from({ length: 17 }, (_, i) => `term${i}`).join(" ") }),
		"input",
		/Shorten to a keyword formulation/,
	);
});

test("stays read-only for browse, search, source reads, and missing notes", async () => {
	const root = corpus({ "README.md": README, "good.md": ACTIVE });
	const before = readdirSync(root).sort();
	await search(root);
	await search(root, { query: "theme" });
	await search(root, { query: "absent knowledge" });
	await read(root, { slug: "good" });
	await read(root, { slug: "README" });
	await rejects(readMemory(root, { slug: "absent-note" }), "corpus");
	assert.deepEqual(readdirSync(root).sort(), before);
	assert.equal(readFileSync(join(root, "good.md"), "utf8"), ACTIVE);
});

test("bounds escaped source output under a long root", async () => {
	let root = corpus({});
	while (root.length < 600) {
		root = join(root, "segment-name-".padEnd(60, "x"));
		mkdirSync(root);
	}
	writeFileSync(join(root, "README.md"), README);
	writeFileSync(join(root, "control.md"), `# Control\n\n${"\u0001".repeat(20 * 1024)}`);
	const result = await read(root, { slug: "control" });
	assert.ok(number(result.contentCodePoints) > 0 && number(result.contentCodePoints) < 12000);
	assert.equal(result.hasMore, true);
	const collected = await collect(root, "control");
	assert.equal(collected.text, readFileSync(join(root, "control.md"), "utf8"));
});

test("extracts literal cue lines without YAML interpretation", () => {
	assert.equal(extractCue("# Title\n", false).metadata, "absent");
	const cue = extractCue(
		'---\ntitle: "A: B"\ntags: [x, y]\nstatus: active\nsuperseded_by: null\ncreated: 2025-01-01\n---\n# A\n',
		false,
	);
	assert.equal(cue.metadata, "ok");
	assert.equal(cue.lines.get("title"), 'title: "A: B"');
	assert.equal(cue.lines.get("tags"), "tags: [x, y]");
	assert.equal(cue.lines.get("superseded_by"), "superseded_by: null");
	assert.equal(cue.lines.has("created"), false);
	assert.equal(extractCue("---\ntitle: A\ntitle: B\n---\n", false).duplicate, true);
	assert.equal(extractCue("---\ntags:\n  - a\n---\n", false).multiline, true);
	assert.equal(extractCue("---\ntitle: A\n", false).metadata, "malformed");
	const partial = extractCue(`---\ntitle: A\n${"y".repeat(9000)}`, true);
	assert.equal(partial.metadata, "partial");
	assert.equal(partial.issue, "frontmatter not closed within the read window");
});

test("keeps original locations through lowercase expansion, contextual casing, and multibyte text", async () => {
	const cases = [
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
		const root = corpus({ "README.md": README, "note.md": source });
		const result = await search(root, { query: `"${query}"` });
		assert.equal(result.totalMatches, 1);
		const note = notes(result)[0];
		const match = sourceLocation(note, source, expected);
		const page = await read(root, { slug: "note", offset: number(match.excerptOffset), digest: string(note.digest) });
		assert.equal(page.content, Array.from(source).slice(number(match.excerptOffset)).join(""));
	}
	assert.equal((await search(corpus({ "README.md": README, "note.md": "e\u0301" }), { query: "é" })).totalMatches, 0);
});

test("contains the full expanded lowercase match and clips oversized phrase spans", async () => {
	const matched = "i\u0307".repeat(198);
	const source = `${"p".repeat(120)}${matched} tail`;
	const root = corpus({ "README.md": README, "note.md": source });
	const match = sourceLocation(notes(await search(root, { query: `"${"İ".repeat(198)}"` }))[0], source, matched);
	assert.equal(match.offset, 120);
	assert.equal(match.endOffset, 516);
	assert.equal(match.excerptOffset, 36);
	assert.equal(match.excerptEndOffset, 516);
	const long = `start${" ".repeat(9000)}finish`;
	const clipped = object(
		notes(await search(corpus({ "README.md": README, "long.md": long }), { query: '"start finish"' }))[0].sourceMatch,
	);
	assert.equal(clipped.offset, 0);
	assert.equal(clipped.endOffset, 480);
	assert.equal(clipped.excerpt, long.slice(0, 480));
});

test("searches introductions, fenced text, and source tails with no section parsing", async () => {
	const intro =
		"---\ntitle: Display\nstatus: active\n---\n\nDisable animated transitions.\n\n# Display\n\nDo not apply this to video playback.\n";
	const fenced =
		"---\ntitle: Preview\n---\n\n# Preview\n\nUse vector output. The following example is retired.\n\n```text\n# Raster example\nrender_mode = raster\n```\n\nKeep vector output.\n";
	const tail = `${ACTIVE}\n${"😀 filler line\n".repeat(1500)}\nOnly choose a quiet room when there is no fee.\n`;
	const root = corpus({ "README.md": README, "intro.md": intro, "fenced.md": fenced, "tail.md": tail });
	for (const [slug, source, query] of [
		["intro", intro, "animated transitions"],
		["fenced", fenced, "render_mode"],
		["tail", tail, "quiet room"],
	]) {
		const result = await search(root, { query });
		assert.equal(result.totalMatches, 1);
		assert.equal(notes(result)[0].slug, slug);
		sourceLocation(notes(result)[0], source, query);
		assert.equal(object(result.search).complete, true);
	}
	const note = notes(await search(root, { query: "quiet room" }))[0];
	const match = object(note.sourceMatch);
	assert.ok(number(match.offset) > 8192);
	assert.match(
		string(
			(await read(root, { slug: "tail", offset: number(match.excerptOffset), digest: string(note.digest) })).content,
		),
		/no fee/,
	);
});

test("retains later source qualifications beyond a selected passage", async () => {
	const source = `${ACTIVE}\nneedle before a qualification\n${"x".repeat(6000)}\nneedle with a later qualification\n`;
	const root = corpus({ "README.md": README, "note.md": source });
	const result = await search(root, { query: "needle" });
	assert.equal(object(result.search).ranking, "lexical");
	const match = sourceLocation(notes(result)[0], source, "needle");
	assert.ok(number(match.excerptEndOffset) < Array.from(source).length);
	assert.equal((await collect(root, "note")).text, source);
});

test("separates coverage gaps from misses and cue warnings", async () => {
	const root = corpus({
		"README.md": README,
		"good.md": "---\ntitle: First\ntitle: Duplicate\n---\n\nneedle\n",
		"large.md": `# Large\n${"x".repeat(65536)}needle`,
		"bad name.md": "needle",
	});
	mkdirSync(join(root, "directory.md"));
	writeFileSync(join(root, "invalid.md"), Buffer.concat([Buffer.from("x".repeat(9000)), Buffer.from([0xff])]));
	const result = await search(root, { query: "needle" });
	assert.equal(object(result.scan).complete, true);
	assert.equal(object(result.search).complete, false);
	assert.equal(object(result.search).notesSearched, 1);
	assert.equal(object(result.search).unavailableNotes, 4);
	assert.equal(result.totalMatches, 1);
	assert.deepEqual(
		issues(result).sort(),
		["note.metadata", "note.nonregular", "note.oversized", "note.unaddressable", "note.unreadable"].sort(),
	);
	const miss = await search(root, { query: "nothing" });
	assert.equal(miss.totalMatches, 0);
	assert.equal(object(miss.search).complete, false);
	assert.equal((await search(root, { query: "large" })).totalMatches, 0);
	assert.ok(notes(await search(root)).some((note) => note.slug === "large"));
	const complete = await search(corpus({ "README.md": README, "note.md": "---\ntitle: Unclosed\n\nneedle" }), {
		query: "needle",
	});
	assert.equal(object(complete.search).complete, true);
	assert.match(string(notes(complete)[0].cueProblem), /no closing delimiter/);
	assert.equal(object(complete.search).unavailableNotes, 0);
});

test("paginates escaped evidence and maximal metadata without skips", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 30; i += 1)
		files[`note-${String(i).padStart(2, "0")}.md`] =
			`${maximalNote(i)}\n${"\u0001".repeat(600)}needle${"\u0001".repeat(600)}`;
	const root = corpus(files);
	const pages = await drain(root, { query: "needle", limit: 25 });
	assert.ok(number(pages[0].returned) < 25);
	const seen: string[] = [];
	for (const page of pages) {
		assert.equal(object(page.search).complete, true);
		assert.equal(object(page.search).notesSearched, 30);
		for (const note of notes(page)) {
			const slug = string(note.slug);
			assert.ok(!seen.includes(slug));
			seen.push(slug);
			sourceLocation(note, files[`${slug}.md`], "needle");
		}
	}
	assert.equal(seen.length, 30);
	assert.deepEqual(seen, [...seen].sort());
	const browsePages = await drain(root);
	assert.equal(browsePages.flatMap(notes).length, 30);
	assert.equal(new Set(browsePages.flatMap((page) => notes(page).map((note) => note.slug))).size, 30);
});

test("retains conflicting and superseded notes with literal lifecycle cues", async () => {
	const root = corpus({
		"README.md": README,
		"active.md": "---\ntitle: Current\nstatus: active\nsupersedes: [old]\n---\n\nUse bullets for a weekly report.\n",
		"old.md":
			"---\ntitle: Previous\nstatus: superseded\nsuperseded_by: active\n---\n\nUse prose for a weekly report.\n",
		"conflict.md": "---\ntitle: Other\nstatus: active\n---\n\nUse a table for a weekly report.\n",
	});
	const result = await search(root, { query: "weekly report" });
	assert.equal(result.totalMatches, 3);
	const bySlug = new Map(notes(result).map((note) => [note.slug, note]));
	assert.deepEqual([...bySlug.keys()].sort(), ["active", "conflict", "old"]);
	assert.equal(bySlug.get("old")?.status, "superseded");
	assert.equal(bySlug.get("active")?.supersedes, "[old]");
});

test("keeps overlapping phrase and word evidence in one selected passage", async () => {
	const phrase = `start needle ${" ".repeat(90)}finish`;
	const source = `${"x".repeat(200)} early ${" ".repeat(300)}${phrase}`;
	const match = object(
		notes(
			await search(corpus({ "README.md": README, "overlap.md": source }), {
				query: 'early "start needle finish" needle',
			}),
		)[0].sourceMatch,
	);
	assert.ok(string(match.excerpt).includes(phrase));
	assert.equal(match.endOffset, source.length);
	assert.ok(number(match.excerptEndOffset) >= source.length);
});

test("clips cue values without splitting astral characters", async () => {
	const title = `${"a".repeat(158)}😀 tail`;
	const value = `${"b".repeat(238)}😀 tail`;
	const root = corpus({
		"README.md": README,
		"frontmatter.md": `---\ntitle: ${title}\ntags: ${value}\nsupersedes: ${value}\n---\nneedle\n`,
		"heading.md": `# ${title}\nneedle\n`,
	});
	for (const options of [{}, { query: "needle" }]) {
		for (const note of notes(await search(root, options))) {
			assert.equal(note.title, `${"a".repeat(158)}…`);
			for (const key of ["tags", "supersedes"])
				if (note[key] !== undefined) assert.equal(note[key], `${"b".repeat(238)}…`);
			for (const text of Object.values(note).filter((value): value is string => typeof value === "string"))
				assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
			assert.match(string(note.cueProblem), /clipped/);
		}
	}
});

test("ranks multi-term evidence with ordinal ranks and explicit missing terms", async () => {
	const root = corpus({
		"README.md": README,
		"both.md": "---\ntitle: Model delegation\ntags: [model, delegation]\n---\nDelegate model tasks.\n",
		"model.md": "# Other\n\nmodel model model model model\n",
		"neither.md": "# Flowers\n\nA garden.\n",
	});
	const result = await search(root, { query: "model delegation unavailable" });
	const found = notes(result);
	assert.deepEqual(
		found.map((note) => note.slug),
		["both", "model"],
	);
	assert.deepEqual(
		found.map((note) => note.rank),
		[1, 2],
	);
	assert.deepEqual(found[0].missing, ["unavailable"]);
	assert.deepEqual(
		array(found[0].matched).map((term) => object(term).term),
		["model", "delegation"],
	);
	assert.equal(found[0].score, undefined);
	assert.equal(object(result.search).ranking, "lexical");
	assert.deepEqual(
		array(object(result.search).terms).map((term) => object(term).notes),
		[2, 1, 0],
	);
});

test("requires phrases, ignores stopwords, and matches adjacent identifier tokens", async () => {
	const root = corpus({
		"README.md": README,
		"yes.md": "# Notes\n\nWeekly\nreport uses PI_MEMORY_DIR and model routing.\n",
		"no.md": "# Notes\n\nWeekly plan then report. PI elsewhere MEMORY then DIR. models only.\n",
	});
	for (const query of ['"weekly report" model', "PI_MEMORY_DIR", "model"])
		assert.deepEqual(
			notes(await search(root, { query })).map((note) => note.slug),
			["yes"],
		);
	const result = await search(root, { query: "the model and model" });
	assert.deepEqual(object(result.search).ignored, ["the", "and"]);
	assert.equal(array(object(result.search).terms).length, 1);
});

test("selects later concentrated evidence rather than the first occurrence", async () => {
	const source = `alpha alone.\n${"unrelated ".repeat(100)}\n😀 alpha beta gamma with a qualification.\n`;
	const match = object(
		notes(await search(corpus({ "README.md": README, "note.md": source }), { query: "alpha beta gamma" }))[0]
			.sourceMatch,
	);
	assert.ok(number(match.offset) > 500);
	assert.match(string(match.excerpt), /alpha beta gamma with a qualification/);
	assert.equal(Array.from(source).slice(number(match.offset), number(match.endOffset)).join(""), "alpha beta gamma");
});

test("defaults browse to byte-bounded cues and query to ten records with exact continuation", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 60; i += 1)
		files[`note-${String(i).padStart(2, "0")}.md`] = `# Subject\n\nneedle ${"extra ".repeat(i)}\n`;
	const root = corpus(files);
	for (const query of [undefined, "needle"]) {
		const initial = await search(root, { query });
		assert.equal(initial.pageSize, query === undefined ? 512 : 10);
		assert.equal(initial.returned, query === undefined ? 60 : 10);
		if (query === undefined) assert.equal(initial.nextCursor, null);
		else assert.equal(typeof initial.nextCursor, "string");
		for (const limit of [1, 25]) {
			const pages = await drain(root, { query, limit });
			assert.equal(pages[0].returned, limit);
			const found = pages.flatMap(notes);
			assert.equal(found.length, 60);
			assert.deepEqual(
				found.map((note) => note.slug),
				Array.from({ length: 60 }, (_, i) => `note-${String(i).padStart(2, "0")}`),
			);
			if (query)
				assert.deepEqual(
					found.map((note) => note.rank),
					Array.from({ length: 60 }, (_, i) => i + 1),
				);
		}
		await rejects(searchMemory(root, { query, cursor: "invalid" }), "input", /cursor/);
	}
});

test("default browse pages all lifecycle records and accepts a larger explicit reducer", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 275; i += 1) files[`note-${String(i).padStart(3, "0")}.md`] = "# Compact cue\n";
	const root = corpus(files);
	const full = await drain(root);
	assert.equal(full.flatMap(notes).length, 275);
	assert.equal(full.at(-1)?.nextCursor, null);
	const reduced = await drain(root, { limit: 50 });
	assert.equal(reduced[0].returned, 50);
	assert.deepEqual(reduced.flatMap(notes), full.flatMap(notes));
	const largeFiles: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 100; i += 1)
		largeFiles[`note-${String(i).padStart(3, "0")}.md`] =
			`---\ntitle: ${"T".repeat(160)}\ntags: ${"t".repeat(240)}\nstatus: active\nsupersedes: ${"s".repeat(240)}\nsuperseded_by: ${"n".repeat(240)}\n---\n`;
	const pages = await drain(corpus(largeFiles));
	assert.ok(pages.length > 1);
	assert.equal(pages.flatMap(notes).length, 100);
	assert.equal(new Set(pages.flatMap(notes).map((note) => note.slug)).size, 100);
});

test("fused passages prefer body evidence and preserve original code-point locations", async () => {
	const source = "\uFEFF---\ntitle: metadata😀\n---\n\n# Subject\n\n😀 bodyneedle\n";
	const root = corpus({
		"README.md": README,
		"subject.md": source,
		"body-rival.md": "# bodyneedle\nbodyneedle bodyneedle\n",
		"metadata-only.md": "---\ntitle: uniquemetadata\n---\n\n# Subject\nflowers\n",
	});
	const result = await search(root, { query: ["metadata", "bodyneedle", "uniquemetadata"] });
	const subject = notes(result).find((note) => note.slug === "subject");
	assert.ok(subject);
	const match = sourceLocation(subject, source, "bodyneedle");
	assert.doesNotMatch(string(match.excerpt), /title:|metadata/);
	assert.equal((JSON.stringify(subject).match(/"sourceMatch":/g) ?? []).length, 1);
	const ranks = array(subject.formulations).map((item) => object(item).rank);
	assert.ok(number(ranks[0]) < number(ranks[1]));
	const metadata = notes(result).find((note) => note.slug === "metadata-only");
	assert.ok(metadata);
	sourceLocation(metadata, "---\ntitle: uniquemetadata\n---\n\n# Subject\nflowers\n", "uniquemetadata");
});

test("slices code points and trims incomplete UTF-8 browse windows", () => {
	assert.deepEqual(sliceByCodePoints("😀ab", 0, 1), {
		content: "😀",
		nextOffset: 1,
		contentCodePoints: 1,
		hasMore: true,
	});
	assert.equal(sliceByCodePoints("😀ab", 1, 1).content, "a");
	assert.equal(trimUtf8(Buffer.from([0x61, 0xc3, 0xa9]), true).toString("utf8"), "aé");
	assert.equal(trimUtf8(Buffer.from([0x61, 0xc3]), true).toString("utf8"), "a");
});

test("rejects pre-aborted calls without exposing the signal reason", async () => {
	const controller = new AbortController();
	controller.abort(new Error("private abort reason"));
	await rejects(searchMemory("/absent", {}, controller.signal), "aborted", /^Memory retrieval cancelled$/);
	await rejects(readMemory("/absent", { slug: "note" }, controller.signal), "aborted", /^Memory retrieval cancelled$/);
});

test("observes cancellation during traversal and permits a later complete call", async () => {
	const files: Record<string, string> = { "README.md": README };
	for (let i = 0; i < 20; i += 1) files[`note-${i}.md`] = "needle ".repeat(2000);
	const root = corpus(files);
	for (const query of [undefined, "needle", ["needle", "alternate"]]) {
		const controller = new AbortController();
		const pending = searchMemory(root, { query }, controller.signal);
		setImmediate(() => controller.abort());
		await rejects(pending, "aborted");
	}
	const controller = new AbortController();
	const pending = readMemory(root, { slug: "note-0" }, controller.signal);
	controller.abort();
	await rejects(pending, "aborted");
	assert.equal((await search(root, { query: "needle" })).totalMatches, 20);
	assert.equal((await read(root, { slug: "note-0" })).hasMore, true);
});

test("preserves best formulation rank, breaks ties with k=60 fusion and keeps independent evidence", async () => {
	const files = {
		"README.md": README,
		"alpha.md": "# Alpha\nalpha alpha alpha\n",
		"beta.md": "# Beta\nbeta beta beta\n",
		"shared.md": "# Shared\nalpha beta\n",
		"neither.md": "# Other\nflowers\n",
	};
	const root = corpus(files);
	const queries = ["alpha", "beta"];
	const singles = await Promise.all(queries.map((query) => search(root, { query })));
	const expected = new Map<string, { best: number; score: number }>();
	for (const single of singles)
		for (const note of notes(single)) {
			const slug = string(note.slug);
			const rank = number(note.rank);
			const prior = expected.get(slug);
			expected.set(slug, { best: Math.min(prior?.best ?? rank, rank), score: (prior?.score ?? 0) + 1 / (60 + rank) });
		}
	const result = await search(root, { query: queries });
	assert.deepEqual(result.query, queries);
	assert.equal(object(result.search).ranking, "best-rank-then-reciprocal-rank-fusion");
	assert.equal(result.totalMatches, 3);
	assert.equal(result.totalNotes, 4);
	assert.equal(object(result.search).notesSearched, 4);
	assert.equal(object(result.scan).visited, 5);
	assert.equal(object(result.search).complete, true);
	assert.deepEqual(
		notes(result).map((note) => note.slug),
		[...expected]
			.sort((a, b) => a[1].best - b[1].best || b[1].score - a[1].score || a[0].localeCompare(b[0]))
			.map(([slug]) => slug),
	);
	assert.deepEqual(
		notes(result).map((note) => note.slug),
		["alpha", "beta", "shared"],
	);
	assert.equal(object(result.search).terms, undefined);
	const summaries = array(object(result.search).formulations).map(object);
	assert.deepEqual(
		summaries.map((summary) => summary.query),
		queries,
	);
	for (const [index, note] of notes(result).entries()) {
		assert.equal(note.rank, index + 1);
		assert.equal(note.score, undefined);
		assert.equal(note.matched, undefined);
		assert.equal(
			note.digest,
			createHash("sha256")
				.update(files[`${string(note.slug)}.md` as keyof typeof files])
				.digest("hex"),
		);
		const evidence = array(note.formulations).map(object);
		assert.equal(evidence.length, 2);
		for (const [formulation, item] of evidence.entries()) {
			const original = notes(singles[formulation]).find((candidate) => candidate.slug === note.slug);
			assert.equal(item.query, queries[formulation]);
			assert.equal(item.rank, original?.rank ?? null);
			assert.equal(item.score, undefined);
			if (original) {
				assert.deepEqual(item.matched, original.matched);
				assert.deepEqual(item.missing, original.missing);
				assert.equal(item.sourceMatch, undefined);
			} else {
				assert.deepEqual(item.matched, []);
				assert.deepEqual(item.missing, [queries[formulation]]);
				assert.equal(item.sourceMatch, undefined);
			}
		}
	}
	assert.equal(
		(await read(root, { slug: "shared", digest: string(notes(result).find((note) => note.slug === "shared")?.digest) }))
			.content,
		files["shared.md"],
	);
});

test("a noisy alternative cannot bury another formulation's first result", async () => {
	const files: Record<string, string> = {
		"README.md": README,
		"subject.md": "harbor lantern coastal beacon",
		"guide.md": "# Common guide\ncommon guide common guide",
	};
	for (let index = 0; index < 20; index++)
		files[`diffuse-${String(index).padStart(2, "0")}.md`] = "harbor coastal common guide unrelated context";
	const root = corpus(files);
	const query = ["harbor lantern", "coastal beacon", "common guide"];
	const singles = await Promise.all(query.map((query) => search(root, { query })));
	assert.equal(notes(singles[0])[0].slug, "subject");
	assert.equal(notes(singles[1])[0].slug, "subject");
	const page = await search(root, { query });
	const leaders = new Set(singles.map((single) => notes(single)[0].slug));
	for (const leader of leaders) {
		const position = notes(page).findIndex((note) => note.slug === leader);
		assert.ok(position >= 0 && position < leaders.size);
	}
	assert.equal(notes(page)[0].slug, "subject");
	const all = (await drain(root, { query, limit: 3 })).flatMap(notes);
	assert.deepEqual(
		all.map((note) => note.slug),
		notes(await search(root, { query, limit: 25 })).map((note) => note.slug),
	);
	assert.equal(new Set(all.map((note) => note.slug)).size, all.length);
});

test("zero matches explain exact tokens and supported reformulations", async () => {
	const root = corpus({ "README.md": README, "subject.md": "configuration setting and accessToken" });
	for (const query of ["settings", "access token"]) {
		const result = await search(root, { query });
		assert.equal(result.totalMatches, 0);
		assert.match(string(result.guidance), /exact tokens without stemming or camelCase splitting/);
		assert.match(string(result.guidance), /alternate inflections, exact identifier forms, or quoted fragments/);
	}
	for (const query of ["setting", "accessToken", '"Token"']) {
		const result = await search(root, { query });
		assert.equal(result.totalMatches, 1);
		assert.equal(result.guidance, undefined);
	}
});

test("keeps phrase requirements local to each formulation", async () => {
	const root = corpus({
		"README.md": README,
		"red.md": "# Red\nred bird alpha\n",
		"blue.md": "# Blue\nblue bird alpha\n",
		"slug-only.md": "# Unrelated\nflower\n",
	});
	const result = await search(root, { query: ['"red bird" alpha', '"blue bird"', '"slug-only"'] });
	assert.equal(result.totalMatches, 3);
	const blue = notes(result).find((note) => note.slug === "blue");
	assert.ok(blue);
	const rejected = object(array(blue.formulations)[0]);
	assert.equal(rejected.rank, null);
	assert.deepEqual(rejected.missing, ["red bird"]);
	assert.deepEqual(
		array(rejected.matched).map((item) => object(item).term),
		["alpha"],
	);
	assert.equal(rejected.sourceMatch, undefined);
	assert.match(string(object(blue.sourceMatch).excerpt), /blue bird/);
	const slug = notes(result).find((note) => note.slug === "slug-only");
	assert.ok(slug);
	assert.equal(slug.sourceMatch, null);
	assert.equal(object(array(slug.formulations)[2]).sourceMatch, undefined);
	assert.equal(object(array(slug.formulations)[2]).rank, 1);
	for (const query of [
		[],
		[" "],
		["alpha", ""],
		["alpha", 2],
		["a", "b", "c", "d"],
		["x".repeat(201)],
		["alpha", '"unclosed'],
	])
		await rejects(searchMemory(root, { query: query as string[] }), "input");
});

test("preserves fusion order under bounded pagination and shared coverage gaps", async () => {
	const files: Record<string, string> = { "README.md": README, "bad name.md": "needle alternate" };
	for (let i = 0; i < 30; i += 1)
		files[`note-${String(i).padStart(2, "0")}.md`] =
			`${maximalNote(i)}\n${"\u0001".repeat(600)}needle alternate third${"\u0001".repeat(600)}`;
	const root = corpus(files);
	const query = ["needle", "alternate", "third"];
	const pages = await drain(root, { query, limit: 25 });
	assert.ok(number(pages[0].returned) < 25);
	const found = pages.flatMap(notes);
	assert.equal(found.length, 30);
	assert.equal(new Set(found.map((note) => note.slug)).size, 30);
	assert.deepEqual(
		found.map((note) => note.rank),
		Array.from({ length: 30 }, (_, i) => i + 1),
	);
	for (const page of pages) {
		assert.equal(object(page.search).complete, false);
		assert.equal(object(page.search).unavailableNotes, 1);
		assert.equal(object(page.scan).issueCount, 31);
	}
	const single = await search(root, { query: "needle" });
	const one = await search(root, { query: ["needle"] });
	assert.deepEqual(
		notes(one).map((note) => note.slug),
		notes(single).map((note) => note.slug),
	);
	assert.equal(notes(single)[0].formulations, undefined);
	assert.equal(object(single.search).formulations, undefined);
	assert.deepEqual(object(array(notes(one)[0].formulations)[0]).matched, notes(single)[0].matched);
});
