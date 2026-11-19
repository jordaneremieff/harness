import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { markdownContribution, type MarkdownCommandCall, type MarkdownHost } from "./durable.ts";
import { acquireResponse, PAGE_BYTES, readPanelAnswer } from "./panel-protocol.ts";
import { MarkdownStore } from "./store.ts";
import { createNativeReadTool, READ_PAGE_BYTES, readStored, readText, type ReadInput } from "./read.ts";

test("a native agent reads an exact revision and recovers from a stale update through the model tools", {
	timeout: 20000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-native-read-"));
	const previous = {
		dir: process.env.PI_MARKDOWN_DIR,
		app: process.env.PI_MARKDOWN_APP,
		file: process.env.PI_HARNESS_FILE,
	};
	process.env.PI_MARKDOWN_DIR = join(root, "documents");
	process.env.PI_MARKDOWN_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const disposers: (() => void | Promise<void>)[] = [];
	try {
		const host: MarkdownHost = {
			durable: Durable,
			agentDir: root,
			cwd: root,
			storageId: "synthetic",
			harness,
			onClose: (callback) => disposers.push(callback),
		};
		const extension = markdownContribution(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			createEventBus(),
			() => {},
		).create(host);
		assert.deepEqual(
			extension.tools?.map((tool) => [tool.name, tool.replay]),
			[
				["markdown_brief", "safe"],
				["markdown_publish", "safe"],
				["markdown_read", "safe"],
				["markdown_live", "safe"],
			],
		);
		registry.install(extension);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const store = new MarkdownStore(process.env.PI_MARKDOWN_DIR);
		const document = (
			await store.create({
				title: "Plan",
				source: "# Plan\n\nFirst.\n",
				contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
			})
		).document.id;
		await store.update(document, 1, {
			title: "Plan",
			source: "# Plan\n\nSecond.\n",
			contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
		});
		const results = async () =>
			(await conversation.entries({}, 100, undefined, context)).items
				.filter((entry) => Durable.ToolResultEntry.is(entry))
				.sort((a, b) => Number(a.id) - Number(b.id))
				.map((entry) => {
					const model = entry.model?.[0];
					return model?.role === "toolResult"
						? { isError: model.isError, parts: model.content.map((part) => (part.type === "text" ? part.text : "")) }
						: undefined;
				});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("markdown_read", { query: "plan" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("markdown_publish", { title: "Plan", text: "# Plan\n\nStale.\n", document, expectedRevision: 1 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("markdown_read", { document, revision: 2 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("markdown_publish", {
					title: "Plan",
					text: "# Plan\n\nSecond.\n\nThird.\n",
					document,
					expectedRevision: 2,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Corrected."),
		]);
		assert.equal(
			(await (await conversation.submit({ type: "input", content: "Correct the plan." }, context)).wait(context))
				.status,
			"done",
		);
		const [find, stale, read, update] = await results();
		assert.match(
			find?.parts[0] ?? "",
			new RegExp(`^1 published document match "plan" among 1 scanned entries\\.\\n${document} · revision 2 · `, "u"),
		);
		assert.equal(stale?.isError, true);
		assert.match(
			stale?.parts.join("") ?? "",
			/Revision 2 \(sha256:[a-f0-9]{64}\) is current\. Read it with markdown_read/u,
		);
		assert.equal(read?.isError, false);
		assert.equal(read?.parts.length, 2);
		assert.equal(read?.parts[1], "# Plan\n\nSecond.\n");
		assert.match(
			read?.parts[0] ?? "",
			/To correct it, publish with document md-[a-f0-9]{20} and expectedRevision 2\./u,
		);
		assert.equal(update?.isError, false);
		const current = await store.get(document);
		assert.equal(current.revision.revision, 3);
		assert.equal(current.source, "# Plan\n\nSecond.\n\nThird.\n");
	} finally {
		for (const dispose of disposers) await dispose();
		await harness.close(context);
		for (const [key, value] of Object.entries({
			PI_MARKDOWN_DIR: previous.dir,
			PI_MARKDOWN_APP: previous.app,
			PI_HARNESS_FILE: previous.file,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});

for (const [name, source] of [
	["one line above the default byte limit", "x".repeat(READ_PAGE_BYTES)],
	["short lines above the default line limit", "x\n".repeat(2500)],
	["a page filled with newlines", `${"\n".repeat(READ_PAGE_BYTES - 1)}x`],
	["multiple pages with Unicode boundaries", `${"a".repeat(READ_PAGE_BYTES - 1)}🦘${"b\n".repeat(READ_PAGE_BYTES)}end`],
])
	test(`native stored reads retain exact headers and source for ${name}`, { timeout: 20000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "markdown-native-page-"));
		const store = new MarkdownStore(root);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = Durable.createRegistry();
		registry.install(Durable.defineExtension({ name: "markdown", tools: [createNativeReadTool(Durable, { store })] }));
		const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
		try {
			const saved = await store.create({
				title: "Exact source",
				source,
				contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() },
			});
			const inputs: ReadInput[] = [];
			const expected: { header: string; source?: string }[] = [];
			let offset: number | null = 0;
			do {
				const input: ReadInput = { document: saved.document.id, revision: 1, offset };
				const page = await readStored(store, input);
				assert.ok(page.ok && page.op === "read");
				inputs.push(input);
				expected.push(readText(page));
				offset = page.nextOffset;
			} while (offset !== null);
			const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			faux.setResponses([
				...inputs.map((input) => fauxAssistantMessage(fauxToolCall("markdown_read", input), { stopReason: "toolUse" })),
				fauxAssistantMessage("Read complete."),
			]);
			assert.equal(
				(await (await conversation.submit({ type: "input", content: "Read every exact page." }, context)).wait(context))
					.status,
				"done",
			);
			const entries = (await conversation.entries({}, 100, undefined, context)).items
				.filter(Durable.ToolResultEntry.is)
				.sort((a, b) => Number(a.id) - Number(b.id));
			assert.equal(entries.length, expected.length);
			let acquired = "";
			for (const [index, entry] of entries.entries()) {
				assert.deepEqual(entry.data.diagnostics, []);
				const message = entry.model?.[0];
				assert.ok(message?.role === "toolResult" && !message.isError);
				assert.deepEqual(message.content, [
					{ type: "text", text: expected[index].header },
					{ type: "text", text: expected[index].source },
				]);
				acquired += expected[index].source;
			}
			assert.ok(acquired === source, "the model-visible pages retain the complete source");
		} finally {
			await harness.close(context);
			await rm(root, { recursive: true, force: true });
		}
	});

// Native calls use the open host Harness; the contribution never opens storage itself.
test("the real contribution publishes and serves text/data reads without a submission or model turn", {
	timeout: 20000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-contribution-"));
	const previous = {
		dir: process.env.PI_MARKDOWN_DIR,
		app: process.env.PI_MARKDOWN_APP,
		file: process.env.PI_HARNESS_FILE,
	};
	process.env.PI_MARKDOWN_DIR = join(root, "documents");
	process.env.PI_MARKDOWN_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const disposers: (() => void | Promise<void>)[] = [];
	try {
		const host: MarkdownHost = {
			durable: Durable,
			agentDir: root,
			cwd: root,
			storageId: "synthetic",
			harness,
			onClose: (callback) => disposers.push(callback),
		};
		const contribution = markdownContribution(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			createEventBus(),
			() => {},
		);
		const extension = contribution.create(host);
		assert.equal(extension.tools?.[0].replay, "safe");
		registry.install(extension);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const call: MarkdownCommandCall = { args: "", conversation, context, host, invocationId: "read" };
		const command = contribution.commands[0];
		const contents = await readdir(root);
		const absent = await command.run({ ...call, data: { op: "published" } });
		assert.ok(typeof absent !== "string");
		assert.deepEqual(readPanelAnswer({ op: "published" }, absent.data), {
			op: "published",
			rows: [],
			root: process.env.PI_MARKDOWN_DIR,
			limited: false,
			unreadable: 0,
		});
		await command.run(call);
		assert.deepEqual(await readdir(root), contents, "reads of an absent store create no directories or locks");
		const source = `${"x".repeat(PAGE_BYTES - 1)}😀e\u0301\nsecond page`;
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("markdown_publish", { title: "Native document", text: "# Exact publication\n\nUnicode 🦘" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(source),
		]);
		assert.equal(
			(await (await conversation.submit({ type: "input", content: "Publish a document." }, context)).wait(context))
				.status,
			"done",
		);
		const before = await conversation.entries({}, 100, undefined, context);
		const result = before.items.find((entry) => Durable.ToolResultEntry.is(entry))?.model?.[0];
		assert.equal(result?.role, "toolResult");
		if (result?.role !== "toolResult") throw new Error("Missing tool result");
		assert.equal(result.isError, false);
		const receipt = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.match(
			receipt,
			/^Saved new document md-[a-f0-9]{20} revision 1 \(\d+ bytes, sha256:[a-f0-9]{64}\)\. No window opened\.\n/u,
		);
		assert.equal((await new MarkdownStore(process.env.PI_MARKDOWN_DIR).list()).documents.length, 1);
		const count = faux.state.callCount;
		const text = await command.run(call);
		assert.equal(typeof text, "string");
		assert.match(String(text), /Previews only/u);
		for (const origin of [undefined, "operator", "model"] as const) {
			const result = await command.run({ ...call, origin, data: { op: "recent" } });
			assert.notEqual(typeof result, "string");
			if (typeof result === "string") throw new Error("Missing data");
			const recent = readPanelAnswer({ op: "recent" }, result.data);
			assert.equal(recent.op, "recent");
			if (recent.op !== "recent") throw new Error("Missing recent list");
			const acquired = await acquireResponse(
				recent.rows[0].entryId,
				async (request) => {
					const response = await command.run({ ...call, origin, data: request });
					if (typeof response === "string") throw new Error("Missing page");
					return readPanelAnswer(request, response.data);
				},
				new AbortController().signal,
			);
			assert.equal(acquired.parts.join("\n\n"), source);
			const published = await command.run({ ...call, origin, data: { op: "published" } });
			assert.notEqual(typeof published, "string");
			if (typeof published === "string") throw new Error("Missing documents");
			const listing = readPanelAnswer({ op: "published" }, published.data);
			assert.ok(listing.op === "published");
			assert.equal(listing.rows.length, 1);
			assert.match(listing.storeId ?? "", /^[a-f0-9]{32}$/u);
		}
		await Promise.all(
			(
				[
					["unknown operation", { op: "reveal" }],
					["unknown version", { op: "recent", version: 2 }],
					["malformed identity", { op: "response", entryId: 42, offset: 0 }],
					["malformed offset", { op: "response", entryId: "42", offset: -1 }],
					["unknown field", { op: "published", cursor: "1" }],
				] as const
			).map(([label, data]) => assert.rejects(command.run({ ...call, data }), /Invalid Markdown request/u, label)),
		);
		const after = await conversation.entries({}, 100, undefined, context);
		assert.deepEqual(
			after.items.map((entry) => entry.id),
			before.items.map((entry) => entry.id),
			"reads append no input, command or response entries",
		);
		assert.equal(faux.state.callCount, count, "reads cause no provider request");
	} finally {
		for (const dispose of disposers) await dispose();
		await harness.close(context);
		for (const [key, value] of Object.entries({
			PI_MARKDOWN_DIR: previous.dir,
			PI_MARKDOWN_APP: previous.app,
			PI_HARNESS_FILE: previous.file,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
