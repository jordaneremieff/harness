import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { makeLinkPage, PAGE_LINK_LIMITS, PageLinkCollector, type PageLinkOptions } from "./page-links.ts";
import { readWebPage, type WebReadRequest } from "./page-reader.ts";
import { extractPageText, makePageExcerpts } from "./page-text.ts";

const finalUrl = "https://example.com/docs/source.html";
async function extract(body: string, url = finalUrl) {
	const collector = new PageLinkCollector(url);
	const page = await extractPageText(Buffer.from(body), "text/html", undefined, collector);
	assert.notEqual(page.method, "plain-text");
	return { text: page, links: collector.finish(page.method as "main" | "article" | "body") };
}
function fetched(body: string, contentType = "text/html") {
	return {
		requestedUrl: "https://example.com/start",
		finalUrl,
		contentType,
		body: Buffer.from(body),
		retrievedAt: "2026-01-01T00:00:00.000Z",
		downloadedBytes: Buffer.byteLength(body),
		redirectCount: 1,
	};
}
function recordUrls(page: Awaited<ReturnType<typeof extract>>) {
	return page.links.records.map((record) => record.url);
}

describe("source link extraction", () => {
	it("resolves complete relative, protocol-relative, query, fragment, and empty hrefs against the final URL", async () => {
		const page = await extract(
			`<main><a href="../spec?q=a&amp;b=c#part">Spec</a><a href="//other.example/x">Other</a><a href="#local">Local</a><a href="?q=1">Query</a><a href="">Self</a><a href="../spec?q=a&amp;b=c#part">Duplicate</a></main>`,
		);
		assert.deepEqual(recordUrls(page), [
			"https://example.com/spec?q=a&b=c#part",
			"https://other.example/x",
			`${finalUrl}#local`,
			"https://example.com/docs/source.html?q=1",
			finalUrl,
			"https://example.com/spec?q=a&b=c#part",
		]);
		assert.equal(page.links.anchorsSeen, 6);
		assert.equal(page.links.skippedUrl, 0);
	});

	it("uses the first base href, including a late, hidden, or empty base, and ignores inert foreign bases", async () => {
		for (const base of [
			'<base href="/root/"><base href="https://wrong.example/">',
			'<base target="_blank"><base hidden href="/root/">',
			'<template><base href="https://wrong.example/"></template><svg><base href="https://wrong.example/"/></svg><base href="/root/">',
		]) {
			const page = await extract(`<main><a href="item#part">Item</a></main>${base}`);
			assert.deepEqual(recordUrls(page), ["https://example.com/root/item#part"]);
			assert.equal(page.links.baseStatus, "element");
		}
		assert.deepEqual(recordUrls(await extract('<base href=""><base href="/wrong/"><a href="item">Item</a>')), [
			"https://example.com/docs/item",
		]);
	});

	it("falls back only for invalid, data, or javascript bases and never invents a public base for other schemes", async () => {
		for (const base of ["http://[", "data:text/plain,x", "javascript:alert(1)"]) {
			const page = await extract(`<base href="${base}"><base href="/ignored/"><a href="item">Item</a>`);
			assert.deepEqual(recordUrls(page), ["https://example.com/docs/item"]);
			assert.equal(page.links.baseStatus, "fallback");
		}
		for (const base of ["file:///root/", "mailto:user@example.com", "https://user:synthetic-pass@example.com/root/"]) {
			const page = await extract(
				`<base href="${base}"><main><a href="item">Relative</a><a href="https://public.example/item">Absolute</a></main>`,
			);
			assert.deepEqual(recordUrls(page), ["https://public.example/item"]);
			assert.equal(page.links.skippedUrl, 1);
		}
		const oversized = await extract(
			`<base href="/${"x".repeat(4096)}"><a href="item">Relative</a><a href="https://public.example/item">Absolute</a>`,
		);
		assert.deepEqual(recordUrls(oversized), ["https://public.example/item"]);
		assert.equal(oversized.links.baseStatus, "over-limit");
		assert.equal(oversized.links.truncated, true);
	});

	it("uses the unchanged text region and excludes hidden and non-content anchors", async () => {
		const page = await extract(
			'<a href="/outside">Outside</a><article><a href="/article">Article</a></article><main><p>Text</p><a href="/keep">Keep <span hidden>secret</span></a><nav><a href="/nav">Nav</a></nav><a hidden href="/hidden">Hidden</a><a aria-hidden="TRUE" href="/aria">ARIA</a><div style="display:none"><a href="/style">CSS</a></div><template><a href="/template">Template</a></template><script>"<a href=\'/script\'>script</a>"</script><a>No href</a></main><footer><a href="/footer">Footer</a></footer>',
		);
		assert.equal(page.links.method, "main");
		assert.deepEqual(recordUrls(page), ["https://example.com/keep"]);
		assert.equal(page.links.records[0].label, "Keep");
		assert.equal(page.links.anchorsSeen, 1);
		assert.equal(
			(await extract('<body><article><a href="/a">A</a></article><a href="/b">B</a></body>')).links.method,
			"article",
		);
		const imageOnly = await extract(
			'<a href="/outside">Outside</a><main><a href="/image"><img alt="Image"></a><a href="/empty"></a></main>',
		);
		assert.equal(imageOnly.links.method, "body");
		assert.deepEqual(
			imageOnly.links.records.map((record) => record.label),
			["Outside", "Image", ""],
		);
	});

	it("selects text with image alt, then aria-label, title, or an explicit empty label", async () => {
		const page = await extract(
			'<main><a href="/1" aria-label="ignored" title="ignored">Read <strong>the</strong> <img alt="manual"><img hidden alt="secret"> now</a><a href="/2" aria-label=" Screen   label " title="ignored"></a><a href="/3" aria-label=" " title=" Title "></a><a href="/4"></a><a href="/5">safe&#x1b;&#x200f; text</a></main>',
		);
		assert.deepEqual(
			page.links.records.map(({ label, labelSource, labelTruncated }) => ({ label, labelSource, labelTruncated })),
			[
				{ label: "Read the manual now", labelSource: "text", labelTruncated: false },
				{ label: "Screen label", labelSource: "aria-label", labelTruncated: false },
				{ label: "Title", labelSource: "title", labelTruncated: false },
				{ label: "", labelSource: "none", labelTruncated: false },
				{ label: "safe text", labelSource: "text", labelTruncated: false },
			],
		);
	});

	it("retains malformed but parseable anchors in source order and resolves entities in attributes", async () => {
		const page = await extract(
			'<main><a href="/outer">Outer<a href="/inner?a=1&amp;b=2">Inner</a>end</a><a href="/last">Unclosed',
		);
		assert.deepEqual(recordUrls(page), [
			"https://example.com/outer",
			"https://example.com/inner?a=1&b=2",
			"https://example.com/last",
		]);
		assert.equal(page.links.records[2].label, "Unclosed");
	});

	it("omits disallowed and malformed URLs without DNS or partial URL output", async () => {
		const hrefs = [
			"javascript:alert(1)",
			"data:text/html,x",
			"mailto:a@example.com",
			"ftp://example.com/x",
			"http://127.0.0.1/",
			"http://[::1]/",
			"https://user:synthetic-pass@example.com/",
			"https://example.com:444/",
			"http://[",
			"https://example.com/\\unsafe",
			"https://example.com/\u202eunsafe",
			"https://example.com/\nunsafe",
			`/${"x".repeat(4096)}`,
		];
		const page = await extract(
			`<main>${hrefs.map((href) => `<a href="${href}">Rejected</a>`).join("")}<a href="https://named.example/">DNS unchecked</a><a href="https://example.com:443/x#part">Default port</a><a href="a b">Space</a></main>`,
		);
		assert.equal(page.links.skippedUrl, hrefs.length);
		assert.equal(page.links.skippedLimit, 0);
		assert.deepEqual(recordUrls(page), [
			"https://named.example/",
			"https://example.com/x#part",
			"https://example.com/docs/a%20b",
		]);
		assert.equal(page.links.anchorsSeen, page.links.records.length + page.links.skippedUrl);
	});

	it("preserves Unicode across parser chunks and caps labels outside surrogate pairs", async () => {
		const prefix = '<main><a href="/unicode">';
		const padding = " ".repeat(8191 - prefix.length);
		const page = await extract(
			`${prefix}${padding}😀é cafe\u0301</a><a href="/long">${"x".repeat(511)}😀tail</a><a href="/fallback" aria-label="${"😀".repeat(257)}"></a></main>`,
		);
		assert.equal(page.links.records[0].label, "😀é cafe\u0301");
		assert.equal(page.links.records[0].labelTruncated, false);
		assert.equal(page.links.records[1].label, "x".repeat(511));
		assert.equal(page.links.records[1].labelTruncated, true);
		assert.equal(page.links.records[2].label, "😀".repeat(256));
		assert.equal(page.links.truncatedLabels, 2);
		assert.equal(page.links.truncated, true);
		for (const record of page.links.records) assert.equal(Buffer.from(record.label).toString("utf8"), record.label);
	});

	it("does not mark a complete maximum-length label as truncated for discarded trailing whitespace", async () => {
		const page = await extract(`<main><a href="/x"><p>${"x".repeat(512)}</p></a></main>`);
		assert.equal(page.links.records[0].label.length, 512);
		assert.equal(page.links.records[0].labelTruncated, false);
	});

	it("bounds record count and both raw and resolved byte retention while counting every selected anchor once", async () => {
		for (const body of [
			`<main>${'<a href="/x">X</a>'.repeat(PAGE_LINK_LIMITS.records + 5)}</main>`,
			`<main>${`<a href="/${"q".repeat(2000)}">${"😀".repeat(200)}</a>`.repeat(200)}</main>`,
			`<base href="https://example.com/${"q".repeat(3000)}/"><main>${'<a href="x">X</a>'.repeat(200)}</main>`,
		]) {
			const page = (await extract(body)).links;
			assert.ok(page.records.length <= PAGE_LINK_LIMITS.records);
			assert.ok(page.retainedBytes <= PAGE_LINK_LIMITS.bytes);
			assert.ok(page.skippedLimit > 0);
			assert.equal(page.anchorsSeen, page.records.length + page.skippedUrl + page.skippedLimit);
			assert.equal(page.truncated, true);
		}
	});

	it("leaves text extraction and text identity unchanged when links are collected or hrefs change", async () => {
		const body =
			'<head><title>Title</title></head><main><p>A <a href="/first">specification</a>.</p><p>Second.</p></main>';
		const first = await extract(body);
		const second = await extract(body.replace("/first", "/second"));
		assert.deepEqual(first.text, await extractPageText(Buffer.from(body), "text/html"));
		assert.deepEqual(first.text, second.text);
		assert.equal(makePageExcerpts(first.text, finalUrl).sourceId, makePageExcerpts(second.text, finalUrl).sourceId);
		assert.notEqual(makeLinkPage(first.links, finalUrl).sourceId, makeLinkPage(second.links, finalUrl).sourceId);
	});
});

