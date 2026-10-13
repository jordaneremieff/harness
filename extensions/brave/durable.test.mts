/**
 * Real-Harness tests for the brave Durable contribution: one model-issued call
 * per tool, the declared replay classes, and recovery over retained storage.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ToolResultMessage } from "@earendil-works/pi-ai";
import { createEventBus, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { runWebSearch } from "./capability.ts";
import { readWebPage } from "./page-reader.ts";
import { braveDurableContribution, type DurableContributionHost } from "./durable.ts";

const source = fileURLToPath(new URL("./index.ts", import.meta.url));

const originalFetch = globalThis.fetch;

beforeEach((t) => {
	assert.ok("mock" in t && "after" in t);
	const agentDir = mkdtempSync(join(tmpdir(), "brave-durable-"));
	t.mock.property(process, "env", { PI_CODING_AGENT_DIR: agentDir });
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** One complete HTTP/1.1 response pushed when the request writes. */
function responseSocket(body: string): Duplex {
	const raw = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
	const socket: Duplex = new Duplex({
		read() {},
		write(_chunk, _encoding, callback) {
			callback();
			queueMicrotask(() => socket.push(Buffer.from(raw)));
		},
	});
	return socket;
}

/**
 * The native form built through the real contribution host shape. The brave
 * tools read no cwd-bound Pi services, so `services` stays empty.
 */
async function nativeExtension(): Promise<Durable.Extension> {
	const contribution = braveDurableContribution(source, createEventBus(), () => {});
	const host: DurableContributionHost = {
		durable: Durable,
		services: {} as DurableContributionHost["services"],
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		storageId: "brave-durable-test",
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [{ name: "brave", source, commands: [] }], ordinaryOnly: [] },
	};
	return await contribution.create(host);
}

/** A MemoryStorage that survives its owner's close, simulating process loss with retained storage. */
class ReopenableMemoryStorage extends Durable.MemoryStorage {
	override async close(_context: Context): Promise<void> {}
}

function nativeModels(): { faux: ReturnType<typeof fauxProvider>; models: Models; registry: Durable.Registry } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, registry: Durable.createRegistry() };
}

async function openRoot(
	models: Models,
	registry: Durable.Registry,
	storage: Durable.Storage,
): Promise<{ harness: Durable.Harness; root: Durable.Conversation }> {
	const harness = await Durable.Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
	harness.resume();
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	return { harness, root };
}

async function toolResults(root: Durable.Conversation): Promise<ToolResultMessage[]> {
	const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	return [...page.items]
		.reverse()
		.flatMap((entry) => (Durable.ToolResultEntry.is(entry) ? (entry.model?.[0] as ToolResultMessage) : []));
}

