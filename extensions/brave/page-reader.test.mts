import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readWebPage } from "./page-reader.ts";

function response(body: string, contentType = "text/html") {
	return {
		requestedUrl: "https://example.com/start",
		finalUrl: "https://example.com/article",
		retrievedAt: "2026-01-01T00:00:00.000Z",
		contentType,
		body: Buffer.from(body),
		downloadedBytes: Buffer.byteLength(body),
		redirectCount: 1,
	};
}

describe("web page reader", () => {
	it("returns readable primary text with provenance and references without a duplicate raw body", async () => {
		const result = await readWebPage({ url: "https://example.com/start" }, undefined, {
			fetchPage: async () =>
				response("<title>Primary source</title><main><p>Direct evidence.</p><p>More evidence.</p></main>"),
		});
		assert.equal(result.details.finalUrl, "https://example.com/article");
		assert.equal(result.details.retrievedAt, "2026-01-01T00:00:00.000Z");
		assert.equal(result.details.extraction, "main");
		assert.equal(result.details.excerptCount, 2);
		assert.equal(result.details.status, "readable");
		assert.equal(result.details.outputTruncated, false);
		assert.match(result.content[0].text, /Untrusted page content/);
		assert.ok(result.content[0].text.includes(`[${result.details.sourceId}:E1] Direct evidence.`));
		assert.ok(!("body" in result.details));
		assert.ok(!("excerpts" in result.details));
	});
	it("reports static empty pages and fallback text without claiming browser coverage", async () => {
		const empty = await readWebPage({ url: "https://example.com" }, undefined, {
			fetchPage: async () => response('<script>boot()</script><div id="root"></div>'),
		});
		assert.equal(empty.details.status, "no-readable-text");
		assert.equal(empty.details.excerptCount, 0);
		assert.match(empty.content[0].text, /may require scripts/);
		const body = await readWebPage({ url: "https://example.com" }, undefined, {
			fetchPage: async () => response("<p>Static body</p>"),
		});
		assert.match(body.content[0].text, /filtered body text/);
	});
	it("bounds multibyte output, metadata, and line counts with an explicit truncation notice", async () => {
		const result = await readWebPage({ url: "https://example.com", max_bytes: 24000 }, undefined, {
			fetchPage: async () => ({
				...response(`<title>${"😀".repeat(500)}</title><main>${"<p>😀 text</p>".repeat(10000)}</main>`),
				contentType: `text/html; ${"x".repeat(16000)}\u001b`,
			}),
		});
		assert.equal(result.details.outputTruncated, true);
		assert.ok(Buffer.byteLength(result.content[0].text) < 50 * 1024);
		assert.ok(result.content[0].text.split("\n").length < 2000);
		assert.ok(result.details.contentType.length <= 200);
		assert.doesNotMatch(result.content[0].text, /\u001b/);
		assert.match(result.content[0].text, /Omitted content is not retained/);
	});
	it("propagates cancellation to transport and distinguishes the shared execution deadline", async () => {
		let cancelled = false;
		const hanging = async (_url: string, signal?: AbortSignal) =>
			new Promise<ReturnType<typeof response>>((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => {
						cancelled = true;
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		const controller = new AbortController();
		const pending = readWebPage({ url: "https://example.com" }, controller.signal, { fetchPage: hanging });
		controller.abort();
		await assert.rejects(pending, /cancelled/);
		assert.equal(cancelled, true);
		cancelled = false;
		await assert.rejects(
			readWebPage({ url: "https://example.com" }, undefined, { fetchPage: hanging, timeoutMs: 5 }),
			/execution deadline/,
		);
		assert.equal(cancelled, true);
	});
	it("validates before network access and preserves honest errors", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls++;
			throw new Error("Web reader rejected the target.");
		};
		await assert.rejects(
			readWebPage({ url: "https://example.com", max_bytes: 0 }, undefined, { fetchPage }),
			/max_bytes/,
		);
		await assert.rejects(readWebPage({ url: "https://example.com" }, AbortSignal.abort(), { fetchPage }), /cancelled/);
		await assert.rejects(
			readWebPage({ url: "https://example.com" }, undefined, { fetchPage, timeoutMs: 0 }),
			/timeout/,
		);
		assert.equal(calls, 0);
		await assert.rejects(readWebPage({ url: "https://example.com" }, undefined, { fetchPage }), /rejected the target/);
		assert.equal(calls, 1);
	});
});