describe("link source identity and complete-record pagination", () => {
	it("binds continuation to the final URL, effective base, selected region, coverage, labels, and destinations", async () => {
		const page = (await extract('<main><a href="/x">X</a></main>')).links;
		const first = makeLinkPage(page, finalUrl);
		for (const changed of [
			{ ...page, baseIdentity: "https://example.com/other/" },
			{ ...page, method: "body" as const },
			{ ...page, skippedLimit: 1, anchorsSeen: 2, truncated: true },
			{ ...page, records: [{ ...page.records[0], label: "Y" }] },
			{ ...page, records: [{ ...page.records[0], url: "https://example.com/y" }] },
		])
			assert.throws(
				() => makeLinkPage(changed, finalUrl, { expected_source_id: first.sourceId }),
				/link source changed.*No links returned/,
			);
		assert.throws(
			() => makeLinkPage(page, `${finalUrl}?new`, { expected_source_id: first.sourceId }),
			/link source changed/,
		);
		assert.equal(
			makeLinkPage(page, finalUrl, {
				find: "absent",
				max_bytes: 1000,
				link_offset: 1,
				expected_source_id: first.sourceId,
			}).sourceId,
			first.sourceId,
		);
	});

	it("returns only literal label matches with stable snapshot offsets under varied budgets", async () => {
		const page = (
			await extract(
				`<main>${Array.from({ length: 300 }, (_, i) => `<a href="/${i}">${i % 2 ? "needle 😀" : "Needle"}</a>`).join("")}</main>`,
			)
		).links;
		const collect = (budgets: number[]) => {
			const records: string[] = [];
			let options: PageLinkOptions = { find: "needle" };
			for (let calls = 0; ; calls++) {
				assert.ok(calls < 100);
				const budget = budgets[calls % budgets.length];
				const result = makeLinkPage(page, finalUrl, { ...options, max_bytes: budget });
				assert.ok(result.records.length > 0);
				assert.ok(Buffer.byteLength(result.records.map((record) => record.text).join("")) <= budget);
				records.push(...result.records.map((record) => record.text));
				if (result.nextOffset === null) break;
				options = { find: "needle", link_offset: result.nextOffset, expected_source_id: result.sourceId };
			}
			return records;
		};
		assert.deepEqual(collect([1000, 24000, 1700]), collect([24000]));
		assert.equal(collect([24000]).length, 150);
		assert.equal(makeLinkPage(page, finalUrl, { find: "/299" }).records.length, 0);
		assert.equal(makeLinkPage(page, finalUrl, { max_bytes: 24000 }).records.length, 160);
		assert.equal(makeLinkPage(page, finalUrl, { find: "NEEDLE" }).records.length, 0);
	});

	it("reports a sufficient budget instead of a clipped URL and supports exact-end and empty results", async () => {
		const url = `https://example.com/${"x".repeat(3900)}#complete`;
		const page = (await extract(`<a href="${url}">Long</a>`)).links;
		const first = makeLinkPage(page, finalUrl, { max_bytes: 1000 });
		assert.deepEqual(first.records, []);
		assert.equal(first.nextOffset, 0);
		assert.ok(first.requiredMaxBytes !== null && first.requiredMaxBytes > 1000 && first.requiredMaxBytes <= 24000);
		const next = makeLinkPage(page, finalUrl, {
			max_bytes: first.requiredMaxBytes,
			link_offset: 0,
			expected_source_id: first.sourceId,
		});
		assert.ok(next.records[0].text.includes(url));
		assert.equal(Buffer.byteLength(next.records[0].text), first.requiredMaxBytes);
		assert.equal(next.nextOffset, null);
		const end = makeLinkPage(page, finalUrl, { link_offset: 1, expected_source_id: first.sourceId });
		assert.deepEqual(end.records, []);
		assert.throws(
			() => makeLinkPage(page, finalUrl, { link_offset: 2, expected_source_id: first.sourceId }),
			/exceeds the retained link count/,
		);
		assert.equal(makeLinkPage((await extract("<main>No links</main>")).links, finalUrl).nextOffset, null);
	});
});

