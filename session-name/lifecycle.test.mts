import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { offerSessionName, type ProvisionalName } from "./lifecycle.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function receipts(manager: SessionManager) {
	return manager.getEntries().filter((entry): entry is Extract<SessionEntry, { type: "custom" }> =>
		entry.type === "custom" && entry.customType === "session-name:automatic");
}

function latest(manager: SessionManager) {
	return manager.getEntries().findLast((entry) => entry.type === "session_info");
}

function namingContext(getManager: () => SessionManager): ExtensionContext {
	return { cwd: "/work/example", get sessionManager() { return getManager(); } } as unknown as ExtensionContext;
}

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
function harness(options: { manager?: SessionManager; appendFailure?: boolean; setterFailure?: boolean; reentrant?: boolean } = {}) {
	let manager = options.manager ?? SessionManager.inMemory("/work/example");
	const bus = createEventBus();
	const handlers = new Map<string, Handler[]>();
	const events: ProvisionalName[] = [];
	bus.on("session-name:provisional", (value) => { events.push(value as ProvisionalName); });
	const ctx = namingContext(() => manager);
	function fire(type: string, event: Record<string, unknown> = {}) {
		for (const handler of [...(handlers.get(type) ?? [])]) handler({ type, ...event }, ctx);
	}
	const pi = {
		events: bus,
		on(type: string, handler: Handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler); handlers.set(type, list);
			return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
		},
		getSessionName() { return manager.getSessionName(); },
		setSessionName(name: string) {
			if (options.setterFailure) throw new Error("Unavailable setter");
			manager.appendSessionInfo(name);
			fire("session_info_changed", { name: manager.getSessionName() });
			if (options.reentrant) manager.appendSessionInfo("Reentrant name");
		},
		appendEntry(type: string, data: unknown) {
			if (options.appendFailure) throw new Error("Unavailable append");
			manager.appendCustomEntry(type, data);
		},
	} as unknown as ExtensionAPI;
	return {
		pi, ctx, events, fire,
		get manager() { return manager; },
		offer(text = "Fix the parser", source: "interactive" | "evo" = "interactive") { offerSessionName(pi, ctx, { source, text }); },
		refine(event = events[0], title: unknown = "Repair parser") {
			assert.ok(event);
			bus.emit("session-name:refined", { sessionId: event.sessionId, nameEntryId: event.nameEntryId, title });
		},
		replace() { manager = SessionManager.inMemory("/work/other"); fire("session_start"); },
	};
}

