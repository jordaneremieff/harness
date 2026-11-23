import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts, plain } from "../../test/load.mts";

class Clock {
	time = 0;
	sequence = 0;
	tasks = new Map<number, { at: number; run: () => void }>();
	set = (run: () => void, delay = 0) => {
		const id = ++this.sequence;
		this.tasks.set(id, { at: this.time + delay, run });
		return id;
	};
	clear = (id: number) => {
		this.tasks.delete(id);
	};
	advance(milliseconds: number) {
		const end = this.time + milliseconds;
		for (let count = 0; count < 100; count++) {
			const next = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) {
				this.time = end;
				return;
			}
			this.time = next[1].at;
			this.tasks.delete(next[0]);
			next[1].run();
		}
		throw new Error("The controlled clock exceeded its task bound.");
	}
}
interface FixtureAPI {
	document(source: string): ReaderDocument;
	render(source: string): ReaderBlock[];
}
function setup(source = "abc\r\n\r\nremote", captured = false) {
	const clock = new Clock();
	const api = scripts(
		[
			"app/host/native.ts",
			"app/core/exact.ts",
			"app/core/source-model.ts",
			"app/core/controller.ts",
			"test/fixtures.ts",
			"test/host-memory.ts",
		],
		{
			setTimeout: clock.set,
			clearTimeout: clock.clear,
			requestAnimationFrame: (run: () => void) => clock.set(run, 16),
			cancelAnimationFrame: clock.clear,
		},
	).reader as ReaderNamespace & { fixtures: FixtureAPI };
	const payload = api.fixtures.document(source);
	payload.meta.capturedSource = captured;
	const host = api.createMemoryHost(payload, api.fixtures.render);
	const controller = api.createController(host, { document: payload, now: () => clock.time });
	const dispose = () => {
		controller.dispose();
		host.dispose();
		assert.equal(clock.tasks.size, 0);
	};
	return { api, clock, payload, host, controller, dispose };
}
function mirror(host: ReaderMemoryHost, controller: ReaderController) {
	assert.deepEqual(Buffer.from(controller.doc?.source ?? ""), Buffer.from(host.source));
	assert.equal(controller.doc?.generation, host.generation);
	assert.deepEqual(Buffer.from(host.recovery().source), Buffer.from(host.source));
	assert.equal(host.recovery().generation, host.generation);
}
function person(controller: ReaderController, start: number, end: number, text: string) {
	const source = controller.doc?.source ?? "";
	return controller.change([{ start, end, text, expected: source.slice(start, end) }]);
}
function agent(
	host: ReaderMemoryHost,
	operationId: string,
	start: number,
	end: number,
	text: string,
	threadId?: string,
) {
	assert.equal(
		host.emit("agentApply", {
			operationId,
			baseGeneration: host.generation,
			...(threadId !== undefined ? { threadId } : {}),
			edits: [{ start, end, text, expected: host.source.slice(start, end) }],
		}),
		true,
	);
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve = (_value: T): void => {
		throw new Error("Uninitialised deferred promise.");
	};
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

test("person, interleaved agent and scoped history keep the validated mirror byte-exact through recovery", () => {
	const { clock, api, host, controller: c, dispose } = setup();
	c.setLock("writing");
	c.activate(c.blocks[0].key);
	assert.equal(person(c, 1, 1, "x").status, "ok");
	mirror(host, c);
	agent(host, "remote", 8, 14, "REMOTE");
	mirror(host, c);
	clock.advance(20);
	assert.equal(person(c, 2, 2, "y").status, "ok");
	const typed = host.source;
	assert.equal(c.undo()?.operations?.length, 2);
	assert.equal(host.source, "abc\r\n\r\nREMOTE");
	mirror(host, c);
	assert.equal(c.redo()?.status, "ok");
	assert.equal(host.source, typed);
	mirror(host, c);
	c.activate(null);
	assert.equal(c.undoAgent("remote")?.status, "ok");
	assert.equal(host.source, "axybc\r\n\r\nremote");
	mirror(host, c);
	const restored = { ...host.recovery(), blocks: api.fixtures.render(host.source) };
	assert.equal(host.emit("document", restored), true);
	mirror(host, c);
	assert.equal(c.doc?.records.length, 0);
	dispose();
});

test("wrong base or expected text never changes the page or mirror; a host refusal reloads the retained source", () => {
	const { host, controller: c, dispose } = setup();
	c.setLock("writing");
	const before = host.source;
	assert.throws(() => c.change([{ start: 0, end: 1, text: "A", expected: "z" }]), /Expected text/);
	assert.equal(
		host.emit("agentApply", {
			operationId: "stale",
			baseGeneration: 9,
			edits: [{ start: 0, end: 1, text: "A", expected: "a" }],
		}),
		true,
	);
	assert.equal(
		host.emit("agentApply", {
			operationId: "wrong",
			baseGeneration: 0,
			edits: [{ start: 0, end: 1, text: "A", expected: "z" }],
		}),
		true,
	);
	assert.deepEqual(
		plain(host.sent.filter((message) => message.type === "agentRefused").map((message) => message.reason)),
		["stale", "stale"],
	);
	assert.equal(c.doc?.records.length, 0);
	assert.equal(host.source, before);
	mirror(host, c);
	for (const [base, expected] of [
		[9, "a"],
		[0, "z"],
	] as const) {
		host.send("edits", {
			presentation: host.document.presentation,
			baseGeneration: base,
			generation: base + 1,
			origin: "person",
			edits: [{ start: 0, end: 1, text: "A", expected }],
		});
		assert.equal(host.source, before);
		mirror(host, c);
	}
	assert.equal(host.inbound.filter((message) => message.type === "refused").length, 2);
	dispose();
});

test("the whole open block stays held without focus or a time limit and claims raise the release action", () => {
	const { host, clock, controller: c, dispose } = setup();
	const notices: ReaderNotice[] = [];
	c.on("notice", (notice) => notices.push(notice));
	c.setLock("writing");
	c.activate(c.blocks[0].key);
	assert.ok(c.doc);
	c.doc.caretPresent = false;
	clock.advance(1000000);
	agent(host, "held", 1, 2, "!");
	assert.equal(host.source, "abc\r\n\r\nremote");
	assert.equal(host.sent.at(-1)?.type, "agentRefused");
	assert.equal(host.sent.at(-1)?.reason, "held");
	assert.deepEqual(plain(host.sent.at(-1)?.range), { start: 0, end: 3 });
	assert.equal(
		host.emit("claim", { claimId: "claim-held", ranges: [{ start: 0, end: 3 }], expiresAt: clock.time + 90000 }),
		true,
	);
	assert.equal(c.claims.size, 0);
	assert.equal(notices.length, 2);
	assert.ok(notices.every((notice) => notice.actions?.[0]?.id === "releaseHold"));
	c.activate(null);
	agent(host, "released", 1, 2, "!");
	assert.equal(host.source, "a!c\r\n\r\nremote");
	mirror(host, c);
	dispose();
});

function nativeController() {
	const clock = new Clock();
	const field = new EventTarget();
	const api = scripts(
		[
			"app/host/native.ts",
			"app/core/exact.ts",
			"app/core/source-model.ts",
			"app/core/controller.ts",
			"test/fixtures.ts",
		],
		{ document: field, setTimeout: clock.set, clearTimeout: clock.clear },
	).reader as ReaderNamespace & { fixtures: FixtureAPI };
	const sent: ReaderHostMessage[] = [];
	const host = api.createNativeHost((m) => {
		sent.push(m);
	});
	const c = api.createController(host, { now: () => clock.time });
	return { clock, field, api, sent, host, c };
}

test("the native entry refuses replacements until marked text and each submitted edit settle", () => {
	const { clock, field, api, sent, host, c } = nativeController();
	const first = { ...api.fixtures.document("abc"), v: 1, type: "document" },
		second = { ...api.fixtures.document("next"), v: 1, type: "document", chrome: "window" };
	assert.equal(host.receive(first), true);
	let installed = 0;
	c.on("document", () => installed++);
	field.dispatchEvent(new Event("compositionstart"));
	clock.advance(100);
	assert.equal(sent.at(-1)?.editingPending, true);
	assert.equal(c.compositionTarget, field);
	assert.equal(host.receive(second), false);
	assert.equal(c.doc?.source, "abc");
	c.setLock("writing");
	person(c, 0, 1, "A");
	person(c, 1, 2, "B");
	field.dispatchEvent(new Event("compositionend"));
	assert.equal(c.compositionTarget, null);
	assert.equal(host.receive(second), false);
	const ack = {
		v: 1,
		type: "ack",
		presentation: first.presentation,
		generation: 1,
		digest: "one",
		recovery: "retained",
	};
	assert.equal(host.receive(ack), true);
	assert.equal(host.receive(ack), true);
	assert.equal(host.receive({ ...ack, presentation: second.presentation, generation: 2 }), true);
	assert.equal(host.receive(second), false);
	assert.equal(c.doc?.source, "ABc");
	assert.equal(host.capabilities.windowChrome, "pane");
	assert.equal(installed, 0);
	assert.equal(
		host.receive({
			v: 1,
			type: "refused",
			presentation: first.presentation,
			generation: 2,
			reason: "mismatched source",
		}),
		true,
	);
	clock.advance(100);
	assert.equal(sent.findLast((m) => m.type === "state")?.editingPending, false);
	assert.equal(host.receive(second), true);
	assert.equal(c.doc?.source, "next");
	assert.equal(host.capabilities.windowChrome, "window");
	assert.equal(installed, 1);
	c.dispose();
	host.dispose();
});

test("Save As changes only the destination, even during composition and outstanding edits", () => {
	const { clock, field, api, sent, host, c } = nativeController();
	const first = { ...api.fixtures.document("abc"), v: 1, type: "document" };
	const meta = { ...first.meta, title: "New file", kind: "localFile", documentKey: "new-file" };
	const change = {
		v: 1,
		type: "documentMetadata",
		presentation: first.presentation,
		previousDocumentKey: first.meta.documentKey,
		meta,
	};
	assert.equal(host.receive(change), false);
	assert.equal(host.receive(first), true);
	c.setLock("writing");
	c.activate(c.blocks[0].key);
	person(c, 0, 1, "A");
	const doc = c.doc,
		active = doc?.active,
		history = doc?.records[0];
	field.dispatchEvent(new Event("compositionstart"));
	let installs = 0;
	const events: string[] = [];
	c.on("document", () => installs++);
	c.on("documentMetadata", (m) => {
		assert.equal(c.payload?.meta.documentKey, m.meta.documentKey);
		events.push(`${m.previousDocumentKey}:${m.meta.documentKey}`);
	});
	for (const patch of [{ presentation: "old" }, { previousDocumentKey: "wrong" }, { meta: { ...meta, digest: null } }])
		assert.equal(host.receive({ ...change, ...patch }), false);
	assert.equal(c.payload?.meta.documentKey, first.meta.documentKey);
	assert.equal(host.receive(change), true);
	assert.equal(host.receive({ ...change, meta: { ...meta, title: "stale duplicate" } }), true);
	assert.equal(c.payload?.meta.title, "New file");
	assert.equal(c.compositionTarget, field);
	assert.equal(c.doc, doc);
	assert.equal(c.doc?.active, active);
	assert.equal(c.doc?.records[0], history);
	assert.equal(c.doc?.source, "Abc");
	field.dispatchEvent(new Event("compositionend"));
	clock.advance(100);
	assert.equal(sent.findLast((m) => m.type === "state")?.editingPending, true);
	const ack = {
		v: 1,
		type: "ack",
		presentation: first.presentation,
		generation: 1,
		digest: "edited",
		recovery: "retained",
		meta: first.meta,
	};
	const receipts: unknown[] = [];
	c.on("ack", (m) => receipts.push([m.generation, m.meta]));
	assert.equal(host.receive(ack), false);
	assert.deepEqual(receipts, [[1, undefined]]);
	clock.advance(100);
	assert.equal(sent.findLast((m) => m.type === "state")?.editingPending, false);
	assert.equal(c.payload?.meta.documentKey, "new-file");
	const moved = { ...change, previousDocumentKey: "new-file", meta: { ...meta, documentKey: "second-file" } };
	assert.equal(host.receive(moved), true);
	assert.equal(host.receive(change), false);
	assert.equal(c.payload?.meta.documentKey, "second-file");
	assert.equal(installs, 0);
	assert.deepEqual(events, [`${first.meta.documentKey}:new-file`, "new-file:second-file"]);
	c.dispose();
	host.dispose();
});

test("a current save updates the shown publication revision; a stale save has no effect", () => {
	const { host, payload, api, controller: c, dispose } = setup();
	const states: string[] = [];
	c.on("saveState", (msg) => states.push(msg.state));
	host.emit("saveState", { state: "saved", presentation: payload.presentation, revision: 4 });
	assert.equal(c.payload?.meta.revision, 4);
	const next = api.fixtures.document("New revision");
	next.meta.revision = 5;
	host.emit("document", next);
	host.emit("saveState", { state: "conflict", presentation: payload.presentation, revision: 4 });
	assert.equal(c.payload?.meta.revision, 5);
	assert.deepEqual(states, ["saved"]);
	next.meta.kind = "draft";
	next.meta.revision = null;
	host.emit("document", next);
	host.emit("saveState", { state: "retrying", presentation: next.presentation, revision: 6 });
	assert.equal(c.payload?.meta.revision, null);
	assert.deepEqual(states, ["saved", "retrying"]);
	dispose();
});

test("late acknowledgements and refusals do not reach a replacement at the same generation", () => {
	const { api, host, controller: c, dispose } = setup();
	const before = host.document,
		after = api.fixtures.document("replacement");
	after.meta.documentKey = "replacement-key";
	assert.equal(host.emit("document", after), true);
	const events: string[] = [];
	for (const type of ["ack", "refused", "error"] as const) c.on(type, () => events.push(type));
	for (const generation of [after.generation, after.generation + 1]) {
		assert.equal(
			host.emit("ack", {
				presentation: before.presentation,
				generation,
				digest: "copy",
				recovery: "retained",
				meta: before.meta,
			}),
			true,
		);
	}
	assert.equal(host.emit("refused", { presentation: before.presentation, generation: 0, reason: "stale" }), true);
	assert.deepEqual(events, []);
	assert.equal(c.payload?.meta.documentKey, after.meta.documentKey);
	assert.equal(host.emit("refused", { presentation: after.presentation, generation: 0, reason: "conflict" }), true);
	assert.deepEqual(events, ["refused"]);
	dispose();
});

test("each edit names its installed presentation and a copy acknowledgement retains the logical key", () => {
	const { api, host, controller: c, dispose } = setup();
	const next = api.fixtures.document("abc");
	assert.notEqual(c.payload?.presentation, next.presentation);
	assert.equal(host.emit("document", next), true);
	c.setLock("writing");
	person(c, 0, 1, "A");
	assert.equal(host.sent.findLast((m) => m.type === "edits")?.presentation, next.presentation);
	const { documentKey, ...copy } = next.meta;
	assert.equal(
		host.emit("ack", {
			presentation: next.presentation,
			generation: 1,
			digest: "copy",
			recovery: "retained",
			meta: { ...copy, documentId: "copy" },
		}),
		true,
	);
	assert.equal(c.payload?.meta.documentId, "copy");
	assert.equal(c.payload?.meta.documentKey, documentKey);
	assert.equal(c.payload?.presentation, next.presentation);
	dispose();
});

test("a captured source gets its copy only on the first edit and the original stays unchanged", () => {
	const { payload, host, controller: c, dispose } = setup("a\r\nb", true);
	assert.equal(c.lock, "reading");
	c.setLock("writing");
	assert.equal(Boolean(host.draft), false);
	assert.equal(host.document.meta.capturedSource, true);
	assert.equal(person(c, 0, 1, "A").status, "ok");
	const copyId = host.document.meta.documentId;
	assert.equal(host.draft?.source, "A\r\nb");
	assert.equal(c.payload?.meta.capturedSource, false);
	assert.equal(c.payload?.meta.copyOf, "fixture");
	assert.notEqual(c.payload?.meta.documentKey, payload.meta.documentKey);
	assert.equal(c.payload?.meta.documentKey, host.document.meta.documentKey);
	assert.equal(c.payload?.presentation, payload.presentation);
	assert.equal(person(c, 3, 4, "B").status, "ok");
	assert.equal(host.document.meta.documentId, copyId);
	assert.equal(c.undo()?.status, "ok");
	assert.equal(c.undo()?.status, "ok");
	assert.equal(host.source, "a\r\nb");
	assert.equal(host.document.meta.capturedSource, false);
	assert.equal(host.mirror.originalSource, "a\r\nb");
	assert.equal(payload.source, "a\r\nb");
	assert.equal(payload.meta.capturedSource, true);
	mirror(host, c);
	dispose();
});

test("settings patches preserve history and never echo to the host", () => {
	const { host, controller: c, dispose } = setup();
	c.setLock("writing");
	person(c, 0, 1, "A");
	const doc = c.doc,
		records = JSON.stringify(c.doc?.records),
		sent = host.sent.length;
	let settings: Record<string, unknown> = {};
	c.on("settings", (patch) => {
		settings = patch;
	});
	assert.equal(
		host.emit("command", { name: "applySettings", args: { textSize: 1.2, codeWrap: false, appearance: "dark" } }),
		true,
	);
	assert.deepEqual(plain(settings), { textSize: 1.2, codeWrap: false, appearance: "dark" });
	assert.deepEqual(plain(c.payload?.settings.textSizeSteps), [0.8, 0.9, 1, 1.1, 1.2, 1.4]);
	assert.equal(c.payload?.settings.appearance, "dark");
	assert.equal(c.doc, doc);
	assert.equal(JSON.stringify(c.doc?.records), records);
	assert.equal(host.sent.length, sent);
	assert.equal(c.undo()?.status, "ok");
	mirror(host, c);
	dispose();
});

test("next history describes the current block and retains the agent operation ID across redo", () => {
	const { host, controller: c, dispose } = setup();
	c.setLock("writing");
	c.activate(c.blocks[0].key);
	person(c, 1, 1, "x");
	agent(host, "remote", 8, 14, "REMOTE");
	assert.deepEqual(plain(c.nextHistory()), { undo: { origin: "person", blockStart: 0 }, redo: null });
	c.undo();
	assert.deepEqual(plain(c.nextHistory()), { undo: null, redo: { origin: "person", blockStart: 0 } });
	c.activate(null);
	assert.deepEqual(plain(c.nextHistory().undo), { origin: "agent", blockStart: 7, operationId: "remote" });
	c.undo();
	assert.deepEqual(plain(c.nextHistory().redo), { origin: "agent", blockStart: 7, operationId: "remote" });
	c.redo();
	assert.deepEqual(plain(c.nextHistory().undo), { origin: "agent", blockStart: 7, operationId: "remote" });
	mirror(host, c);
	dispose();
});

test("agent traces retain old/new text, optional thread identity, unread state and current ranges", () => {
	const { host, controller: c, dispose } = setup();
	const changes: ReaderCoreChange[] = [];
	c.on("agentChange", (change) => changes.push(change));
	agent(host, "one", 7, 13, "REMOTE!", "thread-one");
	const operation = c.agentOperations.get("one");
	assert.ok(operation);
	assert.equal(operation.threadId, "thread-one");
	assert.equal(changes[0].threadId, "thread-one");
	assert.equal(operation.unread, true);
	assert.deepEqual(plain(operation.edits), [{ oldText: "remote", newText: "REMOTE!", start: 7, end: 14 }]);
	c.markRead("one");
	assert.equal(operation.unread, false);
	c.setLock("writing");
	person(c, 0, 0, "PRE");
	assert.deepEqual(plain(operation.edits), [{ oldText: "remote", newText: "REMOTE!", start: 10, end: 17 }]);
	person(c, 10, 10, "x");
	assert.equal(operation.edits[0].start, 11);
	assert.equal(operation.edits[0].end, 18);
	assert.equal(operation.conflicted, false);
	person(c, 12, 13, "?");
	assert.equal(operation.conflicted, true);
	agent(host, "two", 3, 4, "A");
	assert.equal(Object.hasOwn(changes[1], "threadId"), false);
	assert.equal(Object.hasOwn(c.agentOperations.get("two") ?? {}, "threadId"), false);
	assert.equal(c.agentOperations.get("two")?.unread, true);
	mirror(host, c);
	dispose();
});

test("state publication sends only the bridge contract's fields", () => {
	const { host, clock, controller: c, dispose } = setup();
	const states = () => host.sent.filter((message) => message.type === "state");
	c.state({
		localOnly: true,
		hasSelection: true,
		selection: { text: "a", start: 0, end: 1, anchor: 0, focus: 1 },
		scroll: { blockStart: 0, offsetY: 4, scrollTop: 90 },
	});
	clock.advance(100);
	const sent = plain(states().at(-1)) as Record<string, unknown>;
	assert.equal(Object.hasOwn(sent, "localOnly"), false);
	assert.deepEqual(sent.selection, { text: "a", start: 0, end: 1 });
	assert.deepEqual(sent.scroll, { blockStart: 0, offsetY: 4 });
	for (const key of Object.keys(sent).filter((name) => !["v", "type", "id"].includes(name)))
		assert.ok(
			[
				"lock",
				"overlay",
				"editingPending",
				"canUndo",
				"canRedo",
				"canBack",
				"canForward",
				"hasSelection",
				"findOpen",
				"held",
				"activeBlock",
				"scroll",
				"find",
				"selection",
			].includes(key),
			key,
		);
	dispose();
});

test("a large selection preserves its range and leaves state publication live", () => {
	const { api, host, clock, controller: c, dispose } = setup();
	const prefix = '"'.repeat(16_383);
	const text = `${prefix}😀${"\u0001".repeat(256 * 1024)}`;
	const selection = { start: 0, end: text.length, text };
	const state = () => {
		const message = host.sent.findLast((message) => message.type === "state");
		assert.ok(message);
		return message;
	};
	c.state({ hasSelection: true, selection });
	clock.advance(100);
	assert.doesNotThrow(() => api.bridge.page(state()));
	const wire = state().selection as typeof selection;
	assert.equal(wire.start, 0);
	assert.equal(wire.end, text.length);
	assert.equal(wire.text, `${prefix}😀`);
	assert.ok(Buffer.byteLength(wire.text) > 8192, "native annotation must still refuse an oversized quote");
	assert.equal(selection.text, text);
	c.state({ scroll: { blockStart: 0, offsetY: 20 } });
	clock.advance(100);
	assert.equal((state().scroll as { offsetY: number }).offsetY, 20);
	dispose();
});

test("state publication coalesces patches at 100 ms and omits absent held and active ranges", () => {
	const { api, host, clock, controller: c, dispose } = setup();
	const states = () => host.sent.filter((message) => message.type === "state");
	assert.equal(states().length, 1);
	c.setLock("writing");
	c.activate(c.blocks[0].key);
	c.state({ hasSelection: true, selection: { start: 0, end: 1, text: "a" } });
	c.state({ findOpen: true, find: { query: "a", count: 1, index: 0 } });
	clock.advance(99);
	assert.equal(states().length, 1);
	clock.advance(1);
	assert.equal(states().length, 2);
	assert.deepEqual(plain(states()[1].held), { start: 0, end: 3 });
	assert.deepEqual(plain(states()[1].activeBlock), { start: 0, end: 3 });
	assert.equal(states()[1].hasSelection, true);
	assert.equal(states()[1].findOpen, true);
	c.activate(null);
	c.state({ hasSelection: false, selection: undefined, findOpen: false, find: undefined });
	clock.advance(100);
	assert.equal(states().length, 3);
	assert.equal(Object.hasOwn(states()[2], "held"), false);
	assert.equal(Object.hasOwn(states()[2], "activeBlock"), false);
	for (const state of states()) assert.doesNotThrow(() => api.bridge.page(state));
	dispose();
});

test("a stale render reply never replaces newer mapped blocks and the next render uses the current generation", async () => {
	const { api, host, clock, controller: c, dispose } = setup();
	const first = deferred<Record<string, unknown>>();
	let requests = 0;
	host.respond("render", () => {
		requests++;
		return requests === 1 ? first.promise : { generation: host.generation, blocks: api.fixtures.render(host.source) };
	});
	c.setLock("writing");
	person(c, 0, 1, "A");
	clock.advance(16);
	assert.equal(requests, 1);
	person(c, 1, 2, "B");
	const current = JSON.stringify(c.blocks);
	first.resolve({ generation: 1, blocks: api.fixtures.render("STALE") });
	await turn();
	assert.equal(JSON.stringify(c.blocks), current);
	clock.advance(16);
	await turn();
	assert.equal(requests, 2);
	assert.deepEqual(plain(c.blocks), plain(api.fixtures.render(host.source)));
	mirror(host, c);
	dispose();
});

test("document replacement drops an old render and detaches the old document listener", async () => {
	const { api, host, clock, controller: c, dispose } = setup();
	const first = deferred<Record<string, unknown>>();
	host.respond("render", () => first.promise);
	c.setLock("writing");
	person(c, 0, 1, "A");
	clock.advance(16);
	const old = c.doc;
	const replacement = api.fixtures.document("new document");
	replacement.generation = 1;
	assert.equal(host.emit("document", replacement), true);
	const current = JSON.stringify(c.blocks);
	first.resolve({ generation: 1, blocks: api.fixtures.render("OLD") });
	await turn();
	assert.equal(JSON.stringify(c.blocks), current);
	assert.equal(c.doc?.source, "new document");
	const sent = host.sent.length;
	old?.apply([{ start: 0, end: 1, text: "x", expected: "A" }], "person");
	assert.equal(host.sent.length, sent);
	mirror(host, c);
	dispose();
});

test("image edits enter person history only after a matching staged reply", async () => {
	const { host, controller: c, dispose } = setup("a\r\nb", true);
	assert.equal(await c.pickImage({ start: 0, end: 0 }), false);
	c.setLock("writing");
	host.respond("command", () => ({
		generation: 0,
		edits: [{ start: 0, end: 0, text: "![image](asset)", expected: "" }],
	}));
	assert.equal(await c.pickImage({ start: 0, end: 0 }), true);
	assert.equal(host.source, "![image](asset)a\r\nb");
	assert.equal(c.doc?.records[0].origin, "person");
	assert.equal(host.draft?.source, host.source);
	assert.equal(c.undo()?.status, "ok");
	assert.equal(host.source, "a\r\nb");
	assert.equal(host.mirror.originalSource, "a\r\nb");
	mirror(host, c);
	dispose();
});
for (const race of ["edit", "document"] as const) {
	test(`a staged image reply is dropped after an intervening ${race}`, async () => {
		const { api, host, controller: c, dispose } = setup();
		const reply = deferred<Record<string, unknown>>();
		host.respond("command", () => reply.promise);
		const notices: ReaderNotice[] = [];
		c.on("notice", (notice) => notices.push(notice));
		c.setLock("writing");
		const pending = c.pickImage({ start: 0, end: 0 });
		if (race === "edit") person(c, 0, 1, "A");
		else assert.equal(host.emit("document", api.fixtures.document("new document")), true);
		const source = host.source,
			generation = host.generation;
		reply.resolve({ generation: 0, edits: [{ start: 0, end: 0, text: "![image](asset)", expected: "" }] });
		assert.equal(await pending, false);
		assert.equal(host.source, source);
		assert.equal(host.generation, generation);
		assert.equal(notices.length, 1);
		mirror(host, c);
		dispose();
	});
}

test("empty native blocks expose a zero-length editable block through insert, undo and render", async () => {
	const { host, clock, controller: c, dispose } = setup("");
	assert.equal(host.document.blocks.length, 0);
	assert.equal(c.blocks.length, 1);
	assert.equal(c.blocks[0].start, 0);
	assert.equal(c.blocks[0].end, 0);
	c.setLock("writing");
	c.activate(c.blocks[0].key);
	agent(host, "held-empty", 0, 0, "agent");
	assert.equal(host.source, "");
	assert.equal(person(c, 0, 0, "draft\r\n").status, "ok");
	assert.equal(c.blocks[0].end, 7);
	mirror(host, c);
	assert.equal(c.undo()?.status, "ok");
	assert.equal(host.source, "");
	clock.advance(16);
	await turn();
	assert.equal(c.blocks.length, 1);
	assert.equal(c.blocks[0].start, 0);
	assert.equal(c.blocks[0].end, 0);
	mirror(host, c);
	assert.equal(c.redo()?.status, "ok");
	assert.equal(host.source, "draft\r\n");
	assert.equal(c.blocks[0].start, 0);
	assert.equal(c.blocks[0].end, 7);
	mirror(host, c);
	dispose();
});