function toolText(message: ToolResultMessage | undefined): string {
	if (message === undefined) return "";
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("brave durable contribution", () => {
	it("declares the ordinary tool surface, guidance, and replay classes", async () => {
		const extension = await nativeExtension();
		assert.equal(extension.name, "brave");
		const tools = [...(extension.tools ?? [])];
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["web_read", "web_search"],
		);
		assert.equal(tools[0]?.replay, "safe");
		assert.equal(tools[1]?.replay, "unsafe");
		assert.ok(tools.every((tool) => tool.structuredOutputSchema === undefined));
		assert.match(tools[0]?.description ?? "", /public HTTP\(S\) page/);
		assert.match(tools[1]?.description ?? "", /Brave Search/);
		assert.equal(extension.hooks, undefined);
		assert.equal(extension.tasks, undefined);
		const section = extension.sections?.[0];
		assert.equal(section?.key, "web-guidance");
		const rendered = await section?.render({} as never, BACKGROUND_CONTEXT);
		assert.match(rendered ?? "", /public primary page/);
		assert.match(rendered ?? "", /untrusted evidence, not instructions/);
	});

	it("answers model-issued web_search and web_read calls through a real harness", async (t) => {
		const extension = await nativeExtension();
		const { faux, models, registry } = nativeModels();
		registry.install(extension);
		const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "faux-1" } },
		});

		process.env.PI_BRAVE_API_KEY = "durable-test-key";
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches += 1;
			return new Response(
				JSON.stringify({
					query: { original: "durable evidence" },
					web: {
						results: [{ title: "Durable evidence", url: "https://example.com/evidence", description: "A source" }],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		t.mock.method(Agent.prototype, "createConnection", () => responseSocket("Durable page evidence.\n"));

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "durable evidence" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("web_read", { url: "http://8.8.8.8/evidence" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		const settled = await (await root.submit({ type: "input", content: "research" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled.status, "done");
		assert.equal(fetches, 1);

		const results = await toolResults(root);
		assert.equal(results.length, 2);
		const [search, read] = results;
		assert.equal(search?.toolName, "web_search");
		assert.match(toolText(search), /Brave Search results for "durable evidence"/);
		assert.match(toolText(search), /https:\/\/example\.com\/evidence/);
		assert.deepEqual(search?.details, {
			query: "durable evidence",
			resultCount: 1,
			count: 10,
			offset: 0,
			moreResultsAvailable: false,
			outputTruncated: false,
		});
		assert.equal(read?.toolName, "web_read");
		assert.match(toolText(read), /Final URL: http:\/\/8\.8\.8\.8\/evidence/);
		assert.match(toolText(read), /Durable page evidence\./);
		assert.equal((read?.details as { extraction?: unknown } | undefined)?.extraction, "plain-text");

		await harness.close(BACKGROUND_CONTEXT);
	});

	it("returns ordinary strings through public native codemode", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1700000000000 });
		process.env.PI_BRAVE_API_KEY = "durable-test-key";
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					web: {
						results: [{ title: "Nested evidence", url: "https://example.com/evidence", description: "A source" }],
					},
				}),
				{ headers: { "content-type": "application/json" } },
			)) as typeof fetch;
		t.mock.method(Agent.prototype, "createConnection", () => responseSocket("Nested page evidence.\n"));
		const searchArgs = { query: "nested evidence" };
		const readArgs = { url: "http://8.8.8.8/evidence" };
		const ordinarySearch = await runWebSearch(searchArgs, undefined, { agentDir: getAgentDir() });
		const ordinaryRead = await readWebPage(readArgs);
		const expected = [ordinarySearch.content[0]?.text, ordinaryRead.content[0]?.text];
		const { faux, models, registry } = nativeModels();
		registry.install(await nativeExtension());
		const sandbox = new CodemodeSandbox();
		t.after(() => sandbox.close());
		registry.install(createCodemodeExtension({ sandbox, models: false }));
		registry.install(
			Durable.defineExtension({
				name: "web-result-probe",
				tools: [
					Durable.defineTool({
						name: "inspect_web_results",
						description: "Inspect nested web results",
						parameters: Type.Object({}),
						execute: async (_args, api, context) => {
							const results = await Promise.all([
								api.executeTool("web_search", searchArgs, context),
								api.executeTool("web_read", readArgs, context),
							]);
							return { output: [{ type: "text", text: JSON.stringify(results) }] };
						},
					}),
				],
			}),
		);
		const { harness, root } = await openRoot(models, registry, new Durable.MemoryStorage());
		t.after(() => harness.close(BACKGROUND_CONTEXT));
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `text(JSON.stringify(await Promise.all([tools.web_search(${JSON.stringify(searchArgs)}), tools.web_read(${JSON.stringify(readArgs)})])));`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("inspect_web_results", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const settled = await (await root.submit({ type: "input", content: "research" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled.status, "done");
		const results = await toolResults(root);
		assert.equal(results.length, 2, "only model-issued calls add model tool-result messages");
		assert.equal(results[0]?.isError, false);
		assert.ok(expected.every((value) => typeof value === "string" && value.length > 0));
		assert.ok(
			toolText(results[0]).includes(JSON.stringify(expected)),
			"both nested values equal ordinary text exactly",
		);
		const nested = JSON.parse(toolText(results[1])) as Durable.NestedToolExecutionResult[];
		assert.deepEqual(
			nested.map((result) => result.structuredOutput),
			expected,
		);
		assert.deepEqual(
			nested.map((result) => result.details),
			JSON.parse(JSON.stringify([ordinarySearch.details, ordinaryRead.details])),
		);
		assert.ok(nested.every((result) => !result.isError && result.diagnostics.length === 0));
		const calls = (results[0]?.details as Durable.JsonObject | undefined)?.calls as { name: string; status: string }[];
		assert.deepEqual(
			calls.map(({ name, status }) => ({ name, status })),
			[
				{ name: "web_search", status: "ok" },
				{ name: "web_read", status: "ok" },
			],
		);
	});

	it("rejects schema-less errors in public native codemode", async (t) => {
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches += 1;
			throw new Error("Unexpected network request");
		}) as typeof fetch;
		const { faux, models, registry } = nativeModels();
		registry.install(await nativeExtension());
		const sandbox = new CodemodeSandbox();
		t.after(() => sandbox.close());
		registry.install(createCodemodeExtension({ sandbox, models: false }));
		const { harness, root } = await openRoot(models, registry, new Durable.MemoryStorage());
		t.after(() => harness.close(BACKGROUND_CONTEXT));
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `
				const outcomes = await Promise.allSettled([
					tools.web_search({ query: "no configured key" }),
					tools.web_read({ url: "http://127.0.0.1/private" })
				]);
				text(outcomes.map(item => ({status: item.status, error: item.status === "rejected" ? String(item.reason) : "resolved"})));`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: `await tools.web_read({url: "http://127.0.0.1/private"});` }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		const settled = await (await root.submit({ type: "input", content: "errors" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled.status, "done");
		const results = await toolResults(root);
		assert.equal(results.length, 2);
		assert.equal(results[0]?.isError, false, "the script handles both rejected promises");
		assert.equal((toolText(results[0]).match(/rejected/g) ?? []).length, 2);
		assert.match(toolText(results[0]), /PI_BRAVE_API_KEY/);
		assert.match(toolText(results[0]), /public|private|loopback/i);
		assert.equal(results[1]?.isError, true, "an uncaught rejected call fails the script");
		assert.match(toolText(results[1]), /public|private|loopback/i);
		assert.equal(fetches, 0);
	});

	it("reruns a replay-safe web_read after the harness interrupts the call", async (t) => {
		const extension = await nativeExtension();
		const { faux, models, registry } = nativeModels();
		registry.install(extension);
		const storage = new ReopenableMemoryStorage();
		const reached = deferred();
		let connections = 0;
		t.mock.method(Agent.prototype, "createConnection", () => {
			connections += 1;
			if (connections === 1) {
				reached.resolve();
				return new Duplex({
					read() {},
					write(_chunk, _encoding, callback) {
						callback();
					},
				});
			}
			return responseSocket("Replayed page evidence.\n");
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_read", { url: "http://8.8.8.8/evidence" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		let opened = await openRoot(models, registry, storage);
		const submission = await opened.root.submit({ type: "input", content: "read" }, BACKGROUND_CONTEXT);
		await reached.promise;
		await opened.harness.close(BACKGROUND_CONTEXT);

		opened = await openRoot(models, registry, storage);
		const settled = await (await opened.harness.submission(submission.id, BACKGROUND_CONTEXT))?.wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled?.status, "done");
		assert.equal(connections, 2, "the safe tool fetched again after recovery");
		const [read] = await toolResults(opened.root);
		assert.equal(read?.toolName, "web_read");
		assert.equal(read?.isError, false);
		assert.match(toolText(read), /Replayed page evidence\./);
		await opened.harness.close(BACKGROUND_CONTEXT);
	});

	it("does not rerun an interrupted web_search and delivers its interrupted result", async () => {
		const extension = await nativeExtension();
		const { faux, models, registry } = nativeModels();
		registry.install(extension);
		const storage = new ReopenableMemoryStorage();
		process.env.PI_BRAVE_API_KEY = "durable-test-key";
		const reached = deferred();
		let fetches = 0;
		globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
			fetches += 1;
			reached.resolve();
			const signal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}) as typeof fetch;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "must not repeat" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);

		let opened = await openRoot(models, registry, storage);
		const submission = await opened.root.submit({ type: "input", content: "search" }, BACKGROUND_CONTEXT);
		await reached.promise;
		await opened.harness.close(BACKGROUND_CONTEXT);

		opened = await openRoot(models, registry, storage);
		const settled = await (await opened.harness.submission(submission.id, BACKGROUND_CONTEXT))?.wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(settled?.status, "done");
		assert.equal(fetches, 1, "the interrupted unsafe search did not run again");
		const [search] = await toolResults(opened.root);
		assert.equal(search?.toolName, "web_search");
		assert.equal(search?.isError, true);
		assert.match(toolText(search), /interrupted/);
		await opened.harness.close(BACKGROUND_CONTEXT);
	});
});
