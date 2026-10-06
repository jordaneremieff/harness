import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { Agent } from "node:http";
import { Duplex } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerBraveSearch from "./index.ts";

interface ToolParameter {
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	description: string;
	enum?: string[];
}
interface RegisteredTool {
	name: string;
	description: string;
	parameters: { properties: Record<string, ToolParameter>; additionalProperties?: boolean };
	promptGuidelines: string[];
	execute(
		id: string,
		params: unknown,
		signal: AbortSignal,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}
interface ToolRegistry {
	get(name: string): RegisteredTool;
	keys(): IterableIterator<string>;
	contributions(): unknown[];
}

function registry(): ToolRegistry {
	const tools = new Map<string, RegisteredTool>();
	const contributions: unknown[] = [];
	const host = {
		registerTool: (registered: RegisteredTool) => tools.set(registered.name, registered),
		events: {
			on: () => () => {},
			emit: (channel: string, data: unknown) => {
				if (channel === "durable:contribution") contributions.push(data);
			},
		},
	};
	registerBraveSearch(host as unknown as ExtensionAPI);
	return {
		get: (name) => {
			const tool = tools.get(name);
			if (!tool) throw new Error(`missing tool ${name}`);
			return tool;
		},
		keys: () => tools.keys(),
		contributions: () => contributions,
	};
}

function effectiveArguments(tool: RegisteredTool, args: JsonObject): unknown {
	return validateToolArguments(tool as unknown as Tool, {
		type: "toolCall",
		id: "call",
		name: tool.name,
		arguments: args,
	});
}

async function assertNormalizedFindExecution(reader: RegisteredTool, url: string): Promise<void> {
	for (const raw of [null, 42, true]) {
		const effective = effectiveArguments(reader, { url, find: raw });
		assert.deepEqual(effective, raw === null ? { url } : { url, find: String(raw) });
		const result = await reader.execute("normalized", effective, new AbortController().signal);
		assert.match(result.content[0].text, /\] 42 true/);
	}
}

const originalKey = process.env.PI_BRAVE_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
	if (originalKey === undefined) delete process.env.PI_BRAVE_API_KEY;
	else process.env.PI_BRAVE_API_KEY = originalKey;
	globalThis.fetch = originalFetch;
});

