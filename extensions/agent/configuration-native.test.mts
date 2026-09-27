import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession, ProjectTrustStore, SessionManager, ModelRuntime, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { AgentWorkerSession } from "./worker.ts";

function native(worker: AgentWorkerSession): AgentSessionRuntime { return (worker as unknown as { runtime: AgentSessionRuntime }).runtime; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const globals = globalThis as unknown as Record<string, unknown>;
function models(runtime: ModelRuntime) {
	const provider = runtime.getRegisteredNativeProvider(testModel.provider);
	assert.ok(provider);
	runtime.registerNativeProvider({ ...provider, getModels: () => [testModel, { ...testModel, id: "other" }, { ...testModel, id: "plain", reasoning: false }] });
	return provider;
}
const identity = `${testModel.provider}/${testModel.id}`;

test("live configuration preserves effective reasoning against defaults and keeps identity and history", async () => {
	const f = await fixture(undefined, { model: { provider: testModel.provider, modelId: testModel.id, thinkingLevel: "high" } }, { defaultThinkingLevel: "low" });
	try {
		await f.worker.start("retained conversation"); await f.worker.waitForIdle();
		const runtime = native(f.worker);
		models(runtime.services.modelRuntime);
		runtime.services.settingsManager.setModelThinkingLevel(testModel.provider, "other", "medium");
		await runtime.services.settingsManager.flush();
		const settings = readFileSync(join(f.agentDir, "settings.json"), "utf8");
		const before = f.worker.sessionManager().getEntries().map((entry) => entry.id);
		const id = f.worker.sessionId();
		const result = await f.worker.configure({ name: "Configured", model: `${testModel.provider}/other` });
		assert.equal(result.outcome, "applied");
		assert.equal(result.sessionId, id);
		assert.deepEqual(result.before, { name: "", model: identity, thinkingLevel: "high" });
		assert.deepEqual(result.after, { name: "Configured", model: `${testModel.provider}/other`, thinkingLevel: "high" });
		assert.deepEqual(result.reasoning, { requested: "high", effective: "high", clamped: false });
		assert.deepEqual(f.worker.sessionManager().getEntries().slice(0, before.length).map((entry) => entry.id), before);
		assert.equal(readFileSync(join(f.agentDir, "settings.json"), "utf8"), settings);
		assert.equal(f.requests.length, 1);
		const observed: Array<{ model: string; reasoning: unknown }> = [];
		const provider = runtime.services.modelRuntime.getRegisteredNativeProvider(testModel.provider);
		assert.ok(provider);
		runtime.services.modelRuntime.registerNativeProvider({ ...provider, streamSimple: (model, context, options) => {
			observed.push({ model: model.id, reasoning: options?.reasoning });
			return provider.streamSimple(model, context, options);
		} });
		await f.worker.start("explicit next request"); await f.worker.waitForIdle();
		assert.deepEqual(observed, [{ model: "other", reasoning: "high" }]);
		assert.equal((await f.worker.configure({ name: "" })).after.name, "");
	} finally { await f.close(); }
});

test("explicit reasoning wins and native model clamping reaches the actual result", async () => {
	const f = await fixture();
	try {
		models(native(f.worker).services.modelRuntime);
		const selected = await f.worker.configure({ model: identity, thinkingLevel: "minimal" });
		assert.equal(selected.after.thinkingLevel, "low");
		assert.deepEqual(selected.reasoning, { requested: "minimal", effective: "low", clamped: true });
		const clamped = await f.worker.configure({ model: `${testModel.provider}/plain`, thinkingLevel: "high" });
		assert.equal(clamped.after.thinkingLevel, "off");
		assert.equal(clamped.reasoning?.clamped, true);
		assert.equal(f.requests.length, 0);
	} finally { await f.close(); }
});

test("missing models and authentication fail before any live configuration mutation", async (t) => {
	const f = await fixture();
	try {
		const before = f.worker.sessionManager().getEntries();
		const missing = await f.worker.configure({ name: "unapplied", model: "absent/model", thinkingLevel: "high" });
		assert.equal(missing.outcome, "failed");
		assert.deepEqual(missing.after, missing.before);
		assert.equal(missing.persistence.nativeWrites, "not-attempted");
		const check = t.mock.method(native(f.worker).services.modelRuntime, "checkAuth", async () => undefined);
		const denied = await f.worker.configure({ name: "unapplied", model: identity, thinkingLevel: "high" });
		assert.equal(denied.outcome, "failed");
		assert.deepEqual(denied.after, denied.before);
		assert.deepEqual(f.worker.sessionManager().getEntries(), before);
		assert.equal(check.mock.callCount(), 1);
		assert.equal(f.requests.length, 0);
	} finally { await f.close(); }
});

test("closed configuration repairs an unavailable stored model and preserves saved reasoning and identity", async () => {
	const f = await fixture(undefined, { model: { provider: testModel.provider, modelId: testModel.id, thinkingLevel: "high" } }, { defaultThinkingLevel: "low" });
	await f.worker.start("saved conversation"); await f.worker.waitForIdle();
	const id = f.worker.sessionId();
	const entries = f.worker.sessionManager().getEntries().map((entry) => entry.id);
	await f.worker.close();
	const provider = f.runtime.getRegisteredNativeProvider(testModel.provider);
	assert.ok(provider);
	f.runtime.registerNativeProvider({ ...provider, getModels: () => [{ ...testModel, id: "replacement" }] });
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const bytes = readFileSync(f.worker.sessionMetadata().path, "utf8");
		const refused = await manager.configure(id, { name: "not applied", model: "missing/model" });
		assert.equal(refused.outcome, "failed");
		assert.equal(refused.persistence.nativeWrites, "not-attempted");
		assert.equal(readFileSync(f.worker.sessionMetadata().path, "utf8"), bytes);
		const result = await manager.configure(id, { name: "Reopened", model: `${testModel.provider}/replacement` });
		assert.equal(result.outcome, "applied");
		assert.equal(result.beforeSource, "retained");
		assert.equal(result.sessionId, id);
		assert.equal(result.before.model, identity);
		assert.equal(result.after.model, `${testModel.provider}/replacement`);
		assert.equal(result.after.thinkingLevel, "high");
		assert.deepEqual((await manager.sessionEntries(id)).slice(0, entries.length).map((entry) => entry.id), entries);
		assert.equal(f.requests.length, 1);
		await manager.closeAll();
		const reopened = await AgentWorkerSession.open(f.worker.sessionMetadata(), { ...f.options, model: undefined });
		try {
			assert.equal(reopened.sessionId(), id);
			assert.equal((await reopened.status()).name, "Reopened");
			assert.equal((await reopened.status()).model.thinkingLevel, "high");
			assert.equal((await reopened.status()).model.modelId, "replacement");
			assert.equal(f.requests.length, 1);
		} finally { await reopened.close(); }
	} finally { await manager.closeAll(); await f.close(); }
});

