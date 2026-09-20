import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

test("explicit model repair does not replace the captured model of a suspended operation", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-model-active-"));
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(root, "extension.ts"), "export default function() {}\n");
	execFileSync(process.execPath, [join(import.meta.dirname, "prompt-recovery-child.mts"), root, "start"], { timeout: 12000, maxBuffer: 128000 });
	const runtime = await createTestRuntime();
	runtime.unregisterProvider(testModel.provider);
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const manager = new AgentManager(store, runtime, new ProjectTrustStore(agentDir), undefined, agentDir);
	try {
		const id = (await store.list(BACKGROUND_CONTEXT))[0].id;
		await assert.rejects(manager.attach(id, undefined, undefined, "replacement/model"), /requires an idle session/u);
		assert.match(await manager.status(id), /model=agent-test\/model/u);
	} finally { await manager.closeAll(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable stored model remains visible and changes only through explicit idle repair", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-model-repair-"));
	const cwd = join(root, "work"); const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const runtime = await createTestRuntime();
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const worker = await AgentWorkerSession.create({ cwd, agentDir, store, modelRuntime: runtime, model: { provider: testModel.provider, modelId: testModel.id }, rootContext: BACKGROUND_CONTEXT });
	const id = worker.sessionId();
	await worker.appendCustomEntry("retained", { value: "source context" });
	await worker.close();
	runtime.unregisterProvider(testModel.provider);
	assert.equal(runtime.getModel(testModel.provider, testModel.id), undefined);
	let requests = 0;
	const model = { ...testModel, provider: "explicit-repair" };
	runtime.registerNativeProvider({ id: model.provider, name: "Repair", getModels: () => [model], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: () => { requests += 1; throw new Error("No request expected"); }, streamSimple: () => { requests += 1; throw new Error("No request expected"); } });
	const manager = new AgentManager(store, runtime, new ProjectTrustStore(agentDir), undefined, agentDir);
	try {
		const status = await manager.status(id);
		assert.match(status, /stored model unavailable/u);
		assert.match(status, /model=agent-test\/model/u);
		assert.match(status, /no model was substituted/u);
		await assert.rejects(manager.attach(id), /agent-test\/model is unavailable/u);
		await assert.rejects(manager.attach(id, undefined, undefined, "unknown/model"), /unknown\/model is unavailable/u);
		assert.match(await manager.status(id), /model=agent-test\/model/u);
		assert.match(await manager.attach(id, undefined, undefined, "explicit-repair/model"), /explicit-repair\/model/u);
		assert.match(await manager.status(id), /explicit-repair\/model/u);
		assert.ok((await manager.sessionEntries(id)).some(entry => entry.type === "custom" && entry.customType === "retained"));
		assert.equal(requests, 0);
		await manager.closeAll();
		const reopened = await AgentWorkerSession.open((await store.list(BACKGROUND_CONTEXT))[0], { cwd, agentDir, store, modelRuntime: runtime, rootContext: BACKGROUND_CONTEXT });
		assert.equal((await reopened.status()).model.provider, "explicit-repair");
		await reopened.close();
	} finally { await manager.closeAll(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true }); }
});
