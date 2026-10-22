import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import draft from "./index.ts";

test("ordinary discovery resolves the contributed skill and expands /skill:draft", { timeout: 30000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "draft-discovery-"));
	let dispose: (() => void) | undefined;
	try {
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerNativeProvider(faux.provider);
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: false },
				compaction: { enabled: false },
				cacheWarming: "off",
			}),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [draft],
			},
		});
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(dir),
			model: faux.getModel(),
			tools: ["draft", "read"],
		});
		dispose = () => session.dispose();
		await session.bindExtensions({});
		const skill = services.resourceLoader.getSkills().skills.find((item) => item.name === "draft");
		assert.equal(skill?.filePath, fileURLToPath(new URL("./SKILL.md", import.meta.url)));
		assert.match(session.systemPrompt, /<name>draft<\/name>/u);
		faux.setResponses([
			(context) => {
				const message = context.messages.findLast((item) => item.role === "user");
				assert.match(JSON.stringify(message), /Slop is text written from no position/u);
				assert.match(getCurrentSystemPrompt(context.messages) ?? "", /after facts, evidence and position are settled/u);
				return fauxAssistantMessage("The parser rejects an empty file.");
			},
		]);
		await session.prompt("/skill:draft Check this reply.");
		assert.equal(faux.state.callCount, 1);
	} finally {
		dispose?.();
		await rm(dir, { recursive: true, force: true });
	}
});
