import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { durableContribution, type DurableContributionHost } from "./durable.ts";

const SOURCE = fileURLToPath(new URL("./index.ts", import.meta.url));

interface SearchMatch {
	entry: { id: number; kind: string };
	pointer: string;
	excerpt: string;
	offset: number;
	endOffset: number;
}
interface SearchResult {
	status: string;
	visited: number;
	slotsVisited: number;
	candidatesVisited: number;
	scannedBytes: number;
	currentLeafId: number | null;
	startId: number | null;
	matches: SearchMatch[];
	excluded?: number;
	next: { sessionId: string; fromId: number; position: { message: number; block: number }; offset: number } | null;
}
interface ReadItem {
	pointer?: string;
	kind?: string;
}
interface ReadResult {
	status: string;
	text?: string;
	pointer: string;
	items?: ReadItem[];
	entry: { id: number; kind: string };
	membership: string;
	next: unknown;
}

async function openHarness(storageId: string, extraExtensions: Durable.Extension[] = []) {
	const context = BACKGROUND_CONTEXT;
	const host: DurableContributionHost = {
		durable: Durable,
		// The history contribution reads no services fields.
		services: undefined as unknown as AgentSessionServices,
		cwd: fileURLToPath(new URL(".", import.meta.url)),
		agentDir: join(fileURLToPath(new URL(".", import.meta.url)), "agent"),
		storageId,
		signal: new AbortController().signal,
		inventory: { contributions: [{ name: "history", source: SOURCE, commands: [] }], ordinaryOnly: [] },
	};
	const faux = fauxProvider({ tokensPerSecond: Infinity });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const extension = await durableContribution(SOURCE).create(host);
	registry.install(extension);
	for (const extra of extraExtensions) registry.install(extra);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const listed = async () => (await root.entries({}, 100, undefined, context)).items;
	const say = async (input: string) => {
		const settled = await (await root.submit({ type: "input", content: input }, context)).wait(context);
		assert.equal(settled.status, "done");
	};
	const userText = (entry: Durable.EntryRecord): string => {
		const message = entry.model?.[0];
		return message?.role === "user" && typeof message.content === "string" ? message.content : "";
	};
	const resultText = (entry: Durable.EntryRecord): string => {
		const message = entry.model?.[0] as ToolResultMessage | undefined;
		assert.ok(message, "tool result message");
		return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	};
	const toolResults = async (name: string): Promise<Durable.EntryRecord[]> =>
		(await listed()).filter((entry) => {
			const message = entry.model?.[0] as ToolResultMessage | undefined;
			return entry.kind === "pi.tool-result" && message?.toolName === name;
		});
	return { context, extension, faux, harness, listed, resultText, root, say, toolResults, userText };
}

async function nativeSearch(entries: Durable.EntryRecord[], context: Context = BACKGROUND_CONTEXT) {
	const extension = await durableContribution(SOURCE).create({
		durable: Durable,
		services: undefined as unknown as AgentSessionServices,
		cwd: ".",
		agentDir: ".",
		storageId: "synthetic",
		signal: new AbortController().signal,
		inventory: { contributions: [], ordinaryOnly: [] },
	});
	const tool = extension.tools?.find((item) => item.name === "history_search");
	assert.ok(tool);
	const tx = {
		scanEntries: async (query: Durable.EntryQuery, limit: number) => ({
			items: entries.filter((entry) => query.maxEntryId === undefined || entry.id <= query.maxEntryId).slice(0, limit),
		}),
	} as unknown as Durable.Tx;
	const api = {
		conversationId: 1,
		commit: async (fn: (tx: Durable.Tx) => Promise<unknown>) => fn(tx),
	} as unknown as Durable.ToolExecutionApi;
	return async (args: Record<string, unknown> = {}) => {
		const result = await tool.execute(args, api, context);
		const output = result.output as { type: string; text: string }[];
		assert.equal(output.length, 1);
		assert.equal(output[0].type, "text");
		assert.ok(
			Buffer.byteLength(JSON.stringify({ content: output, details: result.details })) <=
				((args.maxOutputBytes as number | undefined) ?? 24576),
		);
		return JSON.parse(output[0].text) as SearchResult;
	};
}