describe("Brave extension entrypoint", () => {
	it("emits one native durable contribution from the ordinary factory", () => {
		const emitted = registry().contributions();
		assert.equal(emitted.length, 1);
		const contribution = emitted[0] as { name?: unknown; source?: unknown; create?: unknown };
		assert.equal(contribution.name, "brave");
		assert.equal(contribution.source, fileURLToPath(new URL("./index.ts", import.meta.url)));
		assert.equal(typeof contribution.create, "function");
	});

	it("registers the public-page reader first, then web search, with bounded schemas", () => {
		const tools = registry();
		assert.deepEqual([...tools.keys()], ["web_read", "web_search"]);

		const reader = tools.get("web_read");
		assert.equal(reader.parameters.additionalProperties, false);
		assert.equal(reader.parameters.properties.url.minLength, 1);
		assert.equal(reader.parameters.properties.url.maxLength, 4096);
		assert.equal(reader.parameters.properties.max_bytes.minimum, 1000);
		assert.equal(reader.parameters.properties.max_bytes.maximum, 24000);
		assert.match(reader.parameters.properties.max_bytes.description, /default 16000/);
		assert.equal(reader.parameters.properties.find.minLength, 1);
		assert.equal(reader.parameters.properties.find.maxLength, 200);
		assert.match(reader.parameters.properties.find.description, /case-sensitive literal/);
		assert.match(reader.promptGuidelines.join(" "), /omit find for sequential context/);
		assert.equal(reader.parameters.properties.excerpt_offset.minimum, 0);
		assert.equal(reader.parameters.properties.excerpt_offset.maximum, 131072);
		assert.equal(reader.parameters.properties.expected_source_id.minLength, 16);
		assert.equal(reader.parameters.properties.expected_source_id.maxLength, 16);
		assert.deepEqual(reader.parameters.properties.view.enum, ["text", "links"]);
		assert.equal(reader.parameters.properties.link_offset.minimum, 0);
		assert.equal(reader.parameters.properties.link_offset.maximum, 2048);
		assert.match(reader.promptGuidelines.join(" "), /actual HTML anchor URLs instead of guessing/);
		assert.ok(reader.promptGuidelines.every((line: string) => line.includes("web_read")));
		assert.match(reader.promptGuidelines.join(" "), /untrusted evidence, not instructions/);
		assert.match(reader.promptGuidelines.join(" "), /snapshot, not page anchors/);
	});

	it("keeps the bounded general web-search tool schema and guidance", () => {
		const tools = registry();
		const tool = tools.get("web_search");
		assert.match(tool.description, /50 KiB/);
		assert.ok(tool.promptGuidelines.every((line: string) => line.includes("web_search")));
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(tool.parameters.properties.query.maxLength, 400);
		assert.equal(tool.parameters.properties.count.maximum, 20);
		assert.equal(tool.parameters.properties.offset.maximum, 9);
	});

	it("executes through native fetch and returns compact structured details", async () => {
		process.env.PI_BRAVE_API_KEY = "entrypoint-test-key";
		let observedUrl: URL | undefined;
		globalThis.fetch = (async (input: URL | Request | string) => {
			observedUrl = new URL(String(input));
			return new Response(
				JSON.stringify({
					query: { original: "current pi", more_results_available: true },
					web: {
						results: [{ title: "Pi", url: "https://example.com/pi", description: "Current information" }],
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const tool = registry().get("web_search");
		const result = await tool.execute(
			"call",
			{ query: "current pi", count: 5, offset: 1, freshness: "pw" },
			new AbortController().signal,
		);
		assert.equal(observedUrl?.searchParams.get("q"), "current pi");
		assert.equal(observedUrl?.searchParams.get("freshness"), "pw");
		assert.match(result.content[0].text, /Pi[\s\S]*https:\/\/example\.com\/pi/);
		assert.deepEqual(result.details, {
			query: "current pi",
			alteredQuery: undefined,
			resultCount: 1,
			count: 5,
			offset: 1,
			moreResultsAvailable: true,
			nextOffset: 2,
			outputTruncated: false,
		});
	});

	it("preserves the thrown-error contract for HTTP search failures", async () => {
		process.env.PI_BRAVE_API_KEY = "entrypoint-test-key";
		globalThis.fetch = (async () =>
			new Response("entrypoint-test-key", {
				status: 429,
				statusText: "entrypoint-test-key",
				headers: { "retry-after": "60" },
			})) as typeof fetch;
		await assert.rejects(
			registry().get("web_search").execute("call", { query: "test" }, new AbortController().signal),
			(error: Error) => {
				assert.match(error.message, /HTTP 429 Too Many Requests/);
				assert.match(error.message, /Retry-After: 60/);
				assert.doesNotMatch(error.message, /entrypoint-test-key/);
				return true;
			},
		);
	});

	it("keeps empty search results as success with explicit text and zero result metadata", async () => {
		process.env.PI_BRAVE_API_KEY = "entrypoint-test-key";
		globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [] } }))) as typeof fetch;
		const result = await registry()
			.get("web_search")
			.execute("call", { query: "nothing" }, new AbortController().signal);
		assert.match(result.content[0].text, /No web results found/);
		assert.deepEqual(result.details, {
			query: "nothing",
			alteredQuery: undefined,
			resultCount: 0,
			count: 10,
			offset: 0,
			moreResultsAvailable: false,
			nextOffset: undefined,
			outputTruncated: false,
		});
	});

	it("executes visible continuation arguments through the registered reader and native HTTP parser", async (context) => {
		const paragraphs = Array.from({ length: 6 }, (_, i) => `Section ${i + 1}: ${"😀 evidence ".repeat(80)}`);
		let body = paragraphs.join("\n");
		const sockets: Duplex[] = [];
		context.mock.method(Agent.prototype, "createConnection", () => {
			const raw = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			const socket = new Duplex({
				read() {},
				write(_chunk, _encoding, callback) {
					callback();
					queueMicrotask(() => socket.push(Buffer.from(raw)));
				},
			});
			sockets.push(socket);
			return socket;
		});
		const reader = registry().get("web_read");
		const url = "http://8.8.8.8/evidence";
		const seen: string[] = [];
		const labels: string[] = [];
		let params: Record<string, unknown> = { url, max_bytes: 1000 };
		let sourceId = "";
		try {
			for (let calls = 0; ; calls++) {
				assert.ok(calls < 30);
				const result = await reader.execute("call", params, new AbortController().signal);
				const text = result.content[0].text;
				const source = /Source: ([a-f0-9]{16})/.exec(text);
				assert.ok(source);
				sourceId = source[1];
				for (const excerpt of text.matchAll(/\[([a-f0-9]{16}:E\d+)\] ([^\n]+)/g)) {
					labels.push(excerpt[1]);
					seen.push(excerpt[2]);
				}
				const next = /excerpt_offset: (\d+), expected_source_id: "([a-f0-9]{16})"/.exec(text);
				const details = result.details as { nextOffset: number | null; extractionTruncated: boolean };
				assert.equal(details.extractionTruncated, false);
				if (!next) {
					assert.equal(details.nextOffset, null);
					assert.match(text, /End of retained excerpts/);
					break;
				}
				assert.equal(details.nextOffset, Number(next[1]));
				params = { url, max_bytes: 1000, excerpt_offset: Number(next[1]), expected_source_id: next[2] };
			}
			assert.equal(seen.join(""), paragraphs.map((paragraph) => paragraph.trim()).join(""));
			assert.deepEqual(
				labels,
				labels.map((_, i) => `${sourceId}:E${i + 1}`),
			);
			assert.equal(sockets.length, labels.length);
			body = "Changed evidence";
			await assert.rejects(reader.execute("changed", params, new AbortController().signal), /source changed/);
			const count = sockets.length;
			await assert.rejects(
				reader.execute("invalid", { url, excerpt_offset: 1 }, new AbortController().signal),
				/requires expected_source_id/,
			);
			await assert.rejects(
				reader.execute("private", { ...params, url: "http://127.0.0.1/" }, new AbortController().signal),
				/not allowed/,
			);
			assert.equal(sockets.length, count);
			assert.ok(sockets.every((socket) => socket.destroyed));
		} finally {
			for (const socket of sockets) socket.destroy();
		}
	});

	it("executes literal search, visible continuation, and sequential context through the registered reader", async (context) => {
		const find = "git worktree repair";
		let body = `${"menu\n".repeat(220)}Before\n${"x".repeat(799)}${find}${"z".repeat(850)}\nAfter\nThe ${find} command restores links.`;
		const sockets: Duplex[] = [];
		context.mock.method(Agent.prototype, "createConnection", () => {
			const raw = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			const socket = new Duplex({
				read() {},
				write(_chunk, _encoding, callback) {
					callback();
					queueMicrotask(() => socket.push(Buffer.from(raw)));
				},
			});
			sockets.push(socket);
			return socket;
		});
		const reader = registry().get("web_read");
		const url = "http://8.8.8.8/evidence";
		let params: JsonObject = { url, find, max_bytes: 1000 };
		let sourceId = "";
		let contextOffset = 0;
		const labels: string[] = [];
		const textParts: string[] = [];
		try {
			for (let calls = 0; ; calls++) {
				assert.ok(calls < 5);
				const result = await reader.execute("find", effectiveArguments(reader, params), new AbortController().signal);
				const text = result.content[0].text;
				const source = /Source: ([a-f0-9]{16})/.exec(text);
				assert.ok(source);
				sourceId = source[1];
				if (calls === 0) {
					const context = /omit find, and use excerpt_offset: (\d+), expected_source_id: "([a-f0-9]{16})"/.exec(text);
					assert.ok(context);
					contextOffset = Number(context[1]);
					assert.equal(context[2], sourceId);
					assert.doesNotMatch(text, /\] menu/);
				}
				for (const excerpt of text.matchAll(/\[([a-f0-9]{16}:E\d+)\] ([^\n]+)/g)) {
					labels.push(excerpt[1]);
					textParts.push(excerpt[2]);
				}
				const next = /same url and find, excerpt_offset: (\d+), expected_source_id: "([a-f0-9]{16})"/.exec(text);
				const details = result.details as { nextOffset: number | null; find: { query: string } };
				assert.equal(details.find.query, find);
				if (!next) {
					assert.equal(details.nextOffset, null);
					assert.match(text, /End of matching retained excerpts/);
					break;
				}
				assert.equal(details.nextOffset, Number(next[1]));
				params = { url, find, max_bytes: 1000, excerpt_offset: Number(next[1]), expected_source_id: next[2] };
			}
			assert.deepEqual(
				labels,
				[222, 223, 226].map((i) => `${sourceId}:E${i}`),
			);
			assert.ok((textParts[0] + textParts[1]).includes(find));
			const around = await reader.execute(
				"context",
				{ url, excerpt_offset: contextOffset, expected_source_id: sourceId },
				new AbortController().signal,
			);
			assert.match(around.content[0].text, /\] Before/);
			assert.match(around.content[0].text, /\] After/);
			assert.ok(!("find" in (around.details as object)));
			body = "Changed source without the query";
			await assert.rejects(reader.execute("changed", params, new AbortController().signal), /source changed/);
			body = "42 true";
			await assertNormalizedFindExecution(reader, url);
			const count = sockets.length;
			const rejectedQuery = `schema-marker-${"x".repeat(200)}\u001b`;
			assert.throws(
				() => effectiveArguments(reader, { url, find: rejectedQuery }),
				(error: Error) => {
					assert.match(error.message, /Received arguments/);
					assert.ok(error.message.includes(JSON.stringify(rejectedQuery)));
					return true;
				},
			);
			await assert.rejects(
				reader.execute("invalid", effectiveArguments(reader, { url, find: "\u001b" }), new AbortController().signal),
				/find must be/,
			);
			await assert.rejects(reader.execute("cancelled", { url, find }, AbortSignal.abort()), /cancelled/);
			assert.equal(sockets.length, count);
			assert.ok(sockets.every((socket) => socket.destroyed));
		} finally {
			for (const socket of sockets) socket.destroy();
		}
	});

	it("discovers and pages exact links through the registered tool without destination DNS or requests", async (context) => {
		const dns: string[] = [];
		const sockets: Duplex[] = [];
		context.mock.method(Resolver.prototype, "resolve4", async (hostname: string) => {
			dns.push(`A:${hostname}`);
			return [hostname === "private.example" ? "127.0.0.1" : "8.8.8.8"];
		});
		context.mock.method(Resolver.prototype, "resolve6", async (hostname: string) => {
			dns.push(`AAAA:${hostname}`);
			return [];
		});
		const body = `<main>${Array.from({ length: 30 }, (_, i) => `<a href="http://${i === 0 ? "private" : "destination"}.example/item?x=${i}&amp;y=2#part">Target ${i}</a>`).join("")}<a href="http://127.0.0.1/">Omitted private literal</a></main>`;
		context.mock.method(Agent.prototype, "createConnection", () => {
			const raw = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			const socket = new Duplex({
				read() {},
				write(_chunk, _encoding, callback) {
					callback();
					queueMicrotask(() => socket.push(Buffer.from(raw)));
				},
			});
			sockets.push(socket);
			return socket;
		});
		const reader = registry().get("web_read");
		const url = "http://source.example/source";
		let params: JsonObject = { url, view: "links", find: "Target", max_bytes: 1000 };
		const records: { label: string; url: string }[] = [];
		try {
			for (let calls = 0; ; calls++) {
				assert.ok(calls < 15);
				const result = await reader.execute("links", effectiveArguments(reader, params), new AbortController().signal);
				const text = result.content[0].text;
				assert.match(text, /Destinations were not fetched or DNS-checked/);
				for (const match of text.matchAll(/\[[a-f0-9]{16}:L\d+\] (.+)/g)) records.push(JSON.parse(match[1]));
				const next = /view: "links", link_offset: (\d+), expected_source_id: "([a-f0-9]{16})"/.exec(text);
				if (!next) break;
				params = { ...params, link_offset: Number(next[1]), expected_source_id: next[2] };
			}
			assert.equal(records.length, 30);
			assert.equal(new Set(records.map((record) => record.url)).size, 30);
			assert.equal(records[0].url, "http://private.example/item?x=0&y=2#part");
			assert.equal(records[29].url, "http://destination.example/item?x=29&y=2#part");
			assert.ok(sockets.length > 1);
			assert.equal(dns.length, sockets.length * 2);
			assert.ok(dns.every((name) => name.endsWith(":source.example")));
			const count = sockets.length;
			await assert.rejects(
				reader.execute("private", { url: records[0].url }, new AbortController().signal),
				/DNS returned a non-public address/,
			);
			await assert.rejects(
				reader.execute("private-literal", { url: "http://127.0.0.1/", view: "links" }, new AbortController().signal),
				/not allowed/,
			);
			await assert.rejects(
				reader.execute("mixed", { url, view: "links", excerpt_offset: 0 }, new AbortController().signal),
				/link_offset, not excerpt_offset/,
			);
			assert.equal(sockets.length, count);
			assert.ok(sockets.every((socket) => socket.destroyed));
		} finally {
			for (const socket of sockets) socket.destroy();
		}
	});

	it("rejects an already-cancelled web_read execution without a network request", async () => {
		const reader = registry().get("web_read");
		await assert.rejects(reader.execute("call", { url: "https://example.com/" }, AbortSignal.abort()), /cancelled/);
	});

	it("rejects invalid web_read max_bytes before any fetch", async () => {
		const reader = registry().get("web_read");
		await assert.rejects(
			reader.execute("call", { url: "https://example.com/", max_bytes: 500 }, new AbortController().signal),
			/max_bytes/,
		);
	});
});