test("native model hooks report observed errors and cannot admit hidden input during configuration", async () => {
	const f = await fixture(`export default pi => {
		pi.on("model_select", () => {
			pi.sendUserMessage("hidden user");
			pi.sendMessage({customType:"hidden",content:"hidden custom",display:false},{triggerTurn:true});
			throw new Error("synthetic private diagnostic");
		});
	}`);
	try {
		models(native(f.worker).services.modelRuntime);
		const result = await f.worker.configure({ model: `${testModel.provider}/other`, thinkingLevel: "high" });
		assert.equal(result.outcome, "applied");
		assert.ok(result.hookErrors.count > 0);
		assert.ok(result.hookErrors.events.includes("model_select"));
		assert.doesNotMatch(JSON.stringify(result), /synthetic private diagnostic/u);
		assert.equal(f.requests.length, 0);
		assert.equal(f.worker.sessionManager().getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "hidden"), false);
		assert.equal(f.worker.observation().pending, 0);
	} finally { await f.close(); }
});

test("a native append failure reports actual partial state without rollback or raw diagnostics", async (t) => {
	const f = await fixture();
	try {
		models(native(f.worker).services.modelRuntime);
		const sessionManager = f.worker.sessionManager();
		const append = sessionManager.appendModelChange.bind(sessionManager);
		const fault = t.mock.method(sessionManager, "appendModelChange", (provider: string, model: string) => { append(provider, model); throw new Error("synthetic private diagnostic"); });
		const result = await f.worker.configure({ name: "not reached", model: `${testModel.provider}/other`, thinkingLevel: "high" });
		assert.equal(result.outcome, "failed");
		assert.equal(result.before.model, identity);
		assert.equal(result.after.model, `${testModel.provider}/other`);
		assert.equal(result.after.name, "");
		assert.equal(result.persistence.nativeWrites, "uncertain");
		assert.match(result.error ?? "", /model update/u);
		assert.doesNotMatch(JSON.stringify(result), /synthetic private diagnostic/u);
		fault.mock.restore();
		assert.equal((await f.worker.configure({ name: "recover explicitly" })).after.name, "recover explicitly");
		assert.equal(f.requests.length, 0);
	} finally { await f.close(); }
});

