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
		assert.equal(makePageExcerpts(page, "https://example.com/page", { max_bytes: 1000 }).sourceId, result.sourceId);
		assert.notEqual(makePageExcerpts(page, "https://example.com/other").sourceId, result.sourceId);
		assert.notEqual(
			makePageExcerpts({ ...page, paragraphs: ["Changed"] }, "https://example.com/page").sourceId,
			result.sourceId,
		);
	});
	it("bounds UTF-8 output and preserves complete code points at the smallest budget", async () => {
		const page = await html(`<main>${"😀".repeat(2000)}</main>`);
		const result = makePageExcerpts(page, "https://example.com", { max_bytes: 1000 });
		assert.equal(result.outputTruncated, true);
		assert.ok(result.excerpts.length > 0);
		const rendered = result.excerpts.map((e) => `[${e.reference}] ${e.text}\n\n`).join("");
		assert.ok(Buffer.byteLength(rendered) <= 1000);
		assert.doesNotMatch(rendered, /�/);
	});
	it("reconstructs all retained paragraphs with budget-independent labels and Unicode chunks", async () => {
		const paragraphs = Array.from({ length: 60 }, (_, i) => `Section ${i + 1}: ${"evidence 😀 café ".repeat(80)}`);
		const page = await extractPageText(Buffer.from(paragraphs.join("\n")), "text/plain");
		const collect = (budgets: number[]) => {
			const collected: { reference: string; text: string }[] = [];
			let offset = 0;
			let sourceId: string | undefined;
			let calls = 0;
			for (;;) {
				const budget = budgets[calls++ % budgets.length];
				const result = makePageExcerpts(page, "https://example.com", {
					max_bytes: budget,
					excerpt_offset: offset,
					expected_source_id: sourceId,
				});
				sourceId = result.sourceId;
				assert.equal(result.excerptOffset, offset);
				assert.equal(result.extractionTruncated, false);
				assert.ok(result.excerpts.length > 0);
				const rendered = result.excerpts.map((e) => `[${e.reference}] ${e.text}\n\n`).join("");
				assert.ok(Buffer.byteLength(rendered) <= budget);
				assert.equal(Buffer.from(rendered).toString("utf8"), rendered);
				collected.push(...result.excerpts);
				if (result.nextOffset === null) {
					assert.equal(result.outputTruncated, false);
					break;
				}
				assert.equal(result.nextOffset, collected.length);
				offset = result.nextOffset;
				assert.ok(calls < 300);
			}
			assert.ok(calls > 1);
			return collected;
		};
		const small = collect([1000, 24000, 1733]);
		assert.deepEqual(small, collect([24000]));
		assert.equal(small.map((e) => e.text).join(""), paragraphs.map((paragraph) => paragraph.trim()).join(""));
		assert.deepEqual(
			small.map((e) => e.reference.split(":")[1]),
			small.map((_, i) => `E${i + 1}`),
		);
	});
	it("returns the first unreturned chunk without gaps at exact Unicode byte boundaries", async () => {
		const page = await extractPageText(Buffer.from(`${"😀".repeat(401)}\n\t End   evidence \n`), "text/plain");
		const first = makePageExcerpts(page, "https://example.com", { max_bytes: 1000 });
		assert.deepEqual(first.excerpts, [{ reference: `${first.sourceId}:E1`, text: "😀".repeat(200) }]);
		assert.equal(first.nextOffset, 1);
		const second = makePageExcerpts(page, "https://example.com", {
			max_bytes: 24000,
			excerpt_offset: 1,
			expected_source_id: first.sourceId,
		});
		assert.deepEqual(second.excerpts, [
			{ reference: `${first.sourceId}:E2`, text: "😀".repeat(200) },
			{ reference: `${first.sourceId}:E3`, text: "😀" },
			{ reference: `${first.sourceId}:E4`, text: "End evidence" },
		]);
		assert.equal(second.nextOffset, null);
	});
	it("pages past the per-response excerpt-count ceiling", async () => {
		const page = await extractPageText(
			Buffer.from(Array.from({ length: 400 }, (_, i) => `P${i}`).join("\n")),
			"text/plain",
		);
		const first = makePageExcerpts(page, "https://example.com", { max_bytes: 24000 });
		assert.equal(first.excerpts.length, 160);
		assert.equal(first.nextOffset, 160);
		const next = makePageExcerpts(page, "https://example.com", {
			max_bytes: 24000,
			excerpt_offset: first.nextOffset,
			expected_source_id: first.sourceId,
		});
		assert.equal(next.excerpts[0].reference, `${first.sourceId}:E161`);
		assert.equal(next.nextOffset, 320);
		const last = makePageExcerpts(page, "https://example.com", {
			max_bytes: 24000,
			excerpt_offset: next.nextOffset,
			expected_source_id: first.sourceId,
		});
		assert.equal(last.excerpts.length, 80);
		assert.equal(last.excerpts[79].text, "P399");
		assert.equal(last.nextOffset, null);
		assert.equal(last.extractionTruncated, false);
	});
	it("refuses changed text or final URL before returning any continuation excerpts", async () => {
		const page = await html("<main>Original evidence</main>");
		const first = makePageExcerpts(page, "https://example.com");
		for (const offset of [0, 1]) {
			const options = { excerpt_offset: offset, expected_source_id: first.sourceId };
			assert.throws(
				() => makePageExcerpts({ ...page, paragraphs: ["Different"] }, "https://example.com", options),
				/source changed.*No excerpts returned/,
			);
			assert.throws(() => makePageExcerpts(page, "https://example.com/other", options), /source changed/);
		}
	});
	it("treats exact-end and empty snapshots as successful but refuses offsets beyond retained text", async () => {
		const page = await html("<main>Evidence</main>");
		const first = makePageExcerpts(page, "https://example.com");
		const end = makePageExcerpts(page, "https://example.com", {
			excerpt_offset: 1,
			expected_source_id: first.sourceId,
		});
		assert.deepEqual(end.excerpts, []);
		assert.equal(end.nextOffset, null);
		assert.equal(end.outputTruncated, false);
		assert.throws(
			() => makePageExcerpts(page, "https://example.com", { excerpt_offset: 2, expected_source_id: first.sourceId }),
			/exceeds the retained excerpt count \(1\)/,
		);
		const empty = makePageExcerpts({ ...page, paragraphs: [] }, "https://example.com");
		assert.deepEqual(empty.excerpts, []);
		assert.equal(empty.nextOffset, null);
		assert.throws(
			() =>
				makePageExcerpts({ ...page, paragraphs: [] }, "https://example.com", {
					excerpt_offset: 1,
					expected_source_id: empty.sourceId,
				}),
			/exceeds the retained excerpt count \(0\)/,
		);
	});
	it("validates output budgets and carries the extraction truncation flag", async () => {
		const page = await html("ok");
		for (const max of [999, 24001, 1.5, Number.NaN])
			assert.throws(() => makePageExcerpts(page, "https://example.com", { max_bytes: max }), /max_bytes/);
		assert.equal(makePageExcerpts({ ...page, truncated: true }, "https://example.com").outputTruncated, true);
	});
});
