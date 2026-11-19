import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { explorerContribution } from "./durable.ts";

test("Durable registers both Explorer tools and does not replay writes or navigation", { timeout: 15000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "explorer-durable-"));
	const saved = {
		PI_EXPLORER_DIR: process.env.PI_EXPLORER_DIR,
		PI_EXPLORER_APP: process.env.PI_EXPLORER_APP,
		PI_HARNESS_FILE: process.env.PI_HARNESS_FILE,
	};
	const store = join(root, "store");
	process.env.PI_EXPLORER_DIR = store;
	process.env.PI_EXPLORER_APP = join(root, "missing.app");
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const close: (() => void | Promise<void>)[] = [];
	try {
		await writeFile(join(root, "hello.txt"), "one\ntwo\n");
		const extension = explorerContribution(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			createEventBus(),
			() => {},
		).create({
			durable: Durable,
			agentDir: root,
			cwd: root,
			harness,
			onClose: (fn) => {
				close.push(fn);
			},
		});
		assert.deepEqual(
			extension.tools?.map((tool) => [tool.name, tool.replay]),
			[
				["explorer_show", "unsafe"],
				["explorer_notes", "unsafe"],
			],
		);
		registry.install(extension);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("explorer_show", { path: "hello.txt", line: 2, note: { text: "See this line." } }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("explorer_notes", { op: "list" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The note is retained."),
		]);
		assert.equal(
			(
				await (
					await conversation.submit({ type: "input", content: "Leave a note and check that it exists." }, context)
				).wait(context)
			).status,
			"done",
		);
		const entries = (await conversation.entries({}, 100, undefined, context)).items
			.filter((entry) => Durable.ToolResultEntry.is(entry))
			.sort((a, b) => Number(a.id) - Number(b.id));
		const [show, notes] = entries.map((entry) => {
			const block = entry.model?.[0];
			assert.equal(block?.role, "toolResult");
			assert.equal(block.isError, false);
			const part = block.content[0];
			assert.equal(part.type, "text");
			return JSON.parse(part.text);
		});
		assert.match(show.noteId, /^n-[a-f0-9]{20}$/u);
		assert.match(show.showUnavailable, /Explorer app/u);
		assert.equal(notes.notes.length, 1);
		assert.equal(notes.notes[0].id, show.noteId);
		assert.equal(notes.notes[0].start, 2);
	} finally {
		for (const dispose of close) await dispose();
		await harness.close(context);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
