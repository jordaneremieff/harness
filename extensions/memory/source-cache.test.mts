import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sourceFreshness } from "./lifecycle.ts";
import { createMemorySourceCache, type ParsedMemoryHeader } from "./source-cache.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function root(): string {
	const path = mkdtempSync(join(tmpdir(), "memory-source-cache-"));
	roots.push(path);
	return path;
}
const HEADER = "---\ntitle: Alpha\ntags:\nstatus: active\nsuperseded_by: null\n---\n# Alpha\n\nBody\n";
function headerOf(cache: ReturnType<typeof createMemorySourceCache>, directory: string, text: string): ParsedMemoryHeader {
	return cache.read(directory, "alpha.md", { text, truncated: false });
}

test("extracts literal cue lines without YAML interpretation", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const absent = headerOf(cache, directory, "# Title\n");
	assert.equal(absent.metadata, "absent");
	assert.equal(absent.bodyStart, 0);
	const bom = headerOf(cache, directory, "\uFEFF# Title\n");
	assert.equal(bom.bodyStart, 1);
	const header = headerOf(
		cache,
		directory,
		'---\ntitle: "A: B"\ntags: [x, y]\nstatus: active\nsuperseded_by: null\ncreated: 2025-01-01\n---\n# A\n',
	);
	assert.equal(header.metadata, "ok");
	assert.equal(header.lines.get("title"), 'title: "A: B"');
	assert.equal(header.lines.get("tags"), "tags: [x, y]");
	assert.equal(header.lines.get("superseded_by"), "superseded_by: null");
	assert.equal(header.lines.has("created"), false);
	assert.equal(headerOf(cache, directory, "---\ntags:\n  - a\n---\n").multiline, true);
});

test("reuses header and pointer parsing for unchanged source", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const first = headerOf(cache, directory, HEADER);
	const second = headerOf(cache, directory, HEADER);
	assert.equal(second, first);
	assert.equal(first.metadata, "ok");
	assert.equal(first.lines.get("title"), "title: Alpha");
	assert.equal(first.pointer("title"), "Alpha");
	const warm = cache.statistics();
	assert.equal(warm.misses, 1);
	assert.equal(warm.hits, 1);
	assert.equal(headerOf(cache, directory, HEADER).pointer("title"), "Alpha");
	assert.equal(cache.statistics().yamlParses, warm.yamlParses);
});

test("reuses header products for body-only edits and takes the heading from the current body", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const text = "---\nstatus: active\nsuperseded_by: null\n---\n# First heading\n";
	assert.equal(headerOf(cache, directory, text).pointer("title"), undefined);
	const warm = cache.statistics().yamlParses;
	const changed = text.replace("# First heading", "# Second heading");
	const header = cache.read(directory, "alpha.md", { text: changed, truncated: false });
	assert.equal(header, headerOf(cache, directory, text));
	assert.equal(changed.slice(header.bodyStart), "# Second heading\n");
	assert.equal(cache.statistics().yamlParses, warm);
	assert.equal(cache.statistics().hits, 2);
});

test("parses a changed header again even at identical byte length", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	assert.equal(headerOf(cache, directory, HEADER).pointer("title"), "Alpha");
	const warm = cache.statistics();
	const changed = HEADER.replace("title: Alpha", "title: Bravo");
	assert.equal(changed.length, HEADER.length);
	const header = headerOf(cache, directory, changed);
	assert.equal(header.pointer("title"), "Bravo");
	assert.equal(cache.statistics().misses, warm.misses + 1);
	assert.equal(cache.statistics().yamlParses, warm.yamlParses + 2);
});

test("keeps complete and truncated interpretations of one window distinct", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const open = "---\ntitle: Alpha\nstatus: active";
	const partial = cache.read(directory, "alpha.md", { text: open, truncated: true });
	const malformed = cache.read(directory, "alpha.md", { text: open, truncated: false });
	assert.equal(partial.metadata, "partial");
	assert.equal(partial.issue, "frontmatter not closed within the read window");
	assert.equal(malformed.metadata, "malformed");
	assert.equal(malformed.issue, "frontmatter has no closing delimiter");
	assert.equal(cache.read(directory, "alpha.md", { text: open, truncated: true }), partial);
	assert.equal(cache.statistics().misses, 2);
	assert.equal(cache.statistics().hits, 1);
});

test("caches malformed frontmatter with its qualification and unusable cues", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const malformedYaml = "---\ntitle: \"Alpha\n---\n# Alpha\n";
	const header = headerOf(cache, directory, malformedYaml);
	assert.equal(header.metadata, "malformed");
	assert.equal(header.parsed, undefined);
	assert.equal(header.issue, "invalid or ambiguous frontmatter; metadata cues are untrusted");
	assert.equal(header.pointer("title"), undefined);
	const duplicate = headerOf(cache, directory, "---\ntitle: A\ntitle: B\nstatus: active\n---\n");
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.unusable.has("title"), true);
	assert.equal(duplicate.pointer("title"), undefined);
	assert.match(duplicate.issue ?? "", /duplicate cue field: title/);
});

