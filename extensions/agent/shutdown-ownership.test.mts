import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { AgentSession, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import type { AgentWorkerSession } from "./worker.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
function nativeRuntime(worker: AgentWorkerSession): AgentSessionRuntime {
	return (worker as unknown as { runtime: AgentSessionRuntime }).runtime;
}
const globals = globalThis as unknown as Record<string, unknown>;
const replacementCommand = `pi.registerCommand("replace", { handler: async (_args, ctx) => ctx.newSession() });`;

for (const transition of ["close", "replace"] as const) {
	test(`${transition} fences native user and custom shutdown admissions`, { timeout: 5000 }, async () => {
		const key = `shutdown${randomUUID()}`;
		let shutdowns = 0;
		globals[key] = () => { shutdowns++; };
		const f = await fixture(`export default pi => {
			${replacementCommand}
			pi.on("session_shutdown", () => {
				globalThis[${JSON.stringify(key)}]();
				pi.sendUserMessage("late native user");
				pi.sendMessage({customType:"shutdown-run",content:"late custom run",display:false},{triggerTurn:true});
				pi.sendMessage({customType:"shutdown-entry",content:"late custom entry",display:false},{triggerTurn:false});
			});
		}`);
		const outgoing = nativeRuntime(f.worker).session;
		const metadata = f.worker.sessionMetadata();
		try {
			if (transition === "close") await f.worker.close();
			else assert.notEqual((await f.worker.runCommand("replace", "")).sessionId, metadata.id);
			assert.equal(shutdowns, 1);
			assert.equal(f.requests.length, 0);
			const entries = outgoing.sessionManager.getEntries();
			assert.equal(entries.some((entry) => entry.type === "custom_message" && entry.customType.startsWith("shutdown-")), false);
			await assert.rejects(outgoing.prompt("stale prompt"), /native input is closed/u);
			await assert.rejects(outgoing.sendUserMessage("stale user"), /native input is closed/u);
			for (const options of [{ triggerTurn: true }, { triggerTurn: false }, { deliverAs: "nextTurn" as const }]) {
				await assert.rejects(outgoing.sendCustomMessage({ customType: "stale", content: "stale custom", display: false }, options), /native input is closed/u);
			}
			assert.deepEqual(outgoing.sessionManager.getEntries(), entries);
			assert.equal(readdirSync(join(f.store.nativeRoot, ".claims")).length, transition === "close" ? 0 : 1);
			const reopened = await f.store.open(metadata);
			await reopened.close();
			if (transition === "replace") {
				await f.worker.sendUserMessage("new native user");
				await f.worker.waitForIdle();
				assert.equal(f.requests.length, 1);
			}
		} finally { await f.close(); delete globals[key]; }
	});

	test(`${transition} joins outgoing native work after shutdown before claim release`, { timeout: 5000 }, async () => {
		const key = `shutdown${randomUUID()}`;
		const entered = deferred(), aborted = deferred(), release = deferred();
		const f = await fixture(`export default pi => {
			${replacementCommand}
			pi.on("session_shutdown", () => globalThis[${JSON.stringify(key)}]?.());
		}`);
		const runtime = nativeRuntime(f.worker);
		const outgoing = runtime.session;
		const metadata = f.worker.sessionMetadata();
		const provider = runtime.services.modelRuntime.getRegisteredNativeProvider(testModel.provider);
		assert.ok(provider);
		let cleaned = false;
		const stream: typeof provider.stream = (model, _context, options) => {
			const events = createAssistantMessageEventStream();
			const response: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() };
			events.push({ type: "start", partial: response });
			const stop = () => {
				aborted.resolve();
				void release.promise.then(() => { cleaned = true; events.push({ type: "error", reason: "aborted", error: response }); events.end(response); });
			};
			if (options?.signal?.aborted) stop();
			else options?.signal?.addEventListener("abort", stop, { once: true });
			entered.resolve();
			return events;
		};
		runtime.services.modelRuntime.registerNativeProvider({ ...provider, stream, streamSimple: stream });
		let nativeTask: Promise<void> | undefined;
		globals[key] = async () => {
			delete globals[key];
			// Bypass only the host admission wrapper to exercise the independent
			// post-shutdown join against a real native run and controlled provider.
			nativeTask = AgentSession.prototype.sendCustomMessage.call(outgoing, { customType: "native-cleanup", content: "cleanup", display: false }, { triggerTurn: true });
			void nativeTask.catch(() => undefined);
			await entered.promise;
		};
		let settled = false;
		const pending = transition === "close" ? f.worker.close() : f.worker.runCommand("replace", "");
		if (transition === "close") assert.equal(f.worker.close(), pending);
		const transitionTask = pending.then(() => { settled = true; });
		try {
			await aborted.promise;
			assert.equal(cleaned, false);
			assert.equal(outgoing.isIdle, false);
			assert.equal(settled, false);
			await assert.rejects(f.store.open(metadata), /exclusive writer claim/u);
			release.resolve();
			await transitionTask;
			await nativeTask;
			assert.equal(cleaned, true);
			assert.equal(outgoing.isIdle, true);
			const reopened = await f.store.open(metadata);
			await reopened.close();
		} finally { release.resolve(); delete globals[key]; await transitionTask; await f.close(); }
	});

	for (const failure of ["join", "dispose"] as const) {
		test(`${transition} retains the outgoing writer claim after failed ${failure}`, { timeout: 5000 }, async (t) => {
			const f = await fixture(`export default pi => { ${replacementCommand} }`);
			const outgoing = nativeRuntime(f.worker).session;
			const metadata = f.worker.sessionMetadata();
			const abort = outgoing.abort.bind(outgoing);
			let aborts = 0;
			const mock = failure === "join"
				? t.mock.method(outgoing, "abort", async () => { if (++aborts > 1) throw new Error("native join failed"); await abort(); })
				: t.mock.method(outgoing, "dispose", () => { throw new Error("native dispose failed"); });
			try {
				await assert.rejects(transition === "close" ? f.worker.close() : f.worker.runCommand("replace", ""), /cleanup/u);
				await assert.rejects(f.store.open(metadata), /exclusive writer claim/u);
				await assert.rejects(f.worker.status(), /host is closed/u);
				assert.equal(f.worker.sessionId(), metadata.id);
				assert.equal(readdirSync(join(f.store.nativeRoot, ".claims")).length, 1);
			} finally { mock.mock.restore(); await f.close(); }
			assert.equal(outgoing.isIdle, true);
		});
	}
}