describe("links view reader", () => {
	it("rejects incompatible views and offsets before fetch and validates shared query and budget inputs", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls++;
			return fetched('<a href="/x">X</a>');
		};
		for (const fields of [
			{ view: "unknown" },
			{ view: null },
			{ view: "links", excerpt_offset: 0 },
			{ link_offset: 0 },
			{ view: "text", link_offset: 1 },
			...[-1, 0.5, Number.NaN, Infinity, 2049, "1", null].map((link_offset) => ({ view: "links", link_offset })),
			{ view: "links", link_offset: 1 },
			{ view: "links", find: "\n" },
			{ view: "links", expected_source_id: "wrong" },
			{ view: "links", max_bytes: 999 },
		])
			await assert.rejects(
				readWebPage({ url: finalUrl, ...fields } as unknown as WebReadRequest, undefined, { fetchPage }),
				/view|offset|expected_source_id|find|max_bytes/,
			);
		assert.equal(calls, 0);
	});

	it("supports HTML only, keeps text view unchanged, and never exposes the raw base or a duplicate link array", async () => {
		const body =
			'<base href="https://user:synthetic-pass@example.com/"><main><a href="https://public.example/spec#section">Spec</a></main>';
		const result = await readWebPage({ url: finalUrl, view: "links" }, undefined, {
			fetchPage: async () => fetched(body),
		});
		assert.equal(result.details.linkCount, 1);
		assert.match(result.content[0].text, /Destinations were not fetched or DNS-checked/);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-pass|baseIdentity/);
		assert.ok(!("records" in result.details));
		for (const contentType of ["application/xhtml+xml", "text/plain", "text/markdown", "application/pdf"])
			await assert.rejects(
				readWebPage({ url: finalUrl, view: "links" }, undefined, { fetchPage: async () => fetched(body, contentType) }),
				/links view supports text\/html only/,
			);
		const options = { fetchPage: async () => fetched(body) };
		assert.deepEqual(
			await readWebPage({ url: finalUrl }, undefined, options),
			await readWebPage({ url: finalUrl, view: "text" }, undefined, options),
		);
	});

	it("refuses XHTML before non-HTML namespace elements become false base or anchor URLs", async () => {
		const body =
			'<html xmlns="http://www.w3.org/1999/xhtml"><head><base xmlns="urn:non-html" href="https://non-html-base.example/" /></head><body><main><a href="target#f">Actual HTML anchor</a><a xmlns="urn:non-html" href="https://non-html-anchor.example/">Not an HTML anchor</a></main></body></html>';
		const options = { fetchPage: async () => fetched(body, "application/xhtml+xml") };
		await assert.rejects(readWebPage({ url: finalUrl, view: "links" }, undefined, options), (error: Error) => {
			assert.match(error.message, /XHTML and other content types are unsupported/);
			assert.doesNotMatch(error.message, /non-html-base|non-html-anchor/);
			return true;
		});
		const text = await readWebPage({ url: finalUrl }, undefined, options);
		assert.equal(text.details.status, "readable");
		assert.match(text.content[0].text, /Actual HTML anchor/);
	});

	it("keeps text and link source IDs distinct and rejects changed hrefs on refetch", async () => {
		let body = '<main><a href="/first">Spec</a></main>';
		const options = { fetchPage: async () => fetched(body) };
		const text = await readWebPage({ url: finalUrl }, undefined, options);
		const links = await readWebPage({ url: finalUrl, view: "links" }, undefined, options);
		await assert.rejects(
			readWebPage({ url: finalUrl, view: "links", expected_source_id: text.details.sourceId }, undefined, options),
			/link source changed/,
		);
		await assert.rejects(
			readWebPage({ url: finalUrl, expected_source_id: links.details.sourceId }, undefined, options),
			/source changed/,
		);
		body = body.replace("/first", "/second");
		await assert.rejects(
			readWebPage({ url: finalUrl, view: "links", expected_source_id: links.details.sourceId }, undefined, options),
			/link source changed/,
		);
		assert.equal((await readWebPage({ url: finalUrl }, undefined, options)).details.sourceId, text.details.sourceId);
	});

	it("keeps output below the host bounds with maximum metadata, records, Unicode, and explicit complete-record retry guidance", async () => {
		const url = `https://example.com/${"x".repeat(4076)}`;
		const linkUrl = `https://example.com/${"x".repeat(3900)}#fragment`;
		const result = await readWebPage({ url, view: "links", max_bytes: 24000, find: "😀" }, undefined, {
			fetchPage: async () => ({
				...fetched(
					`<title>${"😀".repeat(300)}</title><main>${`<a href="${linkUrl}">${'😀"'.repeat(250)}</a>`.repeat(100)}</main>`,
				),
				requestedUrl: url,
				finalUrl: url,
			}),
		});
		assert.ok(result.details.linkCount > 0);
		assert.ok(result.content[0].text.includes(linkUrl));
		const recordStart = result.content[0].text.indexOf(`[${result.details.sourceId}:L`);
		assert.ok(recordStart >= 0);
		const renderedRecords = result.content[0].text.slice(recordStart);
		assert.ok(renderedRecords.includes("😀"));
		assert.ok(Buffer.byteLength(renderedRecords) <= 24000);
		assert.ok(Buffer.byteLength(result.content[0].text) < 50 * 1024);
		assert.ok(result.content[0].text.split("\n").length < 2000);
		const retry = await readWebPage({ url: finalUrl, view: "links", max_bytes: 1000 }, undefined, {
			fetchPage: async () => fetched(`<a href="${url}">Long</a>`),
		});
		assert.equal(retry.details.linkCount, 0);
		assert.ok(retry.details.requiredMaxBytes !== null);
		assert.match(retry.content[0].text, /complete link record requires max_bytes at least/);
		assert.match(retry.content[0].text, /view: "links", link_offset: 0, expected_source_id:/);
	});

	it("propagates cancellation before fetch and during parsing and clears the caller listener after settlement", async () => {
		let calls = 0;
		const options = {
			fetchPage: async () => {
				calls++;
				return fetched(`<main>${'<a href="/x">X</a>'.repeat(10000)}</main>`);
			},
		};
		const params = { url: finalUrl, view: "links" as const };
		await assert.rejects(readWebPage(params, AbortSignal.abort(), options), /cancelled/);
		assert.equal(calls, 0);
		const controller = new AbortController();
		const pending = readWebPage(params, controller.signal, options);
		setImmediate(() => controller.abort());
		await assert.rejects(pending, /cancelled/);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		const settled = new AbortController();
		await readWebPage(params, settled.signal, { fetchPage: async () => fetched('<a href="/x">X</a>') });
		assert.equal(getEventListeners(settled.signal, "abort").length, 0);
		await assert.rejects(
			readWebPage(params, undefined, {
				timeoutMs: 1,
				fetchPage: async (_url, signal) =>
					new Promise((_resolve, reject) =>
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
					),
			}),
			/execution deadline/,
		);
	});
});
