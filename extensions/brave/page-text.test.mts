import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPageText, makePageExcerpts } from "./page-text.ts";

const html = (text: string, signal?: AbortSignal) =>
	extractPageText(Buffer.from(text), "text/html; charset=utf-8", signal);

describe("static page extraction", () => {
	it("prefers main content, decodes entities, and preserves paragraph boundaries", async () => {
		const page = await html(
			"<html><head><title>Primary &amp; source</title><style>hidden</style></head><body>boilerplate<nav>menu</nav><main><h1>Evidence</h1><p>A &amp; B <strong>stay</strong> together.</p><p>Second paragraph &#x1f600;.</p></main><footer>footer</footer></body></html>",
		);
		assert.equal(page.title, "Primary & source");
		assert.equal(page.method, "main");
		assert.deepEqual(page.paragraphs, ["Evidence", "A & B stay together.", "Second paragraph 😀."]);
		assert.equal(page.truncated, false);
	});
	it("takes the document title once and excludes SVG and duplicate titles", async () => {
		const page = await html(
			"<head><title>Document</title><title>Duplicate</title></head><body><svg><title>Logo</title></svg><main>Body</main></body>",
		);
		assert.equal(page.title, "Document");
		assert.deepEqual(page.paragraphs, ["Body"]);
	});
	it("keeps title and retained-text caps outside Unicode surrogate pairs", async () => {
		const page = await html(
			`<head><title>${"a".repeat(299)}😀</title></head><main>${"a".repeat(128 * 1024 - 1)}😀</main>`,
		);
		assert.equal(page.title, "a".repeat(299));
		assert.equal(Buffer.from(page.title).toString("utf8"), page.title);
		assert.equal(Buffer.from(page.paragraphs[0]).toString("utf8"), page.paragraphs[0]);
		assert.equal(page.paragraphs[0], "a".repeat(128 * 1024 - 1));
		assert.equal(page.truncated, true);
	});
	it("uses article or explicitly labeled body fallback and excludes hidden or executable elements", async () => {
		const page = await html(
			'<body>outside<article><p>Visible</p><script>bad</script><template>bad</template><iframe>bad</iframe><p hidden>bad</p><p aria-hidden="true">bad</p><p style="display:none">bad</p><noscript>bad</noscript></article></body>',
		);
		assert.equal(page.method, "article");
		assert.deepEqual(page.paragraphs, ["Visible"]);
		assert.deepEqual((await html("<div>One<br>Two<p>Three")).paragraphs, ["One", "Two", "Three"]);
		assert.equal((await html("<div>body</div>")).method, "body");
	});
	it("handles implied closes and table boundaries without duplicate content", async () => {
		const page = await html("<main><ul><li>One<li>Two</ul><table><tr><th>Name<th>Value<tr><td>A<td>B</table></main>");
		assert.deepEqual(page.paragraphs, ["One", "Two", "| Name | Value", "| A | B"]);
	});
	it("supports plain text and declared character encodings", async () => {
		const page = await extractPageText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/plain; charset=windows-1252");
		assert.deepEqual(page.paragraphs, ["café"]);
		assert.equal(page.method, "plain-text");
		assert.deepEqual((await extractPageText(Buffer.from("# Title\n\nBody"), "text/markdown")).paragraphs, [
			"# Title",
			"Body",
		]);
	});
	it("reports unsupported formats, invalid encoding, and binary content honestly", async () => {
		await assert.rejects(extractPageText(Buffer.from("pdf"), "application/pdf"), /unsupported/);
		await assert.rejects(extractPageText(Buffer.from([255]), "text/plain"), /encoding/);
		await assert.rejects(extractPageText(Buffer.from("text"), "text/plain; charset=not-real"), /encoding/);
		await assert.rejects(extractPageText(Buffer.from("a\0b"), "text/plain"), /binary/);
	});
	it("bounds intake, retained text, element count, and nesting", async () => {
		await assert.rejects(html("x".repeat(2 * 1024 * 1024 + 1)), /byte limit/);
		assert.equal((await html(`<main>${"x".repeat(140000)}</main>`)).truncated, true);
		await assert.rejects(html("<div>".repeat(257)), /nesting limit/);
		await assert.rejects(html("<br>".repeat(50001)), /element or nesting limit/);
	});
	it("does not spend retained-text capacity on discarded whitespace or empty blocks", async () => {
		const page = await html(`<main>${"<div> </div>".repeat(40000)}${" ".repeat(140000)}<p>Useful tail.</p></main>`);
		assert.deepEqual(page.paragraphs, ["Useful tail."]);
		assert.equal(page.truncated, false);
	});
	it("honors cancellation before and during parsing", async () => {
		await assert.rejects(html("hello", AbortSignal.abort()), /abort/i);
		const controller = new AbortController();
		const pending = html(`<main>${"<p>text</p>".repeat(10000)}</main>`, controller.signal);
		setImmediate(() => controller.abort());
		await assert.rejects(pending, /abort/i);
	});
	it("does not invent text for a script-only page and strips terminal/bidi controls", async () => {
		assert.deepEqual((await html('<div id="root"></div><script>loadApp()</script>')).paragraphs, []);
		assert.deepEqual((await html("<main>safe\u001b\u202e text</main>")).paragraphs, ["safe text"]);
	});
});

describe("page excerpt references", () => {
	it("binds references to final URL and extracted text, not retrieval time or output size", async () => {
		const page = await html("<main><p>One</p><p>Two</p></main>");
		const result = makePageExcerpts(page, "https://example.com/page");
		assert.equal(result.excerpts[0].reference, `${result.sourceId}:E1`);
		assert.equal(result.excerpts[1].text, "Two");
		assert.equal(makePageExcerpts(page, "https://example.com/page", 1000).sourceId, result.sourceId);
		assert.notEqual(makePageExcerpts(page, "https://example.com/other").sourceId, result.sourceId);
		assert.notEqual(
			makePageExcerpts({ ...page, paragraphs: ["Changed"] }, "https://example.com/page").sourceId,
			result.sourceId,
		);
	});
	it("bounds UTF-8 output and preserves complete code points at the smallest budget", async () => {
		const page = await html(`<main>${"😀".repeat(2000)}</main>`);
		const result = makePageExcerpts(page, "https://example.com", 1000);
		assert.equal(result.outputTruncated, true);
		assert.ok(result.excerpts.length > 0);
		const rendered = result.excerpts.map((e) => `[${e.reference}] ${e.text}\n\n`).join("");
		assert.ok(Buffer.byteLength(rendered) <= 1000);
		assert.doesNotMatch(rendered, /�/);
	});
	it("validates output budgets and carries the extraction truncation flag", async () => {
		const page = await html("ok");
		for (const max of [999, 24001, 1.5, Number.NaN])
			assert.throws(() => makePageExcerpts(page, "https://example.com", max), /max_bytes/);
		assert.equal(makePageExcerpts({ ...page, truncated: true }, "https://example.com").outputTruncated, true);
	});
});
