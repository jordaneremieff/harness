/**
 * The native Brave contribution loads the page reader on the first web_read. This file evaluates
 * the contribution module with a fresh module hook and no earlier import, so a static reader import shows.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";

const loaded: string[] = [];
let modules: Promise<typeof import("./durable.ts")> | undefined;

const pageReader = () => loaded.filter((url) => url.endsWith("/extensions/brave/page-reader.ts"));
const htmlParser = () => loaded.filter((url) => url.includes("/htmlparser2/"));

const source = fileURLToPath(new URL("./index.ts", import.meta.url));
const originalFetch = globalThis.fetch;
const sockets: Duplex[] = [];

beforeEach((t) => {
	assert.ok("mock" in t && "after" in t);
	const agentDir = mkdtempSync(join(tmpdir(), "brave-durable-loading-"));
	t.mock.property(process, "env", { PI_CODING_AGENT_DIR: agentDir, PI_BRAVE_API_KEY: "loading-test-key" });
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const socket of sockets.splice(0)) socket.destroy();
});

it("the contribution evaluates no page reader, and web_search loads neither it nor its parser", async (t) => {
	registerHooks({
		load(url, context, nextLoad) {
			loaded.push(url);
			return nextLoad(url, context);
		},
	});
	modules ??= import("./durable.ts");
	const { braveDurableContribution } = await modules;
	assert.deepEqual(pageReader(), [], "the contribution graph excludes the page reader");
	assert.deepEqual(htmlParser(), [], "and its parser");

	const contribution = braveDurableContribution(source, createEventBus(), () => {});
	const extension = await contribution.create({
		durable: Durable,
		services: {} as never,
		cwd: process.cwd(),
		agentDir: process.env.PI_CODING_AGENT_DIR ?? "",
		storageId: "brave-durable-loading",
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [{ name: "brave", source, commands: [] }], ordinaryOnly: [] },
	});
	const search = [...(extension.tools ?? [])].find((tool) => tool.name === "web_search");
	assert.ok(search);
	globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [] } }))) as typeof fetch;
	const signal = new AbortController().signal;
	await search.execute({ query: "nothing" }, {} as Parameters<typeof search.execute>[1], { abortSignal: signal } as Context);
	assert.deepEqual(pageReader(), [], "web_search evaluates no page reader");
	assert.deepEqual(htmlParser(), [], "web_search evaluates no parser");

	const read = [...(extension.tools ?? [])].find((tool) => tool.name === "web_read");
	assert.ok(read);
	const api = {} as Parameters<typeof read.execute>[1];
	await assert.rejects(read.execute({ url: "http://8.8.8.8/" }, api, { abortSignal: AbortSignal.abort() } as Context), /cancelled/);
	assert.equal(sockets.length, 0, "a cancelled read opens no connection");
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
	const result = await read.execute({ url: "http://8.8.8.8/evidence" }, api, { abortSignal: signal } as Context);
	const output = result.output;
	const text =
		typeof output === "string"
			? output
			: (output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
	assert.match(text, /Readable evidence/);
	assert.equal(new Set(pageReader()).size, 1, "the first completed read loads the page reader");
	assert.ok(htmlParser().length > 0, "the parser loads with the first completed read");
});
