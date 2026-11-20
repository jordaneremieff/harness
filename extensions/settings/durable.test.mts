import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { settingsContribution } from "./durable.ts";

test("Durable settings tools use the shared backend and never replay an edit", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "settings-durable-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const saved = { PI_HARNESS_FILE: process.env.PI_HARNESS_FILE, PI_SETTINGS_CUSTOM: process.env.PI_SETTINGS_CUSTOM };
	process.env.PI_HARNESS_FILE = join(agentDir, "harness.json");
	delete process.env.PI_SETTINGS_CUSTOM;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const close: (() => void | Promise<void>)[] = [];
	try {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const extension = settingsContribution(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			createEventBus(),
			() => {},
		).create({
			durable: Durable,
			agentDir,
			cwd,
			services: { settingsManager },
			onClose: (fn) => {
				close.push(fn);
			},
		});
		assert.deepEqual(
			extension.tools?.map((tool) => [tool.name, tool.replay]),
			[
				["settings_find", "safe"],
				["settings_get", "safe"],
				["settings_edit", "unsafe"],
				["settings_tools", "safe"],
			],
		);
		registry.install(extension);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("settings_find", { query: "hide thinking" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("settings_get", { ids: ["pi:/hideThinkingBlock"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("settings_edit", {
					mode: "commit",
					changes: [
						{ id: "pi:/hideThinkingBlock", scope: "global", action: "set", value: true, base: { present: false } },
						{ id: "custom:/note", action: "create", value: "kept by agents", type: "string" },
					],
					revisions: { harness: null },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("settings_tools", { activate: ["grep"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const run = await (await conversation.submit({ type: "input", content: "Hide thinking blocks." }, context)).wait(
			context,
		);
		assert.equal(run.status, "done");
		const results = (await conversation.entries({}, 100, undefined, context)).items
			.filter((entry) => Durable.ToolResultEntry.is(entry))
			.sort((a, b) => Number(a.id) - Number(b.id))
			.map((entry) => {
				const block = entry.model?.[0];
				assert.equal(block?.role, "toolResult");
				const part = block.content[0];
				assert.equal(part.type, "text");
				return { error: block.isError, value: JSON.parse(part.text) };
			});
		const [find, get, edit, tools] = results;
		assert.equal(find.value.rows[0].id, "pi:/hideThinkingBlock");
		assert.equal(get.value.entries[0].resolved.source, "default");
		assert.equal(get.value.context.host.kind, "durable");
		assert.equal(edit.error, false);
		assert.equal(edit.value.outcome, "committed", edit.value.summary);
		const pi = edit.value.documents.find((item: { document: string }) => item.document === "pi-global");
		assert.equal(pi.changes[0].apply.state, "pending-restart");
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {
			theme: "dark",
			hideThinkingBlock: true,
		});
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "harness.json"), "utf8")), {
			version: 1,
			settings: { custom: { note: { value: "kept by agents", type: "string" } } },
		});
		assert.equal(tools.value.session, false);
		assert.equal(tools.value.change.applied, false);
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