test("keeps scalar pointer parsing isolated from the raw line and from other fields", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const text = '---\ntitle: "A: B"\nstatus: active\nsuperseded_by: null\n---\n';
	const header = headerOf(cache, directory, text);
	assert.equal(header.lines.get("title"), 'title: "A: B"');
	assert.equal(header.pointer("title"), "A: B");
	assert.equal(header.pointer("tags"), undefined);
	assert.equal(cache.statistics().yamlParses, 2);
	header.pointer("title");
	assert.equal(cache.statistics().yamlParses, 2);
});

test("keys a replaced root separately and invalidates one root without touching another", () => {
	const cache = createMemorySourceCache();
	const first = root();
	const second = root();
	assert.equal(headerOf(cache, first, HEADER).pointer("title"), "Alpha");
	assert.equal(headerOf(cache, second, HEADER).pointer("title"), "Alpha");
	assert.equal(cache.statistics().misses, 2);
	cache.invalidate(first, "alpha.md");
	assert.equal(cache.statistics().entries, 1);
	assert.equal(headerOf(cache, first, HEADER).pointer("title"), "Alpha");
	assert.equal(cache.statistics().misses, 3);
	assert.equal(headerOf(cache, second, HEADER), headerOf(cache, second, HEADER));
});

test("invalidates every interpretation of one file only", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	cache.read(directory, "alpha.md", { text: HEADER, truncated: false });
	cache.read(directory, "alpha.md", { text: HEADER, truncated: true });
	cache.read(directory, "beta.md", { text: HEADER, truncated: false });
	assert.equal(cache.statistics().entries, 3);
	cache.invalidate(directory, "alpha.md");
	assert.equal(cache.statistics().entries, 1);
	assert.equal(headerOf(cache, directory, HEADER).pointer("title"), "Alpha");
	assert.equal(cache.statistics().misses, 4);
});

test("evicts the least recently used entry at the entry limit", () => {
	const cache = createMemorySourceCache({ maxEntries: 2, maxBytes: 8 * 1024 * 1024 });
	const directory = root();
	const read = (file: string) => headerOf(cache, directory, HEADER.replace("Alpha", file.slice(0, -3)));
	read("one.md");
	read("two.md");
	read("one.md");
	read("three.md");
	assert.equal(cache.statistics().entries, 2);
	const before = cache.statistics();
	read("two.md");
	assert.equal(cache.statistics().evictions, before.evictions + 1);
	assert.equal(cache.statistics().entries, 2);
});

test("evicts at the accounted byte limit", () => {
	const large = `---\ntitle: Alpha\ntags: [${"x".repeat(1200)}]\nstatus: active\nsuperseded_by: null\n---\n`;
	const small = "---\ntitle: Beta\nstatus: active\nsuperseded_by: null\n---\n";
	const directory = root();
	const measure = createMemorySourceCache();
	measure.read(directory, "alpha.md", { text: large, truncated: false });
	const alphaBytes = measure.statistics().bytes;
	assert.ok(alphaBytes > 1024);
	const cache = createMemorySourceCache({ maxBytes: alphaBytes });
	cache.read(directory, "alpha.md", { text: large, truncated: false });
	cache.read(directory, "beta.md", { text: small, truncated: false });
	assert.equal(cache.statistics().evictions, 1);
	assert.equal(cache.statistics().entries, 1);
	assert.ok(cache.statistics().bytes <= alphaBytes);
});

test("skips an entry above the per-entry limit without retaining it", () => {
	const cache = createMemorySourceCache({ maxEntryBytes: 100 });
	const directory = root();
	const header = headerOf(cache, directory, HEADER);
	assert.equal(header.pointer("title"), "Alpha");
	assert.equal(cache.statistics().skipped, 1);
	assert.equal(cache.statistics().entries, 0);
	assert.equal(headerOf(cache, directory, HEADER).pointer("title"), "Alpha");
	assert.equal(cache.statistics().skipped, 2);
});

test("accounts parse products, not the note body", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const body = `${"body line\n".repeat(12000)}`;
	const text = `---\ntitle: Alpha\nstatus: active\nsuperseded_by: null\n---\n${body}`;
	const header = headerOf(cache, directory, text);
	assert.equal(text.slice(header.bodyStart), body);
	assert.ok(cache.statistics().bytes > 0);
	assert.ok(cache.statistics().bytes < 4096);
	assert.ok(Buffer.byteLength(text) > 100_000);
});

test("computes freshness and its UTC day outside the cached parse", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	const text =
		"---\ntitle: Alpha\nstatus: active\nsuperseded_by: null\nverified: true\nverified_date: 2026-01-01\nreview_after: 2026-02-01\n---\n";
	const header = headerOf(cache, directory, text);
	const warm = cache.statistics().yamlParses;
	assert.equal(sourceFreshness(header.parsed, header.header, "2026-01-15").deadline, "not-due");
	assert.equal(sourceFreshness(header.parsed, header.header, "2026-02-01").deadline, "due");
	assert.equal(cache.statistics().yamlParses, warm);
	assert.equal(headerOf(cache, directory, text), header);
});

test("clears every retained entry", () => {
	const cache = createMemorySourceCache();
	const directory = root();
	headerOf(cache, directory, HEADER);
	headerOf(cache, directory, HEADER.replace("Alpha", "Beta"));
	assert.equal(cache.statistics().entries, 2);
	cache.clear();
	assert.deepEqual(cache.statistics().entries, 0);
	assert.equal(cache.statistics().bytes, 0);
});
