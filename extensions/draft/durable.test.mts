import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionServices,
	createEventBus,
	formatSkillsForPrompt,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { checkReply, unavailableText } from "./check.ts";
import {
	createDraftDurableExtension,
	type DraftDurableContribution,
	type DraftDurableHost,
	draftDurableContribution,
} from "./durable.ts";
import draft from "./index.ts";
import { filler } from "./scripts/test-kit.mts";
import { promptGuidelines } from "./tool.ts";

const context = BACKGROUND_CONTEXT;
async function start(t: { after(fn: () => Promise<void>): void }, checker = checkReply) {
	const dir = await mkdtemp(join(tmpdir(), "draft-durable-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const bus = createEventBus();
	let contribution: DraftDurableContribution | undefined;
	bus.on("durable:contribution", (value) => {
		contribution = value as DraftDurableContribution;
	});
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			eventBus: bus,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [draft],
		},
	});
	assert.ok(contribution);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let opened: Durable.Harness | undefined;
	const closers: (() => void | Promise<void>)[] = [];
	const host: DraftDurableHost = {
		durable: Durable,
		agentDir: dir,
		services,
		get harness() {
			if (!opened) throw new Error("harness not open");
			return opened;
		},
		onClose: (close) => {
			closers.push(close);
		},
	};
	const registry = createRegistry();
	registry.install(contribution.create(host));
	if (checker !== checkReply) registry.install(createDraftDurableExtension(host, checker));
	registry.install(
		Durable.defineExtension({
			name: "resources",
			sections: [{ key: "skills", render: () => formatSkillsForPrompt(services.resourceLoader.getSkills().skills) }],
		}),
	);
	opened = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await opened.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: dir } });
	const open = opened;
	t.after(async () => {
		await open.close(context);
		for (const close of closers) await close();
	});
	const run = async (...replies: FauxResponseStep[]) => {
		faux.setResponses(replies);
		const settled = await (await root.submit({ type: "input", content: "question" }, context)).wait(context);
		assert.equal(settled.status, "done", settled.status === "unanswered" ? settled.reason : "");
	};
	const transcript = async () =>
		(await root.context(context)).messages
			.map((message: Message) =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
			)
			.join("\n---\n");
	return { run, transcript, faux, services, registry, dir };
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("contribution names the draft extension and its entrypoint", () => {
	const source = fileURLToPath(new URL("./index.ts", import.meta.url));
	const contribution = draftDurableContribution(source, createEventBus(), () => {});
	assert.equal(contribution.name, "draft");
	assert.equal(contribution.source, source);
});
test("real findings continue once and the next run resets the guard", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run(fauxAssistantMessage("A dash — here"), fauxAssistantMessage("Another dash — here"));
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 1);
	await h.run(fauxAssistantMessage("A dash — again"), fauxAssistantMessage("The parser rejects an empty file."));
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 2);
});
test("a clean answer adds no findings", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run(fauxAssistantMessage("The parser rejects an empty file."));
	assert.equal(count(await h.transcript(), "prose meter"), 0);
});
test("native replies skip repair for spelling and reliable green findings", { timeout: 30000 }, async (t) => {
	const h = await start(t);
	await h.run(fauxAssistantMessage("The color and behavior changed."));
	await h.run(fauxAssistantMessage("The pivotal design uses color."));
	await h.run(fauxAssistantMessage(`${filler(200)} A pivotal design is robust.`));
	assert.equal(h.faux.state.callCount, 3);
	assert.equal(count(await h.transcript(), "The prose meter found problems"), 0);
});
test("an unavailable meter adds one notice until analysis succeeds", { timeout: 30000 }, async (t) => {
	let unavailable = true;
	const h = await start(t, async () =>
		unavailable
			? { kind: "unavailable", reason: "failed", text: unavailableText("failed", "rule data unavailable") }
			: { kind: "clean" },
	);
	await h.run(fauxAssistantMessage("First reply"));
	await h.run(fauxAssistantMessage("Second reply"));
	assert.equal(count(await h.transcript(), "The prose meter check did not run"), 1);
	unavailable = false;
	await h.run(fauxAssistantMessage("The parser rejects an empty file."));
	unavailable = true;
	await h.run(fauxAssistantMessage("Third reply"));
	assert.equal(count(await h.transcript(), "The prose meter check did not run"), 2);
});
test("native composition supplies the skill, tool, saved file access and usage guidance", {
	timeout: 30000,
}, async (t) => {
	const h = await start(t);
	assert.equal(
		h.services.resourceLoader.getSkills().skills.find((skill) => skill.name === "draft")?.filePath,
		fileURLToPath(new URL("./SKILL.md", import.meta.url)),
	);
	assert.equal(
		h.registry
			.snapshot()
			.tools()
			.find((entry) => entry.tool.name === "draft")?.tool.replay,
		"safe",
	);
	await writeFile(join(h.dir, "note.md"), "A line — here.");
	await h.run(
		(request) => {
			const system = getCurrentSystemPrompt(request.messages) ?? "";
			assert.match(system, /<name>draft<\/name>/u);
			assert.match(system, /after facts, evidence and position are settled/u);
			for (const guideline of promptGuidelines) assert.ok(system.includes(guideline));
			return fauxAssistantMessage(fauxToolCall("draft", { path: "note.md", kind: "prose" }), { stopReason: "toolUse" });
		},
		(request) => {
			const result = request.messages.findLast((message) => message.role === "toolResult");
			assert.match(JSON.stringify(result), /punctuation.em-dash/u);
			assert.match(JSON.stringify(result), /Calibration:/u);
			return fauxAssistantMessage("The parser rejects an empty file.");
		},
	);
	assert.equal(h.faux.state.callCount, 2);
});
