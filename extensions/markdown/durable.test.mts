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

// Native calls use the open host Harness; the contribution never opens storage itself.
test("the real contribution publishes and serves text/data reads without a submission or model turn", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-contribution-"));
	const previous = { dir: process.env.PI_MARKDOWN_DIR, app: process.env.PI_MARKDOWN_APP, file: process.env.PI_HARNESS_FILE };
	process.env.PI_MARKDOWN_DIR = join(root, "documents");
	process.env.PI_MARKDOWN_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	const faux = fauxProvider();
	const models = createModels(); models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const disposers: (() => void | Promise<void>)[] = [];
	try {
		const host: MarkdownHost = { durable: Durable, agentDir: root, cwd: root, storageId: "synthetic", harness, onClose: (callback) => disposers.push(callback) };
		const contribution = markdownContribution(fileURLToPath(new URL("./index.ts", import.meta.url)), createEventBus(), () => {});
		const extension = contribution.create(host);
		assert.equal(extension.tools?.[0].replay, "safe");
		registry.install(extension);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const call: MarkdownCommandCall = { args: "", conversation, context, host, invocationId: "read" };
		const command = contribution.commands[0];
		const contents = await readdir(root);
		const absent = await command.run({ ...call, data: { op: "published" } });
		assert.ok(typeof absent !== "string");
		assert.deepEqual(readPanelAnswer({ op: "published" }, absent.data), { op: "published", rows: [], root: process.env.PI_MARKDOWN_DIR, limited: false });
		await command.run(call);
		assert.deepEqual(await readdir(root), contents, "reads of an absent store create no directories or locks");
		const source = `${"x".repeat(PAGE_BYTES - 1)}😀e\u0301\nsecond page`;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("markdown_publish", { title: "Native document", text: "# Exact publication\n\nUnicode 🦘" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(source),
		]);
		assert.equal((await (await conversation.submit({ type: "input", content: "Publish a document." }, context)).wait(context)).status, "done");
		const before = await conversation.entries({}, 100, undefined, context);
		const result = before.items.find((entry) => Durable.ToolResultEntry.is(entry))?.model?.[0];
		assert.equal(result?.role, "toolResult");
		if (result?.role !== "toolResult") throw new Error("Missing tool result");
		assert.equal(result.isError, false);
		const receipt = result.content.map((part) => part.type === "text" ? part.text : "").join("");
		assert.match(receipt, /No window opened\. The operator opens it from the Markdown view under Published \(in the agent view, under Owner views\)\. In an ordinary Pi session, \/markdown md-[a-f0-9]{20} also opens it\./u);
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
			const acquired = await acquireResponse(recent.rows[0].entryId, async (request) => {
				const response = await command.run({ ...call, origin, data: request });
				if (typeof response === "string") throw new Error("Missing page");
				return readPanelAnswer(request, response.data);
			}, new AbortController().signal);
			assert.equal(acquired.parts.join("\n\n"), source);
			const published = await command.run({ ...call, origin, data: { op: "published" } });
			assert.notEqual(typeof published, "string");
			if (typeof published === "string") throw new Error("Missing documents");
			const listing = readPanelAnswer({ op: "published" }, published.data);
			assert.ok(listing.op === "published");
			assert.equal(listing.rows.length, 1);
			assert.match(listing.storeId ?? "", /^[a-f0-9]{32}$/u);
		}
		await Promise.all(([
			["unknown operation", { op: "reveal" }],
			["unknown version", { op: "recent", version: 2 }],
			["malformed identity", { op: "response", entryId: 42, offset: 0 }],
			["malformed offset", { op: "response", entryId: "42", offset: -1 }],
			["oversized field", { op: "published", cursor: "1".repeat(201) }],
		] as const).map(([label, data]) => assert.rejects(command.run({ ...call, data }), /Invalid Markdown request/u, label)));
		const after = await conversation.entries({}, 100, undefined, context);
		assert.deepEqual(after.items.map((entry) => entry.id), before.items.map((entry) => entry.id), "reads append no input, command or response entries");
		assert.equal(faux.state.callCount, count, "reads cause no provider request");
	} finally {
		for (const dispose of disposers) await dispose();
		await harness.close(context);
		for (const [key, value] of Object.entries({ PI_MARKDOWN_DIR: previous.dir, PI_MARKDOWN_APP: previous.app, PI_HARNESS_FILE: previous.file })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	}
});
