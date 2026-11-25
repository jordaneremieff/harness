import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("a real ordinary session applies tool activation now and Pi settings at reload", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "config-runtime-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", notices: { cacheMisses: true } }));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_HARNESS_FILE: process.env.PI_HARNESS_FILE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_HARNESS_FILE;
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
	});
	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "models-cache.json"),
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});
		await session.bindExtensions({ mode: "print" });
		const call = async (name: string, input: unknown) => {
			const tool = session.getToolDefinition(name);
			assert.ok(tool, `${name} is registered`);
			const result = await tool.execute(
				"call",
				input as never,
				undefined,
				undefined,
				session.extensionRunner.createToolContext("call", undefined),
			);
			const part = result.content[0];
			assert.equal(part?.type, "text");
			return JSON.parse((part as { text: string }).text);
		};

		const inactive = session
			.getAllTools()
			.find((tool) => tool.exposure === "direct" && !session.getActiveToolNames().includes(tool.name));
		assert.ok(inactive, "the session has a configured tool that is not active");
		const tools = await call("config_tools", { activate: [inactive.name] });
		assert.equal(tools.change.applied, true);
		assert.deepEqual(tools.change.activated, [inactive.name]);
		assert.ok(session.getActiveToolNames().includes(inactive.name));
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).defaultTools, undefined);

		const before = await call("config_get", { ids: ["pi:/notices/compactionCosts"] });
		const revision = before.context.documents.find(
			(item: { document: string }) => item.document === "pi-global",
		).revision;
		const edit = await call("config_edit", {
			mode: "commit",
			changes: [{ id: "pi:/notices/compactionCosts", scope: "global", action: "set", value: true }],
			revisions: { "pi-global": revision },
		});
		assert.equal(edit.outcome, "committed", edit.summary);
		assert.equal(edit.documents[0].changes[0].apply.state, "pending-reload");
		assert.equal(session.settingsManager.getNotices().compactionCosts, false);
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).notices, {
			cacheMisses: true,
			compactionCosts: true,
		});

		await session.reload();
		assert.deepEqual(session.settingsManager.getNotices(), {
			cacheMisses: true,
			cacheWarming: false,
			compactionCosts: true,
			reasoningDrops: false,
		});
		const after = await call("config_get", { ids: ["pi:/notices/compactionCosts"] });
		assert.equal(after.entries[0].session.differs, false);
		assert.equal(after.entries[0].applyState.state, "applied");
		session.dispose();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
