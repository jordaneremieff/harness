import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkerRuntime } from "./runtime.ts";

test("worker controls use session history and clamping without changing global defaults", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-controls-"));
	const settingsPath = join(root, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "original", defaultModel: "original", defaultThinkingLevel: "low" }));
	const before = readFileSync(settingsPath);
	const models = [false, true].map((reasoning) => ({
		id: reasoning ? "reasoner" : "plain", name: reasoning ? "Reasoner" : "Plain",
		api: "controls-api", provider: "controls-provider", baseUrl: "http://localhost:0",
		reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, maxTokens: 4096,
	})) as Model<Api>[];
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false });
	modelRuntime.registerNativeProvider(fauxProvider({ api: "controls-api", provider: "controls-provider", models }).provider);
	await modelRuntime.refresh({ providers: ["controls-provider"], allowNetwork: false });
	const settingsManager = SettingsManager.create(root, root);
	const selected: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => { pi.on("model_select", (event) => { selected.push(event.model.id); }); }],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, settingsManager,
		resourceLoader: loader, sessionManager: SessionManager.inMemory(root), model: models[0], thinkingLevel: "off", tools: [] });
	const runtime = new WorkerRuntime({ session, id: "controls", name: "controls", cwd: root, createdAt: 1 });
	try {
		await session.bindExtensions({});
		await runtime.setModel({ provider: "controls-provider", id: "reasoner" });
		await runtime.setThinking("high");
		assert.equal(session.thinkingLevel, "high");
		await runtime.setModel({ provider: "controls-provider", id: "plain" });
		assert.equal(session.thinkingLevel, "off");
		assert.deepEqual(selected, ["reasoner", "plain"]);
		const entries = session.sessionManager.getEntries();
		assert.ok(entries.some((entry) => entry.type === "model_change" && entry.modelId === "reasoner"));
		assert.ok(entries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"));
		await settingsManager.flush();
		assert.deepEqual(readFileSync(settingsPath), before);
	} finally {
		runtime.shutdown();
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
