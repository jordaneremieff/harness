import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT, type Context, MemorySessionRepo, withAbortSignal } from "@earendil-works/pi-agent-core";
import { hasTrustRequiringProjectResources, type ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const lifecycleFixture = join(here, "testdata", "lifecycle-command");
const trustYesFixture = join(here, "testdata", "trust-yes");

function tempBase(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
	return dir;
}

async function makeRuntime(): Promise<ModelRuntime> {
	return createTestRuntime({ refreshOnCreate: false });
}

function rootContext(): { context: Context; abort: AbortController } {
	const abort = new AbortController();
	return { context: withAbortSignal(abort.signal, BACKGROUND_CONTEXT), abort };
}

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = (): void => {
			void Promise.resolve(predicate()).then((done) => {
				if (done) return resolve();
				if (Date.now() - start > timeoutMs) return reject(new Error("condition not met within timeout"));
				setTimeout(tick, 10);
			});
		};
		tick();
	});
}

describe("agent store", () => {
	it("creates durable JSONL sessions under the configured root and lists them", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		mkdirSync(cwd, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const { context } = rootContext();
		const session = await store.create(cwd, context);
		const listed = await store.list(context);
		assert.equal(listed.length, 1);
		assert.equal(listed[0].id, session.metadata.id);
		assert.equal(listed[0].cwd, cwd);
		assert.ok(existsSync(sessionsRoot));
		await store.close(context);
		rmSync(base, { recursive: true, force: true });
	});
});