test("a cancelled replacement restores admission to the same native session", { timeout: 5000 }, async () => {
	const f = await fixture(`export default pi => {
		${replacementCommand}
		pi.on("session_before_switch", () => ({cancel:true}));
	}`);
	try {
		const session = nativeRuntime(f.worker).session;
		const metadata = f.worker.sessionMetadata();
		await f.worker.runCommand("replace", "");
		assert.equal(f.worker.sessionId(), metadata.id);
		await session.sendCustomMessage({ customType: "continued", content: "still open", display: false }, { triggerTurn: true });
		await session.sendUserMessage("still open");
		await f.worker.waitForIdle();
		assert.equal(f.requests.length, 2);
		await assert.rejects(f.store.open(metadata), /exclusive writer claim/u);
	} finally { await f.close(); }
});

test("replacement joins admitted native preflight without joining its command", { timeout: 5000 }, async () => {
	const key = `preflight${randomUUID()}`;
	const entered = deferred(), shutdown = deferred(), release = deferred();
	globals[key] = async (phase: string) => {
		if (phase === "shutdown") { shutdown.resolve(); return; }
		entered.resolve(); await release.promise;
	};
	const f = await fixture(`export default pi => {
		${replacementCommand}
		pi.registerCommand("launch", {handler: () => { pi.sendUserMessage("admitted user"); }});
		pi.on("before_agent_start", () => globalThis[${JSON.stringify(key)}]("preflight"));
		pi.on("session_shutdown", () => globalThis[${JSON.stringify(key)}]("shutdown"));
	}`);
	let transition: Promise<void> | undefined;
	try {
		const outgoing = nativeRuntime(f.worker).session;
		const metadata = f.worker.sessionMetadata();
		await f.worker.runCommand("launch", "");
		await entered.promise;
		transition = outgoing.sendUserMessage("/replace", { expandPromptTemplates: true });
		await shutdown.promise;
		await assert.rejects(f.store.open(metadata), /exclusive writer claim/u);
		release.resolve();
		await transition;
		assert.notEqual(f.worker.sessionId(), metadata.id);
		assert.equal(f.requests.length, 0);
		const reopened = await f.store.open(metadata);
		await reopened.close();
	} finally { release.resolve(); await transition; await f.close(); delete globals[key]; }
});

test("a replacement validation error restores native admission", { timeout: 5000 }, async () => {
	const f = await fixture(`export default pi => pi.registerCommand("invalid-fork", {handler: async (_args, ctx) => ctx.fork("missing-entry")});`);
	try {
		const outgoing = nativeRuntime(f.worker).session;
		const id = f.worker.sessionId();
		await assert.rejects(f.worker.runCommand("invalid-fork", ""), /Invalid entry ID/u);
		assert.equal(f.worker.sessionId(), id);
		await outgoing.sendUserMessage("still valid");
		await f.worker.waitForIdle();
		assert.equal(f.requests.length, 1);
	} finally { await f.close(); }
});

test("native user command replacement does not join its own command promise", { timeout: 5000 }, async () => {
	const f = await fixture(`export default pi => { ${replacementCommand} }`);
	try {
		const outgoing = nativeRuntime(f.worker).session;
		const metadata = f.worker.sessionMetadata();
		await outgoing.sendUserMessage("/replace", { expandPromptTemplates: true });
		assert.notEqual(f.worker.sessionId(), metadata.id);
		assert.equal(f.requests.length, 0);
		const reopened = await f.store.open(metadata);
		await reopened.close();
	} finally { await f.close(); }
});
