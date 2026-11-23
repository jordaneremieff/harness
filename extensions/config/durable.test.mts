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
import { toolDisplay } from "./display.ts";
import { configContribution } from "./durable.ts";

test("Durable config tools use the shared backend and never replay an edit", { timeout: 20000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "config-durable-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const saved = { PI_HARNESS_FILE: process.env.PI_HARNESS_FILE, PI_CONFIG_CUSTOM: process.env.PI_CONFIG_CUSTOM };
	process.env.PI_HARNESS_FILE = join(agentDir, "harness.json");
	delete process.env.PI_CONFIG_CUSTOM;
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	const close: (() => void | Promise<void>)[] = [];
	const largeValue = "x".repeat(26_000);
	try {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const contribution = configContribution(
			fileURLToPath(new URL("./index.ts", import.meta.url)),
			createEventBus(),
			() => {},
		);
		assert.deepEqual(contribution.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
		const presentation = await import(new URL(contribution.display.entry, import.meta.url).href);
		assert.deepEqual(presentation[contribution.display.export](), toolDisplay());
		const extension = contribution.create({
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
				["config_find", "safe"],
				["config_get", "safe"],
				["config_edit", "unsafe"],
				["config_tools", "safe"],
			],
		);
		registry.install(extension);
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("config_find", { query: "hide thinking" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("config_get", { ids: ["pi:/hideThinkingBlock"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("config_edit", {
					mode: "commit",
					changes: [
						{ id: "pi:/hideThinkingBlock", scope: "global", action: "set", value: true, base: { present: false } },
						{ id: "custom:/note", action: "create", value: largeValue, type: "string" },
					],
					revisions: { harness: null },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("config_tools", { activate: ["grep"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("config_get", { ids: ["custom:/note", "custom:/note"] }), {
				stopReason: "toolUse",
			}),
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
				return { error: block.isError, value: JSON.parse(part.text), details: block.details, content: block.content };
			});
		const [find, get, edit, tools, oversized] = results;
		assert.equal(find.value.rows[0].id, "pi:/hideThinkingBlock");
		assert.equal(get.value.entries[0].resolved.source, "default");
		assert.equal(get.value.context.host.kind, "durable");
		assert.equal(edit.error, false);
		assert.equal(edit.value.outcome, "committed", edit.value.summary);
		assert.deepEqual(find.details, { summary: "config_find" });
		assert.deepEqual(edit.details, {
			summary: "config_edit",
			edit: {
				mode: "commit",
				outcome: "committed",
				lines: [
					edit.value.summary,
					...edit.value.documents.flatMap((document: (typeof edit.value.documents)[number]) =>
						document.changes.map((change: (typeof document.changes)[number]) => `${change.id}: ${change.apply.text}`),
					),
				],
			},
		});
		const pi = edit.value.documents.find((item: { document: string }) => item.document === "pi-global");
		assert.equal(pi.changes[0].apply.state, "pending-restart");
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {
			theme: "dark",
			hideThinkingBlock: true,
		});
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "harness.json"), "utf8")), {
			version: 1,
			config: { custom: { note: { value: largeValue, type: "string" } } },
		});
		assert.equal(tools.value.session, false);
		assert.equal(tools.value.change.applied, false);
		assert.equal(tools.error, false);
		assert.equal(oversized.error, true);
		assert.deepEqual(oversized.content, [
			{ type: "text", text: '{"error":"The result exceeds 98304 bytes; request fewer ids or a smaller page."}' },
		]);
		assert.deepEqual(oversized.details, {
			summary: "config_get",
			outputLimited: true,
			diagnostic: oversized.value.error,
		});
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