for (const stage of ["validation", "native setter"] as const) {
	test(`shutdown during ${stage} retains the writer until configuration settles`, { timeout: 5000 }, async (t) => {
		const f = await fixture();
		const entered = deferred(), release = deferred();
		const runtime = native(f.worker).services.modelRuntime;
		models(runtime);
		const check = runtime.checkAuth.bind(runtime);
		let calls = 0;
		t.mock.method(runtime, "checkAuth", async (provider: string) => {
			if (++calls === (stage === "validation" ? 1 : 2)) { entered.resolve(); await release.promise; }
			return check(provider);
		});
		const pending = f.worker.configure({ name: "configured", model: `${testModel.provider}/other`, thinkingLevel: "high" });
		try {
			await entered.promise;
			let closed = false;
			const close = f.worker.close().then(() => { closed = true; });
			await assert.rejects(f.store.open(f.worker.sessionMetadata()), /exclusive writer/u);
			assert.equal(closed, false);
			release.resolve();
			const result = await pending;
			assert.equal(result.outcome, stage === "validation" ? "failed" : "applied");
			assert.equal(result.after.name, stage === "validation" ? "" : "configured");
			await close;
			const reopened = await f.store.open(f.worker.sessionMetadata()); await reopened.close();
		} finally { release.resolve(); await pending; await f.close(); }
	});
}

test("configuration excludes native input, queues, Bash, and controls through awaited model hooks", { timeout: 5000 }, async () => {
	const entered = deferred(), release = deferred();
	const key = `configuration${randomUUID()}`;
	globals[key] = async () => { entered.resolve(); await release.promise; };
	const f = await fixture(`export default pi => pi.on("model_select", () => globalThis[${JSON.stringify(key)}]());`);
	models(native(f.worker).services.modelRuntime);
	const pending = f.worker.configure({ model: `${testModel.provider}/other` });
	try {
		await Promise.race([entered.promise, pending.then(() => assert.fail("model hook did not run"))]);
		const session = native(f.worker).session;
		for (const input of [() => session.prompt("hidden"), () => session.sendUserMessage("hidden"), () => session.steer("hidden"), () => session.followUp("hidden"), () => session.executeBash("exit 0"), () => f.worker.start("hidden"), () => f.worker.runCommand("reload", ""), () => f.worker.abort()]) {
			await assert.rejects(input(), /configuration|control/u);
		}
		await assert.rejects(f.worker.configure({ name: "parallel" }), /idle/u);
		assert.equal(f.requests.length, 0);
		release.resolve();
		assert.equal((await pending).outcome, "applied");
		await f.worker.start("explicit task"); await f.worker.waitForIdle();
		assert.equal(f.requests.length, 1);
	} finally { release.resolve(); await pending; delete globals[key]; await f.close(); }
});

test("queued input and native input preflight refuse configuration without abort", { timeout: 5000 }, async () => {
	const entered = deferred(), release = deferred();
	const key = `configuration${randomUUID()}`;
	globals[key] = async () => { entered.resolve(); await release.promise; return { action: "handled" }; };
	const f = await fixture(`export default pi => pi.on("input", () => globalThis[${JSON.stringify(key)}]());`);
	try {
		const session = native(f.worker).session;
		const pending = session.prompt("native input");
		await entered.promise;
		assert.equal(session.isIdle, true);
		await assert.rejects(f.worker.configure({ name: "unapplied" }), /idle/u);
		release.resolve(); await pending;
		globals[key] = () => ({ action: "continue" });
		await f.worker.steer("queued");
		await assert.rejects(f.worker.configure({ name: "unapplied" }), /idle/u);
		assert.equal(f.worker.observation().pending, 1);
		assert.equal(f.requests.length, 0);
	} finally { release.resolve(); delete globals[key]; await f.close(); }
});

