import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PillarsStore } from "./store.ts";
import { utcDay } from "./collector.ts";

const hostRoot = process.env.PI_PILLARS_TEST_HOST_ROOT;
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(
	hostRoot ? pathToFileURL(join(hostRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent"
);
const ai: typeof import("@earendil-works/pi-ai") = await import(
	hostRoot
		? pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href
		: "@earendil-works/pi-ai"
);

test("Pi discovery, source delivery, callbacks, commands and awaited shutdown use the actual extension", {
	timeout: 30000,
}, async () => {
	const root = await mkdtemp(join(process.cwd(), ".pillars-sdk-test-"));
	const previous = process.env.PI_PILLARS_DIR;
	const previousCollect = process.env.PI_PILLARS_COLLECT;
	process.env.PI_PILLARS_DIR = join(root, "store");
	process.env.PI_PILLARS_COLLECT = "1";
	const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
	const skill = join(root, "package/skills/pillars/SKILL.md");
	const entryBody = "# Synthetic principle\nUse checked evidence.\n";
	let session: InstanceType<typeof sdk.AgentSession> | undefined;
	try {
		await mkdir(join(root, "package/skills/pillars"), { recursive: true });
		await mkdir(join(root, "package/pillars"));
		await writeFile(
			skill,
			"---\nname: pillars\ndescription: Consult the synthetic Pillars corpus for decisions.\ncompatibility: Requires ../../pillars\n---\nRead ../../pillars/README.md.\n",
		);
		await writeFile(join(root, "package/pillars/README.md"), "# Inventory\n[Example](principle-example.md)\n");
		await writeFile(join(root, "package/pillars/GOVERNANCE.md"), "# Rules\nRead the matching full body.\n");
		await writeFile(join(root, "package/pillars/principle-example.md"), entryBody);
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const faux = ai.fauxProvider({
			provider: "pillars-test",
			models: [{ id: "reader", reasoning: true, contextWindow: 100000 }],
			tokensPerSecond: 0,
		});
		const modelRuntime = await sdk.ModelRuntime.create({
			credentials: new ai.InMemoryCredentialStore(),
			modelsStore: new ai.InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const loader = new sdk.DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [entry],
			additionalSkillPaths: [skill],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getSkills().skills[0]?.filePath, skill);
		const result = await sdk.createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "high",
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(root),
			settingsManager,
			tools: ["read", "pillars", "pillars_usage"],
		});
		session = result.session;
		const errors: string[] = [];
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
		assert.equal(resolve(session.getAllTools().find((tool) => tool.name === "pillars")!.sourceInfo.path), entry);
		assert.ok(loader.getSkills().skills.some((skill) => skill.name === "pillars"));
		assert.ok(session.extensionRunner.getRegisteredCommands().some((command) => command.name === "pillars"));
		faux.setResponses([
			(context) => {
				assert.ok(context.tools?.some((tool) => tool.name === "pillars"));
				assert.ok(context.systemPrompt?.includes("pillars"));
				return ai.fauxAssistantMessage(
					ai.fauxToolCall("pillars", { resource: "principle-example" }, { id: "source-call" }),
				);
			},
			ai.fauxAssistantMessage(
				ai.fauxToolCall("read", { path: join(root, "package/pillars/GOVERNANCE.md") }, { id: "read-call" }),
			),
			ai.fauxAssistantMessage("Synthetic run finished."),
		]);
		await session.prompt("Consult the synthetic principle and its governance.");
		const messages = session.messages.filter((message) => message.role === "toolResult");
		assert.equal(messages.length, 2);
		const sourceText = messages[0].content.find((block) => block.type === "text");
		assert.ok(sourceText && sourceText.type === "text");
		assert.equal(JSON.parse(sourceText.text).text, entryBody);
		const during = await new PillarsStore(join(root, "store")).capture(utcDay());
		assert.ok(
			Object.values(during.shards)
				.flatMap((shard) => shard.cells)
				.some((cell) => cell.observationStage === "tool_request"),
		);
		const messagesBeforeCommand = session.messages.length;
		await session.prompt("/pillars read principle-example");
		assert.equal(
			session.messages.length,
			messagesBeforeCommand,
			"operator-only source output never enters model context",
		);
		const view = session.sessionManager.getLeafEntry();
		assert.ok(view?.type === "custom" && view.customType === "pillars-view");
		assert.ok((view.data as { text: string }).text.includes(entryBody));
		faux.setResponses([
			ai.fauxAssistantMessage(
				ai.fauxToolCall(
					"pillars",
					{ resource: "principle-example", offset: 1, referenceBodyDigest: "0".repeat(64) },
					{ id: "stale-call" },
				),
			),
			ai.fauxAssistantMessage("Synthetic error checked."),
		]);
		await session.prompt("Read a deliberately stale source continuation.");
		const stale = session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "stale-call",
		);
		assert.ok(stale?.role === "toolResult" && stale.isError);
		assert.ok(stale.content.some((block) => block.type === "text" && block.text.includes("source_changed")));
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const captured = await new PillarsStore(join(root, "store")).capture(utcDay());
		const cells = Object.values(captured.shards).flatMap((shard) => shard.cells);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.readRequests, 0),
			3,
		);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.readResults, 0),
			3,
		);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.bodyVerifiedAtObservation, 0),
			2,
		);
		assert.equal(
			cells.reduce((n, cell) => n + cell.counters.resultError, 0),
			1,
		);
		assert.ok(cells.every((cell) => cell.piVersion === sdk.VERSION));
		assert.deepEqual(errors, []);
	} finally {
		session?.dispose();
		if (previous === undefined) delete process.env.PI_PILLARS_DIR;
		else process.env.PI_PILLARS_DIR = previous;
		if (previousCollect === undefined) delete process.env.PI_PILLARS_COLLECT;
		else process.env.PI_PILLARS_COLLECT = previousCollect;
		await rm(root, { recursive: true, force: true });
	}
});
