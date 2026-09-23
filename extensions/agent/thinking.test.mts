import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveModelChoice } from "./index.ts";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";

const CANONICAL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function directories() {
	const root = mkdtempSync(join(tmpdir(), "agent-thinking-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	return { root, cwd, agentDir };
}

/** A provider whose model definitions can be replaced between worker lifetimes. */
function registerModel(runtime: ModelRuntime, thinkingLevelMap: Record<string, string | null>) {
	const template = runtime.getModel("agent-test", "model");
	assert.ok(template, "the local model snapshot offers model");
	const model = { ...template, provider: "clamp-contract", id: "clamp-model", thinkingLevelMap };
	runtime.registerNativeProvider({
		id: model.provider,
		name: "Clamp contract",
		getModels: () => [model],
		auth: { apiKey: { name: "Keyless test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => {
			throw new Error("The clamp contract provider is not streamed in these tests");
		},
		streamSimple: () => {
			throw new Error("The clamp contract provider is not streamed in these tests");
		},
	});
	return model;
}

function entriesOf(worker: AgentWorkerSession): SessionEntry[] {
	return worker.sessionManager().getEntries();
}

describe("thinking-level vocabulary", () => {
	it("accepts every canonical level when creating a session", () => {
		for (const level of CANONICAL_LEVELS) {
			const choice = resolveModelChoice(undefined, level, { provider: "zai", id: "glm-5.3-flash" });
			assert.deepEqual(choice, { provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: level });
		}
	});
	it("rejects an unknown level and keeps the bare-model inheritance", () => {
		assert.throws(
			() => resolveModelChoice(undefined, "extreme", { provider: "zai", id: "glm-5.3-flash" }),
			/unknown thinking level extreme/,
		);
		assert.deepEqual(resolveModelChoice("glm-5.3-flash", undefined, { provider: "zai", id: "other" }), {
			provider: "zai",
			modelId: "glm-5.3-flash",
		});
		assert.equal(resolveModelChoice(undefined, undefined, null), undefined);
	});
});

describe("thinking-level clamping", () => {
	it("clamps an explicit level to the model's supported levels and reports it", async () => {
		const dirs = directories();
		const store = new AgentStore({ sessionsRoot: join(dirs.root, "sessions") });
		const runtime = await createTestRuntime({ refreshOnCreate: false });
		const model = registerModel(runtime, { minimal: null, medium: null });
		const worker = await AgentWorkerSession.create({
			...dirs,
			extensionPaths: [],
			store,
			modelRuntime: runtime,
			model: { provider: model.provider, modelId: model.id, thinkingLevel: "medium" },
			rootContext: BACKGROUND_CONTEXT,
		});
		try {
			const status = await worker.status();
			assert.equal(status.model.thinkingLevel, "high", "medium clamps upward to the next supported level");
		} finally {
			await worker.close();
			await store.close(BACKGROUND_CONTEXT);
			rmSync(dirs.root, { recursive: true, force: true });
		}
	});

	it("clamps a durable level when the reopened model no longer supports it", async () => {
		const dirs = directories();
		const store = new AgentStore({ sessionsRoot: join(dirs.root, "sessions") });
		const runtime = await createTestRuntime({ refreshOnCreate: false });
		const model = registerModel(runtime, { xhigh: "xhigh", max: "max" });
		const worker = await AgentWorkerSession.create({
			...dirs,
			extensionPaths: [],
			store,
			modelRuntime: runtime,
			model: { provider: model.provider, modelId: model.id, thinkingLevel: "xhigh" },
			rootContext: BACKGROUND_CONTEXT,
		});
		assert.equal((await worker.status()).model.thinkingLevel, "xhigh");
		const metadata = (await store.list(BACKGROUND_CONTEXT))[0];
		assert.ok(metadata);
		await worker.close();

		// The provider registration changes between lifetimes, like a model whose
		// definition drops the level the durable session stored.
		registerModel(runtime, { minimal: null, medium: null });
		const reopened = await AgentWorkerSession.open(metadata, {
			...dirs,
			extensionPaths: [],
			store,
			modelRuntime: runtime,
			rootContext: BACKGROUND_CONTEXT,
		});
		try {
			assert.equal((await reopened.status()).model.thinkingLevel, "high");
		} finally {
			await reopened.close();
			await store.close(BACKGROUND_CONTEXT);
			rmSync(dirs.root, { recursive: true, force: true });
		}
	});

	it("clamps a level change, records only real changes, and reports the effective level", async () => {
		const dirs = directories();
		const store = new AgentStore({ sessionsRoot: join(dirs.root, "sessions") });
		const runtime = await createTestRuntime({ refreshOnCreate: false });
		const worker = await AgentWorkerSession.create({
			...dirs,
			extensionPaths: [],
			store,
			modelRuntime: runtime,
			model: { provider: "agent-test", modelId: "model", thinkingLevel: "off" },
			rootContext: BACKGROUND_CONTEXT,
		});
		try {
			assert.equal(await worker.setThinkingLevelAction("minimal"), "low", "minimal clamps to the model's supported level");
			assert.equal((await worker.status()).model.thinkingLevel, "low");
			const afterChange = entriesOf(worker).filter((entry) => entry.type === "custom" && entry.customType === "agent.thinking_level_change").length;
			assert.equal(await worker.setThinkingLevelAction("low"), "low", "an unchanged level is a no-op");
			const unchanged = entriesOf(worker).filter((entry) => entry.type === "custom" && entry.customType === "agent.thinking_level_change").length;
			assert.equal(unchanged, afterChange, "no change entry is appended for an unchanged level");
		} finally {
			await worker.close();
			await store.close(BACKGROUND_CONTEXT);
			rmSync(dirs.root, { recursive: true, force: true });
		}
	});

	it("reports whether an abort had an active operation", async () => {
		const dirs = directories();
		const store = new AgentStore({ sessionsRoot: join(dirs.root, "sessions") });
		const runtime = await createTestRuntime({ refreshOnCreate: false });
		const worker = await AgentWorkerSession.create({
			...dirs,
			extensionPaths: [],
			store,
			modelRuntime: runtime,
			model: { provider: "agent-test", modelId: "model", thinkingLevel: "off" },
			rootContext: BACKGROUND_CONTEXT,
		});
		try {
			assert.equal(await worker.abort(), false, "an idle session has nothing to abort");
			const bash = worker.start("!sleep 30");
			let aborted = false;
			const deadline = Date.now() + 4000;
			while (!aborted && Date.now() < deadline) {
				aborted = await worker.abort();
				if (!aborted) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(aborted, true, "a running user bash command is abortable");
			await bash;
		} finally {
			await worker.close();
			await store.close(BACKGROUND_CONTEXT);
			rmSync(dirs.root, { recursive: true, force: true });
		}
	});
});
