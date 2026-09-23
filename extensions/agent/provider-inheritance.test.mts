import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, type ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { inheritProviders } from "./model-runtime.ts";
import { fixture } from "./native-fixture.mts";
import { defined } from "./test-assertions.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import type { AgentWorkerSession } from "./worker.ts";

function heldWorker(manager: AgentManager, id: string): AgentWorkerSession {
	return defined((manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(id));
}

function workerRegistry(worker: AgentWorkerSession): ModelRegistry {
	return new ModelRegistry((worker as unknown as { runtime: { services: { modelRuntime: ModelRuntime } } }).runtime.services.modelRuntime);
}

test("configured providers retain models, streams, headers, and rotating primary runtime authentication", async () => {
	const primary = await createTestRuntime();
	const id = "configured-inheritance";
	const requests: SimpleStreamOptions[] = [];
	primary.registerProvider(id, {
		api: "openai-completions", baseUrl: "https://example.invalid/configured", apiKey: "synthetic-config-key",
		headers: { "x-provider": "provider-header" },
		models: [{ id: "configured-model", name: "Configured model", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256,
			headers: { "x-model": "model-header" } }],
		streamSimple: (model, _context, options) => {
			requests.push(options ?? {});
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "synthetic response" }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const events = createAssistantMessageEventStream();
			events.push({ type: "done", reason: "stop", message }); events.end(message); return events;
		},
	});
	await primary.setRuntimeApiKey(id, "synthetic-runtime-first");
	const managerRuntime = await createTestRuntime();
	inheritProviders(managerRuntime, new ModelRegistry(primary), testModel.provider);
	await managerRuntime.refresh({ allowNetwork: false });
	const workerRuntime = await createTestRuntime();
	inheritProviders(workerRuntime, new ModelRegistry(managerRuntime), id);
	await workerRuntime.refresh({ allowNetwork: false });
	const model = defined(workerRuntime.getModel(id, "configured-model"));
	assert.equal(model.name, "Configured model");
	assert.equal(model.baseUrl, "https://example.invalid/configured");
	assert.equal(model.contextWindow, 8192);
	assert.equal(workerRuntime.getRegisteredProviderConfig(id), undefined);
	assert.ok(workerRuntime.getRegisteredNativeProvider(id));
	assert.equal((await workerRuntime.getAuth(id))?.auth.apiKey, "synthetic-runtime-first");
	assert.equal((await workerRuntime.completeSimple(model, { messages: [] })).stopReason, "stop");
	assert.equal(requests[0].apiKey, "synthetic-runtime-first");
	assert.equal(requests[0].headers?.["x-provider"], "provider-header");
	assert.equal(requests[0].headers?.["x-model"], "model-header");
	await primary.setRuntimeApiKey(id, "synthetic-runtime-second");
	assert.equal((await workerRuntime.getAuth(id))?.auth.apiKey, "synthetic-runtime-second");
	let headerTransforms = 0;
	const signal = new AbortController().signal;
	assert.equal((await workerRuntime.complete(model, { messages: [] }, {
		signal, temperature: 0.25, maxTokens: 64,
		transformHeaders: (headers) => { headerTransforms++; return { ...headers, "x-request": "transformed" }; },
	})).stopReason, "stop");
	assert.equal(headerTransforms, 1);
	assert.equal(requests[1].signal, signal);
	assert.equal(requests[1].temperature, 0.25);
	assert.equal(requests[1].maxTokens, 64);
	assert.equal(requests[1].apiKey, "synthetic-runtime-second");
	assert.equal(requests[1].headers?.["x-provider"], "provider-header");
	assert.equal(requests[1].headers?.["x-model"], "model-header");
	assert.equal(requests[1].headers?.["x-request"], "transformed");
	await primary.removeRuntimeApiKey(id);
	await workerRuntime.completeSimple(model, { messages: [] });
	assert.equal(requests[2].apiKey, "synthetic-config-key");
	assert.equal(requests.length, 3);
});

test("catalog runtime authentication survives different explicit providers, reopen, and model repair", async () => {
	const f = await fixture();
	await f.worker.close();
	const selected = defined(f.runtime.getModels("openai")[0]);
	const repaired = defined(f.runtime.getModels("anthropic")[0]);
	await f.runtime.setRuntimeApiKey(selected.provider, "synthetic-selected-first");
	await f.runtime.setRuntimeApiKey(repaired.provider, "synthetic-repair-key");
	assert.equal(f.runtime.getRegisteredProviderIds().includes(selected.provider), false);
	const managerRuntime = await createTestRuntime();
	inheritProviders(managerRuntime, new ModelRegistry(f.runtime), testModel.provider);
	await managerRuntime.refresh({ allowNetwork: false });
	assert.ok(managerRuntime.getRegisteredNativeProvider(selected.provider));
	assert.ok(managerRuntime.getRegisteredNativeProvider(repaired.provider));
	let manager = new AgentManager(f.store, managerRuntime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const created = await manager.spawn({ cwd: f.cwd, model: `${selected.provider}/${selected.id}` }, { cwd: f.cwd, model: testModel });
		const first = heldWorker(manager, created.sessionId);
		assert.equal((await first.status()).model.provider, selected.provider);
		assert.equal((await workerRegistry(first).getProviderAuth(selected.provider))?.auth.apiKey, "synthetic-selected-first");
		const metadata = first.sessionMetadata();
		await manager.closeAll();
		await f.runtime.setRuntimeApiKey(selected.provider, "synthetic-selected-second");
		manager = new AgentManager(f.store, managerRuntime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
		await manager.attach(created.sessionId);
		const reopened = heldWorker(manager, created.sessionId);
		assert.equal((await reopened.status()).model.provider, selected.provider);
		assert.equal((await workerRegistry(reopened).getProviderAuth(selected.provider))?.auth.apiKey, "synthetic-selected-second");
		await manager.attach(created.sessionId, undefined, undefined, `${repaired.provider}/${repaired.id}`);
		assert.equal((await reopened.status()).model.provider, repaired.provider);
		assert.equal((await workerRegistry(reopened).getProviderAuth(repaired.provider))?.auth.apiKey, "synthetic-repair-key");
		await manager.closeAll();
		manager = new AgentManager(f.store, managerRuntime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
		await manager.attach(created.sessionId);
		assert.equal((await heldWorker(manager, created.sessionId).status()).model.provider, repaired.provider);
		assert.doesNotMatch(readFileSync(metadata.path, "utf8"), /synthetic-selected-first|synthetic-selected-second|synthetic-repair-key/u);
		assert.equal(f.requests.length, 0);
	} finally { await manager.closeAll(); await f.close(); }
});
