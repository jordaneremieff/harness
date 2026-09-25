import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readWebPage, type WebReadRequest } from "./page-reader.ts";

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
	it("preserves final URL and safe content type on extraction errors", async () => {
		for (const [body, contentType, reason] of [
			["sensitive-body", "application/json; private=hidden", /unsupported/],
			["sensitive-body", "", /unsupported/],
			["sensitive-body", "text/plain; charset=unknown", /cannot decode/],
			["binary\0content", "text/plain", /binary/],
			["<div>".repeat(257), "text/html", /nesting limit/],
		] as const) {
			await assert.rejects(
				readWebPage({ url: "https://example.com/start" }, undefined, {
					fetchPage: async () => response(body, contentType),
				}),
				(error: Error) => {
					assert.match(error.message, reason);
					assert.match(error.message, /HTTP 200 OK/);
					assert.match(error.message, /Final URL: https:\/\/example.com\/article/);
					assert.ok(error.message.includes(`Content type: ${contentType.split(";", 1)[0] || "(not supplied)"}`));
					assert.doesNotMatch(error.message, /sensitive-body|private=hidden|binary\0content/);
					return true;
				},
			);
		}
	});

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
		assert.match(result.content[0].text, /More retained excerpts follow/);
		assert.equal(result.details.extractionTruncated, false);
		assert.equal(result.details.nextOffset, 160);
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
	it("rejects invalid continuation input before network access", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls++;
			return response("<main>Text</main>");
		};
		for (const fields of [
			{ excerpt_offset: 1 },
			...[-1, 0.5, Number.NaN, Infinity, 131073, "1", null].map((excerpt_offset) => ({
				excerpt_offset,
				expected_source_id: "0123456789abcdef",
			})),
			...["", "ABCDEF0123456789", "0123456789abcdeg", "a".repeat(17), 123, null].map((expected_source_id) => ({
				expected_source_id,
			})),
		]) {
			await assert.rejects(
				readWebPage({ url: "https://example.com", ...fields } as unknown as WebReadRequest, undefined, { fetchPage }),
				/excerpt_offset|expected_source_id/,
			);
		}
		assert.equal(calls, 0);
	});
	it("retains extraction-cap warnings on the final noninitial page and scopes the source to retained text", async () => {
		const url = "https://example.com/start";
		let tail = "a";
		const fetchPage = async () => response("x".repeat(128 * 1024) + tail, "text/plain");
		let result = await readWebPage({ url, max_bytes: 24000 }, undefined, { fetchPage });
		const sourceId = result.details.sourceId;
		let calls = 1;
		while (result.details.nextOffset !== null) {
			tail = "b";
			result = await readWebPage(
				{ url, max_bytes: 24000, excerpt_offset: result.details.nextOffset, expected_source_id: sourceId },
				undefined,
				{ fetchPage },
			);
			assert.equal(result.details.sourceId, sourceId);
			assert.ok(++calls < 10);
		}
		assert.ok(result.details.excerptOffset > 0);
		assert.equal(result.details.extractionTruncated, true);
		assert.equal(result.details.outputTruncated, true);
		assert.match(result.content[0].text, /End of retained excerpts.*does not establish full-page coverage/);
		assert.match(result.content[0].text, /Extraction hit.*not available through continuation/);
		assert.doesNotMatch(result.content[0].text, /More retained excerpts/);
	});
	it("refetches and returns complete mismatch diagnostics without changed evidence", async () => {
		let calls = 0;
		let current = response("<main>Original</main>");
		const fetchPage = async () => {
			calls++;
			return current;
		};
		const first = await readWebPage({ url: current.requestedUrl }, undefined, { fetchPage });
		for (const changed of [
			response("<main>replacement-evidence</main>"),
			{ ...response("<main>Original</main>"), finalUrl: "https://example.com/moved" },
		]) {
			current = changed;
			await assert.rejects(
				readWebPage(
					{ url: current.requestedUrl, excerpt_offset: 1, expected_source_id: first.details.sourceId },
					undefined,
					{ fetchPage },
				),
				(error: Error) => {
					assert.match(error.message, /source changed.*Start a new read/);
					assert.ok(error.message.includes(`Final URL: ${current.finalUrl}`));
					assert.match(error.message, /HTTP 200 OK/);
					assert.doesNotMatch(error.message, /replacement-evidence|:E\d/);
					return true;
				},
			);
		}
		assert.equal(calls, 3);
	});
	it("bounds the complete response with maximum URL metadata and continuation guidance", async () => {
		const url = `https://example.com/${"a".repeat(4076)}`;
		const result = await readWebPage({ url, max_bytes: 24000 }, undefined, {
			fetchPage: async () => ({
				...response(`<title>${"😀".repeat(300)}</title><main>${"😀".repeat(20000)}</main>`),
				requestedUrl: url,
				finalUrl: url,
			}),
		});
		assert.ok(result.details.nextOffset !== null);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50 * 1024);
		assert.ok(result.content[0].text.split("\n").length < 2000);
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
