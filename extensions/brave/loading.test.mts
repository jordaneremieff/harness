/**
 * The ordinary Brave entrypoint loads the page reader on the first web_read. This file evaluates
 * the entrypoint with a fresh module hook and no earlier import, so a static reader import shows.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RegisteredTool {
	execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text: string }> }>;
}

const loaded: string[] = [];
let entrypoint: Promise<typeof import("./index.ts")> | undefined;

/** Evaluate the entrypoint once, with the load hook already recording its graph. */
async function tools(): Promise<Map<string, RegisteredTool>> {
	registerHooks({
		load(url, context, nextLoad) {
			loaded.push(url);
			return nextLoad(url, context);
		},
	});
	entrypoint ??= import("./index.ts");
	const factory = (await entrypoint).default;
	const found = new Map<string, RegisteredTool>();
	factory({
		on: () => () => {},
		registerTool: (tool: RegisteredTool & { name: string }) => found.set(tool.name, tool),
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as ExtensionAPI);
	return found;
}

const pageReader = () => loaded.filter((url) => url.endsWith("/extensions/brave/page-reader.ts"));
const htmlParser = () => loaded.filter((url) => url.includes("/htmlparser2/"));

const originalFetch = globalThis.fetch;
const sockets: Duplex[] = [];

beforeEach((t) => {
	assert.ok("mock" in t && "after" in t);
	const agentDir = mkdtempSync(join(tmpdir(), "brave-loading-"));
	t.mock.property(process, "env", { PI_CODING_AGENT_DIR: agentDir, PI_BRAVE_API_KEY: "loading-test-key" });
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const socket of sockets.splice(0)) socket.destroy();
});

it("the entrypoint evaluates no page reader and web_search loads neither it nor its parser", async () => {
	const found = await tools();
	assert.deepEqual(pageReader(), []);
	assert.deepEqual(htmlParser(), []);
	globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [] } }))) as typeof fetch;
	const result = await found.get("web_search")?.execute("call", { query: "nothing" }, new AbortController().signal);
	assert.match(result?.content[0]?.text ?? "", /No web results found/);
	assert.deepEqual(pageReader(), []);
	assert.deepEqual(htmlParser(), []);
});

it("cancellation rejects before any read, and the first web_read loads the page reader", async (t) => {
	const found = await tools();
	const reader = found.get("web_read");
	assert.ok(reader);

	await assert.rejects(reader.execute("cancelled", { url: "http://8.8.8.8/" }, AbortSignal.abort()), /cancelled/);
	assert.deepEqual(pageReader(), [], "a read cancelled before the load imports nothing");

	const controller = new AbortController();
	const pending = reader.execute("late", { url: "http://8.8.8.8/" }, controller.signal);
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(sockets.length, 0, "a read cancelled after the load opens no connection");

	t.mock.method(Agent.prototype, "createConnection", () => {
		const body = "Readable evidence.\n";
		const raw = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
		let socket: Duplex;
		socket = new Duplex({
			read() {},
			write(_chunk, _encoding, callback) {
				callback();
				queueMicrotask(() => socket.push(Buffer.from(raw)));
			},
		});
		sockets.push(socket);
		return socket;
	});
	const result = await reader.execute("call", { url: "http://8.8.8.8/evidence" }, new AbortController().signal);
	assert.match(result.content[0]?.text ?? "", /Readable evidence/);
	assert.equal(new Set(pageReader()).size, 1, "the first completed read loads the page reader");
	assert.ok(htmlParser().length > 0, "the parser loads with the first completed read");
});