async function sdkFixture(t: TestContext, options: { before?: (pi: ExtensionAPI) => void; after?: (pi: ExtensionAPI) => void } = {}) {
	const root = mkdtempSync(join(tmpdir(), "session-name-test-"));
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
	const manager = SessionManager.inMemory(root);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const events: ProvisionalName[] = [];
	const errors: unknown[] = [];
	let api!: ExtensionAPI;
	let requests = 0;
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			api = pi;
			pi.registerProvider("name-fixture", {
				baseUrl: "https://fixture.invalid", api: "name-fixture", apiKey: "synthetic-test-value",
				models: [{ id: "controlled", name: "Controlled", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				streamSimple(model) {
					requests++;
					const message: AssistantMessage = {
						role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
						content: [{ type: "text", text: "Controlled response" }], stopReason: "stop",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			});
			pi.events.on("session-name:provisional", (value) => { events.push(value as ProvisionalName); });
			options.before?.(pi);
			pi.on("input", (event, ctx) => {
				if (event.source === "interactive") offerSessionName(pi, ctx, { source: "interactive", text: event.text });
			});
			options.after?.(pi);
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: [] });
	t.after(async () => { await session.abort(); session.dispose(); rmSync(root, { recursive: true, force: true }); });
	await session.bindExtensions({ onError: (error) => { errors.push(error); } });
	const model = runtime.getModel("name-fixture", "controlled");
	assert.ok(model);
	await session.setModel(model);
	return { session, manager, events, get api() { return api; }, errors, get requests() { return requests; } };
}

it("refines through the public bus after turn start without delaying the turn", { timeout: 20000 }, async (t) => {
	const started = gate();
	const delivered = gate();
	const fixture = await sdkFixture(t, { after(pi) {
		pi.on("turn_start", () => { started.resolve(); });
		pi.events.on("session-name:provisional", (value) => {
			const event = value as ProvisionalName;
			assert.equal(pi.getSessionName(), "Fix the parser");
			void started.promise.then(() => {
				pi.events.emit("session-name:refined", { sessionId: event.sessionId, nameEntryId: event.nameEntryId, title: "Repair parser" });
				delivered.resolve();
			});
		});
	} });
	await fixture.session.prompt("Fix the parser");
	await delivered.promise;
	assert.equal(fixture.manager.getSessionName(), "Repair parser");
	assert.equal(fixture.events.length, 1);
	assert.equal(fixture.events[0]?.signal.aborted, true);
	assert.equal(fixture.requests, 1, "only the controlled main turn requests a response");
	assert.deepEqual(receipts(fixture.manager).map((entry) => entry.data), [
		{ sessionId: fixture.manager.getSessionId(), nameEntryId: fixture.events[0]?.nameEntryId, phase: "fallback" },
		{ sessionId: fixture.manager.getSessionId(), nameEntryId: latest(fixture.manager)?.id, phase: "semantic" },
	]);
	assert.deepEqual(fixture.errors, []);
});

it("protects explicit names, identical names and clears from an uncooperative generator", { timeout: 20000 }, async (t) => {
	for (const name of ["Explicit name", "Fix the parser", ""]) {
		const fixture = await sdkFixture(t);
		await fixture.session.prompt("Fix the parser");
		const event = fixture.events[0]; assert.ok(event);
		fixture.session.setSessionName(name);
		const entry = latest(fixture.manager);
		fixture.api.events.emit("session-name:refined", { sessionId: event.sessionId, nameEntryId: event.nameEntryId, title: "Wrong replacement" });
		assert.equal(latest(fixture.manager)?.id, entry?.id);
		assert.equal(fixture.manager.getSessionName(), name || undefined);
		assert.equal(event.signal.aborted, true);
		await fixture.session.prompt("Another request");
		assert.equal(latest(fixture.manager)?.id, entry?.id);
	}
});

it("discards a consumed input's retained text when a newer prompt starts a turn", { timeout: 20000 }, async (t) => {
	const fixture = await sdkFixture(t, { after(pi) {
		pi.on("input", (event) => event.text === "Old parser request" ? { action: "handled" } : undefined);
	} });
	await fixture.session.prompt("Old parser request");
	const entry = latest(fixture.manager);
	assert.equal(fixture.events.length, 0);
	await fixture.session.prompt("A different request");
	assert.equal(fixture.events.length, 0);
	assert.equal(latest(fixture.manager)?.id, entry?.id);
	assert.equal(fixture.manager.getSessionName(), "Old parser request");
	assert.equal(fixture.requests, 1);
});

it("uses earlier transformed input and does not see input an earlier handler consumes", { timeout: 20000 }, async (t) => {
	const transformed = await sdkFixture(t, { before(pi) {
		pi.on("input", () => ({ action: "transform", text: "Transformed parser request" }));
	} });
	await transformed.session.prompt("Original request");
	assert.equal(transformed.events[0]?.text, "Transformed parser request");
	const consumed = await sdkFixture(t, { before(pi) { pi.on("input", () => ({ action: "handled" })); } });
	await consumed.session.prompt("Invisible request");
	assert.equal(consumed.manager.getSessionName(), undefined);
	assert.equal(consumed.events.length, 0);
	assert.equal(consumed.requests, 0);
});

it("accepts a late result after turn completion and makes a semantic result final", { timeout: 20000 }, async (t) => {
	const fixture = await sdkFixture(t);
	await fixture.session.prompt("Fix the parser");
	await fixture.session.waitForIdle();
	const event = fixture.events[0]; assert.ok(event);
	assert.equal(event.signal.aborted, false);
	const before = receipts(fixture.manager).length;
	fixture.api.events.emit("session-name:refined", { sessionId: event.sessionId, nameEntryId: event.nameEntryId, title: "Repair parser" });
	const semantic = latest(fixture.manager);
	fixture.api.events.emit("session-name:refined", { sessionId: event.sessionId, nameEntryId: semantic?.id, title: "Wrong second result" });
	await fixture.session.prompt("Continue the work");
	assert.equal(latest(fixture.manager)?.id, semantic?.id);
	assert.equal(fixture.events.length, 1);
	assert.equal(receipts(fixture.manager).length, before + 1);
});

it("cancels the signal on SDK reload and ignores the old payload", { timeout: 20000 }, async (t) => {
	const fixture = await sdkFixture(t);
	await fixture.session.prompt("Fix the parser");
	const event = fixture.events[0]; assert.ok(event);
	await fixture.session.reload();
	assert.equal(event.signal.aborted, true);
	const entry = latest(fixture.manager);
	fixture.api.events.emit("session-name:refined", { sessionId: event.sessionId, nameEntryId: event.nameEntryId, title: "Wrong old result" });
	assert.equal(latest(fixture.manager)?.id, entry?.id);
	assert.equal(fixture.events.length, 1);
});

it("keeps fallback behaviour without a generator and emits once", () => {
	const fixture = harness(); fixture.offer();
	assert.equal(fixture.manager.getSessionName(), "Fix the parser");
	assert.equal(receipts(fixture.manager).length, 1);
	fixture.fire("before_agent_start"); fixture.fire("before_agent_start");
	assert.equal(fixture.events.length, 1);
	for (const type of ["turn_end", "agent_end", "agent_settled"]) fixture.fire(type);
	assert.equal(receipts(fixture.manager).length, 1);
	assert.equal(fixture.events[0]?.signal.aborted, false);
});

it("leaves the fallback intact when a generator fails", async (t) => {
	const fixture = harness();
	const observed = gate();
	t.mock.method(console, "error", () => { observed.resolve(); });
	fixture.pi.events.on("session-name:provisional", async () => { throw new Error("Unavailable generator"); });
	fixture.offer(); fixture.fire("before_agent_start");
	await observed.promise;
	assert.equal(fixture.manager.getSessionName(), "Fix the parser");
	assert.equal(receipts(fixture.manager).length, 1);
});

it("bounds Unicode source and titles and ignores unusable input", () => {
	const fixture = harness();
	for (const text of ["", "  ", "/x", "/x --flag", "😀😀"]) fixture.offer(text);
	assert.equal(fixture.manager.getSessionName(), undefined);
	fixture.offer(`Task ${"😀".repeat(5000)}`); fixture.fire("before_agent_start");
	assert.equal(Array.from(fixture.events[0]?.text ?? "").length, 4096);
	fixture.refine(undefined, "one two three four five six seven eight nine");
	assert.equal(fixture.manager.getSessionName(), "one two three four five six seven eight");
	const fallback = harness(); fallback.offer("x".repeat(100));
	assert.equal(fallback.manager.getSessionName(), "Work in example");
});

it("allows the first valid result only and does not consume permission on invalid replies", () => {
	const fixture = harness(); fixture.offer(); fixture.fire("before_agent_start");
	for (const title of [null, "", "!!!", "a".repeat(49)]) fixture.refine(undefined, title);
	fixture.pi.events.emit("session-name:refined", {});
	fixture.pi.events.emit("session-name:refined", { sessionId: "other", nameEntryId: fixture.events[0]?.nameEntryId, title: "Wrong title" });
	assert.equal(receipts(fixture.manager).length, 1);
	fixture.refine(undefined, "First valid title"); fixture.refine(undefined, "Second valid title");
	assert.equal(fixture.manager.getSessionName(), "First valid title");
	assert.equal(receipts(fixture.manager).length, 2);
});

it("guards entry identity even before a direct-write observer runs", () => {
	const fixture = harness(); fixture.offer(); fixture.fire("before_agent_start");
	fixture.manager.appendSessionInfo("Fix the parser");
	const entry = latest(fixture.manager);
	fixture.refine();
	assert.equal(latest(fixture.manager)?.id, entry?.id);
});

it("protects writes without a valid receipt and contains partial writes", () => {
	for (const options of [{ appendFailure: true }, { setterFailure: true }, { reentrant: true }]) {
		const fixture = harness(options); fixture.offer(); fixture.fire("before_agent_start");
		assert.equal(fixture.events.length, 0);
		assert.equal(receipts(fixture.manager).length, 0);
		if (options.reentrant) assert.equal(fixture.manager.getSessionName(), "Reentrant name");
	}
	const fixture = harness(); fixture.offer(); fixture.fire("before_agent_start");
	const entry = fixture.manager.appendSessionInfo("Unmarked name");
	fixture.manager.appendCustomEntry("session-name:automatic", { sessionId: fixture.manager.getSessionId(), nameEntryId: entry, phase: "invalid" });
	fixture.pi.events.emit("session-name:refined", { sessionId: fixture.manager.getSessionId(), nameEntryId: entry, title: "Wrong title" });
	assert.equal(fixture.manager.getSessionName(), "Unmarked name");
});

it("drops stale results on replacement or shutdown and never replays resumed receipts", () => {
	for (const replace of [false, true]) {
		const fixture = harness(); fixture.offer(); fixture.fire("before_agent_start");
		const event = fixture.events[0]; assert.ok(event);
		if (replace) fixture.replace(); else fixture.fire("session_shutdown");
		const entries = fixture.manager.getEntries(); fixture.refine(event);
		assert.deepEqual(fixture.manager.getEntries(), entries);
		assert.equal(event.signal.aborted, true);
	}
	const manager = SessionManager.inMemory(); const entry = manager.appendSessionInfo("Resumed name");
	manager.appendCustomEntry("session-name:automatic", { sessionId: manager.getSessionId(), nameEntryId: entry, phase: "fallback" });
	const resumed = harness({ manager }); resumed.offer(); resumed.fire("before_agent_start");
	assert.equal(resumed.events.length, 0);
	assert.equal(manager.getSessionName(), "Resumed name");
});

it("keeps duplicate consumers from writing or emitting another fallback", () => {
	const fixture = harness(); fixture.offer(); fixture.offer("Evo direction", "evo"); fixture.fire("before_agent_start");
	assert.equal(fixture.manager.getSessionName(), "Fix the parser");
	assert.equal(receipts(fixture.manager).length, 1);
	assert.equal(fixture.events.length, 0, "a newer offer discards the old unemitted excerpt");
});

it("protects whole-file names across branches, compaction and forked entries", () => {
	const manager = SessionManager.inMemory("/work/example");
	const root = manager.appendMessage({ role: "user", content: "Initial task", timestamp: Date.now() });
	manager.appendSessionInfo("Off-leaf name");
	manager.branch(root);
	manager.appendMessage({ role: "user", content: "Other branch", timestamp: Date.now() });
	manager.appendCompaction("Retained context", root, 100);
	assert.equal(latest(manager)?.name, manager.getSessionName());
	assert.equal(manager.getBranch().some((entry) => entry.type === "session_info"), false);
	const fixture = harness({ manager }); fixture.offer();
	assert.equal(manager.getSessionName(), "Off-leaf name");
	const header = manager.getHeader(); assert.ok(header);
	const fork = SessionManager.inMemory("/work/fork", { parentSession: "synthetic-parent.jsonl" }, [header, ...manager.getEntries()]);
	assert.equal(latest(fork)?.name, fork.getSessionName());
	const forked = harness({ manager: fork }); forked.offer();
	assert.equal(fork.getSessionName(), "Off-leaf name");
});
