import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRAVE_WEB_SEARCH_URL, resolveApiKey, searchBraveWeb, type FetchLike } from "./client.ts";

const success = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function settleWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const watchdog = setTimeout(() => reject(new Error("the asynchronous test did not settle")), timeoutMs);
		void promise.then(
			(value) => {
				clearTimeout(watchdog);
				resolve(value);
			},
			(error) => {
				clearTimeout(watchdog);
				reject(error);
			},
		);
	});
}

describe("Brave Search configuration", () => {
	it("prefers an explicit key and otherwise reads PI_BRAVE_API_KEY", async () => {
		assert.equal(
			await resolveApiKey({ apiKey: " explicit-key ", env: { PI_BRAVE_API_KEY: "env-key" } }),
			"explicit-key",
		);
		assert.equal(await resolveApiKey({ env: { PI_BRAVE_API_KEY: " env-key " } }), "env-key");
	});

	it("honors cancellation before configuration reads", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(resolveApiKey({ env: { PI_BRAVE_API_KEY: "key" } }, controller.signal), /cancelled/);
	});

	it("fails clearly when no key is configured", async () => {
		await assert.rejects(resolveApiKey({ env: {} }), /not configured.*PI_BRAVE_API_KEY/i);
	});
});

describe("Brave Search client", () => {
	it("builds one bounded web request and normalizes usable results", async () => {
		let observedUrl: URL | undefined;
		let observedHeaders: Record<string, string> | undefined;
		let observedRedirect: string | undefined;
		const fetch: FetchLike = async (url, init) => {
			observedUrl = url;
			observedHeaders = init.headers;
			observedRedirect = init.redirect;
			return success({
				query: { original: "rust docs", altered: "rust documentation", more_results_available: true },
				web: {
					results: [
						{
							title: "Rust documentation",
							url: "https://doc.rust-lang.org/",
							description: "The Rust documentation.",
							page_age: "2026-07-20T00:00:00Z",
							extra_snippets: ["Books", 7, "Reference"],
						},
						{ title: "unsafe", url: "javascript:alert(1)" },
					],
				},
			});
		};

		const result = await searchBraveWeb(
			{
				query: "  rust docs  ",
				count: 7,
				offset: 2,
				country: "au",
				search_lang: "EN",
				freshness: "pw",
				safesearch: "strict",
				extra_snippets: true,
				spellcheck: false,
			},
			new AbortController().signal,
			{ apiKey: "test-key", fetch },
		);

		assert.ok(observedUrl, "the mocked fetch must have been called");
		assert.equal(observedUrl.origin + observedUrl.pathname, BRAVE_WEB_SEARCH_URL);
		assert.equal(observedUrl?.searchParams.get("q"), "rust docs");
		assert.equal(observedUrl?.searchParams.get("count"), "7");
		assert.equal(observedUrl?.searchParams.get("offset"), "2");
		assert.equal(observedUrl?.searchParams.get("country"), "AU");
		assert.equal(observedUrl?.searchParams.get("search_lang"), "en");
		assert.equal(observedUrl?.searchParams.get("freshness"), "pw");
		assert.equal(observedUrl?.searchParams.get("safesearch"), "strict");
		assert.equal(observedUrl?.searchParams.get("extra_snippets"), "true");
		assert.equal(observedUrl?.searchParams.get("spellcheck"), "false");
		assert.equal(observedUrl?.searchParams.get("text_decorations"), "false");
		assert.equal(observedUrl?.searchParams.get("result_filter"), "web");
		assert.equal(observedUrl?.searchParams.has("test-key"), false);
		assert.equal(observedHeaders?.["X-Subscription-Token"], "test-key");
		assert.equal(observedRedirect, "error");
		assert.deepEqual(result, {
			originalQuery: "rust docs",
			alteredQuery: "rust documentation",
			moreResultsAvailable: true,
			results: [
				{
					title: "Rust documentation",
					url: "https://doc.rust-lang.org/",
					description: "The Rust documentation.",
					age: "2026-07-20T00:00:00Z",
					extraSnippets: ["Books", "Reference"],
				},
			],
		});
	});

	it("rejects an empty query before reading credentials or making a request", async () => {
		let called = false;
		await assert.rejects(
			searchBraveWeb({ query: "   " }, undefined, {
				env: {},
				fetch: async () => {
					called = true;
					return success({});
				},
			}),
			/query cannot be empty/,
		);
		assert.equal(called, false);
	});

	it("maps structured API errors without exposing the credential", async () => {
		const fetch: FetchLike = async () =>
			new Response(JSON.stringify({ error: { code: "RATE_LIMITED", detail: "Too many requests" } }), { status: 429 });
		await assert.rejects(
			searchBraveWeb({ query: "test" }, undefined, { apiKey: "never-print-this", fetch }),
			(error: Error) => {
				assert.match(error.message, /HTTP 429.*RATE_LIMITED.*Too many requests/);
				assert.doesNotMatch(error.message, /never-print-this/);
				return true;
			},
		);
	});

	it("rejects invalid JSON and oversized responses", async () => {
		await assert.rejects(
			searchBraveWeb({ query: "test" }, undefined, {
				apiKey: "key",
				fetch: async () => new Response("not-json", { status: 200 }),
			}),
			/invalid JSON/,
		);
		let cancelled = false;
		const oversizedBody = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		await assert.rejects(
			searchBraveWeb({ query: "test" }, undefined, {
				apiKey: "key",
				fetch: async () =>
					new Response(oversizedBody, {
						status: 200,
						headers: { "content-length": String(6 * 1024 * 1024) },
					}),
			}),
			/safety limit/,
		);
		assert.equal(cancelled, true);
	});

	it("stops streaming a chunked response as soon as its decoded body exceeds the safety limit", async () => {
		let chunks = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		await assert.rejects(
			searchBraveWeb({ query: "test" }, undefined, {
				apiKey: "key",
				fetch: async () => new Response(body, { status: 200 }),
			}),
			/safety limit/,
		);
		assert.ok(chunks >= 6 && chunks <= 7, `expected at most one prefetched chunk, got ${chunks}`);
		assert.equal(cancelled, true);
	});

	it("propagates caller cancellation into the in-flight request", async () => {
		const controller = new AbortController();
		const fetch: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		const pending = searchBraveWeb({ query: "test" }, controller.signal, { apiKey: "key", fetch });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending, /cancelled/);
	});

	it("bounds a stalled request with an owned timeout", async () => {
		const fetch: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		await assert.rejects(
			settleWithin(searchBraveWeb({ query: "test" }, undefined, { apiKey: "key", fetch, timeoutMs: 10 })),
			/timed out after 10ms/,
		);
	});
});