for (const method of ["steer", "followUp"] as const) {
	test(`native ${method} preflight and queued input refuse configuration without abort`, { timeout: 5000 }, async (t) => {
		const entered = deferred(), release = deferred();
		const key = `configuration${randomUUID()}`;
		globals[key] = async () => { entered.resolve(); await release.promise; return { action: "continue" }; };
		const f = await fixture(`export default pi => pi.on("input", () => globalThis[${JSON.stringify(key)}]());`);
		const session = native(f.worker).session;
		const before = f.worker.sessionManager().getEntries();
		const abort = t.mock.method(session, "abort");
		const pending = session[method]("native queued input");
		try {
			assert.equal(f.worker.hasActiveWork(), true, "native queue admission reserves host work synchronously");
			await Promise.race([entered.promise, pending.then(() => assert.fail("input hook did not run"))]);
			assert.equal(session.isIdle, true);
			assert.equal(session.pendingMessageCount, 0);
			await assert.rejects(f.worker.configure({ name: "unapplied" }), /idle/u);
			assert.deepEqual(f.worker.sessionManager().getEntries(), before);
			release.resolve(); await pending;
			assert.equal(session.pendingMessageCount, 1);
			await assert.rejects(f.worker.configure({ name: "unapplied" }), /idle/u);
			assert.equal(abort.mock.callCount(), 0);
			assert.equal(f.requests.length, 0);
		} finally { release.resolve(); await pending.catch(() => undefined); delete globals[key]; await f.close(); }
	});

	test(`shutdown joins native ${method} preflight before writer release`, { timeout: 5000 }, async () => {
		const entered = deferred(), release = deferred();
		const key = `configuration${randomUUID()}`;
		globals[key] = async () => { entered.resolve(); await release.promise; return { action: "continue" }; };
		const f = await fixture(`export default pi => pi.on("input", () => globalThis[${JSON.stringify(key)}]());`);
		const pending = native(f.worker).session[method]("native queued input");
		try {
			await Promise.race([entered.promise, pending.then(() => assert.fail("input hook did not run"))]);
			const refused = assert.rejects(pending, /queued input aborted during preflight/u);
			let closed = false;
			const close = f.worker.close().then(() => { closed = true; });
			await assert.rejects(f.store.open(f.worker.sessionMetadata()), /exclusive writer/u);
			assert.equal(closed, false);
			release.resolve(); await refused; await close;
			const saved = readFileSync(f.worker.sessionMetadata().path, "utf8");
			const second = await f.store.open(f.worker.sessionMetadata());
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(readFileSync(f.worker.sessionMetadata().path, "utf8"), saved, "no native queue write follows writer release");
				assert.equal(f.requests.length, 0);
			} finally { await second.close(); }
		} finally { release.resolve(); await pending.catch(() => undefined); delete globals[key]; await f.close(); }
	});
}

test("closed configuration excludes startup input and reports native startup hook errors", async () => {
	const key = `configuration${randomUUID()}`;
	const f = await fixture(`export default pi => pi.on("session_start", () => {
		if (!globalThis[${JSON.stringify(key)}]) return;
		pi.sendUserMessage("hidden startup user");
		pi.sendMessage({customType:"hidden-startup",content:"hidden startup custom",display:false},{triggerTurn:true});
		throw new Error("synthetic private startup diagnostic");
	});`);
	await f.worker.close();
	globals[key] = true;
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const result = await manager.configure(f.worker.sessionId(), { name: "Configured at startup" });
		assert.equal(result.outcome, "applied");
		assert.equal(result.after.name, "Configured at startup");
		assert.ok(result.hookErrors.events.includes("session_start"));
		assert.doesNotMatch(JSON.stringify(result), /synthetic private startup diagnostic/u);
		assert.equal(f.requests.length, 0);
		assert.equal((await manager.sessionEntries(f.worker.sessionId())).some((entry) => entry.type === "custom_message" && entry.customType === "hidden-startup"), false);
	} finally { delete globals[key]; await manager.closeAll(); await f.close(); }
});

