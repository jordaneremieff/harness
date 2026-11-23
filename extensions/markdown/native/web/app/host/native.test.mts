import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts } from "../../test/load.mts";
function bridge() {
	return scripts(["app/host/native.ts"]).reader as ReaderNamespace;
}
test("classic host sends exact versioned envelopes and matches reply IDs", async () => {
	const api = bridge();
	const host = api.createNativeHost((m) => ({ v: 1, type: "reply", id: m.id, ok: true, generation: 0, blocks: [] }));
	const reply = (await host.request("render", { generation: 0 })) as Record<string, unknown>;
	assert.equal(reply.generation, 0);
	host.dispose();
});
test("unknown version, type and command refuse without dispatch", () => {
	const api = bridge(),
		host = api.createNativeHost(() => undefined);
	let count = 0;
	host.on("command", () => count++);
	assert.equal(api.receive({ v: 2, type: "command", name: "undo" }), false);
	assert.equal(api.receive({ v: 1, type: "invented" }), false);
	for (const type of ["toString", "constructor", "__proto__"]) {
		assert.equal(api.receive({ v: 1, type }), false);
		assert.throws(() => api.bridge.page({ v: 1, type }));
	}
	assert.equal(api.receive({ v: 1, type: "command", name: "invented" }), false);
	assert.equal(count, 0);
	host.dispose();
});
test("malformed and mismatched replies reject requests", async () => {
	const api = bridge(),
		host = api.createNativeHost(() => ({ v: 1, type: "reply", id: "wrong", ok: true }));
	await assert.rejects(host.request("render", { generation: 0 }), /Unexpected reader reply/);
	host.dispose();
});
test("disposal rejects pending requests", async () => {
	const api = bridge(),
		host = api.createNativeHost(() => new Promise(() => {}));
	const pending = host.request("render", { generation: 0 });
	host.dispose();
	await assert.rejects(pending, /disposed/);
});
test("ready and format use the current command vocabulary", () => {
	const api = bridge();
	assert.equal(api.bridge.page({ v: 1, type: "ready", version: "reader", capabilities: { lock: true } }).v, 1);
	assert.equal(
		api.bridge.native({ v: 1, type: "command", name: "format", args: { command: "heading", level: 2 } }).type,
		"command",
	);
	assert.throws(() =>
		api.bridge.native({ v: 1, type: "command", name: "format", args: { command: "heading", level: 7 } }),
	);
});
test("the page sends a batch as one prompt and refuses mixed or invalid shapes", async () => {
	const api = bridge(),
		calls: unknown[] = [];
	const host = api.createNativeHost((m) => {
		calls.push(m);
		return { v: 1, type: "reply", id: m.id, ok: true, accepted: false, detail: "Batch too long." };
	});
	const header = {
		documentKey: "document",
		presentation: "view",
		requestId: "request",
		threadId: "thread",
		generation: 1,
	};
	const annotations = [
		{ text: "Change this.", quote: "😀\n", quoteRange: { start: 0, end: 3 } },
		{ text: "Reduce repetition." },
	];
	const receipt = (await host.request("prompt", { ...header, annotations })) as { accepted: boolean; detail: string };
	assert.equal(receipt.accepted, false);
	assert.equal(receipt.detail, "Batch too long.");
	assert.equal((calls[0] as { annotations: unknown }).annotations, annotations);
	await host.request("prompt", { ...header, annotations, overall: "Keep the tone direct." });
	assert.equal((calls[1] as { overall: unknown }).overall, "Keep the tone direct.");
	for (const fields of [
		{ annotations, overall: " \n" },
		{ annotations, overall: "\u0085" },
		{ annotations, overall: "x".repeat(64 * 1024 + 1) },
		{ annotations, overall: 3 },
		{ text: "A single comment.", overall: "Only batches carry one." },
		{ annotations: [] },
		{ annotations, text: "Mixed" },
		{ annotations: [{ text: " \n" }] },
		{ annotations: Array.from({ length: 51 }, () => annotations[0]) },
		{ annotations: [{ text: "Change this.", quoteRange: { start: 4, end: 1 } }] },
	]) {
		await assert.rejects(host.request("prompt", { ...header, ...fields }));
	}
	assert.equal(calls.length, 2);
	host.dispose();
});
test("authored revisions belong to individual comments and the optional overall comment", () => {
	const { page } = bridge().bridge;
	const header = {
		v: 1,
		type: "prompt",
		requestId: "r",
		threadId: "t",
		documentKey: "d",
		presentation: "p",
		generation: 4,
	};
	const single = { ...header, text: "Review this.", authoredRevision: 3 };
	assert.equal(page(single).authoredRevision, 3);
	const annotations = [
		{ text: "One", authoredRevision: 1 },
		{ text: "Two", authoredRevision: 2 },
	];
	assert.equal(page({ ...header, annotations, overall: "Summarise.", authoredRevision: 3 }).authoredRevision, 3);
	assert.throws(() => page({ ...header, annotations, authoredRevision: 3 }));
	for (const value of [0, -1, 1.5, "3"]) {
		assert.throws(() => page({ ...single, authoredRevision: value }));
		assert.throws(() => page({ ...header, annotations: [{ text: "One", authoredRevision: value }] }));
		assert.throws(() => page({ ...header, annotations, overall: "Summarise.", authoredRevision: value }));
	}
});
test("connection state belongs to the pane and save state requires a presentation", () => {
	const { native } = bridge().bridge;
	const connection = { v: 1, type: "connectionState", detail: "Disconnected" };
	assert.equal(native(connection).detail, "Disconnected");
	assert.throws(() => native({ ...connection, detail: "" }));
	const save = { v: 1, type: "saveState", state: "saved", presentation: "p", revision: 5 };
	assert.equal(native(save).revision, 5);
	assert.throws(() => native({ ...save, presentation: undefined }));
	assert.throws(() => native({ ...save, revision: 0 }));
});
test("a long Ask reply reaches its thread with its final paragraph intact", () => {
	const api = bridge(),
		host = api.createNativeHost(() => undefined);
	const detail = `${"A paragraph for this document.\n\n".repeat(1000)}Last paragraph.`;
	let received: unknown;
	host.on("promptState", (message) => {
		received = (message as { detail: string }).detail;
	});
	assert.equal(
		api.receive({ v: 1, type: "promptState", requestId: "question", threadId: "thread", state: "answered", detail }),
		true,
	);
	assert.equal(received, detail);
	host.dispose();
});
test("the copy command accepts text as its only argument", () => {
	const api = bridge();
	const copy = { v: 1, type: "command", name: "copy", args: { text: "" } };
	assert.equal(api.bridge.page(copy).type, "command");
	assert.throws(() => api.bridge.page({ ...copy, args: { text: "exact", markdown: "unused" } }));
});
test("only the private draft command and its matching query reply accept a 4 MiB recovery group", () => {
	const { page, reply } = bridge().bridge;
	const documentKey = "doc",
		query = { kind: "reviewDraft", documentKey },
		set = { v: 1, type: "command", name: "setReviewDraft" },
		header = { v: 1, type: "reply", id: "q", ok: true };
	const comments = Array.from({ length: 64 }, () => ({ text: "x".repeat(65536) }));
	const draft = { comments, overall: "", parked: [{ text: "saved direction", index: -1, authoredRevision: 2 }] };
	const excess = Buffer.byteLength(JSON.stringify(draft)) - 4 * 1024 * 1024;
	comments[0].text = comments[0].text.slice(excess);
	const args = { documentKey, expectedVersion: 0, draft };
	const snapshot = { ...header, available: true, version: 1, draft };
	assert.equal(page({ ...set, args }).type, "command");
	assert.equal(reply(snapshot, "q", "query", query).version, 1);
	assert.throws(() => reply(snapshot, "q", "query", { kind: "details" }), /byte limit/);
	assert.throws(() => reply({ ...snapshot, ok: false }, "q", "query", query), /byte limit/);
	assert.throws(() => page({ ...set, name: "copy", args }), /byte limit/);
	assert.throws(() => page({ ...set, args, padding: "x".repeat(256 * 1024) }), /byte limit/);
	comments[0].text += "x";
	assert.throws(() => page({ ...set, args }), /byte limit/);
	assert.throws(() => reply(snapshot, "q", "query", query), /byte limit/);
	assert.equal(reply({ ...header, available: false, version: 0 }, "q", "query", query).available, false);
	assert.throws(() => reply({ ...header, available: false, version: 1 }, "q", "query", query));
	const clear = { ...set, args: { documentKey, expectedVersion: 3 } };
	assert.equal(page(clear).name, "setReviewDraft");
	assert.equal(reply({ ...header, status: "stored", version: 4 }, "q", "command", clear).status, "stored");
	assert.throws(() => reply({ ...header, status: "stored", version: 3 }, "q", "command", clear));
});
test("the recovery boundary refuses thread state and validates passage evidence before either direction", () => {
	const { page, reply } = bridge().bridge;
	const proof = {
		text: "**hi**",
		contexts: [{ before: "In ", after: "" }],
		headings: ["A"],
		rendered: { before: "", text: "hi", after: "." },
	};
	const item = {
		text: "explain",
		quote: "hi",
		sourceAnchor: proof,
		range: { start: 0, end: 6 },
		anchorDigest: `sha256:${"0".repeat(64)}`,
		authoredRevision: 1,
	};
	const draft = { comments: [item], overall: "reader notes", parked: [{ comment: item, text: item.text, index: 0 }] };
	const command = (draft: unknown) =>
		page({ v: 1, type: "command", name: "setReviewDraft", args: { documentKey: "doc", expectedVersion: 1, draft } });
	const snapshot = (draft: unknown) =>
		reply({ v: 1, type: "reply", id: "q", ok: true, available: true, version: 2, draft }, "q", "query", {
			kind: "reviewDraft",
		});
	command(draft);
	snapshot(draft);
	for (const bad of [
		{ ...draft, threadId: "private" },
		{ ...draft, comments: [{ ...item, requestId: "private" }] },
		{ ...draft, comments: [{ ...item, sourceAnchor: { ...proof, token: "private" } }] },
		{ ...draft, comments: [{ ...item, sourceAnchor: { ...proof, contexts: [{ before: " ", after: "" }] } }] },
		{
			...draft,
			comments: [{ ...item, sourceAnchor: { ...proof, rendered: { before: "", text: "else", after: "" } } }],
		},
		{ ...draft, comments: [{ ...item, range: { start: 0, end: 6, html: "unbound" } }] },
		{ ...draft, parked: [{ comment: item, text: "other", index: 0 }] },
		{ ...draft, comments: Array.from({ length: 513 }, () => ({ text: "x" })) },
		{ ...draft, parked: [{ index: -1, text: "a", authoredRevision: false }] },
	]) {
		assert.throws(() => command(bad));
		assert.throws(() => snapshot(bad));
	}
	const prompt = {
		v: 1,
		type: "prompt",
		documentKey: "doc",
		presentation: "shown",
		generation: 0,
		requestId: "r",
		threadId: "t",
		text: item.text,
		quote: item.quote,
		quoteRange: item.range,
		passageAnchor: proof,
	};
	assert.equal(page(prompt).type, "prompt");
	assert.throws(() => page({ ...prompt, passageAnchor: { ...proof, token: "private" } }));
	const threadId = "92ad1af3-be1a-4585-bdef-64926112c3bc";
	const row = {
		threadId,
		commentId: `${threadId}:0`,
		kind: "question",
		ordinal: 0,
		text: item.text,
		commentState: "closed",
		version: 2,
		quote: item.quote,
		sourceAnchor: proof.text,
		start: 0,
		end: 6,
	};
	const retained = (passageAnchor: unknown) =>
		reply(
			{ v: 1, type: "reply", id: "q", ok: true, available: true, revision: 2, comments: [{ ...row, passageAnchor }] },
			"q",
			"query",
			{ kind: "reviewComments" },
		);
	assert.equal(retained(proof).revision, 2);
	assert.throws(() => retained({ ...proof, text: "**no**" }));
});
test("ordinary messages enforce their exact byte bound", () => {
	const api = bridge(),
		base = { v: 1, type: "command", name: "copy", args: { text: "" } };
	const overhead = Buffer.byteLength(JSON.stringify(base));
	base.args.text = "a".repeat(256 * 1024 - overhead);
	assert.equal(api.bridge.page(base).type, "command");
	base.args.text += "a";
	assert.throws(() => api.bridge.page(base), /byte limit/);
});
function documentMessage(source = "") {
	return {
		v: 1,
		type: "document",
		source,
		generation: 0,
		presentation: "view",
		meta: {
			documentKey: "document",
			documentId: "fixture",
			kind: "published",
			title: "Fixture",
			shortId: "fixture",
			revision: 1,
			revisions: [],
			digest: "fixture",
			provenance: {},
			capturedSource: false,
		},
		settings: {
			lock: "reading",
			textSize: 1,
			textSizeSteps: [0.9, 1, 1.1],
			codeWrap: true,
			appearance: "system",
			outlineWidth: 240,
			outlineOpen: true,
		},
		blocks: [] as ReaderBlock[],
		headings: [],
		chrome: "pane",
		live: true,
	};
}
test("a refused document leaves capabilities and installed content untouched", () => {
	const api = bridge(),
		host = api.createNativeHost();
	const candidate = { ...documentMessage("replacement"), chrome: "window" };
	let source = "original";
	host.on("document", (value) => {
		source = (value as ReaderDocument).source;
	});
	assert.equal(api.receive({ ...candidate, presentation: null }), false);
	host.on("beforeDocument", () => false);
	assert.equal(api.receive(candidate), false);
	assert.equal(host.capabilities.windowChrome, "pane");
	assert.equal(source, "original");
	host.dispose();
});
test("the native entry propagates an exception after document installation begins", () => {
	const api = bridge(),
		host = api.createNativeHost();
	const failure = new Error("Document display failed.");
	let source = "original";
	host.on("document", (value) => {
		source = (value as ReaderDocument).source;
	});
	host.on("document", () => {
		throw failure;
	});
	assert.throws(
		() => api.receive({ ...documentMessage("replacement"), chrome: "window" }),
		(error) => error === failure,
	);
	assert.equal(host.capabilities.windowChrome, "window");
	assert.equal(source, "replacement");
	host.dispose();
});
test("documents and page writes require the identity of their source", () => {
	const { native, page } = bridge().bridge;
	const doc = documentMessage();
	assert.throws(() => native({ ...doc, presentation: undefined }));
	assert.throws(() => native({ ...doc, meta: { ...doc.meta, documentKey: undefined } }));
	const prompt = {
		v: 1,
		type: "prompt",
		requestId: "r",
		threadId: "t",
		generation: 0,
		text: "Why?",
		documentKey: doc.meta.documentKey,
		presentation: doc.presentation,
	};
	assert.equal(page(prompt).type, "prompt");
	assert.throws(() => page({ ...prompt, documentKey: undefined }));
	assert.throws(() => page({ ...prompt, presentation: "" }));
	assert.throws(() =>
		page({
			v: 1,
			type: "edits",
			baseGeneration: 0,
			generation: 1,
			origin: "person",
			edits: [{ start: 0, end: 0, expected: "", text: "a" }],
		}),
	);
});
test("a fresh prompt refusal distinguishes a known non-delivery from an uncertain receipt", () => {
	const { reply } = bridge().bridge;
	const response = {
		v: 1,
		type: "reply",
		id: "r",
		ok: true,
		accepted: false,
		fresh: true,
		detail: "The document changed.",
	};
	assert.equal(reply(response, "r", "prompt", {}).fresh, true);
	for (const patch of [
		{ accepted: true },
		{ detail: undefined },
		{ uncertain: true, retryable: true },
		{ fresh: "yes" },
	])
		assert.throws(() => reply({ ...response, ...patch }, "r", "prompt", {}));
});
test("document source uses raw UTF-8 rather than escaped JSON bytes", () => {
	const api = bridge(),
		message = documentMessage("é".repeat(1024 * 1024));
	assert.equal(api.bridge.native(message).type, "document");
	message.source += "é";
	assert.throws(() => api.bridge.native(message), /byte limit/);
	const escaped = documentMessage('"'.repeat(2 * 1024 * 1024));
	assert.equal(api.bridge.native(escaped).type, "document");
});
test("local files without a stored revision and revisions without a creation time are accepted", () => {
	const api = bridge(),
		message = documentMessage("# Local\n");
	Object.assign(message.meta, { kind: "localFile", revision: null });
	assert.equal(api.bridge.native(message).type, "document");
	Object.assign(message.meta, { kind: "published", revision: 2, revisions: [{ n: 2, createdAt: "", current: true }] });
	assert.equal(api.bridge.native(message).type, "document");
	Object.assign(message.meta, { revision: "2" });
	assert.throws(() => api.bridge.native(message));
});
test("document blocks and matching render replies have a separate exact JSON bound", () => {
	const api = bridge(),
		message = documentMessage(),
		block = { key: "b", start: 0, end: 0, type: "paragraph", html: "", map: [] };
	message.blocks = [block];
	const overhead = Buffer.byteLength(JSON.stringify(message.blocks));
	block.html = "a".repeat(16 * 1024 * 1024 - overhead);
	assert.equal(api.bridge.native(message).type, "document");
	assert.equal(
		api.bridge.reply({ v: 1, type: "reply", id: "r", ok: true, generation: 0, blocks: message.blocks }, "r", "render", {
			generation: 0,
		}).generation,
		0,
	);
	assert.throws(
		() => api.bridge.native({ v: 1, type: "renderResult", generation: 0, blocks: message.blocks }),
		/byte limit/,
	);
	block.html += "a";
	assert.throws(() => api.bridge.native(message), /byte limit/);
});
test("review HTML has the large bound only for a matching review request", () => {
	const api = bridge(),
		message = {
			v: 1,
			type: "reply",
			id: "review",
			ok: true,
			summary: {
				base: 1,
				target: 2,
				changedRegions: 0,
				addedLines: 0,
				removedLines: 0,
				assetChanges: 0,
				partial: false,
				line: "Fixture",
			},
			html: "a".repeat(16 * 1024 * 1024),
		};
	assert.equal(typeof api.bridge.reply(message, "review", "query", { kind: "review" }).html, "string");
	assert.throws(() => api.bridge.reply(message, "other", "query", { kind: "review" }), /Unexpected reader reply/);
	assert.throws(() => api.bridge.reply(message, "review", "query", { kind: "details" }), /byte limit/);
	message.html += "a";
	assert.throws(() => api.bridge.reply(message, "review", "query", { kind: "review" }), /byte limit/);
});
test("a code block's Markdown goes out as text and returns as HTML within the rendering bound", () => {
	const api = bridge();
	for (const text of ["## Install\n\n- item\n", ""])
		assert.equal(api.bridge.page({ v: 1, type: "query", id: "q", kind: "markdown", text }).type, "query");
	for (const fields of [{}, { text: 1 }, { text: "a".repeat(256 * 1024 + 1) }])
		assert.throws(() => api.bridge.page({ v: 1, type: "query", id: "q", kind: "markdown", ...fields }));
	const message = { v: 1, type: "reply", id: "q", ok: true, html: "a".repeat(16 * 1024 * 1024) };
	assert.equal(typeof api.bridge.reply(message, "q", "query", { kind: "markdown" }).html, "string");
	assert.throws(() => api.bridge.reply({ ...message, html: undefined }, "q", "query", { kind: "markdown" }));
	message.html += "a";
	assert.throws(() => api.bridge.reply(message, "q", "query", { kind: "markdown" }), /byte limit/);
});
test("edits use their exact compact JSON bound independently of metadata", () => {
	const api = bridge(),
		n = 512 * 1024,
		edits = [
			{ start: 0, end: n, expected: "a".repeat(n), text: "x".repeat(2 * 1024 * 1024) },
			{ start: n, end: 2 * n, expected: "a".repeat(n), text: "x".repeat(2 * 1024 * 1024) },
		];
	const excess = Buffer.byteLength(JSON.stringify(edits)) - 5 * 1024 * 1024;
	edits[1].text = edits[1].text.slice(0, edits[1].text.length - excess);
	const page = { v: 1, type: "edits", presentation: "view", baseGeneration: 0, generation: 1, origin: "person", edits };
	assert.equal(api.bridge.page(page).type, "edits");
	assert.equal(
		api.bridge.native({ v: 1, type: "agentApply", baseGeneration: 0, operationId: "agent", edits }).type,
		"agentApply",
	);
	edits[1].text += "x";
	assert.throws(() => api.bridge.page(page), /byte limit/);
});
test("large document groups do not enlarge the remaining metadata allowance", () => {
	const api = bridge(),
		message = { ...documentMessage("é".repeat(1024 * 1024)), padding: "" };
	const rest: Record<string, unknown> = { ...message };
	delete rest.source;
	delete rest.blocks;
	message.padding = "a".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(rest)));
	assert.equal(api.bridge.native(message).type, "document");
	message.padding += "a";
	assert.throws(() => api.bridge.native(message), /byte limit/);
});
test("text settings use positive multipliers and ordered multiplier steps", () => {
	const api = bridge();
	const valid = { v: 1, type: "command", name: "applySettings", args: { textSize: 1.1, textSizeSteps: [0.9, 1, 1.1] } };
	assert.equal(api.bridge.native(valid).type, "command");
	assert.throws(() => api.bridge.native({ ...valid, args: { textSize: 0 } }));
	assert.throws(() => api.bridge.native({ ...valid, args: { textSizeSteps: [1, 0.9] } }));
	assert.throws(() => api.bridge.native({ ...valid, args: { textSizeSteps: [1, 1] } }));
	const doc = documentMessage();
	const incomplete = { ...doc, settings: { lock: "reading", textSize: 1 } };
	assert.throws(() => api.bridge.native(incomplete));
});
test("jump commands and jump history state validate at the host boundary", () => {
	const api = bridge();
	for (const name of ["back", "forward"]) assert.equal(api.bridge.native({ v: 1, type: "command", name }).name, name);
	const state = {
		v: 1,
		type: "state",
		editingPending: false,
		lock: "reading",
		overlay: null,
		canBack: false,
		canForward: true,
		canUndo: false,
		canRedo: false,
		hasSelection: false,
		findOpen: false,
		scroll: { blockStart: 0, offsetY: 0 },
	};
	assert.equal(api.bridge.page(state).canForward, true);
	assert.throws(() => api.bridge.page({ ...state, canBack: "yes" }));
	assert.throws(() => api.bridge.page({ ...state, canForward: undefined }));
});
test("block maps refuse malformed source ranges and block order", () => {
	const api = bridge(),
		message = documentMessage("abc");
	message.blocks = [{ key: "b", start: 0, end: 3, type: "paragraph", html: "abc", map: [[0, 3, 0, 4]] }];
	assert.throws(() => api.bridge.native(message), /inline map/);
	message.blocks = [
		{ key: "b", start: 0, end: 3, type: "paragraph", html: "abc" },
		{ key: "b", start: 1, end: 2, type: "paragraph", html: "b" },
	];
	assert.throws(() => api.bridge.native(message), /blocks/);
});
