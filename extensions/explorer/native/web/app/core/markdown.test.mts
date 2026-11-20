import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const window = { explorer: {} } as Window;
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./markdown.ts", import.meta.url), "utf8")), { window });
const { isMarkdown, sourceSpan, cover, slugs, link } = window.explorer.markdown;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("recognises Markdown files without treating MDX as CommonMark", () => {
	assert.equal(isMarkdown("doc/README.MD"), true);
	assert.equal(isMarkdown("other.markdown"), true);
	assert.equal(isMarkdown("other.mdx"), false);
	assert.equal(isMarkdown("doc.md/config"), false);
});

test("picks source lines from selected spans, not rendered line or character counts", () => {
	const first = sourceSpan("8:2-10:50");
	const last = sourceSpan("14:1-14:0");
	assert.deepEqual(plain(first), { side: "head", start: 8, end: 10 });
	assert.ok(first && last);
	assert.deepEqual(plain(cover([last, first])), { side: "head", start: 8, end: 14 });
	assert.equal(cover([]), null);
	for (const invalid of ["", "0:0-1:3", "3:1-2:1", "9:0-99999999999999999:2"]) assert.equal(sourceSpan(invalid), null);
});

test("makes GitHub-style slugs with unique suffixes and keeps Unicode letters", () => {
	const slug = slugs();
	assert.deepEqual(["Café & Tea!", "Café & Tea!", "café--tea-1", "Café & Tea!", "横断_テスト"].map(slug), [
		"café--tea",
		"café--tea-1",
		"café--tea-1-1",
		"café--tea-2",
		"横断_テスト",
	]);
});

test("resolves relative links and fragments inside the root and rejects other addresses", () => {
	const inDoc = (destination: string) => plain(link(destination, "docs/guide.md"));
	assert.deepEqual(inDoc("../a%20b.md?mode=1#caf%C3%A9"), { kind: "file", path: "a b.md", fragment: "café" });
	assert.deepEqual(inDoc("#install"), { kind: "fragment", fragment: "install" });
	assert.deepEqual(inDoc("HTTPS://example.invalid/"), { kind: "external", url: "HTTPS://example.invalid/" });
	assert.deepEqual(inDoc("mailto:a@example.invalid"), { kind: "external", url: "mailto:a@example.invalid" });
	for (const address of [
		"../../secret",
		"/etc/passwd",
		"//example.invalid/",
		"file:///tmp/a",
		"javascript:alert",
		"%2e%2e/.Git/config",
		"%2F../secret",
		"%gh",
		"a%00b",
	])
		assert.equal(inDoc(address), null);
});