test("a closed-session append failure reports partial state and disposes its provisional native session", async (t) => {
	const f = await fixture();
	await f.worker.start("persisted context"); await f.worker.waitForIdle();
	await f.worker.close();
	models(f.runtime);
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	const append = SessionManager.prototype.appendModelChange;
	const fault = t.mock.method(SessionManager.prototype, "appendModelChange", function (this: SessionManager, provider: string, model: string) {
		const result = append.call(this, provider, model);
		if (model === "other") throw new Error("synthetic private startup diagnostic");
		return result;
	});
	const dispose = t.mock.method(AgentSession.prototype, "dispose");
	try {
		const result = await manager.configure(f.worker.sessionId(), { name: "not reached", model: `${testModel.provider}/other` });
		assert.equal(result.outcome, "failed");
		assert.equal(result.before.model, identity);
		assert.equal(result.after.model, `${testModel.provider}/other`);
		assert.equal(result.after.name, "");
		assert.equal(result.persistence.nativeWrites, "uncertain");
		assert.equal(dispose.mock.callCount(), 1);
		assert.equal(f.requests.length, 1);
		fault.mock.restore(); dispose.mock.restore();
		const reopened = await f.store.open(f.worker.sessionMetadata()); await reopened.close();
	} finally { fault.mock.restore(); dispose.mock.restore(); await manager.closeAll(); await f.close(); }
});

test("native shutdown joins a closed-session configuration setter before writer release", { timeout: 5000 }, async (t) => {
	const key = `configuration${randomUUID()}`;
	const f = await fixture(`export default pi => pi.on("session_start", (_event, ctx) => { globalThis[${JSON.stringify(key)}] = () => ctx.shutdown(); });`);
	await f.worker.start("saved context"); await f.worker.waitForIdle();
	const metadata = f.worker.sessionMetadata();
	await f.worker.close();
	models(f.runtime);
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	const entered = deferred(), release = deferred();
	const check = ModelRuntime.prototype.checkAuth;
	const close = AgentWorkerSession.prototype.close;
	let calls = 0, closed = false;
	let shutdown: Promise<void> | undefined;
	const auth = t.mock.method(ModelRuntime.prototype, "checkAuth", async function (this: ModelRuntime, provider: string) {
		if (provider === testModel.provider && ++calls === 3) { entered.resolve(); await release.promise; }
		return check.call(this, provider);
	});
	const closing = t.mock.method(AgentWorkerSession.prototype, "close", function (this: AgentWorkerSession, ...args: Parameters<AgentWorkerSession["close"]>) {
		shutdown = close.apply(this, args);
		void shutdown.then(() => { closed = true; });
		return shutdown;
	});
	const pending = manager.configure(metadata.id, { model: `${testModel.provider}/other`, name: "configured before release", thinkingLevel: "high" });
	try {
		await Promise.race([entered.promise, pending.then(() => assert.fail("native setter authentication did not run"))]);
		(globals[key] as () => void)();
		assert.ok(shutdown);
		await assert.rejects(f.store.open(metadata), /exclusive writer/u);
		assert.equal(closed, false);
		release.resolve();
		const result = await pending;
		await shutdown;
		assert.equal(result.after.name, "configured before release");
		assert.equal(result.after.model, `${testModel.provider}/other`);
		assert.equal(result.after.thinkingLevel, "high");
		assert.equal(result.outcome, "failed", "owner shutdown is reported without denying the completed field changes");
		const saved = readFileSync(metadata.path, "utf8");
		const second = await f.store.open(metadata);
		try {
			assert.equal(second.manager.getSessionName(), "configured before release");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(readFileSync(metadata.path, "utf8"), saved, "no configuration write follows writer release");
		} finally { await second.close(); }
		assert.equal(f.requests.length, 1);
	} finally { release.resolve(); await pending.catch(() => undefined); auth.mock.restore(); closing.mock.restore(); delete globals[key]; await manager.closeAll(); await f.close(); }
});
