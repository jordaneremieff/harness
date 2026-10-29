import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createRegistryDurableContribution, type RegistryDurableHost } from "./durable.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "registry-notes-durable-"));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent");
	await mkdir(cwd); await mkdir(agentDir);
	const path = join(agentDir, "harness.json");
	await writeFile(path, '{"version":1,"registry":{"notes":true}}');
	const sourceDir = join(root, "extensions/example");
	await mkdir(sourceDir, { recursive: true });
	const source = join(sourceDir, "index.ts");
	await writeFile(source, "export const example = true;\n");
	const piSettings = join(agentDir, "settings.json");
	await writeFile(piSettings, '{"extensions":["/configured-only/entry.ts"]}');
	const loaded = { path: source, resolvedPath: source, sourceInfo: { path: source, source: "local", scope: "temporary" as const, origin: "top-level" as const } };
	const faux = fauxProvider({ models: [{ id: "notes", name: "Notes", contextWindow: 100000, maxTokens: 1000 }] });
	const models = createModels(); models.setProvider(faux.provider);
	const dispose: Array<() => void | Promise<void>> = [];
	const host: RegistryDurableHost = { durable: Durable, cwd, agentDir, storageId: "notes-test", signal: new AbortController().signal,
		onClose: (close) => { dispose.push(close); }, inventory: { contributions: [], ordinaryOnly: [] }, services: {
			settingsManager: { isProjectTrusted: () => true }, modelRuntime: {} as RegistryDurableHost["services"]["modelRuntime"],
			resourceLoader: { getSkills: () => ({ skills: [] }), getPrompts: () => ({ prompts: [] }), getExtensions: () => ({ extensions: [loaded] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined, getAppendSystemPrompt: () => [] },
		} };
	const extension = await createRegistryDurableContribution("/fixture/registry/index.ts", createEventBus()).create(host);
	const registry = Durable.createRegistry(); registry.install(extension);
	registry.install(Durable.defineExtension({ name: "files", tools: [createReadTool(),
		Durable.defineTool({ name: "middle", description: "Read through a nested call", parameters: Type.Object({ path: Type.String() }), replay: "safe",
			execute: async (args, api, context) => {
				const result = await api.executeTool("read", args, context);
				assert.equal(JSON.stringify(result.structuredOutput).includes("[registry]"), false);
				return { output: [{ type: "text", text: "middle result" }] };
			} }),
		Durable.defineTool({ name: "outer", description: "Read through two nested calls", parameters: Type.Object({ path: Type.String() }), replay: "safe",
			execute: async (args, api, context) => {
				const result = await api.executeTool("middle", args, context);
				assert.equal(JSON.stringify(result.structuredOutput).includes("[registry]"), false);
				return { output: [{ type: "text", text: "outer result" }], details: { marker: "preserved" } };
			} }),
	] }));
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, BACKGROUND_CONTEXT);
	const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "notes" } } });
	async function run(id: string, name = "read", target = conversation, file = path) {
		faux.setResponses([fauxAssistantMessage([fauxToolCall(name, { path: file }, { id })], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
		const result = await (await target.submit({ type: "input", content: "Inspect the file." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		assert.equal(result.status, "done");
		const { messages } = await target.context(BACKGROUND_CONTEXT);
		const message = messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
		assert.ok(message && message.role === "toolResult");
		return message;
	}
	return { path, source, piSettings, harness, conversation, run, close: async () => {
		await harness.close(BACKGROUND_CONTEXT);
		for (const close of dispose) await close();
		await rm(root, { recursive: true, force: true });
	} };
}
function text(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["run"]>>): string {
	return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}
test("Durable built-in read appends a note once per conversation over real Harness tasks", async () => {
	const sample = await fixture();
	try {
		const first = await sample.run("first");
		assert.match(text(first), /\[registry\] Configured values/);
		assert.match(text(first), /"name":"<slice>\.<key>"/);
		assert.match(text(first), /"registry":\{"notes":true\}/);
		assert.equal(first.content.length, 2);
		assert.equal(first.isError, false);
		assert.doesNotMatch(text(await sample.run("second")), /\[registry\]/);
		const other = await sample.harness.createConversation({ ownership: { kind: "ownerless" },
			agent: { model: { provider: "faux", modelId: "notes" } } }, BACKGROUND_CONTEXT);
		assert.match(text(await sample.run("other", "read", other)), /\[registry\]/);
	} finally { await sample.close(); }
});
test("Durable source and Pi settings reads use loaded host provenance without ordinary tool calls", async () => {
	const sample = await fixture();
	try {
		const source = text(await sample.run("source", "read", sample.conversation, sample.source));
		assert.match(source, /example is loaded in this session from/);
		assert.match(source, /It publishes no harness settings\./);
		assert.doesNotMatch(source, /"kind":"tool"/);
		const settings = text(await sample.run("pi-settings", "read", sample.conversation, sample.piSettings));
		assert.match(settings, /This session loaded 1 extensions; Pi settings list configured sources, not load results/);
		assert.match(settings, /No harness setting is set by environment\./);
	} finally { await sample.close(); }
});
test("Durable notes obey fresh file and environment off switches", async () => {
	const sample = await fixture();
	const previous = process.env.PI_REGISTRY_NOTES;
	try {
		await writeFile(sample.path, '{"version":1,"registry":{"notes":false}}');
		assert.doesNotMatch(text(await sample.run("off")), /\[registry\]/);
		await writeFile(sample.path, '{"version":1,"registry":{"notes":true}}');
		process.env.PI_REGISTRY_NOTES = "false";
		assert.doesNotMatch(text(await sample.run("env-off")), /\[registry\]/);
		delete process.env.PI_REGISTRY_NOTES;
		assert.match(text(await sample.run("on")), /\[registry\]/);
	} finally {
		if (previous === undefined) delete process.env.PI_REGISTRY_NOTES; else process.env.PI_REGISTRY_NOTES = previous;
		await sample.close();
	}
});
test("Durable nested notes reach only the outermost model-issued result", async () => {
	const sample = await fixture();
	try {
		const result = await sample.run("outer-call", "outer");
		assert.equal(result.content.length, 2);
		assert.match(text(result), /^outer result\n\[registry\]/);
		assert.equal((result.details as { marker: string }).marker, "preserved");
		assert.equal(result.isError, false);
	} finally { await sample.close(); }
});