function nativeEntry(model: unknown[], id = 1, kind = "pi.tool-result"): Durable.EntryRecord {
	return { id, conversationId: 1, kind, model } as unknown as Durable.EntryRecord;
}

test("native text traversal counts bounded work and resumes without a prefix scan", async () => {
	let typeVisits = 0;
	const block = new Proxy(
		{ type: "text", text: "x" },
		{
			getOwnPropertyDescriptor(target, key) {
				if (key === "type") typeVisits++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		},
	);
	const search = await nativeSearch([nativeEntry([{ content: Array(10000).fill(block) }])]);
	const first = await search({ query: "absent" });
	assert.equal(first.status, "slot_limit");
	assert.equal(first.slotsVisited, 512);
	assert.equal(first.candidatesVisited, 513);
	assert.equal(first.scannedBytes, 512);
	assert.equal(typeVisits, 512);
	assert.equal(first.next?.position.block, 512);
	assert.equal(first.next?.position.message, 0);
	const second = await search({ query: "absent", ...first.next });
	assert.equal(second.status, "slot_limit");
	assert.equal(second.candidatesVisited, 512);
	assert.equal(typeVisits, 1024);
	assert.equal(second.next?.position.block, 1024);
});

test("native non-text blocks and empty messages consume physical work without repeated prefixes", async () => {
	let typeVisits = 0;
	let minimumBlock = 0;
	const content = Array.from(
		{ length: 10000 },
		(_, index) =>
			new Proxy(
				{ type: "image", data: "excluded" },
				{
					getOwnPropertyDescriptor(target, key) {
						if (key === "type") {
							assert.ok(index >= minimumBlock, "completed prefixes stay unread");
							typeVisits++;
						}
						return Reflect.getOwnPropertyDescriptor(target, key);
					},
				},
			),
	);
	const search = await nativeSearch([
		nativeEntry([{ content: [...content, { type: "text", text: "target" }], errorMessage: "target error" }]),
	]);
	let cursor: Record<string, unknown> = {};
	const pointers: string[] = [];
	for (let calls = 0; calls < 12; calls++) {
		const before = typeVisits;
		const result = await search({ query: "target", ...cursor });
		assert.ok(typeVisits - before <= 1024);
		assert.ok(result.candidatesVisited <= 1024);
		pointers.push(...result.matches.map((match) => match.pointer));
		if (result.next === null) {
			assert.equal(result.status, "ancestry_exhausted");
			break;
		}
		assert.equal(result.status, "candidate_limit");
		assert.equal(result.candidatesVisited, 1024);
		assert.equal(result.slotsVisited, 0);
		assert.equal(result.scannedBytes, 0);
		minimumBlock = result.next.position.block;
		cursor = result.next;
	}
	assert.equal(typeVisits, 10000);
	assert.deepEqual(pointers, ["/model/0/content/10000/text", "/model/0/errorMessage"]);
	const emptyMessages = await nativeSearch([nativeEntry(Array.from({ length: 10000 }, () => ({})))]);
	const empty = await emptyMessages({ query: "absent" });
	assert.equal(empty.status, "candidate_limit");
	assert.equal(empty.candidatesVisited, 1024);
	assert.equal(empty.slotsVisited, 0);
	assert.equal(empty.next?.position.message, 512);
});

test("native traversal observes cancellation inside skipped content", async () => {
	const controller = new AbortController();
	let visits = 0;
	const block = new Proxy(
		{ type: "image" },
		{
			getOwnPropertyDescriptor(target, key) {
				if (key === "type" && ++visits === 37) controller.abort();
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		},
	);
	const search = await nativeSearch(
		[nativeEntry([{ content: Array(10000).fill(block) }])],
		withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
	);
	await assert.rejects(search({ query: "absent" }), /abort/i);
	assert.equal(visits, 37);
});

test("native physical cursors preserve pointers, filters, overlap, Unicode and output bounds", async () => {
	const text = `${"x".repeat(2047)}🧭λ${"🧭λ".repeat(35)}`;
	const query = "🧭λ";
	const search = await nativeSearch([
		nativeEntry([{ content: Array(10000).fill({ type: "text", text: "excluded" }) }], 2, "pi.assistant"),
		nativeEntry(
			[
				{
					content: [
						{ type: "image" },
						{ type: "thinking", redacted: true, thinking: query },
						{ type: "thinking", thinking: text },
					],
				},
				{ content: text, errorMessage: text },
			],
			1,
			"pi.user",
		),
	]);
	const actual: string[] = [];
	let cursor: Record<string, unknown> = {};
	let complete = false;
	for (let calls = 0; calls < 100; calls++) {
		const result = await search({
			query,
			filter: { source: "user" },
			maxScanBytes: 2048,
			maxMatches: 7,
			maxOutputBytes: 4096,
			...cursor,
		});
		assert.ok(result.candidatesVisited <= 1024);
		assert.ok(result.slotsVisited <= 512);
		assert.ok(result.scannedBytes <= 2048);
		if (calls === 0) assert.equal(result.excluded, 1);
		for (const match of result.matches) {
			assert.equal(text.slice(match.offset, match.endOffset), query);
			actual.push(`${match.pointer}:${match.offset}`);
		}
		if (result.next === null) {
			complete = true;
			break;
		}
		assert.notEqual(JSON.stringify(result.next), JSON.stringify(cursor));
		cursor = result.next;
	}
	assert.ok(complete);
	const expected: string[] = [];
	for (const pointer of ["/model/0/content/2/thinking", "/model/1/content", "/model/1/errorMessage"]) {
		for (let offset = text.indexOf(query); offset !== -1; offset = text.indexOf(query, offset + 1))
			expected.push(`${pointer}:${offset}`);
	}
	assert.deepEqual(actual, expected);
});

test("native search refuses retired text-slot cursors and incomplete physical continuations", async () => {
	const search = await nativeSearch([nativeEntry([{ content: "😀target" }])]);
	for (const slot of [0, 512])
		await assert.rejects(search({ query: "target", fromId: 1, slot, offset: 0 }), /retired.*Start a new search/);
	await assert.rejects(search({ query: "target", fromId: 1, offset: 2 }), /physical position/);
	await assert.rejects(search({ query: "target", position: { message: 0, block: -1 } }), /requires fromId/);
	await assert.rejects(
		search({ query: "target", fromId: 1, position: { message: 0, block: -1 }, offset: 1 }),
		/Unicode boundary/,
	);
	await assert.rejects(
		search({ query: "target", fromId: 1, position: { message: 0, block: 3 } }),
		/physical candidate/,
	);
	const listed = await search({ maxMatches: 1 });
	assert.equal(listed.candidatesVisited, 0);
});

test("history contribution serves model-issued search and read calls over the real Harness", async (t) => {
	const { context, extension, faux, harness, listed, resultText, root, say, toolResults, userText } =
		await openHarness("history-durable-test");
	try {
		faux.setResponses([fauxAssistantMessage("Acknowledged alpha.")]);
		await say("release alpha");
		faux.setResponses([fauxAssistantMessage("Acknowledged beta.")]);
		await say("release beta");

		const fixture = await listed();
		const alpha = fixture.find((entry) => entry.kind === "pi.user" && userText(entry) === "release alpha");
		const beta = fixture.find((entry) => entry.kind === "pi.user" && userText(entry) === "release beta");
		assert.ok(alpha, "alpha user entry");
		assert.ok(beta, "beta user entry");

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history_search", { query: "release", fromId: beta.id, maxMatches: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("First match found."),
		]);
		await say("find the newest release note");
		const firstPage = JSON.parse(resultText((await toolResults("history_search"))[0])) as SearchResult;
		assert.equal(firstPage.status, "match_limit");
		assert.equal(firstPage.matches.length, 1);
		assert.equal(firstPage.matches[0].entry.id, beta.id);
		assert.equal(firstPage.matches[0].excerpt, "release beta");
		assert.ok(firstPage.next, "continuation");
		assert.equal(firstPage.next.fromId, beta.id);

		const continuation = {
			query: "release",
			fromId: firstPage.next.fromId,
			position: firstPage.next.position,
			offset: firstPage.next.offset,
			maxMatches: 1,
			sessionId: firstPage.next.sessionId,
		};
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("history_search", { ...continuation }),
					fauxToolCall("history_read", { entryId: alpha.id, pointer: "/model/0/content" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("history_search", { ...continuation }, { id: "search-again" }),
					fauxToolCall("history_read", { entryId: alpha.id, pointer: "/model/0/content" }, { id: "read-again" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Continuation complete."),
		]);
		await say("continue the search and read the alpha note");

		const searches = (await toolResults("history_search")).map(
			(entry) => JSON.parse(resultText(entry)) as SearchResult,
		);
		const reads = (await toolResults("history_read")).map((entry) => JSON.parse(resultText(entry)) as ReadResult);
		assert.equal(searches.length, 3);
		assert.equal(reads.length, 2);
		const secondPage = searches[0];
		assert.equal(secondPage.status, "match_limit");
		assert.equal(secondPage.matches[0].entry.id, alpha.id);
		assert.ok(secondPage.visited > 1, "continuation crosses entries");
		const pinned = (value: SearchResult | ReadResult) => {
			const copy = { ...value } as Record<string, unknown>;
			delete copy.currentLeafId;
			return copy;
		};
		assert.deepEqual(pinned(searches[0]), pinned(searches[1]));
		const read = reads[0];
		assert.equal(read.status, "complete");
		assert.equal(read.text, "release alpha");
		assert.equal(read.entry.id, alpha.id);
		assert.equal(read.membership, "checked_visible");
		assert.equal(read.next, null);
		assert.deepEqual(pinned(reads[0]), pinned(reads[1]));

		const searchTool = extension.tools?.find((tool) => tool.name === "history_search");
		const readTool = extension.tools?.find((tool) => tool.name === "history_read");
		assert.equal(searchTool?.replay, "safe");
		assert.equal(readTool?.replay, "safe");
		assert.equal(searchTool?.structuredOutputSchema, undefined);
		assert.equal(readTool?.structuredOutputSchema, undefined);
		for (const entry of [...(await toolResults("history_search")), ...(await toolResults("history_read"))]) {
			const message = entry.model?.[0] as ToolResultMessage;
			assert.equal(message.isError, false);
			assert.deepEqual(message.details, {});
			assert.equal(message.content.length, 1);
		}

		const { messages } = await root.context(context);
		const system = messages.find((message) => message.role === "system");
		assert.match(system?.sections?.history ?? "", /history_search/);
		assert.equal(faux.state.callCount, 7);
		t.diagnostic(
			JSON.stringify({
				firstPage: { status: firstPage.status, matched: firstPage.matches[0].entry.id },
				secondPage: {
					status: secondPage.status,
					matched: secondPage.matches[0].entry.id,
					visited: secondPage.visited,
				},
				read: { status: read.status, text: read.text, membership: read.membership },
			}),
		);
	} finally {
		await harness.close(context);
	}
});

test("history read and filter adapt to Durable entry records", async () => {
	const { context, faux, harness, listed, resultText, say, toolResults } = await openHarness("history-durable-records");
	try {
		faux.setResponses([fauxAssistantMessage("note acknowledged")]);
		await say("target note");
		const fixture = await listed();
		const user = fixture.find((entry) => entry.kind === "pi.user");
		const assistant = fixture.find((entry) => entry.kind === "pi.assistant");
		const system = fixture.find((entry) => entry.kind === "pi.system");
		assert.ok(user, "user entry");
		assert.ok(assistant, "assistant entry");
		assert.ok(system, "system entry");

		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("history_search", { query: "note", filter: { source: "user" } }),
					fauxToolCall("history_read", { entryId: user.id, pointer: "/model/0" }),
					fauxToolCall("history_read", { entryId: assistant.id, pointer: "/model/0/content/0/text" }),
					fauxToolCall("history_read", { entryId: system.id, pointer: "/model/0/sections/history" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Records checked."),
		]);
		await say("verify the records");

		const search = JSON.parse(resultText((await toolResults("history_search"))[0])) as SearchResult;
		const reads = (await toolResults("history_read")).map((entry) => JSON.parse(resultText(entry)) as ReadResult);
		const readAt = (pointer: string): ReadResult => {
			const found = reads.find((read) => read.pointer === pointer);
			assert.ok(found, pointer);
			return found;
		};

		assert.equal(search.matches.length, 1);
		assert.equal(search.matches[0].entry.id, user.id);
		assert.equal(search.matches[0].entry.kind, "pi.user");
		assert.equal(search.matches[0].excerpt, "note");
		assert.ok((search.excluded ?? 0) >= 1);

		const manifest = readAt("/model/0");
		assert.equal(manifest.status, "complete");
		assert.equal(manifest.entry.kind, "pi.user");
		assert.deepEqual(
			(manifest.items ?? []).map((item) => item.pointer),
			["/model/0/role", "/model/0/content", "/model/0/timestamp"],
		);

		const block = readAt("/model/0/content/0/text");
		assert.equal(block.status, "complete");
		assert.equal(block.text, "note acknowledged");
		assert.equal(block.entry.kind, "pi.assistant");

		const section = readAt("/model/0/sections/history");
		assert.equal(section.status, "complete");
		assert.match(section.text ?? "", /history_search/);
	} finally {
		await harness.close(context);
	}
});

test("native codemode receives history JSON text strings with continuations and exact escapes", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const { context, faux, harness, listed, resultText, say, toolResults, userText } = await openHarness(
			"history-native-codemode",
			[createCodemodeExtension({ sandbox, models: false })],
		);
		try {
			const note = "nested alpha \u0001😀";
			faux.setResponses([fauxAssistantMessage("Note stored.")]);
			await say(note);
			const user = (await listed()).find((entry) => entry.kind === "pi.user" && userText(entry) === note);
			assert.ok(user);
			const searchArgs = { query: "nested", fromId: user.id, maxMatches: 1 };
			const readArgs = { entryId: user.id, pointer: "/model/0/content" };
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("history_search", searchArgs), fauxToolCall("history_read", readArgs)], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Direct calls complete."),
			]);
			await say("Read the pinned note directly.");
			const directSearch = JSON.parse(resultText((await toolResults("history_search"))[0]));
			const directRead = JSON.parse(resultText((await toolResults("history_read"))[0]));

			const code = `
const search = await tools.history_search(${JSON.stringify(searchArgs)});
const read = await tools.history_read(${JSON.stringify(readArgs)});
const page = await tools.history_read(${JSON.stringify({ ...readArgs, maxBytes: 4 })});
const next = JSON.parse(page).next;
const continuation = await tools.history_read(next);
const manifest = await tools.history_read({ entryId: ${user.id} });
text(JSON.stringify({ fixture: "history-nested", search, read, page, continuation, manifest }));`;
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Nested calls complete."),
			]);
			await say("Read the same pinned note through codemode.");
			const result = (await toolResults("codemode"))[0];
			assert.equal((result.model?.[0] as ToolResultMessage | undefined)?.isError, false);
			const line = resultText(result)
				.split("\n")
				.find((value) => value.startsWith('{"fixture":"history-nested"'));
			assert.ok(line, resultText(result));
			const nested = JSON.parse(line);
			for (const key of ["search", "read", "page", "continuation", "manifest"]) {
				assert.equal(typeof nested[key], "string", key);
			}
			const pinned = (value: Record<string, unknown>) => {
				const copy = { ...value };
				delete copy.currentLeafId;
				return copy;
			};
			assert.deepEqual(pinned(JSON.parse(nested.search)), pinned(directSearch));
			assert.deepEqual(pinned(JSON.parse(nested.read)), pinned(directRead));
			assert.match(nested.read, /\\u0001/);
			assert.equal(JSON.parse(nested.read).text, note);
			assert.equal(JSON.parse(nested.page).status, "page");
			assert.equal(JSON.parse(nested.page).text, "nest");
			assert.equal(JSON.parse(nested.page).next.offset, 4);
			assert.equal(JSON.parse(nested.continuation).text, note.slice(4));
			assert.ok(JSON.parse(nested.manifest).items.some((item: ReadItem) => item.pointer === "/model"));
			assert.equal((await toolResults("history_search")).length, 1, "nested calls do not enter the transcript");
			assert.equal((await toolResults("history_read")).length, 1, "nested calls do not enter the transcript");
		} finally {
			await harness.close(context);
		}
	} finally {
		await sandbox.close();
	}
});