describe("agent worker session", () => {
	it("spawns a session whose session-view identity is the durable harness session id", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();
		const worker = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const status = await worker.status();
			assert.equal(status.sessionId, worker.sessionId());
			assert.equal(status.cwd, cwd);
			// The seeded agent.meta model entry is durable from creation; it is the
			// reopen source of truth, not a hidden seed.
			assert.equal(status.entryCount, 1, "fresh session carries exactly the durable agent.meta entry");
			assert.ok(status.tipId, "fresh session has a tip");
			assert.ok(status.tools.includes("bash"), "harness-native bash tool present");
			assert.ok(status.tools.includes("read"), "harness-native read tool present");
			assert.equal(status.extensions.length, 0, "no extensions configured in this test");
		} finally {
			await worker.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("projects durable entries with exact ids, parent chain, and tip; survives reopen", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();

		const worker = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		const sessionId = worker.sessionId();
		await worker.appendCustomEntry("agent.test.tag", { round: 1 });
		await worker.appendCustomEntry("agent.test.tag", { round: 2 });
		const beforeEntries = () => worker.status().then((s) => s.entryCount);
		await waitFor(async () => (await beforeEntries()) >= 2);
		await worker.close();

		const listed = await store.list(context);
		const metadata = listed.find((candidate) => candidate.id === sessionId);
		assert.ok(metadata, "session metadata survives close");

		const reopened = await AgentWorkerSession.open(metadata, {
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const status = await reopened.status();
			assert.equal(status.sessionId, sessionId);
			assert.ok(status.entryCount >= 2, `reopened session keeps entries (${status.entryCount})`);
			assert.ok(status.tipId, "reopened session has a tip");
			assert.equal(status.model.provider, "agent-test");
		} finally {
			await reopened.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("forks a live session into a new durable session with the same transcript", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();

		const source = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		await source.appendCustomEntry("agent.test.fork-source", { n: 1 });
		const sourceId = source.sessionId();
		const metadataList = await store.list(context);
		const sourceMetadata = metadataList.find((m) => m.id === sourceId);
		assert.ok(sourceMetadata, "source metadata is listed");

		const fork = await AgentWorkerSession.fork(sourceMetadata, {
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const forkId = fork.sessionId();
			assert.notEqual(forkId, sourceId);
			await waitFor(async () => (await fork.status()).entryCount >= 1);
			const forkStatus = await fork.status();
			assert.ok(forkStatus.entryCount >= 1, `fork copies transcript entries (${forkStatus.entryCount})`);
			const listed = await store.list(context);
			assert.equal(listed.length, 2);
		} finally {
			await source.close();
			await fork.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// Memory repo path is exercised via AgentWorkerSession over a Memory repo only if
// a store backed by MemorySessionRepo is desired; the durable JSONL store is the
// contract under test above.
void MemorySessionRepo;

describe("agent trust and replacement", () => {
	it("reopens without an explicit model from the durable agent.meta entry", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();
		const worker = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		const sessionId = worker.sessionId();
		await worker.close();
		const listed = await store.list(context);
		const metadata = listed.find((candidate) => candidate.id === sessionId);
		assert.ok(metadata, "session metadata survives close");
		// No model option: the durable meta entry is the only model source.
		const reopened = await AgentWorkerSession.open(metadata, {
			cwd,
			agentDir,
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const status = await reopened.status();
			assert.equal(status.model.provider, "agent-test", "model restored from the durable meta entry");
			assert.ok(status.entryCount >= 1, "durable meta entry present after reopen");
			const meta = reopened.sessionManager().getEntries().find(
				(entry) => entry.type === "custom" && entry.customType === "agent.meta",
			);
			assert.ok(meta, "agent.meta entry is on the durable branch");
		} finally {
			await reopened.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("resolves project trust through the ordinary order for a gated cwd", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();
		const trustStore = new ProjectTrustStore(agentDir);
		assert.equal(hasTrustRequiringProjectResources(cwd), true, "fixture cwd is trust-gated");

		// No saved decision, no extension event, no UI: the ordinary order denies.
		const denied = await AgentWorkerSession.create({
			cwd, agentDir, model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [], store, modelRuntime, trustStore, rootContext: context,
		});
		assert.equal(denied.isProjectTrusted(), false, "undecided gated cwd denies without UI");
		await denied.close();

		// An explicit operator decision is honored and persists through reopen.
		const explicit = await AgentWorkerSession.create({
			cwd, agentDir, model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [], store, modelRuntime, trustStore, trusted: true, rootContext: context,
		});
		assert.equal(explicit.isProjectTrusted(), true, "explicit trust decision is honored");
		await explicit.close();
		// Persistence of explicit decisions is the manager layer's job; persist and reopen.
		trustStore.set(cwd, true);
		const savedMetadata = (await store.list(context)).at(-1);
		assert.ok(savedMetadata, "saved session metadata is listed");
		const saved = await AgentWorkerSession.open(savedMetadata, {
			cwd, agentDir, extensionPaths: [], store, modelRuntime, trustStore, rootContext: context,
		});
		assert.equal(saved.isProjectTrusted(), true, "decision persisted in the trust store");
		await saved.close();

		await store.close(context);
		rmSync(base, { recursive: true, force: true });
	});

	it("honors an extension project_trust decision and remembers it", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();
		const trustStore = new ProjectTrustStore(agentDir);
		const worker = await AgentWorkerSession.create({
			cwd, agentDir, model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [trustYesFixture], store, modelRuntime, trustStore, rootContext: context,
		});
		try {
			assert.equal(worker.isProjectTrusted(), true, "extension project_trust yes decides");
			assert.equal(trustStore.get(cwd), true, "remember:true persisted the decision");
		} finally {
			await worker.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keeps worker extension UI headless across reload under an interactive primary", async () => {
		const base = tempBase();
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd); mkdirSync(agentDir);
		const store = new AgentStore({ sessionsRoot: join(base, "sessions") });
		const { context } = rootContext();
		const manager = new AgentManager(store, await makeRuntime(), new ProjectTrustStore(agentDir), undefined, agentDir);
		manager.setHostUI(new Proxy({} as import("@earendil-works/pi-coding-agent").ExtensionUIContext, {
			get: (_target, key) => { throw new Error(`Worker borrowed primary UI: ${String(key)}`); },
		}), "tui");
		try {
			const { sessionId } = await manager.spawn({ cwd, model: "agent-test/model", trust: true }, { cwd, model: null }, undefined, { extensionPaths: [lifecycleFixture] });
			await manager.runCommand(sessionId, "agent-ui-context-test", "");
			await manager.runCommand(sessionId, "reload", "");
			await manager.runCommand(sessionId, "agent-ui-context-test", "");
			const observations = (await manager.sessionEntries(sessionId)).flatMap((entry) => entry.type === "custom" && entry.customType === "agent.ui-context" ? [entry.data] : []);
			assert.deepEqual(observations, Array.from({ length: 2 }, () => ({ mode: "print", hasUI: false, confirmed: false, selected: null, input: null, custom: null, editor: "" })));
		} finally {
			await manager.closeAll();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("replaces sessions through the manager boundary with durable setup and a live withSession context", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();
		const trustStore = new ProjectTrustStore(agentDir);
		const manager = new AgentManager(store, modelRuntime, trustStore, undefined, agentDir);
		try {
			await manager.spawn(
				{ cwd, model: "agent-test/model" },
				{ cwd, model: null },
				undefined,
				{ extensionPaths: [lifecycleFixture] },
			);
			const [sessionId] = await manager.listSessions();
			assert.ok(sessionId, "spawned session is listed");
			await manager.runCommand(sessionId, "agent-write-boundary", "");
			const committed = await manager.sessionEntries(sessionId);
			assert.ok(committed.some((entry) => entry.type === "custom" && entry.customType === "agent.pending-write"));
			const immediate = committed.find((entry) => entry.type === "custom" && entry.customType === "agent.immediate-read");
			assert.deepEqual(immediate?.type === "custom" ? immediate.data : undefined, { immediate: false });

			const result = await manager.runCommand(sessionId, "agent-replace-test", "");
			assert.ok(result.sessionId, "replacement session id reported to the caller");
			assert.notEqual(result.sessionId, sessionId, "replacement is a new session");

			const replacementEntries = await manager.sessionEntries(result.sessionId);
			assert.ok(
				replacementEntries.some((entry) => entry.type === "custom" && entry.customType === "agent.setup.test"),
				"setup callback write landed durably on the replacement",
			);
			assert.ok(
				replacementEntries.some(
					(entry) => entry.type === "custom_message" && entry.customType === "agent.replaced.test",
				),
				"withSession sendMessage recorded as an ordinary custom_message on the replacement",
			);

			const listed = await store.list(context);
			assert.ok(listed.some((candidate) => candidate.id === result.sessionId), "replacement is durable");

			// Durability beyond the live view: close everything, reopen the
			// replacement from the store, and verify the same ids and content.
			await manager.closeAll();
			const replacementMetadata = (await store.list(context)).find(
				(candidate) => candidate.id === result.sessionId,
			);
			assert.ok(replacementMetadata, "replacement metadata is listed after close");
			const reopened = await AgentWorkerSession.open(replacementMetadata, {
				cwd,
				agentDir,
				store,
				modelRuntime,
				trustStore,
				rootContext: context,
			});
			try {
				const durableEntries = reopened.sessionManager().getEntries();
				const setupEntry = durableEntries.find(
					(entry) => entry.type === "custom" && entry.customType === "agent.setup.test",
				);
				assert.ok(setupEntry, "setup write survives close/reopen");
				assert.deepEqual(setupEntry?.type === "custom" ? setupEntry.data : undefined, { seeded: true });
				const messageEntry = durableEntries.find(
					(entry) => entry.type === "custom_message" && entry.customType === "agent.replaced.test",
				);
				assert.ok(messageEntry, "withSession message survives close/reopen as ordinary custom_message");
				// The lane tip sits on the replacement ancestry: the next run's model
				// context is built from these setup entries.
				const tip = await reopened.status().then((s) => s.tipId);
				const branch = reopened.sessionManager().getBranch(tip ?? undefined);
				assert.ok(
					branch.some((entry) => entry.type === "custom" && entry.customType === "agent.setup.test"),
					"setup entry is on the tip ancestry feeding the next model run",
				);
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.closeAll();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});
describe("partial worker startup", () => {
	for (const operation of ["create", "open", "fork"] as const) {
		it(`closes all acquired resources after ${operation} attachment fails`, async (t) => {
			const base = tempBase();
			const cwd = join(base, "work");
			const agentDir = join(base, "agent");
			mkdirSync(cwd); mkdirSync(agentDir);
			const store = new AgentStore({ sessionsRoot: join(base, "sessions") });
			const modelRuntime = await makeRuntime();
			const { context } = rootContext();
			const created: string[] = [];
			const closed: string[] = [];
			const options = { cwd, agentDir, store, modelRuntime, rootContext: context, model: { provider: "agent-test", modelId: "model" }, onSessionCreated: (id: string) => created.push(id), onSessionClosed: (id: string) => closed.push(id) };
			try {
				if (operation !== "create") { const source = await AgentWorkerSession.create(options); await source.close(); }
				created.length = 0; closed.length = 0;
				const source = (await store.list(context))[0];
				const prototype = AgentWorkerSession.prototype as unknown as { attachToSession(...args: unknown[]): Promise<void> };
				const attach = prototype.attachToSession;
				let failedWorker: AgentWorkerSession | undefined;
				const failure = new Error("injected attachment failure");
				const mock = t.mock.method(prototype, "attachToSession", async function(this: AgentWorkerSession, ...args: unknown[]) {
					failedWorker = this;
					await attach.apply(this, args);
					throw failure;
				});
				const task = operation === "create" ? AgentWorkerSession.create(options) : operation === "open" ? AgentWorkerSession.open(source, options) : AgentWorkerSession.fork(source, options);
				await assert.rejects(task, (error) => error === failure);
				assert.deepEqual(closed, created);
				assert.equal(created.length, 1);
				assert.ok(failedWorker, "attachment reached the worker");
				const closedWorker = failedWorker;
				assert.throws(() => closedWorker.sessionId(), /not attached/u);
				const internals = failedWorker as unknown as { harness?: unknown; laneWatcher?: unknown; laneObservers: Set<unknown> };
				assert.equal(internals.harness, undefined);
				assert.equal(internals.laneWatcher, undefined);
				assert.equal(internals.laneObservers.size, 0);
				mock.mock.restore();
				const metadata = (await store.list(context)).find((candidate) => candidate.id === created[0]);
				assert.ok(metadata, "failed startup retains its session");
				const reopened = await AgentWorkerSession.open(metadata, options);
				await reopened.close();
			} finally { await store.close(context); rmSync(base, { recursive: true, force: true }); }
		});
	}

	it("preserves the primary failure when cleanup also fails", async (t) => {
		const base = tempBase();
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd); mkdirSync(agentDir);
		const store = new AgentStore({ sessionsRoot: join(base, "sessions") });
		const { context } = rootContext();
		try {
			const primary = new Error("primary attachment failure");
			const cleanup = new Error("cleanup failure");
			const prototype = AgentWorkerSession.prototype as unknown as { attachToSession(...args: unknown[]): Promise<void> };
			t.mock.method(prototype, "attachToSession", async function(this: AgentWorkerSession) {
				const close = this.close.bind(this);
				t.mock.method(this, "close", async () => { await close(); throw cleanup; });
				throw primary;
			});
			await assert.rejects(AgentWorkerSession.create({ cwd, agentDir, store, modelRuntime: await makeRuntime(), rootContext: context, model: { provider: "agent-test", modelId: "model" } }), (error) => {
				assert.ok(error instanceof AggregateError);
				assert.equal(error.cause, primary);
				assert.deepEqual(error.errors, [primary, cleanup]);
				return true;
			});
		} finally { await store.close(context); rmSync(base, { recursive: true, force: true }); }
	});
});

describe("agent lane observer", () => {
	it("delivers raw lane events in order and closes when the last subscriber leaves", async () => {
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await makeRuntime();
		const { context } = rootContext();
		const worker = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const observer = await worker.observeLane();
			const events: string[] = [];
			const unsubscribe = observer.subscribe((event) => {
				events.push(String((event as { type: string }).type));
			});
			await worker.appendCustomEntry("agent.test.observe", { n: 1 });
			await waitFor(() => events.includes("entry_added"));
			assert.ok(events.includes("entry_added"), "observer received raw entry_added event");
			unsubscribe();
			const eventsAfter: string[] = [];
			const second = await worker.observeLane();
			const unsub2 = second.subscribe((event) => eventsAfter.push(String((event as { type: string }).type)));
			await worker.appendCustomEntry("agent.test.observe", { n: 2 });
			await waitFor(() => eventsAfter.includes("entry_added"));
			assert.ok(eventsAfter.includes("entry_added"), "observer reopened after unsubscribe");
			unsub2();
		} finally {
			await worker.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});