test("history model errors stay errors and schema-less native codemode calls reject", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const { context, faux, harness, resultText, say, toolResults } = await openHarness("history-native-errors", [
			createCodemodeExtension({ sandbox, models: false }),
		]);
		try {
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("history_read", { entryId: 0 }),
						fauxToolCall("history_search", { sessionId: "different-storage" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Direct errors observed."),
			]);
			await say("Check invalid history arguments.");
			const invalidRead = (await toolResults("history_read"))[0];
			const invalidSearch = (await toolResults("history_search"))[0];
			assert.equal((invalidRead.model?.[0] as ToolResultMessage | undefined)?.isError, true);
			assert.equal((invalidSearch.model?.[0] as ToolResultMessage | undefined)?.isError, true);
			assert.match(resultText(invalidRead), /entryId/);
			assert.match(resultText(invalidSearch), /Session changed/);

			const code = `
const errors = [];
for (const call of [
  () => tools.history_read({ entryId: 0 }),
  () => tools.history_search({ sessionId: "different-storage" }),
  () => tools.history_read({ entryId: 1, pointer: "not-a-pointer" })
]) {
  try { await call(); errors.push("resolved"); }
  catch (error) { errors.push(error.message); }
}
text(JSON.stringify({ fixture: "history-errors", errors }));`;
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Nested rejections observed."),
			]);
			await say("Catch invalid history calls in codemode.");
			const caught = (await toolResults("codemode"))[0];
			assert.equal((caught.model?.[0] as ToolResultMessage | undefined)?.isError, false);
			const line = resultText(caught)
				.split("\n")
				.find((value) => value.startsWith('{"fixture":"history-errors"'));
			assert.ok(line, resultText(caught));
			const { errors } = JSON.parse(line);
			assert.equal(errors.length, 3);
			assert.match(errors[0], /entryId/);
			assert.match(errors[1], /Session changed/);
			assert.match(errors[2], /JSON pointer/);

			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("codemode", { code: 'await tools.history_search({ sessionId: "different-storage" });' }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Uncaught rejection observed."),
			]);
			await say("Let the invalid history call reject codemode.");
			const uncaught = (await toolResults("codemode"))[0];
			assert.equal((uncaught.model?.[0] as ToolResultMessage | undefined)?.isError, true);
			assert.match(resultText(uncaught), /Session changed/);
		} finally {
			await harness.close(context);
		}
	} finally {
		await sandbox.close();
	}
});
